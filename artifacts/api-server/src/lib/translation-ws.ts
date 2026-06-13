/**
 * WebSocket-based live translation server.
 *
 * New model (receive-language):
 * - Each client declares only the language they WANT TO HEAR (receiveLanguage).
 * - Speaker language is auto-detected by ElevenLabs Scribe STT.
 * - For every receiver in the room, text is translated into their receiveLanguage
 *   and sent as synthesised audio.
 *
 * TTS routing:
 *   Telugu  (no cloned voice)  → Google Translate TTS (te)
 *   Other languages             → ElevenLabs eleven_multilingual_v2
 *   Any language (cloned voice) → ElevenLabs eleven_multilingual_v2 + voiceId
 */

import { Readable } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { ElevenLabsClient } from "elevenlabs";
import { logger } from "./logger.js";

const eleven = new ElevenLabsClient({
  apiKey: process.env["ELEVENLABS_API_KEY"] ?? "",
});

// Default ElevenLabs voice used when the sender has no cloned voice
const ELEVEN_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel – stable multilingual voice

// ─── Language maps ──────────────────────────────────────────────────────────

/** Language name → ISO 639-1 code (used by Scribe and ElevenLabs) */
const LANG_TO_ISO: Record<string, string> = {
  english: "en",
  telugu:  "te",
  hindi:   "hi",
  spanish: "es",
  tamil:   "ta",
  french:  "fr",
  german:  "de",
};

/** ISO 639-1 → MyMemory language pair code */
const ISO_TO_MYMEMORY: Record<string, string> = {
  en: "en-GB",
  te: "te",
  hi: "hi",
  es: "es",
  ta: "ta",
  fr: "fr",
  de: "de",
};

/** Language name → Google Translate TTS language code */
const LANG_TO_GTTS: Record<string, string> = {
  telugu:  "te",
  hindi:   "hi",
  tamil:   "ta",
  spanish: "es",
  french:  "fr",
  german:  "de",
  english: "en",
};

// ─── Translation ─────────────────────────────────────────────────────────────

