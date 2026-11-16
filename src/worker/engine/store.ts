// engine/store.ts — WP5 internal D1 helpers shared by the engine and the WP5 routes (not a §8 contract).
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { OrderPlan } from "../../shared/precision";
import type { Intent, IntentLine } from "../../shared/schemas";
import { intentLines, intents, matches, reviews, ynabCategories, ynabCategoryGroups } from "../db/schema";
import type { DIntent, DLine } from "../domain/types";
import type { BatchItem, DB } from "../env";
import { AppError } from "../lib/errors";

export type IntentRow = typeof intents.$inferSelect;
export type LineRow = typeof intentLines.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export const OPEN_STATUSES = ["pending", "partial", "review"] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];
export const isOpen = (s: IntentRow["status"]): s is OpenStatus => (OPEN_STATUSES as readonly string[]).includes(s);

/** D1 binds at most 100 parameters per statement. */
export const chunk = <T>(xs: T[], n = 90): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function getIntentRow(db: DB, userId: string, id: string): Promise<IntentRow | null> {
  return (await db.select().from(intents).where(and(eq(intents.userId, userId), eq(intents.id, id))).get()) ?? null;
}

/** Owner check (DESIGN §7: not the owner → 404). */
export async function requireIntent(db: DB, userId: string, id: string): Promise<IntentRow> {
  const row = await getIntentRow(db, userId, id);
  if (!row) throw new AppError("not_found", "Intent not found");
  return row;
}

export async function getLines(db: DB, intentIds: string[]): Promise<Map<string, LineRow[]>> {
  const out = new Map<string, LineRow[]>();
  for (const ids of chunk([...new Set(intentIds)])) {
    const rows = await db.select().from(intentLines).where(inArray(intentLines.intentId, ids)).orderBy(asc(intentLines.idx)).all();
    for (const r of rows) {
      const list = out.get(r.intentId) ?? [];
      list.push(r);
      out.set(r.intentId, list);
    }
  }
  return out;
}

export async function getLinesOf(db: DB, intentId: string): Promise<LineRow[]> {
  return (await getLines(db, [intentId])).get(intentId) ?? [];
}

