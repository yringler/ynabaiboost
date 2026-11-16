// hooks/useSpeechInput.ts — WP6 (DESIGN §11.3): unified mic hook (browser | server | none).
//   server : me.sttAllowed && settings.voiceMode === "server" && MediaRecorder exists → record, POST /api/stt
//   browser: Web Speech API (SpeechRecognition / webkitSpeechRecognition), tap to start, tap to stop
//   none   : no mic button (keyboard dictation still works in the textarea)
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage, isApiError, postAudio } from "../lib/api";
import { useRecorder } from "./useRecorder";

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

export interface SpeechInputOptions {
  /** Called with every finalized piece of text (append it to the textarea). */
  onText: (text: string, source: "browser_stt" | "server_stt") => void;
  /** me.sttAllowed && settings.voiceMode === "server". */
  preferServer?: boolean;
}

// Minimal Web Speech API typings (not in lib.dom).
interface SpeechAlternative { transcript: string }
interface SpeechResult { readonly isFinal: boolean; readonly length: number; [i: number]: SpeechAlternative | undefined }
interface SpeechResultList { readonly length: number; [i: number]: SpeechResult | undefined }
export interface SpeechRecognitionEventLike { resultIndex: number; results: SpeechResultList }
export interface SpeechRecognitionErrorLike { error: string }
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function resolveSpeechMode(opts: { preferServer: boolean; hasMediaRecorder: boolean; hasSpeechRecognition: boolean }): SpeechMode {
  if (opts.preferServer && opts.hasMediaRecorder) return "server";
  return opts.hasSpeechRecognition ? "browser" : "none";
}

export function useSpeechInput(opts: SpeechInputOptions): SpeechInput {
  const onTextRef = useRef(opts.onText);
  onTextRef.current = opts.onText;

  // Session-level downgrades: "not-allowed" disables the mic; 403 stt_not_allowed falls back to the browser.
  const [disabled, setDisabled] = useState(false);
  const [serverRefused, setServerRefused] = useState(false);
  const [state, setState] = useState<SpeechState>("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hasSR = getSpeechRecognition() !== null;
  const hasMR = typeof window !== "undefined" && "MediaRecorder" in window && !!navigator.mediaDevices?.getUserMedia;
  const mode: SpeechMode = disabled
    ? "none"
    : resolveSpeechMode({ preferServer: !!opts.preferServer && !serverRefused, hasMediaRecorder: hasMR, hasSpeechRecognition: hasSR });

  // ── server mode ───────────────────────────────────────────────────────
  const transcribe = useCallback(async (blob: Blob | null) => {
    if (!blob) {
      setState("idle");
      toast("Too short. Hold on a little longer.");
      return;
    }
    setState("transcribing");
    try {
      const { text } = await postAudio(blob);
      const t = text.trim();
      if (t) onTextRef.current(t, "server_stt");
      setState("idle");
    } catch (e) {
      if (isApiError(e) && e.code === "stt_not_allowed") {
        setServerRefused(true);
        setState("idle");
        toast("Server voice is off for your account. Using the browser instead.");
        return;
      }
      const msg = errorMessage(e);
      setError(msg);
      setState("error");
      toast.error(msg);
    }
  }, []);
  const recorder = useRecorder({ onAutoStop: (b) => void transcribe(b) });

  // ── browser mode ──────────────────────────────────────────────────────
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const userStoppedRef = useRef(true);

  const stopBrowser = useCallback(() => {
    userStoppedRef.current = true;
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      try { rec.stop(); } catch { /* already stopped */ }
    }
    setInterim("");
    setState((s) => (s === "listening" ? "idle" : s));
  }, []);

  const startBrowser = useCallback(() => {
    const SR = getSpeechRecognition();
    if (!SR) return;
    const rec = new SR();
    rec.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r?.[0]?.transcript ?? "";
        if (!r || !t) continue;
        if (r.isFinal) {
          const final = t.trim();
          if (final) onTextRef.current(final, "browser_stt");
        } else {
          pending += t;
        }
      }
      setInterim(pending.trim());
    };
    rec.onerror = (e) => {
      switch (e.error) {
        case "no-speech":
        case "aborted":
          return;
        case "not-allowed":
        case "service-not-allowed":
          userStoppedRef.current = true;
          setDisabled(true);
          setState("idle");
          toast.error("Microphone access was blocked. Use keyboard dictation instead.");
          return;
        case "network":
          userStoppedRef.current = true;
          setState("idle");
          toast.error("Voice unavailable, use keyboard dictation");
          return;
        default:
          userStoppedRef.current = true;
          setError(e.error);
          setState("error");
      }
    };
    rec.onend = () => {
      // Chrome Android ignores `continuous`: keep listening until the user taps stop.
      if (!userStoppedRef.current && recRef.current === rec) {
        try {
          rec.start();
          return;
        } catch {
          // fall through to idle
        }
      }
      if (recRef.current === rec) recRef.current = null;
      setInterim("");
      setState((s) => (s === "listening" ? "idle" : s));
    };
    userStoppedRef.current = false;
    recRef.current = rec;
    setError(null);
    setInterim("");
    try {
      rec.start();
      setState("listening");
    } catch (err) {
      recRef.current = null;
      userStoppedRef.current = true;
      setError(err instanceof Error ? err.message : "Could not start voice input");
      setState("error");
    }
  }, []);

  // ── public API ────────────────────────────────────────────────────────
  const start = useCallback(() => {
    if (state === "listening" || state === "transcribing") return;
    setError(null);
    if (mode === "browser") startBrowser();
    else if (mode === "server") {
      setState("listening");
      recorder.start().catch((e: unknown) => {
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        const msg = denied ? "Microphone access was blocked" : "Could not start recording";
        setError(msg);
        setState("error");
        toast.error(msg);
      });
    }
  }, [mode, recorder, startBrowser, state]);

  const stop = useCallback(() => {
    if (mode === "browser" || recRef.current) stopBrowser();
    if (recorder.recording) {
      setState("transcribing");
      void recorder.stop().then(transcribe);
    }
  }, [mode, recorder, stopBrowser, transcribe]);

  useEffect(
    () => () => {
      userStoppedRef.current = true;
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        rec.onend = null;
        try { rec.abort(); } catch { /* ignore */ }
      }
    },
    [],
  );

  return { mode, state, interim, error, start, stop };
}
