// lib/queryKeys.ts — WP6 (DESIGN §11.1).
export const queryKeys = {
  me: ["me"] as const,
  catalog: ["catalog"] as const,
  plans: ["plans"] as const,
  authConfig: ["authConfig"] as const,
  intents: (status: "open" | "stale" | "resolved" | "cancelled") => ["intents", status] as const,
  intentsAll: ["intents"] as const,
  candidates: (intentId: string) => ["candidates", intentId] as const,
  reviews: ["reviews"] as const,
  activity: ["activity"] as const,
  adminUsers: ["adminUsers"] as const,
};

/** Mutation key of the manual "Sync now" mutation (read back with useMutationState for banners). */
export const syncMutationKey = ["sync"] as const;

/** Everything a sync or a write can change. Invalidated after "Sync now" and after intent/review writes. */
export const DATA_KEYS = [
  queryKeys.me, queryKeys.intentsAll, queryKeys.reviews, queryKeys.activity,
] as const;
