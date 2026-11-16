// hooks/useMe.ts — WP6. Stub created by WP1.
import type { UseQueryResult } from "@tanstack/react-query";
import type { Me } from "../../shared/schemas";
import type { ApiError } from "../lib/api";

export function useMe(): UseQueryResult<Me, ApiError> {
  throw new Error("not implemented: useMe");
}
