import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSpeechMode, useSpeechInput, type SpeechRecognitionEventLike, type SpeechRecognitionLike,
} from "../../src/client/hooks/useSpeechInput";
import { pickMimeType } from "../../src/client/hooks/useRecorder";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

class FakeSR implements SpeechRecognitionLike {
  static instances: FakeSR[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  starts = 0;
  stopped = false;
  constructor() {
    FakeSR.instances.push(this);
  }
  start() { this.starts++; }
  stop() { this.stopped = true; this.onend?.(); }
  abort() { this.stopped = true; }
  emit(results: { t: string; final: boolean }[], resultIndex = 0) {
    const list = results.map((r) => Object.assign([{ transcript: r.t }], { isFinal: r.final }));
    this.onresult?.({ resultIndex, results: list as unknown as SpeechRecognitionEventLike["results"] });
  }
}

const last = () => FakeSR.instances[FakeSR.instances.length - 1]!;

beforeEach(() => {
  FakeSR.instances = [];
  (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeSR;
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe("resolveSpeechMode", () => {
  it("prefers server only when allowed and MediaRecorder exists", () => {
    expect(resolveSpeechMode({ preferServer: true, hasMediaRecorder: true, hasSpeechRecognition: true })).toBe("server");
    expect(resolveSpeechMode({ preferServer: true, hasMediaRecorder: false, hasSpeechRecognition: true })).toBe("browser");
    expect(resolveSpeechMode({ preferServer: false, hasMediaRecorder: true, hasSpeechRecognition: false })).toBe("none");
  });
});

describe("pickMimeType", () => {
  const all = () => true;
  it("prefers webm/opus, and mp4 on WebKit", () => {
    expect(pickMimeType(all, false)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType(all, true)).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickMimeType((t) => t === "audio/ogg;codecs=opus", false)).toBe("audio/ogg;codecs=opus");
    expect(pickMimeType(() => false, false)).toBe("");
  });
});

describe("useSpeechInput (browser mode)", () => {
  it("is 'none' without SpeechRecognition", () => {
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    const { result } = renderHook(() => useSpeechInput({ onText: vi.fn() }));
    expect(result.current.mode).toBe("none");
  });

  it("streams interim text, commits finals, restarts on end until stopped", () => {
    const onText = vi.fn();
    const { result } = renderHook(() => useSpeechInput({ onText }));
    expect(result.current.mode).toBe("browser");

    act(() => result.current.start());
    expect(result.current.state).toBe("listening");
    const rec = last();
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);

    act(() => rec.emit([{ t: "about 200 at", final: false }]));
    expect(result.current.interim).toBe("about 200 at");

    act(() => rec.emit([{ t: "about 200 at Costco", final: true }]));
    expect(onText).toHaveBeenCalledWith("about 200 at Costco", "browser_stt");
    expect(result.current.interim).toBe("");

    // Chrome Android ends sessions on its own: the hook restarts while the user hasn't stopped.
    act(() => rec.onend?.());
    expect(rec.starts).toBe(2);
    expect(result.current.state).toBe("listening");

    act(() => result.current.stop());
    expect(rec.stopped).toBe(true);
    expect(result.current.state).toBe("idle");
    expect(rec.starts).toBe(2);
  });

  it("ignores no-speech and disables voice on not-allowed", () => {
    const { result } = renderHook(() => useSpeechInput({ onText: vi.fn() }));
    act(() => result.current.start());
    act(() => last().onerror?.({ error: "no-speech" }));
    expect(result.current.state).toBe("listening");
    act(() => last().onerror?.({ error: "not-allowed" }));
    expect(result.current.mode).toBe("none");
    expect(result.current.state).toBe("idle");
  });

  it("network errors stop listening without disabling voice", () => {
    const { result } = renderHook(() => useSpeechInput({ onText: vi.fn() }));
    act(() => result.current.start());
    act(() => last().onerror?.({ error: "network" }));
    act(() => last().onend?.());
    expect(result.current.state).toBe("idle");
    expect(result.current.mode).toBe("browser");
  });
});
