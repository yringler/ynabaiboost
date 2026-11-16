// lib/routing.ts — WP6: search-param parsing and helpers shared by router.tsx and route components (no cycles).

export interface LoginSearch {
  error?: string;
  uid?: string;
  pat?: boolean;
  redirect?: string;
}
export type PendingTab = "review" | "pending" | "stale";
export interface PendingSearch {
  tab?: PendingTab;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function parseLoginSearch(s: Record<string, unknown>): LoginSearch {
  const out: LoginSearch = {};
  const error = str(s.error);
  const uid = str(s.uid) ?? (typeof s.uid === "number" ? String(s.uid) : undefined);
  const redirectTo = str(s.redirect);
  if (error) out.error = error;
  if (uid) out.uid = uid;
  if (s.pat === true || s.pat === 1 || s.pat === "1" || s.pat === "true" || s.pat === "") out.pat = true;
  // Only same-app paths, never an absolute URL (open-redirect guard).
  if (redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//")) out.redirect = redirectTo;
  return out;
}

/** Pulls a YNAB user id out of a not_allowed message ("… Send your user id abc-123 to the owner"). */
export function extractUserId(message: string): string | undefined {
  const m = /user id[:\s]+([A-Za-z0-9-]{4,64})/i.exec(message);
  return m?.[1];
}
