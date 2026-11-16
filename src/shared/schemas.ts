// src/shared/schemas.ts
import { z } from "zod";

export const Id = z.string().min(1).max(64);
export const IsoDate = z.iso.date();
export const Milli = z.int().nonnegative();     // our positive amounts
export const SignedMilli = z.int();             // YNAB-signed amounts

export const FlagColor = z.enum(["red", "orange", "yellow", "green", "blue", "purple"]);
export type FlagColor = z.infer<typeof FlagColor>; // WP1 addition: type alias used by §8.3
export const MerchantKind = z.enum(["amazon", "online", "in_person", "other"]);
export const DirectionSchema = z.enum(["outflow", "inflow"]);
export const Confidence = z.enum(["high", "medium", "low"]);
export const VoiceMode = z.enum(["browser", "server"]);
export const InputMode = z.enum(["typed", "browser_stt", "server_stt"]);
export const AuthType = z.enum(["oauth", "pat"]);
export type MerchantKind = z.infer<typeof MerchantKind>;
export type ConfidenceT = z.infer<typeof Confidence>;

export const CurrencyFormat = z.object({ isoCode: z.string(), decimalDigits: z.int() });
export type CurrencyFormat = z.infer<typeof CurrencyFormat>;

// ── settings ──────────────────────────────────────────────────────────────
export const SettingsShape = z.object({
  planId: Id.nullable(),
  timezone: z.string().min(1),                  // IANA, set from browser on onboarding
  createPlaceholders: z.boolean(),
  defaultAccountId: Id.nullable(),
  autoApproveMatches: z.boolean(),
  staleAfterDays: z.int().min(3).max(90),
  amazonWindowDays: z.int().min(3).max(45),
  maxTaxRate: z.number().min(0).max(0.25),
  flagColor: FlagColor.nullable(),              // flag put on transactions we touch
  voiceMode: VoiceMode,                         // 'server' only honoured if admin allowed
  aiDataConsent: z.boolean(),                   // must be true before any Claude call
});
export type Settings = z.infer<typeof SettingsShape>;
export const DEFAULT_SETTINGS: Settings = {
  planId: null, timezone: "UTC", createPlaceholders: true, defaultAccountId: null,
  autoApproveMatches: true, staleAfterDays: 14, amazonWindowDays: 21, maxTaxRate: 0.11,
  flagColor: "purple", voiceMode: "browser", aiDataConsent: false,
};
export const SettingsPatch = SettingsShape.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;
/** Merge stored JSON over defaults; drop any stored field that no longer validates. */
export function resolveSettings(stored: unknown): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored)) {
      const field = SettingsShape.shape[k as keyof Settings];
      if (field && field.safeParse(v).success) out[k] = v;
    }
  }
  return SettingsShape.parse(out);
}

// ── catalog (cached YNAB data) ────────────────────────────────────────────
export const Category = z.object({ id: Id, groupId: Id, groupName: z.string(), name: z.string() });
export const Account = z.object({ id: Id, name: z.string(), type: z.string(), onBudget: z.boolean(), closed: z.boolean(),
  directImportLinked: z.boolean() });           // false => intents on it become final entries
export const Payee = z.object({ id: Id, name: z.string() });
export type Category = z.infer<typeof Category>;
export type Account = z.infer<typeof Account>;
export type Payee = z.infer<typeof Payee>;

export const TxnView = z.object({
  id: Id,
  date: IsoDate,
  amount: SignedMilli,
  payeeName: z.string().nullable(),
  importPayeeName: z.string().nullable(),       // import_payee_name_original ?? import_payee_name
  accountId: Id,
  accountName: z.string(),
  categoryId: Id.nullable(),                    // null also for YNAB's internal "Uncategorized"
  memo: z.string().nullable(),
  approved: z.boolean(),
  cleared: z.enum(["cleared", "uncleared", "reconciled"]),
  isSplit: z.boolean(),
  isTransfer: z.boolean(),
  isImported: z.boolean(),
});
export type TxnView = z.infer<typeof TxnView>;

// ── intents ───────────────────────────────────────────────────────────────
export const IntentLineDraft = z.object({
  description: z.string().min(1).max(200),
  categoryId: Id.nullable(),
  amount: Milli.nullable(),
  approximate: z.boolean(),
  confidence: Confidence.nullable(),            // from Claude; null when user-entered
});
export type IntentLineDraft = z.infer<typeof IntentLineDraft>;

export const IntentDraft = z.object({
  payee: z.string().min(1).max(200),
  payeeId: Id.nullable(),
  merchantKind: MerchantKind,
  direction: DirectionSchema,
  date: IsoDate,
  accountId: Id.nullable(),
  accountExplicit: z.boolean(),
  totalAmount: Milli.nullable(),
  approximate: z.boolean(),
  memo: z.string().max(200).nullable(),
  lines: z.array(IntentLineDraft).min(1).max(20),
});
export type IntentDraft = z.infer<typeof IntentDraft>;

/** What POST /api/intents accepts: a draft the user has confirmed. */
export const IntentCreate = IntentDraft.extend({
  totalAmount: Milli.refine((v) => v > 0, "amount required"),
  lines: z.array(IntentLineDraft.extend({ categoryId: Id })).min(1).max(20),
  createPlaceholder: z.boolean(),
}).superRefine((d, ctx) => {
  if (d.lines.length > 1 && d.lines.some((l) => l.amount === null || l.amount <= 0))
    ctx.addIssue({ code: "custom", path: ["lines"], message: "every line needs an amount when there are several lines" });
});
export type IntentCreate = z.infer<typeof IntentCreate>;

