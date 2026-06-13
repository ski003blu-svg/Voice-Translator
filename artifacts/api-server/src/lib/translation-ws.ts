/**
 * WebSocket-based live translation server.
 *
 * Receive-language model:
 * - Each client declares only the language they WANT TO HEAR (receiveLanguage).
 * - Speaker language is auto-detected by ElevenLabs Scribe STT.
 * - For each receiver, text is translated → synthesised → sent as audio.
 *
 * Translation: Google Translate free API (reliable, no key needed).
 * TTS:
 *   - With cloned voiceId → ElevenLabs eleven_multilingual_v2 (if available)
 *   - All other cases    → Google Translate TTS (free, supports all 7 languages)
 *   - If Google TTS fails → send text to client for browser Web Speech API
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

// ─── Language maps ───────────────────────────────────────────────────────────

/** Language name → ISO 639-1 code */
const LANG_TO_ISO: Record<string, string> = {
  english: "en",
  telugu:  "te",
  hindi:   "hi",
  spanish: "es",
  tamil:   "ta",
  french:  "fr",
  german:  "de",
};

/** Language name → Google Translate TTS code */
const LANG_TO_GTTS: Record<string, string> = {
  english: "en",
  telugu:  "te",
  hindi:   "hi",
  spanish: "es",
  tamil:   "ta",
  french:  "fr",
  german:  "de",
};

/** Scribe 3-letter ISO → 2-letter ISO for Google Translate */
const ISO3_TO_ISO2: Record<string, string> = {
  eng: "en", tel: "te", hin: "hi", spa: "es",
  tam: "ta", fra: "fr", deu: "de", ben: "bn",
  por: "pt", ita: "it", rus: "ru", jpn: "ja",
  kor: "ko", zho: "zh", ara: "ar", mkd: "mk",
};

function normaliseIso(code: string): string {
  if (code.length === 3) return ISO3_TO_ISO2[code] ?? code.slice(0, 2);
  return code.split("-")[0];
}

// ─── Translation (Google Translate free API) ─────────────────────────────────

