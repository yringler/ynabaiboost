// hooks/useSync.ts — WP6. POST /api/sync only from the "Sync now" button (owner decision, DESIGN D11):
// never on mount, on focus, or on an interval. Background syncs come from the 6-hourly cron.
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SyncResult } from "../../shared/schemas";
import { call, errorMessage, type ApiError } from "../lib/api";
import { DATA_KEYS, queryKeys, syncMutationKey } from "../lib/queryKeys";

export function describeSync(r: SyncResult): { kind: "success" | "info" | "error"; text: string } {
  if (r.errors.length > 0) return { kind: "error", text: r.errors.map((e) => e.message || e.code).join(" · ") };
  switch (r.skipped) {
    case "throttled": return { kind: "info", text: "Synced less than a minute ago" };
    case "locked": return { kind: "info", text: "A sync is already running" };
    case "rate_limited": return { kind: "error", text: "YNAB is rate limiting us. Try again later." };
    case "no_plan": return { kind: "error", text: "Pick a YNAB plan first" };
    case "reauth": return { kind: "error", text: "Reconnect YNAB to sync" };
    case "not_allowed": return { kind: "error", text: "This account is not allowed" };
    case "error": return { kind: "error", text: "Sync failed" };
    case null: break;
  }
  const parts: string[] = [];
  if (r.matched) parts.push(`${r.matched} matched`);
  if (r.reviewsCreated) parts.push(`${r.reviewsCreated} to review`);
  if (r.changedTransactions) parts.push(`${r.changedTransactions} updated`);
  return { kind: "success", text: parts.length ? `Synced · ${parts.join(", ")}` : "Synced · nothing new" };
}

export function useSync(): UseMutationResult<SyncResult, ApiError, void> {
  const qc = useQueryClient();
  return useMutation<SyncResult, ApiError, void>({
    mutationKey: syncMutationKey,
    mutationFn: () => call("sync"),
    onSuccess: async (r) => {
      const d = describeSync(r);
      if (d.kind === "error") toast.error(d.text);
      else if (d.kind === "info") toast(d.text);
      else toast.success(d.text);
      await Promise.all([
        ...DATA_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })),
        qc.invalidateQueries({ queryKey: queryKeys.catalog }),
      ]);
    },
    onError: (e) => {
      toast.error(errorMessage(e));
    },
  });
}
