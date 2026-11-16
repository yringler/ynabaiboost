// hooks/useCatalog.ts — WP6. Stub created by WP1.
import type { UseQueryResult } from "@tanstack/react-query";
import type { z } from "zod";
import type { CatalogRes } from "../../shared/api";
import type { ApiError } from "../lib/api";

export function useCatalog(): UseQueryResult<z.infer<typeof CatalogRes>, ApiError> {
  throw new Error("not implemented: useCatalog");
}
