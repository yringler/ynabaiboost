// ai/schemas.ts — WP4 (DESIGN §9.2). Created by WP1 verbatim from the design; WP4 owns it.
import { z } from "zod";

export const ParsedLine = z.object({
  description: z.string().describe("Short item description, e.g. 'phone case'"),
  category_ref: z.string().nullable().describe("Ref from CATEGORIES, e.g. 'c12'; null if nothing fits"),
  category_confidence: z.enum(["high", "medium", "low"]),
  amount: z.number().nullable().describe("This line's amount in currency units, e.g. 12.99; null if unknown"),
  amount_is_estimate: z.boolean().describe("true if you estimated or the user rounded"),
  quantity: z.number().int().describe("Quantity as written (e.g. 'Qty: 2'); 1 if not stated. amount is the line total"),
});
/** Facts copied from the note or a pasted order page. Reported, never trusted: postprocess/precision verify them. */
export const ParsedShipment = z.object({
  line_numbers: z.array(z.number().int()).describe("1-based numbers of this transaction's lines in this shipment/delivery"),
  total: z.number().nullable().describe("Amount charged for this shipment if the text shows it, else null"),
});
export const ParsedOrder = z.object({
  item_subtotal: z.number().nullable().describe("'Item(s) Subtotal' as written, else null"),
  tax: z.number().nullable().describe("Tax as written (e.g. 'Estimated tax to be collected'), else null"),
  shipping: z.number().nullable().describe("Shipping & handling as written, else null"),
  discount: z.number().nullable().describe("Sum of promotions, coupons and free-shipping credits as a positive number, else null"),
  gift_card: z.number().nullable().describe("Gift card / reward points / store credit applied, positive, else null"),
  grand_total: z.number().nullable().describe("'Grand Total' / 'Order Total' as written, else null"),
  shipments: z.array(ParsedShipment).describe("Shipment groups if the text groups items into shipments; else []"),
});
export const ParsedTransaction = z.object({
  payee: z.string().describe("Canonical merchant name, e.g. 'Costco'; reuse PAYEES spelling when it obviously matches"),
  merchant_kind: z.enum(["amazon", "online", "in_person", "other"]),
  direction: z.enum(["outflow", "inflow"]),
  date: z.string().describe("YYYY-MM-DD, resolved against TODAY; never in the future"),
  account_ref: z.string().nullable().describe("Ref from ACCOUNTS only if the user named an account/card"),
  total_amount: z.number().nullable().describe("Total in currency units as the user said it"),
  total_is_approximate: z.boolean(),
  total_has_cents: z.boolean().describe("true only if the total is written in the text with explicit cents, e.g. '48.10'"),
  order: ParsedOrder.nullable().describe("Order summary facts when the text shows any (pasted order page); else null"),
  clarity_note: z.string().nullable().describe("One short sentence for the user on what is missing or unclear for exact matching; null if nothing"),
  memo: z.string().nullable().describe("≤ 80 chars summary of items, or null"),
  lines: z.array(ParsedLine),
});
export const ParsedUtterance = z.object({
  status: z.enum(["ok", "not_a_transaction", "needs_clarification"]),
  clarification_question: z.string().nullable(),
  transactions: z.array(ParsedTransaction),
});


// ── conversational edit (DESIGN §9.6) ────────────────────────────────────────
// Closed discriminated union; every field is required (null = "no change"), so the JSON schema is strict-mode
// compatible (anyOf of objects with additionalProperties:false). Items and lines are addressed by the refs the
// prompt shows (i1.., 1-based line numbers, c../a.. catalog refs): the model never sees or emits a database id.
const itemRef = z.string().describe("Ref of an item from OPEN ITEMS, e.g. 'i3'");
const lineNo = z.number().int().describe("1-based line number within that item, as listed (L1, L2, …)");

export const EditUpdateIntent = z.object({
  type: z.literal("update_intent"),
  intent_ref: itemRef,
  payee: z.string().nullable().describe("New merchant name, or null to keep"),
  date: z.string().nullable().describe("New date YYYY-MM-DD resolved against TODAY, or null to keep"),
  account_ref: z.string().nullable().describe("Ref from ACCOUNTS when the user names an account/card, or null to keep"),
  memo: z.string().nullable().describe("New memo; empty string clears it; null keeps it"),
  total_amount: z.number().nullable().describe("New total in currency units as the user said it, or null to keep"),
  total_is_approximate: z.boolean().nullable().describe("With total_amount: true if hedged or rounded; else null"),
});
export const EditUpdateLine = z.object({
  type: z.literal("update_line"),
  intent_ref: itemRef,
  line_number: lineNo,
  category_ref: z.string().nullable().describe("Ref from CATEGORIES, or null to keep"),
  amount: z.number().nullable().describe("New line amount in currency units, or null to keep"),
  amount_is_estimate: z.boolean().nullable().describe("With amount: true if estimated or derived; else null"),
  description: z.string().nullable().describe("New description, or null to keep"),
});
export const EditAddLine = z.object({
  type: z.literal("add_line"),
  intent_ref: itemRef,
  category_ref: z.string().describe("Ref from CATEGORIES"),
  amount: z.number().describe("Line amount in currency units"),
  amount_is_estimate: z.boolean(),
  description: z.string(),
});
export const EditRemoveLine = z.object({ type: z.literal("remove_line"), intent_ref: itemRef, line_number: lineNo });
export const EditDeleteIntent = z.object({ type: z.literal("delete_intent"), intent_ref: itemRef });
export const EditExtend = z.object({
  type: z.literal("extend"), intent_ref: itemRef,
  days: z.number().int().nullable().describe("Days to keep watching (1-90); null for the default 7"),
});
export const EditKeepFinal = z.object({ type: z.literal("keep_final"), intent_ref: itemRef });
export const EditCreateIntent = z.object({
  type: z.literal("create_intent"),
  transaction: ParsedTransaction.describe("A new purchase, exactly like a parsed note"),
});
export const EditClarify = z.object({
  type: z.literal("clarify"),
  question: z.string().describe("One short question when the request is ambiguous or matches several items"),
});

export const EditModelAction = z.discriminatedUnion("type", [
  EditUpdateIntent, EditUpdateLine, EditAddLine, EditRemoveLine, EditDeleteIntent, EditExtend, EditKeepFinal,
  EditCreateIntent, EditClarify,
]);
export const EditModelPlan = z.object({
  summary: z.string().describe("One short sentence describing the change, e.g. 'Moved Costco to Nov 13'"),
  actions: z.array(EditModelAction),
});
