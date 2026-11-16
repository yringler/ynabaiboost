// ai/stt.ts — WP4 (DESIGN §8.4, §11.3, D10). Server STT through the Workers AI binding.
// STT_MODEL=whisper (default): @cf/openai/whisper-large-v3-turbo with raw base64 audio and a vocabulary prompt.
// STT_MODEL=nova3: @cf/deepgram/nova-3. Its binding types `audio.body` as an object; Cloudflare's examples pass a
// ReadableStream, so the bytes go in as a stream (spike S6 confirms the encoding on real devices).
import { AppError } from "../lib/errors";

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const NOVA3_MODEL = "@cf/deepgram/nova-3";
/** Payee / category names used in the whisper vocabulary prompt (each). */
export const STT_HINTS = 30;
const CAPACITY_ERROR = /\b3040\b/;

/** Standard base64 (no `data:` prefix), encoded in chunks so large buffers don't blow the call stack. */
export function toBase64(audio: ArrayBuffer): string {
  const bytes = new Uint8Array(audio);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const clean = (xs: string[]) => xs.map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s !== "").slice(0, STT_HINTS);

export function vocabularyPrompt(hints: { payees: string[]; categories: string[] }): string {
  return `Payees: ${clean(hints.payees).join(", ")}. Categories: ${clean(hints.categories).join(", ")}.`;
}

async function runOnce(env: Env, audio: ArrayBuffer, contentType: string, hints: { payees: string[]; categories: string[] }): Promise<string> {
  if (env.STT_MODEL === "nova3") {
    const body = new Response(audio).body;
    if (!body) return "";
    const res = await env.AI.run(NOVA3_MODEL, {
      audio: { body, contentType },
      smart_format: true,
      numerals: true,
    });
    return res.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }
  const res = await env.AI.run(WHISPER_MODEL, {
    audio: toBase64(audio),
    vad_filter: true,
    condition_on_previous_text: false,
    initial_prompt: vocabularyPrompt(hints),
  });
  return res.text ?? "";
}

/** Transcribes a short voice note. Workers AI capacity error 3040 is retried once; any other failure → ai_unavailable. */
export async function transcribe(env: Env, audio: ArrayBuffer, contentType: string, hints: { payees: string[]; categories: string[] }): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await runOnce(env, audio, contentType, hints)).trim();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (attempt === 0 && CAPACITY_ERROR.test(message)) continue;
      console.error(JSON.stringify({ msg: "stt_failed", model: env.STT_MODEL, error: message.slice(0, 200) }));
      throw new AppError("ai_unavailable", "Voice transcription failed. Try again or type the note.", e);
    }
  }
}
