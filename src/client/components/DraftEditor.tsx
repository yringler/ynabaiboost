// components/DraftEditor.tsx — WP6 (DESIGN §11.1–§11.2): one IntentDraft: payee, total, ≈, date, account, lines[],
// placeholder toggle. Line amounts must add up to the total (live sum shown).
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId } from "react";
import type { Catalog } from "../hooks/useCatalog";
import { draftSums, emptyLine, resolvePayeeId, type DraftState } from "../lib/draft";
import { formatMoney, milliToInput } from "../lib/format";
import { cn } from "../lib/utils";
import { AccountSelect } from "./AccountSelect";
import { LineRow } from "./LineRow";
import { MoneyInput } from "./MoneyInput";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

export interface DraftEditorProps {
  draft: DraftState;
  onChange: (draft: DraftState) => void;
  onRemove?: () => void;
  catalog: Pick<Catalog, "categories" | "accounts" | "payees" | "recentCategoryIds" | "currency">;
  /** settings.createPlaceholders; when false the per-intent toggle is shown disabled. */
  placeholdersEnabled: boolean;
  errors?: string[];
}

export function DraftEditor({ draft, onChange, onRemove, catalog, placeholdersEnabled, errors = [] }: DraftEditorProps) {
  const id = useId();
  const decimals = catalog.currency.decimalDigits;
  const sums = draftSums(draft, decimals);
  const multi = draft.lines.length > 1;
  const account = draft.accountId ? catalog.accounts.find((a) => a.id === draft.accountId) : undefined;
  const finalEntry = account !== undefined && !account.directImportLinked;
  const totalInvalid = draft.totalText.trim() !== "" && sums.total === null;
  const set = (patch: Partial<DraftState>) => onChange({ ...draft, ...patch });

  return (
    <Card className="gap-3 py-4" data-testid="draft-editor">
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor={`${id}-payee`} className="flex items-center gap-2">
              Payee
              {draft.payee.trim() !== "" && draft.payeeId === null && (
                <Badge variant="outline" className="text-[11px]">new payee</Badge>
              )}
            </Label>
            <Input
              id={`${id}-payee`}
              value={draft.payee}
              maxLength={200}
              onChange={(e) => set({ payee: e.target.value, payeeId: resolvePayeeId(e.target.value, catalog.payees) })}
              className="h-11 text-base"
              autoComplete="off"
              list={`${id}-payees`}
            />
            <datalist id={`${id}-payees`}>
              {catalog.payees.slice(0, 200).map((p) => <option key={p.id} value={p.name} />)}
            </datalist>
          </div>
          {onRemove && (
            <Button type="button" variant="ghost" size="icon-lg" className="mt-6 size-11" onClick={onRemove} aria-label="Discard this entry">
              <Trash2Icon />
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-total`}>{draft.direction === "inflow" ? "Inflow" : "Total"}</Label>
            <MoneyInput
              id={`${id}-total`}
              label="Total"
              value={draft.totalText}
              onChange={(totalText) => set({ totalText })}
              approximate={draft.approximate}
              onApproximateChange={(approximate) => set({ approximate })}
              invalid={totalInvalid}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-date`}>Date</Label>
            <Input
              id={`${id}-date`}
              type="date"
              value={draft.date}
              onChange={(e) => set({ date: e.target.value })}
              className="h-11 text-base"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-account`}>Account</Label>
          <AccountSelect
            id={`${id}-account`}
            accounts={catalog.accounts}
            value={draft.accountId}
            onChange={(accountId) => set({ accountId, accountExplicit: accountId !== null })}
            autoLabel="Usual account for this payee"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{multi ? "Items" : "Category"}</span>
            {multi && (
              <span
                className={cn("tabular text-sm", sums.balanced ? "text-ok" : "text-destructive")}
                data-testid="line-sum"
                aria-live="polite"
              >
                {formatMoney(sums.lineSum, catalog.currency)}
                {sums.total !== null && ` of ${formatMoney(sums.total, catalog.currency)}`}
              </span>
            )}
          </div>
          {draft.lines.map((line, i) => (
            <LineRow
              key={line.key}
              line={line}
              categories={catalog.categories}
              recentIds={catalog.recentCategoryIds}
              decimals={decimals}
              showAmount={multi}
              onChange={(l) => set({ lines: draft.lines.map((x, j) => (j === i ? l : x)) })}
              {...(multi ? { onRemove: () => set({ lines: draft.lines.filter((_, j) => j !== i) }) } : {})}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-10"
              disabled={draft.lines.length >= 20}
              onClick={() => {
                // Splitting a single-line draft: the first line keeps the total so the sum still balances.
                const first = draft.lines[0];
                const lines = !multi && first && sums.total !== null && first.amountText.trim() === ""
                  ? [{ ...first, amountText: milliToInput(sums.total, decimals), approximate: draft.approximate }, emptyLine()]
                  : [...draft.lines, emptyLine()];
                set({ lines });
              }}
            >
              <PlusIcon /> Add item
            </Button>
            {multi && !sums.balanced && sums.linesWithAmount === draft.lines.length && sums.lineSum > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-10"
                onClick={() => set({ totalText: milliToInput(sums.lineSum, decimals) })}
              >
                Use item sum as total
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-memo`}>Memo</Label>
          <Input
            id={`${id}-memo`}
            value={draft.memo}
            maxLength={200}
            placeholder="Optional"
            onChange={(e) => set({ memo: e.target.value })}
            className="h-11 text-base"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${id}-ph`} className="flex flex-col items-start gap-0.5 font-normal">
            <span className="font-medium">{finalEntry ? "Record in YNAB now" : "Add placeholder to YNAB"}</span>
            <span className="text-xs text-muted-foreground">
              {!placeholdersEnabled
                ? "Placeholders are off in Settings"
                : finalEntry
                  ? "No bank import on this account: the entry is final"
                  : "Your budget reflects it before the bank does"}
            </span>
          </Label>
          <Switch
            id={`${id}-ph`}
            checked={placeholdersEnabled && draft.createPlaceholder}
            disabled={!placeholdersEnabled}
            onCheckedChange={(createPlaceholder) => set({ createPlaceholder })}
          />
        </div>

        {errors.length > 0 && (
          <ul className="list-disc rounded-md bg-destructive/10 py-2 pr-2 pl-6 text-sm text-destructive" role="alert">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

