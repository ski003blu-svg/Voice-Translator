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
  const speakText = useCallback((text: string, lang: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // stop any in-progress speech

    const langCode: Record<string, string> = {
      english: "en-US",
      telugu:  "te-IN",
    };

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = langCode[lang] ?? "en-US";
    utter.rate = 0.95;
    utter.onstart  = () => setStatus("speaking");
    utter.onend    = () => setStatus("listening");
    utter.onerror  = () => setStatus("listening");
    utteranceRef.current = utter;
    window.speechSynthesis.speak(utter);
  }, []);

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
      // Only sends audio to the server when the mic volume crosses the speech
      // threshold, so we don't burn Gemini quota on silence.
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let isSpeaking = false;
      let silenceFrames = 0;
      const SPEECH_THRESHOLD = 18;   // RMS level (0-255) to treat as active speech
      const SILENCE_END_FRAMES = 25; // ~800ms of quiet after speech before we close the segment

      const checkVAD = () => {
        if (!wsRef.current) return; // stop loop when WS closes
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (avg > SPEECH_THRESHOLD) {
          silenceFrames = 0;
          if (!isSpeaking && recorder.state === "inactive") {
            // Start capturing this utterance
            isSpeaking = true;
            setStatus("listening");
            recorder.start();
          }
        } else {
          silenceFrames++;
          if (isSpeaking && silenceFrames > SILENCE_END_FRAMES) {
            // Speech ended — stop recording; ondataavailable fires with the full clip
            isSpeaking = false;
            if (recorder.state === "recording") recorder.stop();
          }
        }
        requestAnimationFrame(checkVAD);
      };

      // When a speech segment finishes, send the full clip to the server
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          e.data.arrayBuffer().then((buf) => wsRef.current?.send(buf));
        }
        // Recorder is now "inactive" — VAD will call recorder.start() again on next utterance
      };

      checkVAD(); // start the detection loop
    } catch (err) {
      console.error("Mic access failed", err);
    }
  }, [roomId, myLanguage, friendLanguage, speakText]);

  const stopTranslation = useCallback(() => {
    window.speechSynthesis?.cancel();
    utteranceRef.current = null;
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
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

        <div className="mt-12 text-center px-6">
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
