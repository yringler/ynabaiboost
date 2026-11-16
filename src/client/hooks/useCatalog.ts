// hooks/useCatalog.ts — WP6. GET /api/catalog (cached YNAB data; the worker runs an initial sync when empty).
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { z } from "zod";
import type { CatalogRes } from "../../shared/api";
import { call, type ApiError } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

export type Catalog = z.infer<typeof CatalogRes>;

export function useCatalog(opts: { enabled?: boolean } = {}): UseQueryResult<Catalog, ApiError> {
  return useQuery<Catalog, ApiError>({
    queryKey: queryKeys.catalog,
    queryFn: ({ signal }) => call("catalog", { signal }),
    staleTime: 5 * 60_000,
    enabled: opts.enabled ?? true,
  });
}
