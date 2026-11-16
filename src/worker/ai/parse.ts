// ai/parse.ts — WP4 (DESIGN §8.4, §9.1, §9.4). Note → IntentDrafts. Writes nothing.
import type { z } from "zod";
import type { ParseRes } from "../../shared/api";
import { todayIn } from "../../shared/dates";
import type { Settings } from "../../shared/schemas";
import type { DB } from "../env";
import { getAccounts, getAllPayees, getCurrency, getSelectableCategories, getTopPayees, lastAccountForPayee } from "../ynab/cache";
import { callStructured, getClaude } from "./claude";
import { toDrafts } from "./postprocess";
import { CATALOG_PAYEES, PARSE_SYSTEM, renderCatalog, renderParseUserTurn } from "./prompts";
import { ParsedUtterance } from "./schemas";

export interface AiCtx { env: Env; db: DB; userId: string; planId: string; settings: Settings }

/** §9.1 parse call policy. */
export const PARSE_CALL = { effort: "low", maxTokens: 8000, timeoutMs: 30_000, maxRetries: 1 } as const;

/** Safe "today" for a stored timezone (an invalid IANA name falls back to UTC instead of throwing). */
export function safeTodayIn(tz: string, now: Date = new Date()): string {
  try {
    return todayIn(tz, now);
  } catch {
    return todayIn("UTC", now);
  }
}

export async function parseUtterance(ctx: AiCtx, text: string): Promise<z.infer<typeof ParseRes>> {
  const { db, userId, planId, settings } = ctx;
  const client = await getClaude(ctx.env, db, userId);       // consent + key first: no cache reads if missing
  const [categories, allAccounts, topPayees, allPayees, currencyRow] = await Promise.all([
    getSelectableCategories(db, userId, planId),
    getAccounts(db, userId, planId),
    getTopPayees(db, userId, planId, CATALOG_PAYEES),
    getAllPayees(db, userId, planId),
    getCurrency(db, userId, planId),
  ]);
  // Intents are spending on budget accounts only: tracking accounts take no categories (the SPA hides them too).
  const accounts = allAccounts.filter((a) => a.onBudget);
  const currency = { isoCode: currencyRow.isoCode, decimalDigits: currencyRow.decimalDigits };
  const catalog = renderCatalog({ categories, accounts, payees: topPayees });
  const today = safeTodayIn(settings.timezone);

  // No cache_control: parse calls are too rare for the 5-minute cache to pay off (§9.1).
  const parsed = await callStructured(client, {
    schema: ParsedUtterance,
    system: [{ type: "text", text: PARSE_SYSTEM }, { type: "text", text: catalog.text }],
    user: renderParseUserTurn({ today, timezone: settings.timezone, currency, note: text }),
    ...PARSE_CALL,
  });

  const result = toDrafts(parsed, { catalog, payees: allPayees, today, decimalDigits: currency.decimalDigits });

  // §9.4.6: no explicit account → the payee's last account, then the default account (accountExplicit=false).
  const openAccountIds = new Set(accounts.map((a) => a.id));
  const defaultAccountId = settings.defaultAccountId !== null && openAccountIds.has(settings.defaultAccountId) ? settings.defaultAccountId : null;
  const drafts = await Promise.all(result.drafts.map(async (d) => {
    if (d.accountId !== null) return d;
    const last = await lastAccountForPayee(db, userId, planId, d.payee);
    return { ...d, accountId: last ?? defaultAccountId, accountExplicit: false };
  }));

  return { status: result.status, question: result.question, drafts, warnings: result.warnings };
}
