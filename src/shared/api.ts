// src/shared/api.ts
import { z } from "zod";
import {
  ActivityEntry, AdminUser, Account, Category, CurrencyFormat, Id, Intent, IntentCreate,
  IntentDraft, IntentLineDraft, InputMode, IsoDate, Me, Payee, ReviewItem, SettingsPatch,
  SettingsShape, SyncResult, TxnView,
} from "./schemas";

export const ErrorCode = z.enum([
  "unauthenticated", "forbidden", "not_allowed", "not_found", "validation", "conflict", "rate_limited",
  "ynab_reauth_required", "ynab_rate_limited", "ynab_subscription_lapsed", "ynab_error", "no_plan_selected",
  "anthropic_key_missing", "anthropic_key_invalid", "anthropic_billing", "ai_consent_required", "ai_refusal", "ai_unavailable",
  "stt_not_allowed", "payload_too_large", "unsupported_media", "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const ApiErrorBody = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, forbidden: 403, not_allowed: 403, not_found: 404, validation: 400,
  conflict: 409, rate_limited: 429, ynab_reauth_required: 409, ynab_rate_limited: 429,
  ynab_subscription_lapsed: 409, ynab_error: 502,                  // YNAB 403.1 / 403.2 → subscription_lapsed
  no_plan_selected: 409, anthropic_key_missing: 409, anthropic_key_invalid: 409, anthropic_billing: 409,
  ai_consent_required: 409, ai_refusal: 422, ai_unavailable: 503, stt_not_allowed: 403,
  payload_too_large: 413, unsupported_media: 415, internal: 500,
};

const Ok = z.object({ ok: z.literal(true) });

// requests
export const PatLoginReq = z.object({ token: z.string().trim().min(20).max(200) });
export const AnthropicKeyReq = z.object({ apiKey: z.string().trim().startsWith("sk-ant-").max(300) });
export const ParseReq = z.object({ text: z.string().trim().min(1).max(2000), inputMode: InputMode });
export const CreateIntentsReq = z.object({ intents: z.array(IntentCreate).min(1).max(10), rawText: z.string().max(2000), inputMode: InputMode });
export const UpdateIntentReq = z.object({
  payee: z.string().min(1).max(200).optional(), date: IsoDate.optional(),
  accountId: Id.nullable().optional(), totalAmount: z.int().positive().optional(),
  approximate: z.boolean().optional(), memo: z.string().max(200).nullable().optional(),
  lines: z.array(IntentLineDraft.extend({ categoryId: Id, amount: z.int().positive() })).min(1).max(20).optional(),
}).strict();
export const ExtendIntentReq = z.object({ days: z.int().min(1).max(90) });
export const LinkIntentReq = z.object({ transactionId: Id, lineIds: z.array(Id).nullable() }); // null = all open lines
export const ResolveReviewReq = z.union([
  z.object({ optionId: z.string() }),
  z.object({ dismiss: z.literal(true) }),
]);
export const AdminUserPatchReq = z.object({ sttAllowed: z.boolean() }).strict();
export const IntentListQuery = z.object({ status: z.enum(["open", "stale", "resolved", "cancelled"]).default("open") });
export const ActivityQuery = z.object({ before: z.coerce.number().int().optional() });

// responses
export const PlansRes = z.object({ plans: z.array(z.object({ id: Id, name: z.string() })) });
export const CatalogRes = z.object({
  planId: Id, currency: CurrencyFormat, categories: z.array(Category),
  accounts: z.array(Account), payees: z.array(Payee),          // top 200 by recent use
  recentCategoryIds: z.array(Id),                               // most-used first, max 15
});
export const ParseRes = z.object({
  status: z.enum(["ok", "not_a_transaction", "needs_clarification"]),
  question: z.string().nullable(),
  drafts: z.array(IntentDraft),
  warnings: z.array(z.string()),
});
export const IntentsRes = z.object({ intents: z.array(Intent) });
export const IntentRes = z.object({ intent: Intent });
export const CreateIntentsRes = z.object({ intents: z.array(Intent), warnings: z.array(z.string()) });
export const CandidatesRes = z.object({ transactions: z.array(TxnView) });
export const ReviewsRes = z.object({ reviews: z.array(ReviewItem) });
export const ActivityRes = z.object({ entries: z.array(ActivityEntry), nextCursor: z.int().nullable() });
export const AdminUsersRes = z.object({ users: z.array(AdminUser) });
export const SttRes = z.object({ text: z.string() });
export const AuthConfigRes = z.object({ oauthAvailable: z.boolean() });

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const route = <Req extends z.ZodType | null, Res extends z.ZodType, Q extends z.ZodType | null = null>(
  method: Method, path: string, req: Req, res: Res, query: Q = null as Q) =>
  ({ method, path, req, res, query }) as const;
// Worker: zValidator("query", API.x.query) when query ≠ null. Client: call(key, { params, query, body }) is typed from it.

/** Single source of truth for paths. `:param` segments are substituted by the client helper. */
export const API = {
  me:              route("GET",    "/api/me", null, Me),
  getSettings:     route("GET",    "/api/settings", null, SettingsShape),
  patchSettings:   route("PATCH",  "/api/settings", SettingsPatch, SettingsShape),
  putAnthropicKey: route("PUT",    "/api/secrets/anthropic", AnthropicKeyReq, Ok),
  delAnthropicKey: route("DELETE", "/api/secrets/anthropic", null, Ok),
  deleteAccount:   route("DELETE", "/api/account", null, Ok),
  plans:           route("GET",    "/api/plans", null, PlansRes),
  catalog:         route("GET",    "/api/catalog", null, CatalogRes),
  sync:            route("POST",   "/api/sync", null, SyncResult),
  parse:           route("POST",   "/api/intents/parse", ParseReq, ParseRes),
  createIntents:   route("POST",   "/api/intents", CreateIntentsReq, CreateIntentsRes),
  listIntents:     route("GET",    "/api/intents", null, IntentsRes, IntentListQuery),
  getIntent:       route("GET",    "/api/intents/:id", null, IntentRes),
  updateIntent:    route("PATCH",  "/api/intents/:id", UpdateIntentReq, IntentRes),
  extendIntent:    route("POST",   "/api/intents/:id/extend", ExtendIntentReq, IntentRes),
  cancelIntent:    route("DELETE", "/api/intents/:id", null, IntentRes),
  keepIntent:      route("POST",   "/api/intents/:id/keep", null, IntentRes),   // "Keep as final"
  candidates:      route("GET",    "/api/intents/:id/candidates", null, CandidatesRes),
  linkIntent:      route("POST",   "/api/intents/:id/link", LinkIntentReq, IntentRes),
  listReviews:     route("GET",    "/api/reviews", null, ReviewsRes),
  resolveReview:   route("POST",   "/api/reviews/:id/resolve", ResolveReviewReq, Ok),
  stt:             route("POST",   "/api/stt", null, SttRes),                  // raw audio body
  activity:        route("GET",    "/api/activity", null, ActivityRes, ActivityQuery),
  adminUsers:      route("GET",    "/api/admin/users", null, AdminUsersRes),
  adminPatchUser:  route("PATCH",  "/api/admin/users/:id", AdminUserPatchReq, AdminUser),
  authConfig:      route("GET",    "/auth/config", null, AuthConfigRes),
  patLogin:        route("POST",   "/auth/pat", PatLoginReq, Me),
  logout:          route("POST",   "/auth/logout", null, Ok),
} as const;
export type ApiKey = keyof typeof API;
