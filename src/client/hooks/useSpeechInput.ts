// hooks/useSpeechInput.ts — WP6 (DESIGN §11.3): unified mic hook (browser | server | none). Stub created by WP1.
export type SpeechMode = "browser" | "server" | "none";
export type SpeechState = "idle" | "listening" | "transcribing" | "error";
export interface SpeechInput {
  mode: SpeechMode;
  state: SpeechState;
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
}
export function useSpeechInput(_opts: { onText: (text: string) => void }): SpeechInput {
  throw new Error("not implemented: useSpeechInput");
}
