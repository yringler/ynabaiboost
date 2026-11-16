// hooks/useMe.ts — WP6. GET /api/me. 401/403 surface as ApiError (the router guard redirects).
import { queryOptions, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Me } from "../../shared/schemas";
import { call, type ApiError } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

export const meQueryOptions = queryOptions<Me, ApiError>({
  queryKey: queryKeys.me,
  queryFn: ({ signal }) => call("me", { signal }),
  staleTime: 30_000,
});

export function useMe(): UseQueryResult<Me, ApiError> {
  return useQuery(meQueryOptions);
}

/** Plan, Anthropic key and AI consent are required before the main screens (§11.2 guards). */
export function needsOnboarding(me: Me): boolean {
  return !me.settings.planId || !me.hasAnthropicKey || !me.settings.aiDataConsent;
}
