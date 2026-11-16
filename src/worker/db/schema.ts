// Drizzle tables mirroring migrations/0001_init.sql (DESIGN §5) table by table, column by column.
// snake_case columns, camelCase properties. INTEGER 0/1 booleans use { mode: "boolean" }.
// JSON columns stay TEXT; parse them with the shared zod schemas.
import { sql } from "drizzle-orm";
import { AuditAction, type AuditAction as AuditActionT } from "../../shared/schemas";
import { index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

const bool = (name: string) => integer(name, { mode: "boolean" });

// ── identity ────────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  authType: text("auth_type", { enum: ["oauth", "pat"] }).notNull(),
  sttAllowed: bool("stt_allowed").notNull().default(false),
  needsReauth: bool("needs_reauth").notNull().default(false),
  tokenRefreshLockUntil: integer("token_refresh_lock_until"),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user").on(t.userId), index("sessions_expiry").on(t.expiresAt)],
);

export const userSecrets = sqliteTable(
  "user_secrets",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["ynab_access", "ynab_refresh", "ynab_pat", "anthropic"] }).notNull(),
    sealed: text("sealed").notNull(),
    expiresAt: integer("expires_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  json: text("json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── YNAB sync state & cache ────────────────────────────────────────────────
export const syncState = sqliteTable(
  "sync_state",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    planName: text("plan_name"),
    currencyIso: text("currency_iso").notNull().default("USD"),
    currencyDecimals: integer("currency_decimals").notNull().default(2),
    serverKnowledge: integer("server_knowledge"),
    lastSyncAt: integer("last_sync_at"),
    lastCycleAt: integer("last_cycle_at"),
    lastError: text("last_error"),
    rateLimitedUntil: integer("rate_limited_until"),
    lockUntil: integer("lock_until"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.planId] })],
);

export const ynabCategoryGroups = sqliteTable(
  "ynab_category_groups",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    hidden: bool("hidden").notNull().default(false),
    deleted: bool("deleted").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

export const ynabCategories = sqliteTable(
  "ynab_categories",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    id: text("id").notNull(),
    groupId: text("group_id").notNull(),
    name: text("name").notNull(),
    hidden: bool("hidden").notNull().default(false),
    deleted: bool("deleted").notNull().default(false),
    sortIndex: integer("sort_index").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] }), index("ynab_categories_plan").on(t.userId, t.planId)],
);