async function translateText(
  text: string,
  fromIso: string,
  toLang: string,
): Promise<string> {
  const toIso   = LANG_TO_ISO[toLang] ?? toLang;
  // If source and target are the same language, skip translation
  if (fromIso === toIso) return text;

  const from = ISO_TO_MYMEMORY[fromIso] ?? fromIso;
  const to   = ISO_TO_MYMEMORY[toIso]   ?? toIso;
  const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MyMemory error: ${resp.status}`);

  const data = await resp.json() as {
    responseStatus: number;
    responseData: { translatedText: string };
  };
  if (data.responseStatus !== 200) throw new Error(`MyMemory status ${data.responseStatus}`);

  return data.responseData.translatedText.trim();
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

async function readableToBuffer(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Google Translate TTS – free, good quality for Indian languages */
async function googleTTS(text: string, langCode: string): Promise<Buffer> {
  const params = new URLSearchParams({
    ie: "UTF-8",
    q: text,
    tl: langCode,
    client: "gtx",
    ttsspeed: "1",
  });
  const resp = await fetch(
    `https://translate.google.com/translate_tts?${params}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://translate.google.com/",
      },
    },
  );
  if (!resp.ok) throw new Error(`Google TTS HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/** ElevenLabs TTS – multilingual v2, supports most languages */
async function elevenLabsTTS(
  text: string,
  voiceId: string,
): Promise<Buffer> {
  const stream = await eleven.textToSpeech.convert(voiceId, {
    model_id: "eleven_multilingual_v2",
    text,
    voice_settings: { stability: 0.45, similarity_boost: 0.80 },
  });
  return readableToBuffer(stream as unknown as Readable);
}

/**
 * Generate TTS audio for `receiveLang`.
 *
 * Priority:
 *   1. Cloned voice (voiceId set) → ElevenLabs with voiceId
 *   2. Telugu (no voiceId)        → Google Translate TTS
 *   3. Other (no voiceId)         → ElevenLabs default voice
 */
async function generateTTS(
  text: string,
  receiveLang: string,
  senderVoiceId: string | null,
): Promise<Buffer> {
  // 1 — Cloned voice: always use ElevenLabs with the sender's voice
  if (senderVoiceId) {
    return elevenLabsTTS(text, senderVoiceId);
  }

  // 2 — Telugu (no clone): Google Translate TTS
  if (receiveLang === "telugu") {
    try {
      logger.info("Using Google TTS for Telugu");
      return await googleTTS(text, "te");
    } catch (err) {
      logger.warn({ err }, "Google TTS failed for Telugu, falling back to ElevenLabs");
    }
  }

  // 3 — All other languages (and Telugu fallback): ElevenLabs default voice
  return elevenLabsTTS(text, ELEVEN_DEFAULT_VOICE);
}

// ─── Room management ─────────────────────────────────────────────────────────

interface RoomClient {
  ws: WebSocket;
  roomId: string;
  receiveLanguage: string;   // The language this client wants to HEAR
  voiceId: string | null;    // Cloned voice of THIS client (used when they are the sender)
  audioChunks: Buffer[];
  processingTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, RoomClient[]>();

function getOtherClients(client: RoomClient): RoomClient[] {
  const room = rooms.get(client.roomId);
  if (!room) return [];
  return room.filter((c) => c !== client && c.ws.readyState === WebSocket.OPEN);
}

function sendStatus(ws: WebSocket, status: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "status", status }));
  }
}

// ─── Translation pipeline ────────────────────────────────────────────────────

async function processAudio(client: RoomClient): Promise<void> {
  if (client.audioChunks.length === 0) return;

  const audioBuffer = Buffer.concat(client.audioChunks);
  client.audioChunks = [];

  try {
    sendStatus(client.ws, "translating");

    // Step 1 — STT: auto-detect speaker language via ElevenLabs Scribe
    const audioBlob = new Blob([audioBuffer], { type: "audio/webm" });

    const transcription = await eleven.speechToText.convert({
      model_id: "scribe_v1",
      file: audioBlob,
      // No language_code → Scribe auto-detects
      tag_audio_events: false,
    });

    const transcript = transcription.text?.trim();
    if (!transcript) {
      sendStatus(client.ws, "listening");
      return;
    }

    // Detected language ISO code (e.g. "en", "te", "hi")
    const detectedIso: string =
      (transcription as unknown as { language_code?: string }).language_code ?? "en";

    logger.info({ transcript, detectedIso }, "STT result");

    const others = getOtherClients(client);
    if (others.length === 0) {
      sendStatus(client.ws, "listening");
      return;
    }

    // Step 2 — For each receiver, translate + generate TTS in their chosen language
    await Promise.all(
      others.map(async (receiver) => {
        try {
          const receiveLang = receiver.receiveLanguage;

          // Translate to receiver's language
          const translatedText = await translateText(transcript, detectedIso, receiveLang);
          if (!translatedText) return;

          logger.info({ receiveLang, translatedText }, "Translated");

          // Generate TTS (use SENDER's cloned voice if available)
          const audioOut = await generateTTS(translatedText, receiveLang, client.voiceId);

          // Send audio + caption to receiver
          if (receiver.ws.readyState === WebSocket.OPEN) {
            receiver.ws.send(JSON.stringify({
              type: "audio_data",
              data: audioOut.toString("base64"),
              text: translatedText,
              mimeType: "audio/mpeg",
            }));
          }
        } catch (err) {
          logger.error({ err, receiveLang: receiver.receiveLanguage }, "Failed to generate for receiver");
          // Fallback: send text so browser TTS can handle it
          if (receiver.ws.readyState === WebSocket.OPEN) {
            receiver.ws.send(JSON.stringify({
              type: "speech",
              text: transcript,
              lang: receiver.receiveLanguage,
            }));
          }
        }
      }),
    );

    sendStatus(client.ws, "listening");
  } catch (err) {
    logger.error({ err }, "Translation pipeline error");
    sendStatus(client.ws, "listening");
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: "error", message: "Translation failed, please try again" }));
    }
  }
}

function scheduleProcessing(client: RoomClient): void {
  if (client.processingTimer) clearTimeout(client.processingTimer);
  client.processingTimer = setTimeout(() => {
    processAudio(client).catch((err) => logger.error({ err }, "Error in processAudio"));
  }, 200);
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

export function setupTranslationWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/translate" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ url: req.url }, "WebSocket client connected");

    const client: RoomClient = {
      ws,
      roomId: "",
      receiveLanguage: "english",
      voiceId: null,
      audioChunks: [],
      processingTimer: null,
    };

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (client.roomId) {
          client.audioChunks.push(data);
          scheduleProcessing(client);
        }
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start") {
          client.roomId         = msg.roomId         || "default";
          client.receiveLanguage = msg.receiveLanguage || "english";
          client.voiceId        = msg.voiceId        || null;

          if (!rooms.has(client.roomId)) rooms.set(client.roomId, []);
          rooms.get(client.roomId)!.push(client);

          logger.info(
            { roomId: client.roomId, receiveLanguage: client.receiveLanguage, hasVoice: !!client.voiceId },
            "Client joined room",
          );
          sendStatus(ws, "listening");
        }
      } catch {
        if (client.roomId) {
          client.audioChunks.push(data);
          scheduleProcessing(client);
        }
      }
    });

    ws.on("close", () => {
      logger.info({ roomId: client.roomId }, "WebSocket client disconnected");
      if (client.processingTimer) clearTimeout(client.processingTimer);
      if (client.roomId) {
        const room = rooms.get(client.roomId);
        if (room) {
          const idx = room.indexOf(client);
          if (idx !== -1) room.splice(idx, 1);
          if (room.length === 0) rooms.delete(client.roomId);
        }
      }
    });

    ws.on("error", (err) => logger.error({ err }, "WebSocket error"));
  });

  logger.info("WebSocket translation server ready at /ws/translate");
}
