// ai/parse.ts — WP4 (DESIGN §8.4). Stub created by WP1.
import type { z } from "zod";
import type { ParseRes } from "../../shared/api";
import type { Settings } from "../../shared/schemas";
import type { DB } from "../env";

export interface AiCtx { env: Env; db: DB; userId: string; planId: string; settings: Settings }
export async function parseUtterance(_ctx: AiCtx, _text: string): Promise<z.infer<typeof ParseRes>> {
  throw new Error("not implemented: parseUtterance");
}
