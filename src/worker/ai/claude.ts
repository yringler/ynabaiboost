// ai/claude.ts — WP4 (DESIGN §8.4, §9.1). Stub created by WP1.
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { DB } from "../env";

export const CLAUDE_MODEL = "claude-opus-5-5";

/** Via getAnthropicKey. */
export async function getClaude(_env: Env, _db: DB, _userId: string): Promise<Anthropic> {
  throw new Error("not implemented: getClaude");
}
/** messages.parse + zodOutputFormat with the §9.4 error policy. */
export async function callStructured<T extends z.ZodType>(_client: Anthropic, _args: {
  schema: T; system: Anthropic.TextBlockParam[]; user: string;
  effort: "low" | "medium"; maxTokens: number; timeoutMs: number; maxRetries: number;
}): Promise<z.infer<T>> {
  throw new Error("not implemented: callStructured");
}
