// components/TxnRow.tsx — WP6 (DESIGN §11.1): date, payee, amount, account, category chip.
import type { ReactNode } from "react";
import type { CurrencyFormat, TxnView } from "../../shared/schemas";
import { formatDate, formatMoney } from "../lib/format";
import { cn } from "../lib/utils";

export interface TxnRowProps {
  txn: TxnView;
  currency: CurrencyFormat | null;
  /** Category chip / suggestion slot under the payee. */
  chip?: ReactNode;
  /** Right-hand actions (approve, dismiss…). */
  actions?: ReactNode;
  className?: string;
}

export const txnPayee = (t: TxnView): string => t.payeeName ?? t.importPayeeName ?? "(no payee)";

export function TxnRow({ txn, currency, chip, actions, className }: TxnRowProps) {
  const inflow = txn.amount > 0;
  return (
    <div className={cn("flex items-start gap-3 py-3", className)} data-testid="txn-row">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{txnPayee(txn)}</span>
          <span className={cn("tabular shrink-0 font-medium", inflow && "text-ok")}>
            {inflow ? "+" : "−"}
            {formatMoney(Math.abs(txn.amount), currency)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{formatDate(txn.date)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{txn.accountName}</span>
          {txn.importPayeeName && txn.payeeName && txn.importPayeeName !== txn.payeeName && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate font-mono">{txn.importPayeeName}</span>
            </>
          )}
          {!txn.approved && (
            <>
              <span aria-hidden>·</span>
              <span>unapproved</span>
            </>
          )}
        </div>
        {chip && <div className="pt-1">{chip}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1 self-center">{actions}</div>}
    </div>
  );
}