export const IntentStatus = z.enum(["pending", "partial", "review", "resolved", "cancelled"]);
export const PlaceholderStatus = z.enum(["none", "created", "auto_matched", "deleted", "missing", "failed", "final"]);
export type IntentStatus = z.infer<typeof IntentStatus>; // WP1 addition
export type PlaceholderStatus = z.infer<typeof PlaceholderStatus>; // WP1 addition: used by §10.1

export const IntentLine = z.object({
  id: Id, idx: z.int(), description: z.string(), categoryId: Id, amount: Milli, tolerance: Milli,
  approximate: z.boolean(), status: z.enum(["open", "matched"]), matchedTxnId: Id.nullable(),
});
export const Intent = z.object({
  id: Id, shortRef: z.string(), status: IntentStatus, isStale: z.boolean(),
  rawText: z.string(), payee: z.string(), payeeId: Id.nullable(), merchantKind: MerchantKind,
  direction: DirectionSchema, date: IsoDate, accountId: Id.nullable(), accountExplicit: z.boolean(),
  totalAmount: Milli, tolerance: Milli, approximate: z.boolean(), memo: z.string().nullable(),
  placeholder: z.object({ txnId: Id.nullable(), status: PlaceholderStatus, amount: Milli.nullable() }),
  expiresOn: IsoDate, createdAt: z.int(), resolvedAt: z.int().nullable(),
  lines: z.array(IntentLine),
  matchedTransactionIds: z.array(Id),
});
export type Intent = z.infer<typeof Intent>;
export type IntentLine = z.infer<typeof IntentLine>;

// ── reviews ───────────────────────────────────────────────────────────────
export const Allocation = z.object({ categoryId: Id, amount: SignedMilli, memo: z.string().nullable() });
export type Allocation = z.infer<typeof Allocation>;
export const ReviewKind = z.enum(["ambiguous_match", "amazon_split", "ynab_matched_other", "split_conflict", "too_complex", "approved_import"]);
export type ReviewKind = z.infer<typeof ReviewKind>; // WP1 addition: used by §10.1
export const ReviewOption = z.object({
  id: z.string(),                               // stable within the review, e.g. "o1"
  label: z.string(),                            // human summary: "Costco $173.50 on Nov 14"
  intentId: Id,                                 // may differ between options of a cross-intent review
  transactionId: Id,
  lineIds: z.array(Id),
  allocation: z.array(Allocation),              // sums exactly to the txn amount
  score: z.number(),
});
export type ReviewOption = z.infer<typeof ReviewOption>;
export const ReviewItem = z.object({
  id: Id, kind: ReviewKind,
  intentId: Id.nullable(),                      // owner; null for a cross-intent review
  transactionId: Id.nullable(),
  summary: z.string(), createdAt: z.int(),
  options: z.array(ReviewOption),               // may be empty for split_conflict / too_complex
  transactions: z.array(TxnView),               // every txn referenced by options (+ transactionId)
  intents: z.array(Intent),                     // every intent referenced by options (+ owner)
});
export type ReviewItem = z.infer<typeof ReviewItem>;

// ── activity / audit ──────────────────────────────────────────────────────
export const AuditAction = z.enum([
  "login", "logout", "settings_changed", "secret_changed", "admin_change",
  "intent_created", "intent_updated", "intent_extended", "intent_cancelled", "intent_resolved", "intent_kept_final",
  "placeholder_created", "placeholder_updated", "placeholder_deleted", "placeholder_delete_refused", "final_entry_created",
  "txn_categorized", "txn_split", "txn_approved",
  "review_created", "review_resolved", "review_dismissed",
]);
export type AuditAction = z.infer<typeof AuditAction>;
/** Frozen shape of audit_log.before_json/after_json for every txn write (D15). Enough to replay a later undo. */
export const TxnSnapshot = z.object({
  categoryId: Id.nullable(), approved: z.boolean(), memo: z.string().nullable(),
  flagColor: FlagColor.nullable(), isSplit: z.boolean(),
});
export type TxnSnapshot = z.infer<typeof TxnSnapshot>;
export const ActivityEntry = z.object({
  id: Id, at: z.int(), actor: z.enum(["user", "cron", "app"]), action: AuditAction,
  summary: z.string(), intentId: Id.nullable(), transactionId: Id.nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

// ── me / admin / sync ─────────────────────────────────────────────────────
export const Me = z.object({
  userId: Id, isAdmin: z.boolean(), authType: AuthType,
  needsReauth: z.boolean(), sttAllowed: z.boolean(), hasAnthropicKey: z.boolean(),
  oauthAvailable: z.boolean(), settings: SettingsShape,
  plan: z.object({ id: Id, name: z.string(), currency: CurrencyFormat }).nullable(),
  counts: z.object({ pending: z.int(), stale: z.int(), review: z.int() }),
  lastSyncError: z.string().nullable(),         // sync_state.last_error, e.g. "ynab_subscription_lapsed: …"
  lastSyncAt: z.int().nullable(),               // sync_state.last_cycle_at (epoch ms), shown as "Last synced …"
});
export type Me = z.infer<typeof Me>;
export const AdminUser = z.object({
  userId: Id, isAdmin: z.boolean(), sttAllowed: z.boolean(),
  authType: AuthType, createdAt: z.int(), lastSeenAt: z.int(),
});
export type AdminUser = z.infer<typeof AdminUser>; // WP1 addition
export const SyncResult = z.object({
  ranAt: z.int(),
  skipped: z.enum(["throttled", "locked", "rate_limited", "no_plan", "reauth", "not_allowed", "error"]).nullable(),
  changedTransactions: z.int(), matched: z.int(), reviewsCreated: z.int(),
  stale: z.int(),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),  // ErrorCode values + per-decision engine errors
});
export type SyncResult = z.infer<typeof SyncResult>;
