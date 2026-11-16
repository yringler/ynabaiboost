// components/MicButton.tsx — WP6 (DESIGN §11.1): idle / listening (pulsing) / transcribing / error. Hidden in mode "none".
import { Loader2Icon, MicIcon, MicOffIcon, SquareIcon } from "lucide-react";
import type { SpeechInput } from "../hooks/useSpeechInput";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export function MicButton({ speech, className }: { speech: SpeechInput; className?: string }) {
  if (speech.mode === "none") return null;
  const { state } = speech;
  const listening = state === "listening";
  const busy = state === "transcribing";
  const label = listening ? "Stop listening" : busy ? "Transcribing" : state === "error" ? "Voice error, tap to retry" : "Speak";
  return (
    <Button
      type="button"
      size="icon-lg"
      variant={listening ? "default" : "outline"}
      className={cn("size-12 rounded-full", listening && "mic-pulse", state === "error" && "border-destructive text-destructive", className)}
      onClick={() => (listening ? speech.stop() : speech.start())}
      disabled={busy}
      aria-label={label}
      aria-pressed={listening}
      title={speech.error ?? label}
      data-state={state}
    >
      {busy ? (
        <Loader2Icon className="size-5 animate-spin" />
      ) : listening ? (
        <SquareIcon className="size-4 fill-current" />
      ) : state === "error" ? (
        <MicOffIcon className="size-5" />
      ) : (
        <MicIcon className="size-5" />
      )}
    </Button>
  );
}
