// YNAB fixtures (WP3): raw API JSON shapes (snake_case, as api.ynab.com returns them) for one test plan.
// Used by test/msw/ynab.ts (FakeYnab). Ids are readable strings; YNAB uses UUIDs but nothing here depends on that.

export interface RawCategory { id: string; category_group_id: string; name: string; hidden: boolean; internal?: boolean; deleted: boolean;
  budgeted: number; activity: number; balance: number }
export interface RawGroup { id: string; name: string; hidden: boolean; internal?: boolean; deleted: boolean }
export interface RawAccount { id: string; name: string; type: string; on_budget: boolean; closed: boolean; balance: number;
  cleared_balance: number; uncleared_balance: number; transfer_payee_id: string | null; direct_import_linked: boolean; deleted: boolean }
export interface RawPayee { id: string; name: string; transfer_account_id: string | null; deleted: boolean }
export interface RawSub { id: string; transaction_id: string; amount: number; memo: string | null; payee_id: string | null;
  category_id: string | null; transfer_account_id: string | null; deleted: boolean }
export interface RawTxn {
  id: string; date: string; amount: number; memo: string | null; cleared: "cleared" | "uncleared" | "reconciled"; approved: boolean;
  flag_color: string | null; account_id: string; payee_id: string | null; category_id: string | null;
  transfer_account_id: string | null; transfer_transaction_id: string | null; matched_transaction_id: string | null;
  import_id: string | null; import_payee_name: string | null; import_payee_name_original: string | null; deleted: boolean;
}

export const PLAN_ID = "plan-1";
export const PLAN_NAME = "My Plan";

export const cat = (id: string, groupId: string, name: string, extra: Partial<RawCategory> = {}): RawCategory => ({
  id, category_group_id: groupId, name, hidden: false, internal: false, deleted: false, budgeted: 0, activity: 0, balance: 0, ...extra,
});
export const acct = (id: string, name: string, extra: Partial<RawAccount> = {}): RawAccount => ({
  id, name, type: "checking", on_budget: true, closed: false, balance: 0, cleared_balance: 0, uncleared_balance: 0,
  transfer_payee_id: `tp-${id}`, direct_import_linked: true, deleted: false, ...extra,
});
export const payee = (id: string, name: string, extra: Partial<RawPayee> = {}): RawPayee => ({
  id, name, transfer_account_id: null, deleted: false, ...extra,
});
export const txn = (id: string, date: string, amount: number, extra: Partial<RawTxn> = {}): RawTxn => ({
  id, date, amount, memo: null, cleared: "cleared", approved: false, flag_color: null, account_id: "acc-checking",
  payee_id: null, category_id: null, transfer_account_id: null, transfer_transaction_id: null, matched_transaction_id: null,
  import_id: null, import_payee_name: null, import_payee_name_original: null, deleted: false, ...extra,
});

/** A plan with the edge cases the cache queries care about. `today` anchors txn dates (YYYY-MM-DD). */
export function seedPlan(today: string) {
  const d = (offset: number) => {
    const t = new Date(`${today}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + offset);
    return t.toISOString().slice(0, 10);
  };
  const groups: RawGroup[] = [
    { id: "g-internal", name: "Internal Master Category", hidden: false, internal: true, deleted: false },
    { id: "g-cc", name: "Credit Card Payments", hidden: false, deleted: false },
    { id: "g-everyday", name: "Everyday", hidden: false, deleted: false },
    { id: "g-hidden", name: "Old Stuff", hidden: true, deleted: false },
    { id: "g-bills", name: "Bills", hidden: false, deleted: false },
  ];
  const categories: RawCategory[] = [
    cat("c-uncat", "g-internal", "Uncategorized", { internal: true }),
    cat("c-rta", "g-internal", "Inflow: Ready to Assign", { internal: true }),
    cat("c-visa-pay", "g-cc", "Visa"),
    cat("c-groceries", "g-everyday", "Groceries"),
    cat("c-dining", "g-everyday", "Dining Out"),
    cat("c-hidden-own", "g-everyday", "Hidden Own", { hidden: true }),
    cat("c-deleted", "g-everyday", "Deleted Cat", { deleted: true }),
    cat("c-in-hidden-group", "g-hidden", "Visible but group hidden"),
    cat("c-electric", "g-bills", "Electric"),
  ];
  const accounts: RawAccount[] = [
    acct("acc-checking", "Checking"),
    acct("acc-cash", "Wallet", { type: "cash", direct_import_linked: false }),
    acct("acc-visa", "Visa", { type: "creditCard" }),
    acct("acc-closed", "Old Savings", { type: "savings", closed: true }),
  ];
  const payees: RawPayee[] = [
    payee("p-costco", "Costco"),
    payee("p-starbucks", "Starbucks"),
    payee("p-amazon", "Amazon"),
    payee("p-power", "City Power"),
    payee("tp-acc-checking", "Transfer : Checking", { transfer_account_id: "acc-checking" }),
    payee("p-start", "Starting Balance"),
  ];
  const transactions: RawTxn[] = [
    txn("t-costco-1", d(-10), -120_000, { payee_id: "p-costco", category_id: "c-groceries", approved: true, import_id: "YNAB:-120000:1",
      import_payee_name: "Costco", import_payee_name_original: "COSTCO WHSE #0123", account_id: "acc-visa" }),
    txn("t-costco-2", d(-3), -80_500, { payee_id: "p-costco", category_id: "c-groceries", approved: true, account_id: "acc-visa",
      import_id: "YNAB:-80500:1", import_payee_name_original: "COSTCO WHSE #0123" }),
    txn("t-sbux-1", d(-2), -5_250, { payee_id: "p-starbucks", category_id: "c-dining", approved: true }),
    txn("t-sbux-2", d(-1), -6_100, { payee_id: "p-starbucks", category_id: null, approved: false, import_id: "YNAB:-6100:1",
      import_payee_name_original: "STARBUCKS STORE 123" }),
    txn("t-uncat", d(-1), -9_990, { payee_id: "p-amazon", category_id: "c-uncat", approved: false, import_id: "YNAB:-9990:1",
      import_payee_name_original: "AMZN Mktp US*2K4L" }),
    txn("t-split", d(-4), -50_000, { payee_id: "p-amazon", category_id: null, approved: true }),
    txn("t-transfer", d(-5), -100_000, { payee_id: "tp-acc-checking", transfer_account_id: "acc-checking", account_id: "acc-visa", approved: true }),
    txn("t-refund", d(-1), 20_000, { payee_id: "p-costco", category_id: null, approved: false, account_id: "acc-visa",
      import_id: "YNAB:20000:1", import_payee_name_original: "COSTCO WHSE #0123" }),
    txn("t-power", d(-20), -60_000, { payee_id: "p-power", category_id: "c-electric", approved: true }),
  ];
  const subtransactions: RawSub[] = [
    { id: "s-1", transaction_id: "t-split", amount: -30_000, memo: null, payee_id: null, category_id: "c-groceries", transfer_account_id: null, deleted: false },
    { id: "s-2", transaction_id: "t-split", amount: -20_000, memo: null, payee_id: null, category_id: "c-dining", transfer_account_id: null, deleted: false },
  ];
  return { id: PLAN_ID, name: PLAN_NAME, currency: { iso_code: "USD", decimal_digits: 2 }, groups, categories, accounts, payees, transactions, subtransactions };
}
export type SeedPlan = ReturnType<typeof seedPlan>;