export const ynabAccounts = sqliteTable(
  "ynab_accounts",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    onBudget: bool("on_budget").notNull(),
    directImportLinked: bool("direct_import_linked").notNull().default(false),
    closed: bool("closed").notNull().default(false),
    deleted: bool("deleted").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

export const ynabPayees = sqliteTable(
  "ynab_payees",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    transferAccountId: text("transfer_account_id"),
    deleted: bool("deleted").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

export const ynabTransactions = sqliteTable(
  "ynab_transactions",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    id: text("id").notNull(),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    payeeId: text("payee_id"),
    payeeName: text("payee_name"),
    importPayeeName: text("import_payee_name"),
    importPayeeNameOriginal: text("import_payee_name_original"),
    accountId: text("account_id").notNull(),
    categoryId: text("category_id"),
    memo: text("memo"),
    cleared: text("cleared", { enum: ["cleared", "uncleared", "reconciled"] }).notNull(),
    approved: bool("approved").notNull(),
    flagColor: text("flag_color"),
    importId: text("import_id"),
    matchedTransactionId: text("matched_transaction_id"),
    transferAccountId: text("transfer_account_id"),
    isSplit: bool("is_split").notNull().default(false),
    deleted: bool("deleted").notNull().default(false),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index("ynab_txn_plan_date").on(t.userId, t.planId, t.date),
    index("ynab_txn_matched").on(t.userId, t.matchedTransactionId),
    index("ynab_txn_inbox").on(t.userId, t.planId, t.approved, t.deleted),
  ],
);

// ── intents ─────────────────────────────────────────────────────────────────
export const intents = sqliteTable(
  "intents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    shortRef: text("short_ref").notNull(),
    status: text("status", { enum: ["pending", "partial", "review", "resolved", "cancelled"] }).notNull(),
    rawText: text("raw_text").notNull(),
    inputMode: text("input_mode", { enum: ["typed", "browser_stt", "server_stt"] }).notNull(),
    payee: text("payee").notNull(),
    payeeId: text("payee_id"),
    merchantKind: text("merchant_kind", { enum: ["amazon", "online", "in_person", "other"] }).notNull(),
    direction: text("direction", { enum: ["outflow", "inflow"] }).notNull(),
    intentDate: text("intent_date").notNull(),
    accountId: text("account_id"),
    accountExplicit: bool("account_explicit").notNull().default(false),
    totalAmount: integer("total_amount").notNull(),
    tolerance: integer("tolerance").notNull(),
    approximate: bool("approximate").notNull(),
    memo: text("memo"),
    placeholderTxnId: text("placeholder_txn_id"),
    placeholderStatus: text("placeholder_status", {
      enum: ["none", "created", "auto_matched", "deleted", "missing", "failed", "final"],
    })
      .notNull()
      .default("none"),
    placeholderAmount: integer("placeholder_amount"),
    expiresOn: text("expires_on").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [unique().on(t.userId, t.shortRef), index("intents_user_status").on(t.userId, t.status)],
);

export const intentLines = sqliteTable(
  "intent_lines",
  {
    id: text("id").primaryKey(),
    intentId: text("intent_id").notNull().references(() => intents.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    description: text("description").notNull(),
    categoryId: text("category_id").notNull(),
    amount: integer("amount").notNull(),
    tolerance: integer("tolerance").notNull(),
    approximate: bool("approximate").notNull(),
    status: text("status", { enum: ["open", "matched"] }).notNull().default("open"),
    matchedTxnId: text("matched_txn_id"),
  },
  (t) => [unique().on(t.intentId, t.idx)],
);

// ── matching / review / inbox / audit ──────────────────────────────────────
export const matches = sqliteTable(
  "matches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    intentId: text("intent_id").notNull().references(() => intents.id, { onDelete: "cascade" }),
    ynabTxnId: text("ynab_txn_id").notNull(),
    kind: text("kind", { enum: ["ynab_auto", "single", "split", "amazon_subset", "manual", "review"] }).notNull(),
    lineIds: text("line_ids").notNull(), // JSON string[]
    allocation: text("allocation").notNull(), // JSON Allocation[] (signed)
    score: real("score"),
    state: text("state", { enum: ["planned", "applied", "failed"] }).notNull(),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    appliedAt: integer("applied_at"),
  },
  (t) => [
    uniqueIndex("matches_txn_live").on(t.userId, t.ynabTxnId).where(sql`state IN ('planned','applied')`),
    index("matches_intent").on(t.intentId),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    intentId: text("intent_id").references(() => intents.id, { onDelete: "cascade" }),
    ynabTxnId: text("ynab_txn_id"),
    kind: text("kind", {
      enum: ["ambiguous_match", "amazon_split", "ynab_matched_other", "split_conflict", "too_complex", "approved_import"],
    }).notNull(),
    options: text("options").notNull(), // JSON ReviewOption[]
    summary: text("summary").notNull(),
    status: text("status", { enum: ["open", "resolved", "dismissed"] }).notNull().default("open"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    uniqueIndex("reviews_open_intent")
      .on(t.userId, t.intentId)
      .where(sql`status = 'open' AND intent_id IS NOT NULL`),
    uniqueIndex("reviews_open_txn")
      .on(t.userId, t.ynabTxnId)
      .where(sql`status = 'open' AND intent_id IS NULL`),
  ],
);

export const inboxSuggestions = sqliteTable(
  "inbox_suggestions",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    ynabTxnId: text("ynab_txn_id").notNull(),
    categoryId: text("category_id"),
    confidence: text("confidence", { enum: ["high", "medium", "low"] }).notNull(),
    reason: text("reason").notNull(),
    source: text("source", { enum: ["claude", "ynab_existing", "history"] }).notNull(),
    status: text("status", { enum: ["suggested", "applied", "dismissed"] }).notNull().default("suggested"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ynabTxnId] })],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    actor: text("actor", { enum: ["user", "cron", "app"] }).notNull(),
    action: text("action", { enum: AuditAction.options as [AuditActionT, ...AuditActionT[]] }).notNull(), // AuditAction (shared)
    summary: text("summary").notNull(),
    intentId: text("intent_id"),
    ynabTxnId: text("ynab_txn_id"),
    beforeJson: text("before_json"), // TxnSnapshot JSON
    afterJson: text("after_json"), // TxnSnapshot JSON
  },
  (t) => [index("audit_user_at").on(t.userId, t.at)],
);
