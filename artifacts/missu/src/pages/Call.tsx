import { useEffect, useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Mic, MicOff, Volume2, VolumeX, PhoneOff, Languages, Activity, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGetAgoraToken } from "@workspace/api-client-react";
import AgoraRTC, { IAgoraRTCClient, IMicrophoneAudioTrack, IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import Waveform from "@/components/Waveform";

type CallStatus = "idle" | "listening" | "translating" | "speaking";

export default function Call() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const roomId = searchParams.get("roomId") || "UNKNOWN";
  const myLanguage = searchParams.get("myLanguage") || "english";
  const friendLanguage = searchParams.get("friendLanguage") || "telugu";

  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isTranslating, setIsTranslating] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [isConnected, setIsConnected] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // Caption: last translation received from the other user
  const [caption, setCaption] = useState<string>("");

  // Agora refs
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const localTrackRef = useRef<IMicrophoneAudioTrack | null>(null);
  const remoteTracksRef = useRef<Record<string, IRemoteAudioTrack>>({});

  // Translation WebSocket refs
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  // Ref to track active speech utterance (for cancellation)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  // Blocks VAD audio sending while TTS is playing (set BEFORE speak() to close the gap)
  const isTTSActiveRef = useRef(false);
  // Holds the latest speech to play after the current one finishes (prevents cancellation cascade)
  const pendingSpeechRef = useRef<{ text: string; lang: string } | null>(null);
  // Ref to the speakText function itself so callbacks can call it without stale closure
  const speakTextRef = useRef<(text: string, lang: string) => void>(() => {});
  // Safety timer — force-clears isTTSActiveRef if onend/onerror never fires (mobile bug)
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getTokenMutation = useGetAgoraToken();

  // --- Agora voice call setup ---
  useEffect(() => {
    if (!roomId || roomId === "UNKNOWN") {
      setLocation("/join");
      return;
    }

    const initCall = async () => {
      try {
        setConnectError(null);
        const uid = Math.floor(Math.random() * 100000);

        // Fetch Agora token from backend
        let response;
        try {
          response = await getTokenMutation.mutateAsync({
            data: { channelName: roomId, uid },
          });
        } catch (err) {
          throw new Error(`Token fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Use h264 codec — universally supported on mobile (Safari iOS, Android Chrome)
        const client = AgoraRTC.createClient({ mode: "rtc", codec: "h264" });
        clientRef.current = client;

        client.on("user-published", async (user, mediaType) => {
          await client.subscribe(user, mediaType);
          if (mediaType === "audio" && user.audioTrack) {
            remoteTracksRef.current[String(user.uid)] = user.audioTrack;
            user.audioTrack.play();
          }
        });

        client.on("user-unpublished", (user, mediaType) => {
          if (mediaType === "audio") {
            delete remoteTracksRef.current[String(user.uid)];
          }
        });

        // Join the Agora channel
        try {
          await client.join(response.appId, response.channelName, response.token, response.uid);
        } catch (err) {
          throw new Error(`Channel join failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Request mic access and publish
        try {
          const localTrack = await AgoraRTC.createMicrophoneAudioTrack();
          localTrackRef.current = localTrack;
          await client.publish([localTrack]);
        } catch (err) {
          throw new Error(`Microphone access failed — please allow mic permission and retry: ${err instanceof Error ? err.message : String(err)}`);
        }

        setIsConnected(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Failed to join call:", msg);
        setConnectError(msg);
      }
    };

    initCall();

    return () => {
      localTrackRef.current?.stop();
      localTrackRef.current?.close();
      clientRef.current?.leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // --- Speak translated text via browser Web Speech API ---
  // Queue-based: if already speaking, store latest text and speak it when done.
  // isTTSActiveRef is set IMMEDIATELY (not in onstart) to close the echo gap.
  const speakText = useCallback((text: string, lang: string) => {
    if (!window.speechSynthesis) return;

    // If TTS is already playing, queue this as the next utterance (replace older pending)
    if (isTTSActiveRef.current) {
      pendingSpeechRef.current = { text, lang };
      return;
    }

    const langCode: Record<string, string> = {
      english: "en-US",
      telugu:  "te-IN",
    };

    // Block VAD IMMEDIATELY — before speak() — so there's no window where mic is open
    isTTSActiveRef.current = true;
    setStatus("speaking");
    setCaption(text);

    // Clear any previous safety timer before starting a new one
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);

    // Chrome pauses speechSynthesis when the tab goes to background — resume first
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = langCode[lang] ?? "en-US";
    utter.rate = 0.92;

    const releaseLock = () => {
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
      // 600ms cooldown after TTS ends — prevents mic from immediately picking up speaker echo
      setTimeout(() => {
        isTTSActiveRef.current = false;
        const next = pendingSpeechRef.current;
        pendingSpeechRef.current = null;
        if (next) {
          speakTextRef.current(next.text, next.lang);
        } else {
          setStatus("listening");
        }
      }, 600);
    };

    utter.onend   = releaseLock;
    utter.onerror = releaseLock;
    utteranceRef.current = utter;

    // Safety timeout: if onend/onerror never fires (mobile Chrome silent failure),
    // force-release the lock so subsequent translations aren't blocked forever.
    // Estimate ~100ms per character + 5s buffer.
    const estimatedMs = Math.max(5000, text.length * 100 + 3000);
    safetyTimerRef.current = setTimeout(() => {
      safetyTimerRef.current = null;
      releaseLock();
    }, estimatedMs);

    window.speechSynthesis.speak(utter);
  }, []);

  // Keep speakTextRef in sync so the releaseLock callback can call the latest version
  useEffect(() => {
    speakTextRef.current = speakText;
  }, [speakText]);

  // --- Translation WebSocket management ---
  const startTranslation = useCallback(async () => {
    if (wsRef.current) return; // already connected

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/translate`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", roomId, myLanguage, friendLanguage }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "status") {
            setStatus(msg.status as CallStatus);
          } else if (msg.type === "speech") {
            speakText(msg.text as string, msg.lang as string);
          }
        } catch {
          // ignore
        }
      }
    };

    ws.onerror = (err) => console.error("WS error", err);
    ws.onclose = () => {
      wsRef.current = null;
      setStatus("idle");
    };

    // Capture mic audio with Voice Activity Detection (VAD)
    // Only sends audio to the server when the user is actually speaking,
    // which prevents burning through Gemini quota on silence.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      // --- Voice Activity Detection via Web Audio API ---
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let isSpeaking = false;
      let silenceFrames = 0;
      const SPEECH_THRESHOLD = 25;   // RMS level — raised to reduce false triggers
      const SILENCE_END_FRAMES = 30; // ~1s of quiet after speech before closing segment

      const checkVAD = () => {
        if (!wsRef.current) return; // stop loop when WS closes
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        // Never start or continue recording while TTS is playing — prevents echo feedback
        if (isTTSActiveRef.current) {
          if (isSpeaking && recorder.state === "recording") {
            isSpeaking = false;
            recorder.stop(); // discard what was recorded (it's TTS echo)
          }
          silenceFrames = 0;
          requestAnimationFrame(checkVAD);
          return;
        }

        if (avg > SPEECH_THRESHOLD) {
          silenceFrames = 0;
          if (!isSpeaking && recorder.state === "inactive") {
            isSpeaking = true;
            setStatus("listening");
            recorder.start();
          }
        } else {
          silenceFrames++;
          if (isSpeaking && silenceFrames > SILENCE_END_FRAMES) {
            isSpeaking = false;
            if (recorder.state === "recording") recorder.stop();
          }
        }
        requestAnimationFrame(checkVAD);
      };

      // When a speech segment finishes, send the full clip to the server
      // (also guarded: skip if TTS was active when the segment ended)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN && !isTTSActiveRef.current) {
          e.data.arrayBuffer().then((buf) => wsRef.current?.send(buf));
        }
      };

      checkVAD(); // start the detection loop
    } catch (err) {
      console.error("Mic access failed", err);
    }
  }, [roomId, myLanguage, friendLanguage, speakText]);

  const stopTranslation = useCallback(() => {
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
    window.speechSynthesis?.cancel();
    utteranceRef.current = null;
    isTTSActiveRef.current = false;
    pendingSpeechRef.current = null;
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    setCaption("");
    setStatus("idle");
  }, []);

  // Toggle translation on/off
  useEffect(() => {
    if (isTranslating) {
      startTranslation();
    } else {
      stopTranslation();
    }
    return () => {
      if (!isTranslating) stopTranslation();
    };
  }, [isTranslating, startTranslation, stopTranslation]);

  // When translation is ON, mute the local Agora track so the other person
  // hears ONLY the translated TTS voice — not the raw original voice.
  // When translation is OFF, restore the track (unless the user manually muted).
  useEffect(() => {
    if (localTrackRef.current) {
      localTrackRef.current.setMuted(isTranslating ? true : isMuted);
    }
  }, [isTranslating, isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopTranslation();
  }, [stopTranslation]);

  const toggleMute = () => {
    if (localTrackRef.current) {
      const newState = !isMuted;
      localTrackRef.current.setMuted(newState);
      setIsMuted(newState);
    }
  };

  const toggleSpeaker = () => {
    const newState = !isSpeakerOn;
    Object.values(remoteTracksRef.current).forEach((track) => {
      track.setVolume(newState ? 100 : 0);
    });
    setIsSpeakerOn(newState);
  };

  const endCall = () => {
    stopTranslation();
    setLocation("/join");
  };

  const getStatusColor = () => {
    switch (status) {
      case "listening":   return "text-primary";
      case "translating": return "text-accent";
      case "speaking":    return "text-green-400";
      default:            return "text-muted-foreground";
    }
  };

  const getStatusText = () => {
    switch (status) {
      case "listening":   return "Listening...";
      case "translating": return "Translating...";
      case "speaking":    return "Speaking...";
      default:            return isConnected ? "Connected" : "Connecting...";
    }
  };

  const langNames: Record<string, string> = { english: "English", telugu: "Telugu" };

  return (
    <div className="min-h-screen w-full flex flex-col bg-background text-foreground relative overflow-hidden">
      {/* Ambient background glow */}
      <div
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] h-[80vh] rounded-full blur-[150px] pointer-events-none transition-colors duration-1000 ${
          status === "listening"   ? "bg-primary/10"    :
          status === "translating" ? "bg-accent/10"     :
          status === "speaking"    ? "bg-green-500/10"  : "bg-transparent"
        }`}
      />

      {/* Header */}
      <header className="pt-12 px-6 flex flex-col items-center relative z-10">
        <div
          data-testid="text-room-id"
          className="px-4 py-1.5 rounded-full bg-white/5 border border-white/10 text-sm font-mono tracking-widest text-muted-foreground mb-4"
        >
          ROOM: {roomId}
        </div>
        <div className="flex items-center gap-3 text-lg font-medium text-white/90">
          <span className="capitalize">{langNames[myLanguage]}</span>
          <ArrowRight className="w-4 h-4 text-primary" />
          <span className="capitalize">{langNames[friendLanguage]}</span>
        </div>
      </header>

      {/* Main visual */}
      <main className="flex-1 flex flex-col items-center justify-center relative z-10">
        <div className="relative w-64 h-64 flex items-center justify-center">
          <div
            className={`absolute inset-0 rounded-full border-2 transition-colors duration-500 ${
              status !== "idle"
                ? "border-primary/50 animate-pulse"
                : "border-white/10"
            }`}
          />
          <div className="w-48 h-48 bg-secondary rounded-full flex items-center justify-center border border-white/5 shadow-2xl overflow-hidden">
            {connectError ? (
              <div className="flex flex-col items-center p-4">
                <span className="text-2xl mb-1">⚠️</span>
                <span className="text-xs text-destructive text-center leading-tight">Failed</span>
              </div>
            ) : !isConnected ? (
              <div className="flex flex-col items-center animate-pulse">
                <Activity className="w-8 h-8 text-muted-foreground mb-2" />
                <span className="text-sm text-muted-foreground">Connecting...</span>
              </div>
            ) : status === "idle" ? (
              <div className="text-4xl text-primary/40 font-serif">M</div>
            ) : (
              <Waveform active={true} color={status === "translating" ? "accent" : "primary"} />
            )}
          </div>
        </div>

        <div className="mt-8 text-center px-6 flex flex-col items-center gap-4">
          {connectError ? (
            <div className="flex flex-col items-center gap-3">
              <p data-testid="status-call-status" className="text-sm text-destructive text-center leading-snug max-w-xs">
                {connectError}
              </p>
              <Button
                data-testid="button-retry-connect"
                size="sm"
                variant="outline"
                className="border-white/20 text-white hover:bg-white/10"
                onClick={() => window.location.reload()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <p
              data-testid="status-call-status"
              className={`text-lg font-medium transition-colors duration-300 ${getStatusColor()}`}
            >
              {getStatusText()}
            </p>
          )}

          {/* Translation caption — shows the latest translated text received */}
          {caption && isTranslating && (
            <div className="max-w-xs w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
              <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Translation</p>
              <p className="text-sm text-white/90 leading-relaxed">{caption}</p>
            </div>
          )}
        </div>
      </main>

      {/* Controls */}
      <footer className="p-8 pb-12 flex flex-col items-center gap-8 relative z-10">
        <div className="bg-card/50 backdrop-blur-xl border border-white/10 rounded-3xl p-2 flex items-center gap-4">
          {/* Mute */}
          <Button
            data-testid="button-toggle-mute"
            variant="ghost"
            size="icon"
            onClick={toggleMute}
            className={`w-14 h-14 rounded-2xl transition-all ${
              isMuted
                ? "bg-destructive/20 text-destructive hover:bg-destructive/30"
                : "hover:bg-white/10 text-white"
            }`}
          >
            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </Button>

          {/* Live Translation toggle */}
          <Button
            data-testid="button-toggle-translation"
            variant="ghost"
            size="icon"
            onClick={() => setIsTranslating(!isTranslating)}
            className={`w-14 h-14 rounded-2xl transition-all ${
              isTranslating
                ? "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(59,130,246,0.4)]"
                : "bg-white/5 text-muted-foreground hover:bg-white/10"
            }`}
            title={isTranslating ? "Disable Live Translation" : "Enable Live Translation"}
          >
            <Languages className="w-6 h-6" />
          </Button>

          {/* Speaker */}
          <Button
            data-testid="button-toggle-speaker"
            variant="ghost"
            size="icon"
            onClick={toggleSpeaker}
            className={`w-14 h-14 rounded-2xl transition-all ${
              !isSpeakerOn
                ? "bg-white/10 text-muted-foreground"
                : "hover:bg-white/10 text-white"
            }`}
          >
            {isSpeakerOn ? <Volume2 className="w-6 h-6" /> : <VolumeX className="w-6 h-6" />}
          </Button>
        </div>

        {/* End Call */}
        <Button
          data-testid="button-end-call"
          onClick={endCall}
          className="bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded-full w-16 h-16 shadow-[0_0_20px_rgba(220,38,38,0.3)] hover:shadow-[0_0_30px_rgba(220,38,38,0.5)] transition-all"
        >
          <PhoneOff className="w-7 h-7" />
        </Button>
      </footer>
    </div>
  );
}
