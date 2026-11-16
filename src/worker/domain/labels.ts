// domain/labels.ts — WP5. PURE. Human-readable review summaries and option labels (no currency symbol:
// the SPA formats money itself; these strings are only short descriptions).
import { format, parseISO } from "date-fns";
import type { ReviewOption } from "../../shared/schemas";
import type { DLine, DTxn } from "./types";

export const fmtAmount = (m: number, decimals: number): string => (Math.abs(m) / 1000).toFixed(Math.max(0, decimals));
export const fmtDate = (iso: string): string => {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso;
  }
};
export const txnPayee = (t: DTxn): string => t.payeeName ?? t.importPayeeNameOriginal ?? t.importPayeeName ?? "Unknown payee";

/** "Costco 173.50 on Nov 14" or, for a subset of an order, "Charge 31.40 on Nov 12 → phone case, book". */
export function optionLabel(
  o: Omit<ReviewOption, "label">, txn: DTxn | undefined, lines: DLine[], decimals: number, opts: { subset: boolean; payee?: string },
): string {
  if (!txn) return `Transaction ${o.transactionId}`;
  const amt = fmtAmount(txn.amount, decimals);
  const when = fmtDate(txn.date);
  if (opts.subset) {
    const names = o.lineIds.map((id) => lines.find((l) => l.id === id)?.description).filter((d): d is string => !!d);
    const who = opts.payee ? `${opts.payee}: charge` : "Charge";
    return `${who} ${amt} on ${when} → ${names.join(", ") || "items"}`.slice(0, 200);
  }
  return `${txnPayee(txn)} ${amt} on ${when}`.slice(0, 200);
}
