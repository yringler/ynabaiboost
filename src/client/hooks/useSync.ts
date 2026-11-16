// hooks/useSync.ts — WP6. POST /api/sync only from the "Sync now" button / pull-to-refresh;
// no auto-sync on mount or focus (owner decision, DESIGN D11). Stub created by WP1.
import type { UseMutationResult } from "@tanstack/react-query";
import type { SyncResult } from "../../shared/schemas";
import type { ApiError } from "../lib/api";

export function useSync(): UseMutationResult<SyncResult, ApiError, void> {
  throw new Error("not implemented: useSync");
}