/** Stored verified order plan (JSON) or null when absent/unreadable. */
export function parseOrderPlan(json: string | null): OrderPlan | null {
  if (json === null) return null;
  try {
    const r = OrderPlan.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function toDLine(l: LineRow): DLine {
  return { id: l.id, categoryId: l.categoryId, amount: l.amount, tolerance: l.tolerance, status: l.status, description: l.description };
}

/** DIntent for the planner. `total`/`tolerance` describe what is still open, so partial intents keep matching. */
export function toDIntent(r: IntentRow, lines: LineRow[]): DIntent {
  const open = lines.filter((l) => l.status === "open");
  const partial = open.length > 0 && open.length < lines.length;
  const total = partial ? open.reduce((s, l) => s + l.amount, 0) : r.totalAmount;
  const tolerance = partial ? open.reduce((s, l) => s + l.tolerance, 0) : r.tolerance;
  return {
    id: r.id, shortRef: r.shortRef, payee: r.payee, merchantKind: r.merchantKind, direction: r.direction,
    date: r.intentDate, accountId: r.accountId, accountExplicit: r.accountExplicit, total, tolerance,
    status: r.status === "partial" || r.status === "review" ? r.status : "pending",
    placeholderTxnId: r.placeholderTxnId, placeholderStatus: r.placeholderStatus, lines: lines.map(toDLine),
    order: r.merchantKind === "amazon" && r.precision === "exact" ? parseOrderPlan(r.orderPlan) : null,
  };
}

export function toIntentLine(l: LineRow): IntentLine {
  return {
    id: l.id, idx: l.idx, description: l.description, categoryId: l.categoryId, amount: l.amount, tolerance: l.tolerance,
    approximate: l.approximate, status: l.status, matchedTxnId: l.matchedTxnId,
  };
}

export function toIntentDto(r: IntentRow, lines: LineRow[], matchedTxnIds: string[], today: string): Intent {
  return {
    id: r.id, shortRef: r.shortRef, status: r.status, isStale: isOpen(r.status) && r.expiresOn < today,
    rawText: r.rawText, payee: r.payee, payeeId: r.payeeId, merchantKind: r.merchantKind, direction: r.direction,
    date: r.intentDate, accountId: r.accountId, accountExplicit: r.accountExplicit,
    totalAmount: r.totalAmount, tolerance: r.tolerance, approximate: r.approximate, memo: r.memo,
    precision: { level: r.precision, note: r.precisionNote },
    placeholder: { txnId: r.placeholderTxnId, status: r.placeholderStatus, amount: r.placeholderAmount },
    expiresOn: r.expiresOn, createdAt: r.createdAt, resolvedAt: r.resolvedAt,
    lines: lines.map(toIntentLine), matchedTransactionIds: matchedTxnIds,
  };
}

/** Intent DTOs for rows (lines + applied matches loaded in bulk), same order as `rows`. */
export async function intentDtos(db: DB, rows: IntentRow[], today: string): Promise<Intent[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = await getLines(db, ids);
  const matched = new Map<string, string[]>();
  for (const part of chunk(ids)) {
    const ms = await db.select({ intentId: matches.intentId, txnId: matches.ynabTxnId }).from(matches)
      .where(and(inArray(matches.intentId, part), eq(matches.state, "applied"))).orderBy(asc(matches.createdAt)).all();
    for (const m of ms) {
      const list = matched.get(m.intentId) ?? [];
      if (!list.includes(m.txnId)) list.push(m.txnId);
      matched.set(m.intentId, list);
    }
  }
  return rows.map((r) => toIntentDto(r, lines.get(r.id) ?? [], matched.get(r.id) ?? [], today));
}

export async function intentDto(db: DB, userId: string, id: string, today: string): Promise<Intent> {
  const row = await requireIntent(db, userId, id);
  const [dto] = await intentDtos(db, [row], today);
  if (!dto) throw new AppError("not_found", "Intent not found");
  return dto;
}

/** Ids of YNAB's internal "Uncategorized" category for the plan. */
export async function uncategorizedIds(db: DB, userId: string, planId: string): Promise<Set<string>> {
  const rows = await db.select({ id: ynabCategories.id }).from(ynabCategories)
    .innerJoin(ynabCategoryGroups, and(eq(ynabCategoryGroups.userId, ynabCategories.userId), eq(ynabCategoryGroups.id, ynabCategories.groupId)))
    .where(and(eq(ynabCategories.userId, userId), eq(ynabCategories.planId, planId),
      eq(ynabCategories.name, "Uncategorized"), eq(ynabCategoryGroups.name, "Internal Master Category"))).all();
  return new Set(rows.map((r) => r.id));
}

export async function categoryNames(db: DB, userId: string, planId: string): Promise<Map<string, string>> {
  const rows = await db.select({ id: ynabCategories.id, name: ynabCategories.name }).from(ynabCategories)
    .where(and(eq(ynabCategories.userId, userId), eq(ynabCategories.planId, planId))).all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Status an open intent returns to when it leaves a review: partial if any line is matched. */
export async function statusAfterReview(db: DB, intentId: string): Promise<"pending" | "partial"> {
  const r = await db.select({ n: sql<number>`count(*)` }).from(intentLines)
    .where(and(eq(intentLines.intentId, intentId), eq(intentLines.status, "matched"))).get();
  return (r?.n ?? 0) > 0 ? "partial" : "pending";
}

export async function openReviews(db: DB, userId: string): Promise<ReviewRow[]> {
  return db.select().from(reviews).where(and(eq(reviews.userId, userId), eq(reviews.status, "open"))).orderBy(desc(reviews.createdAt)).all();
}

/** True when a D1 error is a UNIQUE constraint violation. */
export function isUniqueViolation(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error && /UNIQUE constraint failed/i.test(cur.message)) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}

/** db.batch for a possibly empty list (D1 batches are atomic). */
export async function runBatch(db: DB, stmts: BatchItem<"sqlite">[]): Promise<void> {
  const [first, ...rest] = stmts;
  if (first) await db.batch([first, ...rest]);
}
