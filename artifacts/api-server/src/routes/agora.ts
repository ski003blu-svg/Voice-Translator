import { Router } from "express";
import { RtcTokenBuilder, RtcRole } from "agora-access-token";
import { GetAgoraTokenBody } from "@workspace/api-zod";

const router = Router();

router.post("/agora-token", (req, res) => {
  const parsed = GetAgoraTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { channelName, uid } = parsed.data;

  const appId = process.env["AGORA_APP_ID"];
  const appCertificate = process.env["AGORA_APP_CERTIFICATE"];

  if (!appId || !appCertificate) {
    req.log.error("Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE");
    res.status(500).json({ error: "Agora credentials not configured" });
    return;
  }

  // Token expires in 1 hour
  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    res.json({ token, appId, channelName, uid });
  } catch (err) {
    req.log.error({ err }, "Failed to generate Agora token");
    res.status(500).json({ error: "Failed to generate token" });
  }
});

export default router;
