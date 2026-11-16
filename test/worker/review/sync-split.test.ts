// Review regression: delta sync must clear a cached split flag when the user un-splits a transaction in YNAB.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ynabTransactions } from "../../../src/worker/db/schema";
import { syncPlan } from "../../../src/worker/ynab/sync";
import { summaryToTxn, unsplitParentsOf } from "../../../src/worker/ynab/client";
import type { YnabClient } from "../../../src/worker/ynab/client";
import type { PlanDelta } from "../../../src/worker/ynab/types";
import { PLAN, cacheTxns, db, mkTxn, seedUser, uid } from "../wp5-helpers";

describe("syncPlan split flag", () => {
  it("clears is_split when the delta carries the parent with all its subtransactions deleted", async () => {
    const userId = uid("user");
    await seedUser(userId);
    const id = uid("t");
    await cacheTxns(userId, [mkTxn({ id, isSplit: true, categoryId: null })]);

    // What the client produces for a parent whose subtransactions were all deleted (un-split, recategorized).
    const parent = summaryToTxn(PLAN, {
      id, date: "2026-11-11", amount: -10000, cleared: "cleared", approved: true, account_id: "acc-card",
      category_id: "cat-groceries", deleted: false, import_id: `YNAB:${id}`,
    } as never, new Map(), new Set()); // splitParentsOf() ignores deleted subtransactions → empty set
    expect(parent.isSplit).toBe(false);

    const client = {
      async getPlanDelta(): Promise<PlanDelta> {
        // The delta carries the parent's subtransactions as tombstones.
        const unsplitTxnIds = unsplitParentsOf([
          { id: "s-1", transaction_id: id, amount: -6000, deleted: true },
          { id: "s-2", transaction_id: id, amount: -4000, deleted: true },
        ] as never);
        return { serverKnowledge: 9, transactions: [parent], categoryGroups: [], categories: [], accounts: [], payees: [], unsplitTxnIds };
      },
    } as unknown as YnabClient;
    await syncPlan(env, db(), client, userId, PLAN);
    const row = await db().select().from(ynabTransactions).where(and(eq(ynabTransactions.userId, userId), eq(ynabTransactions.id, id))).get();
    expect(row?.categoryId).toBe("cat-groceries");
    expect(row?.isSplit).toBe(false);
  });
});

describe("unsplitParentsOf", () => {
  it("names only parents with no live subtransactions left", () => {
    expect(unsplitParentsOf([
      { id: "a1", transaction_id: "A", deleted: true }, { id: "a2", transaction_id: "A", deleted: true },
      { id: "b1", transaction_id: "B", deleted: true }, { id: "b2", transaction_id: "B", deleted: false },
    ] as never)).toEqual(["A"]);
  });
});
