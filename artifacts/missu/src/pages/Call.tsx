import React, { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { Mic, MicOff, Volume2, VolumeX, PhoneOff, Settings2, Activity, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGetAgoraToken } from "@workspace/api-client-react";
import AgoraRTC, { IAgoraRTCClient, IMicrophoneAudioTrack, IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import Waveform from "@/components/Waveform";

type CallStatus = "idle" | "listening" | "translating" | "speaking";

export default function Call() {
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const roomId = searchParams.get("roomId") || "UNKNOWN";
  const myLanguage = searchParams.get("myLanguage") || "english";
  const friendLanguage = searchParams.get("friendLanguage") || "telugu";

  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isTranslating, setIsTranslating] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [isConnected, setIsConnected] = useState(false);

  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const localTrackRef = useRef<IMicrophoneAudioTrack | null>(null);
  const remoteTracksRef = useRef<Record<string, IRemoteAudioTrack>>({});

  const getTokenMutation = useGetAgoraToken();

  useEffect(() => {
    if (!roomId || roomId === "UNKNOWN") {
      setLocation("/join");
      return;
    }

    const initCall = async () => {
      try {
        const uid = Math.floor(Math.random() * 100000);
        
        const response = await getTokenMutation.mutateAsync({
          data: { channelName: roomId, uid }
        });

        const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
        clientRef.current = client;

        client.on("user-published", async (user, mediaType) => {
          await client.subscribe(user, mediaType);
          if (mediaType === "audio" && user.audioTrack) {
            remoteTracksRef.current[user.uid] = user.audioTrack;
            user.audioTrack.play();
          }
        });

        client.on("user-unpublished", (user, mediaType) => {
          if (mediaType === "audio") {
            delete remoteTracksRef.current[user.uid];
          }
        });

        await client.join(response.appId, response.channelName, response.token, response.uid);
        
        const localTrack = await AgoraRTC.createMicrophoneAudioTrack();
        localTrackRef.current = localTrack;
        await client.publish([localTrack]);

        setIsConnected(true);
      } catch (err) {
        console.error("Failed to join call", err);
      }
    };

    initCall();

    return () => {
      if (localTrackRef.current) {
        localTrackRef.current.stop();
        localTrackRef.current.close();
      }
      if (clientRef.current) {
        clientRef.current.leave();
      }
    };
  }, [roomId]);

  const toggleMute = () => {
    if (localTrackRef.current) {
      const newState = !isMuted;
      localTrackRef.current.setMuted(newState);
      setIsMuted(newState);
    }
  };

  const toggleSpeaker = () => {
    const newState = !isSpeakerOn;
    Object.values(remoteTracksRef.current).forEach(track => {
      track.setVolume(newState ? 100 : 0);
    });
    setIsSpeakerOn(newState);
  };

  const endCall = () => {
    setLocation("/join");
  };

  // Mock status changes for visual demonstration
  useEffect(() => {
    if (!isTranslating) {
      setStatus("idle");
      return;
    }

    const interval = setInterval(() => {
      setStatus(prev => {
        if (prev === "idle") return "listening";
        if (prev === "listening") return "translating";
        if (prev === "translating") return "speaking";
        return "idle";
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [isTranslating]);

  const getStatusColor = () => {
    switch (status) {
      case "listening": return "text-primary shadow-primary";
      case "translating": return "text-accent shadow-accent";
      case "speaking": return "text-green-400 shadow-green-400";
      default: return "text-muted-foreground shadow-transparent";
    }
  };

  const getStatusText = () => {
    switch (status) {
      case "listening": return "Listening...";
      case "translating": return "Translating...";
      case "speaking": return "Speaking...";
      default: return "Connected";
    }
  };

  const langNames = {
    english: "English",
    telugu: "Telugu"
  };

  return (
    <div className="min-h-screen w-full flex flex-col bg-background text-foreground relative overflow-hidden">
      {/* Dynamic background glow based on status */}
      <div 
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] h-[80vh] rounded-full blur-[150px] pointer-events-none transition-colors duration-1000 ${
          status === "listening" ? "bg-primary/10" :
          status === "translating" ? "bg-accent/10" :
          status === "speaking" ? "bg-green-500/10" : "bg-transparent"
        }`} 
      />

      <header className="pt-12 px-6 flex flex-col items-center relative z-10">
        <div className="px-4 py-1.5 rounded-full bg-white/5 border border-white/10 text-sm font-mono tracking-widest text-muted-foreground mb-4">
          ROOM: {roomId}
        </div>
        <div className="flex items-center gap-3 text-lg font-medium text-white/90">
          <span className="capitalize">{langNames[myLanguage as keyof typeof langNames]}</span>
          <ArrowRight className="w-4 h-4 text-primary" />
          <span className="capitalize">{langNames[friendLanguage as keyof typeof langNames]}</span>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center relative z-10">
        <div className="relative w-64 h-64 flex items-center justify-center">
          {/* Avatar/Status Circle */}
          <div className={`absolute inset-0 rounded-full border-2 transition-colors duration-500 ${
            status !== "idle" ? `border-${status === "translating" ? "accent" : status === "speaking" ? "green-400" : "primary"}/50 animate-pulse-glow` : "border-white/10"
          }`} />
          
          <div className="w-48 h-48 bg-secondary rounded-full flex items-center justify-center border border-white/5 shadow-2xl overflow-hidden relative">
            {!isConnected ? (
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

        <div className="mt-12 text-center h-8">
          <p className={`text-lg font-medium transition-colors duration-300 ${getStatusColor()}`}>
            {getStatusText()}
          </p>
        </div>
      </main>

      <footer className="p-8 pb-12 flex flex-col items-center gap-8 relative z-10">
        <div className="bg-card/50 backdrop-blur-xl border border-white/10 rounded-3xl p-2 flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleMute}
            className={`w-14 h-14 rounded-2xl transition-all ${isMuted ? 'bg-destructive/20 text-destructive hover:bg-destructive/30' : 'hover:bg-white/10 text-white'}`}
          >
            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsTranslating(!isTranslating)}
            className={`w-14 h-14 rounded-2xl transition-all ${isTranslating ? 'bg-primary text-primary-foreground shadow-[0_0_15px_rgba(59,130,246,0.4)]' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
          >
            <Settings2 className="w-6 h-6" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSpeaker}
            className={`w-14 h-14 rounded-2xl transition-all ${!isSpeakerOn ? 'bg-white/10 text-muted-foreground' : 'hover:bg-white/10 text-white'}`}
          >
            {isSpeakerOn ? <Volume2 className="w-6 h-6" /> : <VolumeX className="w-6 h-6" />}
          </Button>
        </div>

        <Button
          onClick={endCall}
          className="bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded-full w-16 h-16 shadow-[0_0_20px_rgba(220,38,38,0.3)] hover:shadow-[0_0_30px_rgba(220,38,38,0.5)] transition-all"
        >
          <PhoneOff className="w-7 h-7" />
        </Button>
      </footer>
    </div>
  );
}
