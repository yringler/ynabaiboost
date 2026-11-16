// hooks/useRecorder.ts — WP6 (DESIGN §11.3): MediaRecorder wrapper for server STT.
// Mono, echo-cancelled audio at 32 kbps; auto-stops at 60 s; recordings shorter than 0.7 s are dropped.
import { useCallback, useEffect, useRef, useState } from "react";

export interface Recorder {
  recording: boolean;
  start(): Promise<void>;
  stop(): Promise<Blob | null>;
}

export interface RecorderOptions {
  /** Auto-stop after this many ms (default 60 s). */
  maxMs?: number;
  /** Recordings shorter than this are discarded (default 700 ms). */
  minMs?: number;
  /** Called with the blob (or null when too short) when the recording stopped by itself at maxMs. */
  onAutoStop?: (blob: Blob | null) => void;
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];

/** WebKit (Safari, every iOS browser) records MP4/AAC most reliably. */
export function isWebKit(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /AppleWebKit/.test(ua) && (!/Chrome|Chromium|Android|Edg\//.test(ua) || /CriOS|FxiOS|EdgiOS/.test(ua));
}

/** First supported MIME type, MP4 first on WebKit; "" means "let the browser choose". */
export function pickMimeType(
  isSupported: (t: string) => boolean = (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
  webkit: boolean = isWebKit(),
): string {
  const order = webkit ? [...MIME_CANDIDATES.filter((m) => m.startsWith("audio/mp4")), ...MIME_CANDIDATES.filter((m) => !m.startsWith("audio/mp4"))] : MIME_CANDIDATES;
  return order.find((t) => isSupported(t)) ?? "";
}

export function useRecorder(opts: RecorderOptions = {}): Recorder {
  const { maxMs = 60_000, minMs = 700 } = opts;
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWaitersRef = useRef<((b: Blob | null) => void)[]>([]);
  const onAutoStopRef = useRef(opts.onAutoStop);
  onAutoStopRef.current = opts.onAutoStop;
  const autoStoppedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    if (recRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    chunksRef.current = [];
    autoStoppedRef.current = false;
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const duration = Date.now() - startedAtRef.current;
      const type = rec.mimeType || mimeType || "audio/webm";
      const blob = duration < minMs || chunksRef.current.length === 0 ? null : new Blob(chunksRef.current, { type: type.split(";")[0] ?? type });
      chunksRef.current = [];
      cleanup();
      const waiters = stopWaitersRef.current;
      stopWaitersRef.current = [];
      waiters.forEach((w) => w(blob));
      if (autoStoppedRef.current) onAutoStopRef.current?.(blob);
    };
    streamRef.current = stream;
    recRef.current = rec;
    startedAtRef.current = Date.now();
    rec.start(); // no timeslice: one chunk at stop
    setRecording(true);
    timerRef.current = setTimeout(() => {
      if (recRef.current?.state === "recording") {
        autoStoppedRef.current = true;
        recRef.current.stop();
      }
    }, maxMs);
  }, [cleanup, maxMs, minMs]);

  const stop = useCallback((): Promise<Blob | null> => {
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    return new Promise<Blob | null>((resolve) => {
      stopWaitersRef.current.push(resolve);
      rec.stop();
    });
  }, []);

  useEffect(
    () => () => {
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") {
        rec.onstop = null;
        rec.stop();
      }
      cleanup();
    },
    [cleanup],
  );

  return { recording, start, stop };
}
