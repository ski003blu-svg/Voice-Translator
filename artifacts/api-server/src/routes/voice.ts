import { Router } from "express";
import express from "express";
import { ElevenLabsClient } from "elevenlabs";
import { logger } from "../lib/logger.js";

const eleven = new ElevenLabsClient({
  apiKey: process.env["ELEVENLABS_API_KEY"] ?? "",
});

const router = Router();

router.post(
  "/voices/clone",
  express.raw({ type: "*/*", limit: "25mb" }),
  async (req, res) => {
    try {
      const audioBuffer = req.body as Buffer;

      if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 500) {
        res.status(400).json({ error: "Audio sample too short or missing" });
        return;
      }

      logger.info({ bytes: audioBuffer.length }, "Voice clone request received");

      const file = new File([audioBuffer], "voice-sample.webm", {
        type: "audio/webm",
      });

      const voice = await eleven.voices.add({
        name: `MissU-${Date.now()}`,
        files: [file],
        description: "Real-time translation voice clone",
      });

      logger.info({ voiceId: voice.voice_id }, "Voice cloned successfully");
      res.json({ voiceId: voice.voice_id });
    } catch (err) {
      logger.error({ err }, "Voice cloning failed");
      res.status(500).json({ error: "Voice cloning failed. Please try again." });
    }
  },
);

export default router;
