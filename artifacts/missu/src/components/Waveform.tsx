import React from "react";

interface WaveformProps {
  active: boolean;
  color?: "primary" | "accent" | "green";
}

export default function Waveform({ active, color = "primary" }: WaveformProps) {
  const bars = Array.from({ length: 11 });
  
  const getColorClass = () => {
    switch(color) {
      case "accent": return "bg-accent";
      case "green": return "bg-green-400";
      default: return "bg-primary";
    }
  };

  return (
    <div className="flex items-center justify-center gap-1 h-20">
      {bars.map((_, i) => (
        <div
          key={i}
          className={`w-1.5 rounded-full ${getColorClass()} ${active ? 'animate-[waveform_1.2s_ease-in-out_infinite]' : 'h-1.5'}`}
          style={{
            animationDelay: `${i * 0.1}s`,
            height: active ? '100%' : '6px',
            opacity: Math.max(0.3, 1 - Math.abs(i - 5) * 0.15)
          }}
        />
      ))}
    </div>
  );
}
