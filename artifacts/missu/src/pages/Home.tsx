import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Globe, Mic, Headphones } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen w-full flex flex-col relative overflow-hidden bg-background text-foreground">
      {/* Decorative background elements */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />

      <main className="flex-1 flex flex-col items-center justify-center px-6 relative z-10">
        <div className="max-w-2xl w-full text-center space-y-10">
          <div className="flex justify-center mb-8">
            <div className="relative">
              <div className="absolute inset-0 bg-primary/30 blur-2xl rounded-full" />
              <div className="w-24 h-24 rounded-3xl bg-secondary flex items-center justify-center border border-white/10 shadow-2xl relative z-10 overflow-hidden group">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                <Mic className="w-10 h-10 text-primary" />
              </div>
            </div>
          </div>
          
          <div className="space-y-4">
            <h1 className="text-5xl md:text-7xl font-bold tracking-tight text-white drop-shadow-sm">
              MissU
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground font-medium">
              Talk in your language. <span className="text-primary/90">Hear in theirs.</span>
            </p>
          </div>

          <div className="text-muted-foreground max-w-lg mx-auto leading-relaxed">
            A real-time voice bridge connecting you with the people you love. Experience seamless English and Telugu conversations, translated live as you speak.
          </div>

          <div className="pt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/join" className="w-full sm:w-auto">
              <Button size="lg" className="w-full sm:w-auto rounded-full px-8 h-14 text-lg bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_20px_rgba(59,130,246,0.3)] transition-all hover:shadow-[0_0_30px_rgba(59,130,246,0.5)]">
                Start a Conversation
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-32 grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl w-full">
          <div className="flex flex-col items-center text-center space-y-3 p-6 rounded-2xl bg-white/5 border border-white/5 backdrop-blur-sm">
            <Globe className="w-8 h-8 text-primary" />
            <h3 className="font-semibold text-lg text-white">Cross-Cultural</h3>
            <p className="text-sm text-muted-foreground">Break language barriers effortlessly between English and Telugu.</p>
          </div>
          <div className="flex flex-col items-center text-center space-y-3 p-6 rounded-2xl bg-white/5 border border-white/5 backdrop-blur-sm">
            <Mic className="w-8 h-8 text-accent" />
            <h3 className="font-semibold text-lg text-white">Real-Time</h3>
            <p className="text-sm text-muted-foreground">Speak naturally. Our engine translates continuously as you talk.</p>
          </div>
          <div className="flex flex-col items-center text-center space-y-3 p-6 rounded-2xl bg-white/5 border border-white/5 backdrop-blur-sm">
            <Headphones className="w-8 h-8 text-primary" />
            <h3 className="font-semibold text-lg text-white">Intimate</h3>
            <p className="text-sm text-muted-foreground">Designed for late-night calls and meaningful connections.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
