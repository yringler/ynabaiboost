// WP4 prompt fixture set (§12 WP4): test/fixtures/utterances.json — ~30 notes with their expected drafts.
//  - Always: the fixture file is well-formed (refs exist in its catalog), so it can't rot silently.
//  - Live eval (NOT CI): runs every note through the real parse prompt + post-processing against the API:
//      EVAL_PARSE=1 ANTHROPIC_API_KEY=sk-ant-... npx vitest run --project unit test/unit/ai/eval-parse.test.ts
//    (intended to back `npm run eval:parse`). Prints per-field mismatches and requires an 80 % case pass rate.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { addDays } from "../../../src/shared/dates";
import { payeeSimilarity } from "../../../src/shared/payee";
import type { Account, Category, CurrencyFormat, IntentDraft, Payee } from "../../../src/shared/schemas";
import { callStructured } from "../../../src/worker/ai/claude";
import { PARSE_CALL } from "../../../src/worker/ai/parse";
import { toDrafts } from "../../../src/worker/ai/postprocess";
import { PARSE_SYSTEM, renderCatalog, renderParseUserTurn } from "../../../src/worker/ai/prompts";
import { ParsedUtterance } from "../../../src/worker/ai/schemas";
import fixture from "../../fixtures/utterances.json";

interface ExpectedDraft {
  payee: string; payeeId: string | null; merchantKind: string; direction: "outflow" | "inflow"; dateOffset: number;
  accountId: string | null; totalAmount: number | null; approximate: boolean; categoryIds: string[]; lineCount: number;
}
interface Case { note: string; status: "ok" | "not_a_transaction" | "needs_clarification"; drafts: ExpectedDraft[] }
const data = fixture as unknown as {
  catalog: { today: string; timezone: string; currency: CurrencyFormat; categories: Category[]; accounts: Account[]; payees: Payee[] };
  cases: Case[];
};
const { catalog: cat, cases } = data;

/** Field-level differences between an expected and an actual draft ([] = match). */
export function diffDraft(exp: ExpectedDraft, got: IntentDraft): string[] {
  const out: string[] = [];
  if (payeeSimilarity(exp.payee, [got.payee]) < 0.8) out.push(`payee ${got.payee} ≠ ${exp.payee}`);
  if (exp.payeeId !== null && got.payeeId !== exp.payeeId) out.push(`payeeId ${got.payeeId} ≠ ${exp.payeeId}`);
  if (got.direction !== exp.direction) out.push(`direction ${got.direction}`);
  if (got.date !== addDays(cat.today, exp.dateOffset)) out.push(`date ${got.date}`);
  if (exp.accountId !== null && got.accountId !== exp.accountId) out.push(`account ${got.accountId} ≠ ${exp.accountId}`);
  if (got.totalAmount !== exp.totalAmount) out.push(`total ${got.totalAmount} ≠ ${exp.totalAmount}`);
  if (got.approximate !== exp.approximate) out.push(`approximate ${got.approximate}`);
  if (got.lines.length !== exp.lineCount) out.push(`lines ${got.lines.length} ≠ ${exp.lineCount}`);
  const cats = [...new Set(got.lines.flatMap((l) => (l.categoryId ? [l.categoryId] : [])))].sort();
  if (exp.categoryIds.length > 0 && JSON.stringify(cats) !== JSON.stringify([...new Set(exp.categoryIds)].sort())) {
    out.push(`categories ${cats.join(",")} ≠ ${exp.categoryIds.join(",")}`);
  }
  return out;
}

describe("utterances.json fixture", () => {
  it("has ~30 cases whose expected ids exist in the fixture catalog", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const catIds = new Set(cat.categories.map((c) => c.id));
    const accIds = new Set(cat.accounts.map((a) => a.id));
    const payeeIds = new Set(cat.payees.map((p) => p.id));
    for (const c of cases) {
      expect(c.note.length).toBeGreaterThan(0);
      if (c.status !== "ok") expect(c.drafts).toEqual([]);
      for (const d of c.drafts) {
        for (const id of d.categoryIds) expect(catIds.has(id), `${c.note}: ${id}`).toBe(true);
        if (d.accountId !== null) expect(accIds.has(d.accountId), c.note).toBe(true);
        if (d.payeeId !== null) expect(payeeIds.has(d.payeeId), c.note).toBe(true);
        expect(d.lineCount).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

const live = process.env.EVAL_PARSE === "1" && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!live)("live parse eval (real API, not CI)", () => {
  it("parses the fixture notes", { timeout: 15 * 60_000 }, async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
    const rendered = renderCatalog({ categories: cat.categories, accounts: cat.accounts, payees: cat.payees });
    let passed = 0;
    const report: string[] = [];
    for (const c of cases) {
      const parsed = await callStructured(client, {
        schema: ParsedUtterance,
        system: [{ type: "text", text: PARSE_SYSTEM }, { type: "text", text: rendered.text }],
        user: renderParseUserTurn({ today: cat.today, timezone: cat.timezone, currency: cat.currency, note: c.note }),
        ...PARSE_CALL,
      }).catch((e: unknown) => e);
      if (!(parsed && typeof parsed === "object" && "status" in parsed)) {
        report.push(`✗ ${c.note}\n    error: ${String(parsed)}`);
        continue;
      }
      const r = toDrafts(parsed as Parameters<typeof toDrafts>[0], { catalog: rendered, payees: cat.payees, today: cat.today, decimalDigits: cat.currency.decimalDigits });
      const problems: string[] = [];
      if (r.status !== c.status) problems.push(`status ${r.status} ≠ ${c.status}`);
      else if (c.status === "ok") {
        if (r.drafts.length !== c.drafts.length) problems.push(`drafts ${r.drafts.length} ≠ ${c.drafts.length}`);
        c.drafts.forEach((exp, i) => {
          const got = r.drafts[i];
          if (got) problems.push(...diffDraft(exp, got).map((p) => `#${i + 1} ${p}`));
        });
      }
      if (problems.length === 0) passed++;
      report.push(`${problems.length === 0 ? "✓" : "✗"} ${c.note}${problems.map((p) => `\n    ${p}`).join("")}`);
    }
    console.log(`${report.join("\n")}\n\n${passed}/${cases.length} cases passed`);
    expect(passed / cases.length).toBeGreaterThanOrEqual(0.8);
  });
});
