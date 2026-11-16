// lib/queryKeys.ts — WP6 (DESIGN §11.1). Created by WP1.
export const queryKeys = {
  me: ["me"] as const,
  catalog: ["catalog"] as const,
  intents: (status: "open" | "stale" | "resolved" | "cancelled") => ["intents", status] as const,
  reviews: ["reviews"] as const,
  inbox: ["inbox"] as const,
  activity: ["activity"] as const,
};
