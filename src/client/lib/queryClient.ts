// lib/queryClient.ts — WP6: one QueryClient for the app. No refetch-on-focus *sync* exists anywhere:
// queries only re-read the worker's D1 cache; YNAB is contacted by cron, "Sync now" and intent creation (D11).
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api";

export function createAppQueryClient(onUnauthenticated: () => void): QueryClient {
  const handle = (e: unknown) => {
    if (isApiError(e) && e.status === 401) onUnauthenticated();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        // Client errors (401/403/404/409/422) won't fix themselves; retry only network/5xx once.
        retry: (count, e) => !(isApiError(e) && e.status >= 400 && e.status < 500) && count < 1,
        staleTime: 15_000,
      },
      mutations: { retry: false },
    },
  });
}
