// lib/api.ts — WP6 (DESIGN §11.1, D17): typed fetch helper driven by the shared route table.
// Signatures created by WP1; WP6 implements. Always send Content-Type: application/json with a body.
import type { z } from "zod";
import { API, type ApiKey, type ErrorCode } from "../../shared/api";

type RouteOf<K extends ApiKey> = (typeof API)[K];
export type ReqOf<K extends ApiKey> = RouteOf<K>["req"] extends z.ZodType ? z.input<RouteOf<K>["req"]> : never;
export type QueryOf<K extends ApiKey> = RouteOf<K>["query"] extends z.ZodType ? z.input<RouteOf<K>["query"]> : never;
export type ResOf<K extends ApiKey> = z.output<RouteOf<K>["res"]>;

export interface CallOpts<K extends ApiKey> {
  params?: Record<string, string>;
  query?: QueryOf<K>;
  body?: ReqOf<K>;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function call<K extends ApiKey>(key: K, _opts?: CallOpts<K>): Promise<ResOf<K>> {
  void API[key];
  throw new Error("not implemented: call");
}
