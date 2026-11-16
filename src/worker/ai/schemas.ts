// ai/schemas.ts — WP4 (DESIGN §9.2). Created by WP1 verbatim from the design; WP4 owns it.
import { z } from "zod";

export const ParsedLine = z.object({
  description: z.string().describe("Short item description, e.g. 'phone case'"),
  category_ref: z.string().nullable().describe("Ref from CATEGORIES, e.g. 'c12'; null if nothing fits"),
  category_confidence: z.enum(["high", "medium", "low"]),
  amount: z.number().nullable().describe("This line's amount in currency units, e.g. 12.99; null if unknown"),
  amount_is_estimate: z.boolean().describe("true if you estimated or the user rounded"),
});
export const ParsedTransaction = z.object({
  payee: z.string().describe("Canonical merchant name, e.g. 'Costco'; reuse PAYEES spelling when it obviously matches"),
  merchant_kind: z.enum(["amazon", "online", "in_person", "other"]),
  direction: z.enum(["outflow", "inflow"]),
  date: z.string().describe("YYYY-MM-DD, resolved against TODAY; never in the future"),
  account_ref: z.string().nullable().describe("Ref from ACCOUNTS only if the user named an account/card"),
  total_amount: z.number().nullable().describe("Total in currency units as the user said it"),
  total_is_approximate: z.boolean(),
  memo: z.string().nullable().describe("≤ 80 chars summary of items, or null"),
  lines: z.array(ParsedLine),
});
export const ParsedUtterance = z.object({
  status: z.enum(["ok", "not_a_transaction", "needs_clarification"]),
  clarification_question: z.string().nullable(),
  transactions: z.array(ParsedTransaction),
});

