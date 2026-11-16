// domain/note.ts — PURE helpers for an intent's own text and stored facts (§9.5, §9.6), shared by the intent
// services and the conversational-edit validator.
import { MAX_NOTE_CHARS, OrderFacts, statedAmounts } from "../../shared/precision";

/** Upper bound for an intent's raw_text once edit notes are appended to it. */
export const MAX_RAW_TEXT = 2 * MAX_NOTE_CHARS;

/** The note an edit adds to an intent's own text: amounts in it then count as stated by the user. */
export function appendNote(raw: string, note: string): string {
  const n = note.trim();
  if (n === "") return raw;
  const joined = raw.trim() === "" ? n : `${raw}\n${n}`;
  return joined.length <= MAX_RAW_TEXT ? joined : `${raw.slice(0, Math.max(0, MAX_RAW_TEXT - n.length - 1))}\n${n}`;
}

/** Stored facts JSON → OrderFacts, or null. */
export function storedFacts(json: string | null): OrderFacts | null {
  if (json === null) return null;
  try {
    const r = OrderFacts.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** An edit that changes the total re-derives the "written with cents" fact from the user's edit words
 *  (deterministically, like statedAmounts); the parse-time report described the old total. */
export function factsAfterEdit(facts: OrderFacts | null, note: string | undefined, oldTotal: number, newTotal: number,
  decimalDigits: number): OrderFacts | null {
  if (!facts || note === undefined || newTotal === oldTotal) return facts;
  return { ...facts, totalHasCents: statedAmounts(note, decimalDigits).exact.has(newTotal) };
}
