/**
 * WebSocket-based live translation server using Google Gemini.
 *
 * Flow per client:
 * 1. Client connects and sends a JSON "start" message with roomId, myLanguage, friendLanguage
 * 2. Client streams raw audio chunks as binary (Buffer)
 * 3. Server accumulates chunks for ~1.5s of silence, then:
 *    - Sends audio + translation prompt to gemini-2.0-flash (STT + translate in one shot)
 *    - Synthesizes translated text to speech via gemini-2.5-flash-preview-tts
 * 4. Server sends translated MP3 audio back to the OTHER client in the same room as binary
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "./logger.js";

const genAI = new GoogleGenerativeAI(process.env["GEMINI_API_KEY"] ?? "");

// Translation model — understands audio input natively
const translationModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// TTS model — produces audio output
const ttsModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-tts" });

// Retry a Gemini call with exponential backoff on 429 quota errors
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const status = (err as { status?: number })?.status;
      if (status === 429 && attempt < maxRetries) {
        // Extract retry delay from error message, default to 10s doubling each attempt
        const retryMatch = String(err).match(/retryDelay.*?(\d+)s/);
        const waitSecs = retryMatch ? parseInt(retryMatch[1]) : Math.pow(2, attempt + 1) * 5;
        const waitMs = Math.min(waitSecs * 1000, 60_000);
        logger.warn({ attempt, waitMs }, "Gemini quota hit, retrying after delay");
        await new Promise((res) => setTimeout(res, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const langNames: Record<string, string> = {
  english: "English",
  telugu: "Telugu",
};

interface RoomClient {
  ws: WebSocket;
  roomId: string;
  myLanguage: string;
  friendLanguage: string;
  audioChunks: Buffer[];
  processingTimer: ReturnType<typeof setTimeout> | null;
}

// roomId -> clients in that room
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

async function processAudio(client: RoomClient): Promise<void> {
  if (client.audioChunks.length === 0) return;

  const audioBuffer = Buffer.concat(client.audioChunks);
  client.audioChunks = [];

  const myLang = client.myLanguage;
  const friendLang = client.friendLanguage;
  const myLangName = langNames[myLang] ?? myLang;
  const friendLangName = langNames[friendLang] ?? friendLang;

  try {
    // Notify sender we're working on it
    sendStatus(client.ws, "translating");

    // Step 1 + 2 combined: STT + Translation in a single Gemini call
    // Gemini 2.0 Flash can understand audio natively
    const base64Audio = audioBuffer.toString("base64");

    const prompt = `You are a real-time interpreter. The audio contains speech in ${myLangName}.
Listen to it, transcribe it, and return ONLY the ${friendLangName} translation — no explanation, no original text, just the translated sentence.
If the audio is silent or unclear, return an empty string.`;

    const translationResult = await withRetry(() =>
      translationModel.generateContent([
        { inlineData: { data: base64Audio, mimeType: "audio/webm" } },
        prompt,
      ])
    );

    const translatedText = translationResult.response.text().trim();

    if (!translatedText) {
      sendStatus(client.ws, "listening");
      return;
    }

    logger.info({ translatedText, myLang, friendLang }, "Translated text");

    // Step 3: Text-to-speech using Gemini 2.5 Flash TTS
    const ttsPrompt = `Say the following in ${friendLangName} in a clear, natural voice:\n\n${translatedText}`;

    const ttsResult = await withRetry(() =>
      ttsModel.generateContent({
        contents: [{ role: "user", parts: [{ text: ttsPrompt }] }],
        generationConfig: {
          // @ts-expect-error - responseModalities is a valid field for TTS model
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede",
              },
            },
          },
        },
      })
    );

    // Extract audio data from TTS response
    const audioPart = ttsResult.response.candidates?.[0]?.content?.parts?.[0];
    if (!audioPart?.inlineData?.data) {
      logger.warn("TTS returned no audio data");
      sendStatus(client.ws, "listening");
      return;
    }

    const audioData = Buffer.from(audioPart.inlineData.data, "base64");
    const mimeType = audioPart.inlineData.mimeType ?? "audio/mp3";

    // Step 4: Send translated audio to the OTHER clients in the room
    const others = getOtherClients(client);
    for (const other of others) {
      if (other.ws.readyState === WebSocket.OPEN) {
        // Send mime type header first so client knows how to play it
        other.ws.send(JSON.stringify({ type: "audio-meta", mimeType }));
        other.ws.send(audioData);
        sendStatus(other.ws, "speaking");
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
  // Client sends complete utterances (VAD-gated), so process quickly after receiving
  client.processingTimer = setTimeout(() => {
    processAudio(client).catch((err) => logger.error({ err }, "Error in processAudio"));
  }, 200);
}

export function setupTranslationWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/translate" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ url: req.url }, "WebSocket client connected");

    const client: RoomClient = {
      ws,
      roomId: "",
      myLanguage: "english",
      friendLanguage: "telugu",
      audioChunks: [],
      processingTimer: null,
    };

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Binary audio chunk
        if (client.roomId) {
          client.audioChunks.push(data);
          scheduleProcessing(client);
        }
        return;
      }

      // Text control message
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "start") {
          client.roomId = msg.roomId || "default";
          client.myLanguage = msg.myLanguage || "english";
          client.friendLanguage = msg.friendLanguage || "telugu";

          if (!rooms.has(client.roomId)) rooms.set(client.roomId, []);
          rooms.get(client.roomId)!.push(client);

          logger.info({ roomId: client.roomId, myLanguage: client.myLanguage }, "Client joined room");
          sendStatus(ws, "listening");
        }
      } catch {
        // Non-JSON text, treat as binary audio fallback
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
