/**
 * WebSocket-based live translation server using ElevenLabs + MyMemory.
 *
 * Pipeline per utterance:
 * 1. Client sends a complete speech segment (VAD-gated audio blob)
 * 2. ElevenLabs Scribe STT  → transcript text
 * 3. MyMemory free API       → translated text (no API key needed)
 * 4a. ElevenLabs TTS (cloned voice) → translated audio sent as base64 JSON  [if voiceId set]
 * 4b. Fallback: send translated text → receiving client speaks via browser TTS [no voiceId]
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

// Language codes used by ElevenLabs Scribe STT (ISO-639-1 / ISO-639-3)
const STT_LANG: Record<string, string> = {
  english: "en",
  telugu: "te",
};

// MyMemory language pair codes
const MT_LANG: Record<string, string> = {
  english: "en-GB",
  telugu: "te",
};

/** Translate text using MyMemory (free, no API key, supports en ↔ te) */
async function translateText(text: string, fromLang: string, toLang: string): Promise<string> {
  const from = MT_LANG[fromLang] ?? fromLang;
  const to   = MT_LANG[toLang]   ?? toLang;
  const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MyMemory API error: ${resp.status}`);

  const data = await resp.json() as { responseStatus: number; responseData: { translatedText: string } };
  if (data.responseStatus !== 200) throw new Error(`MyMemory returned status ${data.responseStatus}`);

  return data.responseData.translatedText.trim();
}

/** Drain a Readable stream into a Buffer */
async function readableToBuffer(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ─── Room management ────────────────────────────────────────────────────────

interface RoomClient {
  ws: WebSocket;
  roomId: string;
  myLanguage: string;
  friendLanguage: string;
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
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "status", status }));
  }
}

// ─── Translation pipeline ────────────────────────────────────────────────────

async function processAudio(client: RoomClient): Promise<void> {
  if (client.audioChunks.length === 0) return;

  const audioBuffer = Buffer.concat(client.audioChunks);
  client.audioChunks = [];

  const myLang     = client.myLanguage;
  const friendLang = client.friendLanguage;

  try {
    sendStatus(client.ws, "translating");

    // Step 1 — STT: transcribe speaker's audio with ElevenLabs Scribe
    const audioBlob = new Blob([audioBuffer], { type: "audio/webm" });

    const transcription = await eleven.speechToText.convert({
      model_id: "scribe_v1",
      file: audioBlob,
      language_code: STT_LANG[myLang] ?? "en",
      tag_audio_events: false,
    });

    const transcript = transcription.text?.trim();
    if (!transcript) {
      sendStatus(client.ws, "listening");
      return;
    }

    logger.info({ transcript, myLang, friendLang }, "STT transcript");

    // Step 2 — Translation: MyMemory free API
    const translatedText = await translateText(transcript, myLang, friendLang);
    if (!translatedText) {
      sendStatus(client.ws, "listening");
      return;
    }

    logger.info({ translatedText }, "Translated text");

    const others = getOtherClients(client);

    // Step 3a — If sender has a cloned voice, use ElevenLabs TTS and send audio
    if (client.voiceId && others.length > 0) {
      try {
        logger.info({ voiceId: client.voiceId, textLen: translatedText.length }, "Generating TTS with cloned voice");

        const audioStream = await eleven.textToSpeech.convert(client.voiceId, {
          model_id: "eleven_multilingual_v2",
          text: translatedText,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.80,
          },
        });

        const ttsBuffer = await readableToBuffer(audioStream as unknown as Readable);
        const base64Audio = ttsBuffer.toString("base64");

        for (const other of others) {
          if (other.ws.readyState === WebSocket.OPEN) {
            other.ws.send(JSON.stringify({
              type: "audio_data",
              data: base64Audio,
              text: translatedText,
              mimeType: "audio/mpeg",
            }));
          }
        }

        logger.info({ bytes: ttsBuffer.length }, "TTS audio sent to peer");
      } catch (ttsErr) {
        // TTS failed — fall back to text so the other user still hears something
        logger.warn({ ttsErr }, "ElevenLabs TTS failed, falling back to text");
        for (const other of others) {
          if (other.ws.readyState === WebSocket.OPEN) {
            other.ws.send(JSON.stringify({ type: "speech", text: translatedText, lang: friendLang }));
          }
        }
      }
    } else {
      // Step 3b — No cloned voice: forward text for browser Web Speech API
      for (const other of others) {
        if (other.ws.readyState === WebSocket.OPEN) {
          other.ws.send(JSON.stringify({ type: "speech", text: translatedText, lang: friendLang }));
        }
      }
    }

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

// ─── WebSocket server ────────────────────────────────────────────────────────

export function setupTranslationWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/translate" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ url: req.url }, "WebSocket client connected");

    const client: RoomClient = {
      ws,
      roomId: "",
      myLanguage: "english",
      friendLanguage: "telugu",
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

      // Text control message (JSON)
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start") {
          client.roomId         = msg.roomId         || "default";
          client.myLanguage     = msg.myLanguage     || "english";
          client.friendLanguage = msg.friendLanguage || "telugu";
          client.voiceId        = msg.voiceId        || null;

          if (!rooms.has(client.roomId)) rooms.set(client.roomId, []);
          rooms.get(client.roomId)!.push(client);

          logger.info(
            { roomId: client.roomId, myLanguage: client.myLanguage, hasVoice: !!client.voiceId },
            "Client joined room",
          );
          sendStatus(ws, "listening");
        }
      } catch {
        // Non-JSON: treat as audio
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
