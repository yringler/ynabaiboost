// components/ReviewCard.tsx — WP6 (DESIGN §11.1): summary + one-tap option buttons + "None of these".
import type { Category, CurrencyFormat, ReviewItem } from "../../shared/schemas";
import { formatApprox, formatMoney } from "../lib/format";
import { TxnRow } from "./TxnRow";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const KIND_LABEL: Record<ReviewItem["kind"], string> = {
  ambiguous_match: "Which charge is it?",
  amazon_split: "Split this order",
  ynab_matched_other: "YNAB matched something else",
  split_conflict: "Already split in YNAB",
  too_complex: "Too many possibilities",
  approved_import: "Already categorized in YNAB",
};

export interface ReviewCardProps {
  review: ReviewItem;
  currency: CurrencyFormat | null;
  categories: Category[];
  busy?: boolean;
  onResolve: (optionId: string) => void;
  onDismiss: () => void;
}

export function ReviewCard({ review, currency, categories, busy, onResolve, onDismiss }: ReviewCardProps) {
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? "Unknown category";
  const crossIntent = review.intentId === null && review.intents.length > 1;
  const txnById = new Map(review.transactions.map((t) => [t.id, t]));
  const intentById = new Map(review.intents.map((i) => [i.id, i]));
  return (
    <Card className="gap-3 py-4" data-testid="review-card">
      <CardHeader className="px-4">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{KIND_LABEL[review.kind]}</Badge>
        </div>
        <CardTitle className="text-base leading-snug font-medium">{review.summary}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {(crossIntent || review.intents.length > 0) && (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {review.intents.map((i) => (
              <li key={i.id}>
                You said: <span className="text-foreground">{i.payee}</span>{" "}
                <span className="tabular">{formatApprox(i.totalAmount, i.approximate, currency)}</span>
                {i.lines.length > 1 && ` (${i.lines.map((l) => l.description).join(", ")})`}
              </li>
            ))}
          </ul>
        )}
        {review.options.length === 0 && review.transactions.length > 0 && (
          <div className="divide-y rounded-lg border px-3">
            {review.transactions.map((t) => <TxnRow key={t.id} txn={t} currency={currency} />)}
          </div>
        )}
        <div className="flex flex-col gap-2">
          {review.options.map((o) => {
            const t = txnById.get(o.transactionId);
            const intent = intentById.get(o.intentId);
            return (
              <Button
                key={o.id}
                type="button"
                variant="outline"
                className="h-auto min-h-11 flex-col items-start gap-1 py-2 text-left whitespace-normal"
                disabled={busy}
                onClick={() => onResolve(o.id)}
              >
                <span className="font-medium">{o.label}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {crossIntent && intent ? `For ${intent.payee} · ` : ""}
                  {t ? `${t.accountName} · ` : ""}
                  {o.allocation.map((a) => `${catName(a.categoryId)} ${formatMoney(Math.abs(a.amount), currency)}`).join(" + ")}
                </span>
              </Button>
            );
          })}
          <Button type="button" variant="ghost" className="h-11" disabled={busy} onClick={onDismiss}>
            None of these
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
