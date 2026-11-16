// components/LineRow.tsx — WP6 (DESIGN §11.1): description, category chip (tap → picker), amount, remove.
import { XIcon } from "lucide-react";
import { useState } from "react";
import type { Category } from "../../shared/schemas";
import type { LineState } from "../lib/draft";
import { parseMoneyInput } from "../lib/format";
import { CategoryChip, CategoryPicker } from "./CategoryPicker";
import { MoneyInput } from "./MoneyInput";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface LineRowProps {
  line: LineState;
  onChange: (line: LineState) => void;
  onRemove?: () => void;
  categories: Category[];
  recentIds: string[];
  decimals: number;
  /** Single-line drafts take their amount from the total, so the amount field is hidden. */
  showAmount: boolean;
}

export function LineRow({ line, onChange, onRemove, categories, recentIds, decimals, showAmount }: LineRowProps) {
  const [picking, setPicking] = useState(false);
  const amountInvalid = showAmount && line.amountText.trim() !== "" && parseMoneyInput(line.amountText, decimals) === null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background/60 p-2" data-testid="line-row">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Item"
          placeholder="What was it?"
          value={line.description}
          maxLength={200}
          onChange={(e) => onChange({ ...line, description: e.target.value })}
          className="h-11 flex-1 text-base"
        />
        {onRemove && (
          <Button type="button" variant="ghost" size="icon-lg" onClick={onRemove} aria-label="Remove item" className="size-11">
            <XIcon />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CategoryChip
          categoryId={line.categoryId}
          categories={categories}
          confidence={line.confidence}
          onClick={() => setPicking(true)}
        />
        {showAmount && (
          <MoneyInput
            label="Item amount"
            className="w-40"
            value={line.amountText}
            onChange={(amountText) => onChange({ ...line, amountText })}
            approximate={line.approximate}
            onApproximateChange={(approximate) => onChange({ ...line, approximate })}
            invalid={amountInvalid}
          />
        )}
      </div>
      <CategoryPicker
        open={picking}
        onOpenChange={setPicking}
        categories={categories}
        recentIds={recentIds}
        value={line.categoryId}
        // A category the user picked is no longer a guess.
        onSelect={(categoryId) => onChange({ ...line, categoryId, confidence: null })}
      />
    </div>
  );
}
