import React, { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRight, Lock, Headphones } from "lucide-react";

const LANGUAGES = [
  { value: "english", label: "English" },
  { value: "telugu",  label: "Telugu" },
  { value: "hindi",   label: "Hindi" },
  { value: "spanish", label: "Spanish" },
  { value: "tamil",   label: "Tamil" },
  { value: "french",  label: "French" },
  { value: "german",  label: "German" },
];

export default function Join() {
  const [, setLocation] = useLocation();
  const [roomId, setRoomId] = useState("");
  const [receiveLanguage, setReceiveLanguage] = useState("english");

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId.trim()) return;
    const params = new URLSearchParams({
      roomId: roomId.trim().toUpperCase(),
      receiveLanguage,
    });
    setLocation(`/call?${params.toString()}`);
  };

  const generateRandomRoom = () => {
    setRoomId(Math.random().toString(36).substring(2, 8).toUpperCase());
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="max-w-md w-full relative z-10">
        <div className="bg-card/50 backdrop-blur-xl border border-white/10 rounded-3xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Join a Room</h1>
            <p className="text-muted-foreground">Choose the language you want to hear.</p>
          </div>

          <form onSubmit={handleJoin} className="space-y-6">
            {/* Room ID */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <Label htmlFor="roomId" className="text-white/80">Room ID</Label>
                <button
                  type="button"
                  onClick={generateRandomRoom}
                  className="text-xs text-primary hover:text-primary/80 transition-colors"
                >
                  Generate Random
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                <Input
                  id="roomId"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  placeholder="Enter secret room code"
                  className="pl-10 h-14 bg-black/20 border-white/10 text-lg uppercase focus-visible:ring-primary focus-visible:border-primary placeholder:text-muted-foreground/50 placeholder:normal-case"
                  required
                />
              </div>
            </div>

            {/* Receive language */}
            <div className="space-y-2">
              <Label className="text-white/80 flex items-center gap-2">
                <Headphones className="w-4 h-4 text-primary" />
                Receive audio in
              </Label>
              <Select value={receiveLanguage} onValueChange={setReceiveLanguage}>
                <SelectTrigger className="h-14 bg-black/20 border-white/10 text-white text-base">
                  <SelectValue placeholder="Choose your language" />
                </SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white">
                  {LANGUAGES.map((lang) => (
                    <SelectItem key={lang.value} value={lang.value}>
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground pl-1">
                Everyone else's speech will be translated and played back to you in this language.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full h-14 text-lg rounded-xl bg-primary hover:bg-primary/90 text-white flex items-center justify-center gap-2 group mt-4 shadow-[0_0_15px_rgba(59,130,246,0.2)]"
              disabled={!roomId.trim()}
            >
              Enter Room
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
