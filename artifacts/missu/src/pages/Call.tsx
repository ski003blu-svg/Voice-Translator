import { useEffect, useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Mic, MicOff, Volume2, VolumeX, PhoneOff, Languages, Activity, ArrowRight, UserCircle, Check, Loader2, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGetAgoraToken } from "@workspace/api-client-react";
import AgoraRTC, { IAgoraRTCClient, IMicrophoneAudioTrack, IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import Waveform from "@/components/Waveform";

type CallStatus = "idle" | "listening" | "translating" | "speaking";
type VoiceCloneState = "idle" | "recording" | "uploading" | "ready" | "error";

const VOICE_ID_KEY = "missu_voice_id";
const MAX_RECORD_SECONDS = 30;

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
  const [caption, setCaption] = useState<string>("");

  // Voice cloning state
  const [voiceCloneState, setVoiceCloneState] = useState<VoiceCloneState>(() => {
    return localStorage.getItem(VOICE_ID_KEY) ? "ready" : "idle";
  });
  const [voiceId, setVoiceId] = useState<string | null>(() => {
    return localStorage.getItem(VOICE_ID_KEY);
  });
  const [recordSeconds, setRecordSeconds] = useState(0);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Agora refs
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const localTrackRef = useRef<IMicrophoneAudioTrack | null>(null);
  const remoteTracksRef = useRef<Record<string, IRemoteAudioTrack>>({});

  // Translation WebSocket refs
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const isTTSActiveRef = useRef(false);
  const pendingSpeechRef = useRef<{ text: string; lang: string } | null>(null);
  const speakTextRef = useRef<(text: string, lang: string) => void>(() => {});
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTranslatingRef = useRef(false);

  // Ref to mirror voiceId so WS callbacks always read latest value
  const voiceIdRef = useRef<string | null>(voiceId);
  useEffect(() => { voiceIdRef.current = voiceId; }, [voiceId]);

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

        let response;
        try {
          response = await getTokenMutation.mutateAsync({
            data: { channelName: roomId, uid },
          });
        } catch (err) {
          throw new Error(`Token fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        const client = AgoraRTC.createClient({ mode: "rtc", codec: "h264" });
        clientRef.current = client;

        client.on("user-published", async (user, mediaType) => {
          await client.subscribe(user, mediaType);
          if (mediaType === "audio" && user.audioTrack) {
            remoteTracksRef.current[String(user.uid)] = user.audioTrack;
            user.audioTrack.play();
            if (isTranslatingRef.current) {
              user.audioTrack.setVolume(0);
            }
          }
        });

        client.on("user-unpublished", (user, mediaType) => {
          if (mediaType === "audio") {
            delete remoteTracksRef.current[String(user.uid)];
          }
        });

        try {
          await client.join(response.appId, response.channelName, response.token, response.uid);
        } catch (err) {
          throw new Error(`Channel join failed: ${err instanceof Error ? err.message : String(err)}`);
        }

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

  // --- Play incoming base64 audio (from server ElevenLabs TTS) ---
  const playAudioData = useCallback((base64: string, text: string, mimeType = "audio/mpeg") => {
    if (isTTSActiveRef.current) return;

    isTTSActiveRef.current = true;
    setStatus("speaking");
    setCaption(text);

    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType });
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        isTTSActiveRef.current = false;
        setStatus("listening");
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        isTTSActiveRef.current = false;
        setStatus("listening");
      };
      audio.play().catch(() => {
        isTTSActiveRef.current = false;
        setStatus("listening");
      });
    } catch {
      isTTSActiveRef.current = false;
      setStatus("listening");
    }
  }, []);

  // --- Speak translated text via browser Web Speech API (fallback, no cloned voice) ---
  const speakText = useCallback((text: string, lang: string) => {
    if (!window.speechSynthesis) return;

    if (isTTSActiveRef.current) {
      pendingSpeechRef.current = { text, lang };
      return;
    }

    const langCode: Record<string, string> = {
      english: "en-US",
      telugu:  "te-IN",
    };

    isTTSActiveRef.current = true;
    setStatus("speaking");
    setCaption(text);

    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);

    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();

    const utter = new SpeechSynthesisUtterance(text);
    const targetLang = langCode[lang] ?? "en-US";
    utter.rate = 0.92;

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      const langPrefix = targetLang.split("-")[0];
      const exactMatch  = voices.find((v) => v.lang === targetLang);
      const prefixMatch = voices.find((v) => v.lang.startsWith(langPrefix));
      const bestMatch   = exactMatch ?? prefixMatch;
      if (bestMatch) {
        utter.voice = bestMatch;
        utter.lang  = bestMatch.lang;
      }
    } else {
      utter.lang = targetLang;
    }

    const releaseLock = () => {
      if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
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

    const estimatedMs = Math.max(5000, text.length * 100 + 3000);
    safetyTimerRef.current = setTimeout(() => {
      safetyTimerRef.current = null;
      releaseLock();
    }, estimatedMs);

    window.speechSynthesis.speak(utter);
  }, []);

  useEffect(() => {
    speakTextRef.current = speakText;
  }, [speakText]);

  // --- Translation WebSocket management ---
  const startTranslation = useCallback(async () => {
    if (wsRef.current) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/translate`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "start",
        roomId,
        myLanguage,
        friendLanguage,
        voiceId: voiceIdRef.current ?? undefined,
      }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "status") {
            setStatus(msg.status as CallStatus);
          } else if (msg.type === "audio_data") {
            playAudioData(msg.data as string, msg.text as string, msg.mimeType as string);
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let isSpeaking = false;
      let silenceFrames = 0;
      const SPEECH_THRESHOLD = 25;
      const SILENCE_END_FRAMES = 30;

      const checkVAD = () => {
        if (!wsRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (isTTSActiveRef.current) {
          if (isSpeaking && recorder.state === "recording") {
            isSpeaking = false;
            recorder.stop();
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

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN && !isTTSActiveRef.current) {
          e.data.arrayBuffer().then((buf) => wsRef.current?.send(buf));
        }
      };

      checkVAD();
    } catch (err) {
      console.error("Mic access failed", err);
    }
  }, [roomId, myLanguage, friendLanguage, speakText, playAudioData]);

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

  useEffect(() => {
    isTranslatingRef.current = isTranslating;
  }, [isTranslating]);

  useEffect(() => {
    if (localTrackRef.current) {
      localTrackRef.current.setMuted(isTranslating || isMuted);
    }
    Object.values(remoteTracksRef.current).forEach((track) => {
      track.setVolume(isTranslating ? 0 : (isSpeakerOn ? 100 : 0));
    });
  }, [isTranslating, isMuted, isSpeakerOn]);

  useEffect(() => {
    return () => stopTranslation();
  }, [stopTranslation]);

  // --- Voice cloning ---
  const stopVoiceRecording = useCallback(() => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
    if (autoStopTimerRef.current) { clearTimeout(autoStopTimerRef.current); autoStopTimerRef.current = null; }
    voiceRecorderRef.current?.stop();
  }, []);

  const startVoiceRecording = useCallback(async () => {
    if (voiceCloneState === "recording") {
      stopVoiceRecording();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      voiceRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) voiceChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
        if (autoStopTimerRef.current) { clearTimeout(autoStopTimerRef.current); autoStopTimerRef.current = null; }
        setRecordSeconds(0);

        const audioBlob = new Blob(voiceChunksRef.current, { type: mimeType });
        if (audioBlob.size < 5000) {
          setVoiceCloneState("error");
          setTimeout(() => setVoiceCloneState("idle"), 3000);
          return;
        }

        setVoiceCloneState("uploading");

        try {
          const resp = await fetch("/api/voices/clone", {
            method: "POST",
            headers: { "Content-Type": mimeType },
            body: audioBlob,
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: "Unknown error" }));
            throw new Error((err as { error: string }).error);
          }

          const { voiceId: newId } = await resp.json() as { voiceId: string };
          localStorage.setItem(VOICE_ID_KEY, newId);
          setVoiceId(newId);
          setVoiceCloneState("ready");
        } catch (err) {
          console.error("Voice cloning failed:", err);
          setVoiceCloneState("error");
          setTimeout(() => setVoiceCloneState("idle"), 3000);
        }
      };

      recorder.start(200);
      setVoiceCloneState("recording");
      setRecordSeconds(0);

      recordTimerRef.current = setInterval(() => {
        setRecordSeconds((s) => s + 1);
      }, 1000);

      autoStopTimerRef.current = setTimeout(() => {
        stopVoiceRecording();
      }, MAX_RECORD_SECONDS * 1000);
    } catch (err) {
      console.error("Mic access failed for voice clone:", err);
      setVoiceCloneState("error");
      setTimeout(() => setVoiceCloneState("idle"), 3000);
    }
  }, [voiceCloneState, stopVoiceRecording]);

  const clearVoice = () => {
    localStorage.removeItem(VOICE_ID_KEY);
    setVoiceId(null);
    setVoiceCloneState("idle");
  };

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

          {caption && isTranslating && (
            <div className="max-w-xs w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
              <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Translation</p>
              <p className="text-sm text-white/90 leading-relaxed">{caption}</p>
            </div>
          )}

          {/* Voice Clone Panel */}
          <div className="max-w-xs w-full">
            {voiceCloneState === "idle" && (
              <button
                onClick={startVoiceRecording}
                className="flex items-center gap-2 mx-auto px-4 py-2 rounded-full bg-white/5 border border-white/10 text-sm text-muted-foreground hover:bg-white/10 hover:text-white transition-all"
              >
                <UserCircle className="w-4 h-4" />
                Clone your voice for translation
              </button>
            )}

            {voiceCloneState === "recording" && (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-white/60">
                  Speak naturally — {MAX_RECORD_SECONDS - recordSeconds}s remaining
                </p>
                <button
                  onClick={stopVoiceRecording}
                  className="flex items-center gap-2 px-4 py-2 rounded-full bg-red-500/20 border border-red-500/40 text-sm text-red-400 hover:bg-red-500/30 transition-all animate-pulse"
                >
                  <StopCircle className="w-4 h-4" />
                  Stop recording ({recordSeconds}s)
                </button>
              </div>
            )}

            {voiceCloneState === "uploading" && (
              <div className="flex items-center gap-2 mx-auto w-fit px-4 py-2 rounded-full bg-white/5 border border-white/10 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Cloning your voice...
              </div>
            )}

            {voiceCloneState === "ready" && (
              <div className="flex items-center justify-center gap-3">
                <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/30 text-sm text-green-400">
                  <Check className="w-4 h-4" />
                  Your voice is active
                </div>
                <button
                  onClick={clearVoice}
                  className="text-xs text-white/30 hover:text-white/60 transition-colors underline underline-offset-2"
                >
                  Reset
                </button>
              </div>
            )}

            {voiceCloneState === "error" && (
              <p className="text-xs text-destructive text-center">
                Voice cloning failed. Please try again.
              </p>
            )}
          </div>
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
            onClick={() => {
              if (!isTranslating && window.speechSynthesis) {
                const primer = new SpeechSynthesisUtterance(" ");
                primer.volume = 0;
                window.speechSynthesis.speak(primer);
              }
              setIsTranslating(!isTranslating);
            }}
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
