/**
 * WebSocket-based live translation server.
 *
 * Flow per client:
 * 1. Client connects and sends a JSON "start" message with roomId, myLanguage, friendLanguage
 * 2. Client streams raw audio chunks as binary (ArrayBuffer / Buffer)
 * 3. Server accumulates chunks for ~1s, then sends to OpenAI:
 *    - STT: transcribe the audio
 *    - Translation + TTS: translate the transcript and synthesize speech
 * 4. Server sends translated audio back to the OTHER client in the same room as binary
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server } from "http";
import OpenAI from "openai";
import { logger } from "./logger.js";

const openai = new OpenAI({
  apiKey: process.env["OPENAI_API_KEY"],
});

interface RoomClient {
  ws: WebSocket;
  roomId: string;
  myLanguage: string;
  friendLanguage: string;
  audioChunks: Buffer[];
  processingTimer: ReturnType<typeof setTimeout> | null;
}

// Map roomId -> list of clients in that room
const rooms = new Map<string, RoomClient[]>();

function getOtherClients(client: RoomClient): RoomClient[] {
  const room = rooms.get(client.roomId);
  if (!room) return [];
  return room.filter((c) => c !== client && c.ws.readyState === WebSocket.OPEN);
}

async function processAudio(client: RoomClient): Promise<void> {
  if (client.audioChunks.length === 0) return;

  const audioBuffer = Buffer.concat(client.audioChunks);
  client.audioChunks = [];

  const myLang = client.myLanguage;
  const friendLang = client.friendLanguage;

  const langNames: Record<string, string> = {
    english: "English",
    telugu: "Telugu",
  };

  try {
    // Step 1: Transcribe speaker's audio
    const audioBlob = new Blob([audioBuffer], { type: "audio/webm" });
    const audioFile = new File([audioBlob], "audio.webm", { type: "audio/webm" });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: myLang === "telugu" ? "te" : "en",
    });

    const transcript = transcription.text.trim();
    if (!transcript) return;

    logger.info({ transcript, myLang, friendLang }, "Transcribed audio");

    // Notify client that translation is in progress
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: "status", status: "translating" }));
    }

    // Step 2: Translate the text
    const translationPrompt = `Translate the following ${langNames[myLang]} text to ${langNames[friendLang]}. Return only the translated text, nothing else.\n\n${transcript}`;

    const translationResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: translationPrompt }],
      max_tokens: 500,
    });

    const translatedText = translationResponse.choices[0]?.message?.content?.trim();
    if (!translatedText) return;

    logger.info({ translatedText }, "Translated text");

    // Step 3: Convert translated text to speech
    const ttsVoice = friendLang === "telugu" ? "nova" : "alloy";
    const speechResponse = await openai.audio.speech.create({
      model: "tts-1",
      voice: ttsVoice,
      input: translatedText,
      response_format: "mp3",
    });

    const speechBuffer = Buffer.from(await speechResponse.arrayBuffer());

    // Step 4: Send translated audio to OTHER clients in the room
    const others = getOtherClients(client);
    for (const other of others) {
      if (other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(speechBuffer);
        other.ws.send(JSON.stringify({ type: "status", status: "speaking" }));
      }
    }

    // Signal done to sender
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: "status", status: "listening" }));
    }
  } catch (err) {
    logger.error({ err }, "Translation pipeline error");
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: "error", message: "Translation failed" }));
    }
  }
}

function scheduleProcessing(client: RoomClient): void {
  if (client.processingTimer) {
    clearTimeout(client.processingTimer);
  }
  // Process audio after 1.5s of silence
  client.processingTimer = setTimeout(() => {
    processAudio(client).catch((err) => {
      logger.error({ err }, "Error processing audio");
    });
  }, 1500);
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

    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (!isBinary && typeof data === "object" || typeof data === "string") {
        // Try to parse as JSON control message
        try {
          const text = data.toString();
          const msg = JSON.parse(text);

          if (msg.type === "start") {
            client.roomId = msg.roomId || "default";
            client.myLanguage = msg.myLanguage || "english";
            client.friendLanguage = msg.friendLanguage || "telugu";

            // Register in room
            if (!rooms.has(client.roomId)) {
              rooms.set(client.roomId, []);
            }
            rooms.get(client.roomId)!.push(client);

            logger.info({ roomId: client.roomId, myLanguage: client.myLanguage }, "Client joined room");
            ws.send(JSON.stringify({ type: "status", status: "listening" }));
          }
        } catch {
          // Not JSON — treat as binary audio data
          if (client.roomId && Buffer.isBuffer(data)) {
            client.audioChunks.push(data);
            scheduleProcessing(client);
          }
        }
      } else if (isBinary && Buffer.isBuffer(data)) {
        // Binary audio chunk
        if (client.roomId) {
          client.audioChunks.push(data);
          scheduleProcessing(client);
        }
      }
    });

    ws.on("close", () => {
      logger.info({ roomId: client.roomId }, "WebSocket client disconnected");
      if (client.processingTimer) clearTimeout(client.processingTimer);

      // Remove from room
      if (client.roomId) {
        const room = rooms.get(client.roomId);
        if (room) {
          const idx = room.indexOf(client);
          if (idx !== -1) room.splice(idx, 1);
          if (room.length === 0) rooms.delete(client.roomId);
        }
      }
    });

    ws.on("error", (err) => {
      logger.error({ err }, "WebSocket error");
    });
  });

  logger.info("WebSocket translation server ready at /ws/translate");
}
