// WP5 domain test helpers: compact builders for DIntent / DTxn / ReconcileInput.
import { DEFAULT_SETTINGS, type Settings } from "../../../src/shared/schemas";
import { computeTolerance } from "../../../src/worker/domain/tolerance";
import type { DIntent, DLine, DTxn, ReconcileInput } from "../../../src/worker/domain/types";

export interface LineSpec { id: string; categoryId: string; amount: number; description?: string; approximate?: boolean; status?: "open" | "matched" }
export interface IntentSpec {
  id: string; payee: string; date: string; total?: number; approximate?: boolean;
  merchantKind?: DIntent["merchantKind"]; direction?: DIntent["direction"]; accountId?: string | null; accountExplicit?: boolean;
  status?: DIntent["status"]; shortRef?: string; placeholderTxnId?: string | null; placeholderStatus?: DIntent["placeholderStatus"];
  tolerance?: number; lines?: LineSpec[]; categoryId?: string;
}
export interface TxnSpec {
  id: string; date: string; amount: number; payee?: string | null; importPayee?: string | null; importPayeeOriginal?: string | null;
  imported?: boolean; accountId?: string; categoryId?: string | null; approved?: boolean; memo?: string | null;
  matchedTransactionId?: string | null; transferAccountId?: string | null; isSplit?: boolean; deleted?: boolean;
  cleared?: DTxn["cleared"]; flagColor?: string | null;
}

export function line(s: LineSpec): DLine {
  return {
    id: s.id, categoryId: s.categoryId, amount: s.amount, description: s.description ?? s.id,
    tolerance: computeTolerance(s.amount, s.approximate ?? false), status: s.status ?? "open",
  };
}

export function intent(s: IntentSpec): DIntent {
  const lines = (s.lines ?? [{ id: `${s.id}-l1`, categoryId: s.categoryId ?? "cat-1", amount: s.total ?? 0, approximate: s.approximate }]).map(line);
  const total = s.total ?? lines.reduce((a, l) => a + l.amount, 0);
  return {
    id: s.id, shortRef: s.shortRef ?? s.id.toUpperCase().replace(/[^0-9A-Z]/g, "").padEnd(6, "X").slice(0, 6),
    payee: s.payee, merchantKind: s.merchantKind ?? "in_person", direction: s.direction ?? "outflow", date: s.date,
    accountId: s.accountId ?? null, accountExplicit: s.accountExplicit ?? false,
    total, tolerance: s.tolerance ?? computeTolerance(total, s.approximate ?? false), status: s.status ?? "pending",
    placeholderTxnId: s.placeholderTxnId ?? null, placeholderStatus: s.placeholderStatus ?? "none", lines,
  };
}

export function txn(s: TxnSpec): DTxn {
  const imported = s.imported ?? true;
  return {
    id: s.id, planId: "plan-1", date: s.date, amount: s.amount,
    payeeId: null, payeeName: s.payee === undefined ? null : s.payee,
    importPayeeName: s.importPayee === undefined ? null : s.importPayee,
    importPayeeNameOriginal: s.importPayeeOriginal === undefined ? null : s.importPayeeOriginal,
    accountId: s.accountId ?? "acc-1", categoryId: s.categoryId ?? null, memo: s.memo ?? null,
    cleared: s.cleared ?? (imported ? "cleared" : "uncleared"), approved: s.approved ?? false, flagColor: s.flagColor ?? null,
    importId: imported ? `YNAB:${Math.abs(s.amount)}:${s.date}:1` : null,
    matchedTransactionId: s.matchedTransactionId ?? null, transferAccountId: s.transferAccountId ?? null,
    isSplit: s.isSplit ?? false, deleted: s.deleted ?? false,
  };
}

export function input(p: {
  today?: string; settings?: Partial<Settings>; intents: DIntent[]; others?: DIntent[]; txns: DTxn[];
  excluded?: string[]; uncategorizedIds?: string[]; categoryNames?: Record<string, string>; decimalDigits?: number;
}): ReconcileInput {
  return {
    today: p.today ?? "2026-11-16", settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) }, decimalDigits: p.decimalDigits ?? 2,
    intents: p.intents, otherOpenAmazonIntents: p.others ?? [], txns: p.txns,
    excluded: new Set(p.excluded ?? []), uncategorizedIds: new Set(p.uncategorizedIds ?? ["cat-uncat"]),
    categoryNames: new Map(Object.entries(p.categoryNames ?? {})),
  };
}
