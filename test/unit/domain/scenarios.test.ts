// DESIGN §13 scenario fixtures for planReconciliation (test/unit/domain/scenarios/*.json).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planReconciliation } from "../../../src/worker/domain/plan";
import type { Decision } from "../../../src/worker/domain/types";
import { input, intent, txn, type IntentSpec, type TxnSpec } from "./helpers";

interface Scenario {
  name: string;
  today?: string;
  intents: IntentSpec[];
  others?: IntentSpec[];
  txns: TxnSpec[];
  excluded?: string[];
  categoryNames?: Record<string, string>;
  expected: Partial<Decision>[] | "any";
  forbidKinds?: Decision["kind"][];
  expectOptions?: Record<string, unknown>[];
}

/** Recursive partial match: objects only need the listed keys, arrays must match element by element. */
function deep(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(deep);
  if (x !== null && typeof x === "object") {
    return expect.objectContaining(Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deep(v)])));
  }
  return x;
}

const dir = fileURLToPath(new URL("./scenarios/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

describe("planReconciliation scenarios (§13)", () => {
  it("has the required fixtures", () => {
    for (const n of ["01", "02", "03", "04-", "04b", "04c", "05-", "05b", "06", "07", "08", "09"]) {
      expect(files.some((f) => f.startsWith(n)), n).toBe(true);
    }
  });

  for (const f of files) {
    const s = JSON.parse(readFileSync(dir + f, "utf8")) as Scenario;
    it(s.name, () => {
      const inp = input({
        today: s.today, intents: s.intents.map(intent), others: (s.others ?? []).map(intent), txns: s.txns.map(txn),
        excluded: s.excluded, categoryNames: s.categoryNames,
      });
      const decisions = planReconciliation(inp);
      // Deterministic: the same input gives the same output.
      expect(planReconciliation(inp)).toEqual(decisions);
      for (const k of s.forbidKinds ?? []) expect(decisions.map((d) => d.kind)).not.toContain(k);
      if (s.expected !== "any") {
        expect(decisions).toHaveLength(s.expected.length);
        for (const exp of s.expected) expect(decisions).toContainEqual(deep(exp));
      }
      if (s.expectOptions) {
        const review = decisions.find((d) => d.kind === "review");
        expect(review).toBeDefined();
        if (review?.kind !== "review") return;
        for (const o of s.expectOptions) expect(review.options).toContainEqual(deep(o));
        for (const o of review.options) {
          const t = inp.txns.find((x) => x.id === o.transactionId);
          expect(o.allocation.reduce((a, x) => a + x.amount, 0)).toBe(t?.amount);
          expect(o.id).toMatch(/^o\d+$/);
        }
        expect(new Set(review.options.map((o) => o.id)).size).toBe(review.options.length);
      }
    });
  }
});
