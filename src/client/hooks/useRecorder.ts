// hooks/useRecorder.ts — WP6 (DESIGN §11.3): MediaRecorder wrapper. Stub created by WP1.
export interface Recorder {
  recording: boolean;
  start(): Promise<void>;
  stop(): Promise<Blob | null>;
}
export function useRecorder(): Recorder {
  throw new Error("not implemented: useRecorder");
}