async function translateText(
  text: string,
  fromIso: string,
  toLang: string,
): Promise<string> {
  const toIso = LANG_TO_ISO[toLang] ?? toLang;
  // Same language – no translation needed
  if (fromIso === toIso) return text;

  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=${encodeURIComponent(fromIso)}&tl=${encodeURIComponent(toIso)}&dt=t` +
    `&q=${encodeURIComponent(text)}`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!resp.ok) throw new Error(`Google Translate HTTP ${resp.status}`);

  // Response: [[["translated","original"],...], null, "detected_lang"]
  const data = (await resp.json()) as unknown[][];
  const segments = data[0] as string[][];
  const translated = segments
    .map((seg) => (typeof seg[0] === "string" ? seg[0] : ""))
    .join("")
    .trim();

  return translated || text; // fallback to original if empty
}

// ─── TTS (Google Translate TTS) ──────────────────────────────────────────────

/**
 * Google Translate TTS. Splits long text into ≤ 200-char sentence chunks.
 * Returns null on failure so the caller can fall back to browser speech.
 */
async function googleTTS(text: string, langCode: string): Promise<Buffer | null> {
  try {
    // Split into ≤ 200-char chunks on sentence boundaries
    const chunks: string[] = [];
    if (text.length <= 200) {
      chunks.push(text);
    } else {
      const sentences = text.split(/(?<=[.!?।])\s+/);
      let current = "";
      for (const s of sentences) {
        if (current.length + s.length > 195) {
          if (current) chunks.push(current.trim());
          current = s;
        } else {
          current = current ? `${current} ${s}` : s;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }

    const buffers = await Promise.all(
      chunks.map(async (chunk) => {
        const params = new URLSearchParams({
          ie: "UTF-8",
          q: chunk,
          tl: langCode,
          client: "gtx",
          ttsspeed: "1",
        });
        const r = await fetch(
          `https://translate.google.com/translate_tts?${params}`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
              Referer: "https://translate.google.com/",
            },
          },
        );
        if (!r.ok) throw new Error(`Google TTS HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      }),
    );

    return Buffer.concat(buffers);
  } catch (err) {
    logger.warn({ err }, "Google TTS failed");
    return null;
  }
}

/** ElevenLabs TTS – only used when sender has a cloned voiceId */
async function elevenLabsTTS(
  text: string,
  voiceId: string,
): Promise<Buffer | null> {
  try {
    const stream = await eleven.textToSpeech.convert(voiceId, {
      model_id: "eleven_multilingual_v2",
      text,
      voice_settings: { stability: 0.45, similarity_boost: 0.80 },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of stream as unknown as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logger.warn({ err }, "ElevenLabs TTS failed – falling back to Google TTS");
    return null;
  }
}

/**
 * Generate TTS audio.
 *
 * Priority:
 *   1. Sender has cloned voice → ElevenLabs, fallback to Google TTS
 *   2. All other cases         → Google TTS
 *   Returns null if everything fails (caller will use browser speech synthesis).
 */
async function generateTTS(
  text: string,
  receiveLang: string,
  senderVoiceId: string | null,
): Promise<Buffer | null> {
  const langCode = LANG_TO_GTTS[receiveLang] ?? "en";

  if (senderVoiceId) {
    const buf = await elevenLabsTTS(text, senderVoiceId);
    if (buf) return buf;
    // ElevenLabs failed – fall through to Google TTS
  }

  return googleTTS(text, langCode);
}

// ─── Room management ─────────────────────────────────────────────────────────

interface RoomClient {
  ws: WebSocket;
  roomId: string;
  receiveLanguage: string;
  voiceId: string | null;
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
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "status", status }));
}

// ─── Translation pipeline ─────────────────────────────────────────────────────

async function processAudio(client: RoomClient): Promise<void> {
  if (client.audioChunks.length === 0) return;

  const audioBuffer = Buffer.concat(client.audioChunks);
  client.audioChunks = [];

  try {
    sendStatus(client.ws, "translating");

    // Step 1 — STT via ElevenLabs Scribe (auto-detects language)
    const transcription = await eleven.speechToText.convert({
      model_id: "scribe_v1",
      file: new Blob([audioBuffer], { type: "audio/webm" }),
      tag_audio_events: false,
    });

    const transcript = transcription.text?.trim();
    if (!transcript) { sendStatus(client.ws, "listening"); return; }

    const rawIso: string =
      (transcription as unknown as { language_code?: string }).language_code ?? "en";
    const detectedIso = normaliseIso(rawIso);

    logger.info({ transcript, detectedIso }, "STT result");

    const others = getOtherClients(client);
    if (others.length === 0) { sendStatus(client.ws, "listening"); return; }

    // Step 2 — For each receiver: translate + TTS
    await Promise.all(
      others.map(async (receiver) => {
        const receiveLang = receiver.receiveLanguage;
        let translatedText = transcript;

        // Translate
        try {
          translatedText = await translateText(transcript, detectedIso, receiveLang);
          logger.info({ receiveLang, translatedText }, "Translated");
        } catch (err) {
          logger.warn({ err, receiveLang }, "Translation failed – using original text");
        }

        if (!translatedText) return;

        // TTS – try server-side audio first
        const audioOut = await generateTTS(translatedText, receiveLang, client.voiceId);

        if (receiver.ws.readyState !== WebSocket.OPEN) return;

        if (audioOut) {
          // Send synthesised audio
          receiver.ws.send(
            JSON.stringify({
              type: "audio_data",
              data: audioOut.toString("base64"),
              text: translatedText,
              mimeType: "audio/mpeg",
            }),
          );
        } else {
          // Fallback: let client browser speak it
          receiver.ws.send(
            JSON.stringify({
              type: "speech",
              text: translatedText,   // ← translated, not original
              lang: receiveLang,
            }),
          );
        }
      }),
    );

    sendStatus(client.ws, "listening");
  } catch (err) {
    logger.error({ err }, "Translation pipeline error");
    sendStatus(client.ws, "listening");
  }
}

function scheduleProcessing(client: RoomClient): void {
  if (client.processingTimer) clearTimeout(client.processingTimer);
  client.processingTimer = setTimeout(
    () => processAudio(client).catch((e) => logger.error({ e }, "processAudio error")),
    200,
  );
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
        if (client.roomId) { client.audioChunks.push(data); scheduleProcessing(client); }
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start") {
          client.roomId          = msg.roomId          || "default";
          client.receiveLanguage = msg.receiveLanguage || "english";
          client.voiceId         = msg.voiceId         || null;

          if (!rooms.has(client.roomId)) rooms.set(client.roomId, []);
          rooms.get(client.roomId)!.push(client);

          logger.info(
            { roomId: client.roomId, receiveLanguage: client.receiveLanguage, hasVoice: !!client.voiceId },
            "Client joined room",
          );
          sendStatus(ws, "listening");
        }
      } catch {
        if (client.roomId) { client.audioChunks.push(data); scheduleProcessing(client); }
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
