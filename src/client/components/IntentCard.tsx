// components/IntentCard.tsx — WP6 (DESIGN §11.1): pending / partial / stale card; tap → detail sheet.
import { ChevronRightIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { Category, CurrencyFormat, Intent } from "../../shared/schemas";
import { formatApprox, formatDate } from "../lib/format";
import { cn } from "../lib/utils";
import { PrecisionChip } from "./PrecisionChip";
import { Badge } from "./ui/badge";

export const PLACEHOLDER_LABEL: Record<Intent["placeholder"]["status"], string> = {
  none: "No placeholder",
  created: "Placeholder in YNAB",
  auto_matched: "YNAB matched the placeholder",
  deleted: "Placeholder removed",
  missing: "Placeholder deleted in YNAB",
  failed: "Placeholder failed",
  final: "Recorded as final",
};

export function intentStatusLabel(i: Intent): string {
  if (i.isStale && (i.status === "pending" || i.status === "partial")) return "stale";
  return i.status;
}

export function matchedProgress(i: Intent): string | null {
  if (i.lines.length < 2) return null;
  const matched = i.lines.filter((l) => l.status === "matched").length;
  return matched > 0 ? `${matched} of ${i.lines.length} items matched` : null;
}

export interface IntentCardProps {
  intent: Intent;
  currency: CurrencyFormat | null;
  categories: Category[];
  onOpen?: () => void;
  actions?: ReactNode;
  /** Multi-select for conversational edits (§9.6): a checkbox, and a long press on the card toggles it too. */
  selected?: boolean;
  onToggleSelect?: () => void;
}

const LONG_PRESS_MS = 500;

export function IntentCard({ intent, currency, categories, onOpen, actions, selected, onToggleSelect }: IntentCardProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const selectable = !!onToggleSelect;
  const status = intentStatusLabel(intent);
  const progress = matchedProgress(intent);
  const catNames = intent.lines
    .map((l) => categories.find((c) => c.id === l.categoryId)?.name)
    .filter((n): n is string => !!n);
  const summary = intent.lines.length > 1
    ? intent.lines.map((l) => l.description).join(", ")
    : [...new Set(catNames)].join(", ");
  return (
    <div
      className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", selected && "border-primary ring-1 ring-primary")}
      data-testid="intent-card"
      data-selected={selected ? "true" : undefined}
    >
      <div className="flex items-start">
      {selectable && (
        <label className="flex shrink-0 cursor-pointer items-center self-stretch pl-4">
          <input
            type="checkbox"
            className="size-5 accent-primary"
            checked={!!selected}
            onChange={onToggleSelect}
            aria-label={`Select ${intent.payee}`}
          />
        </label>
      )}
      <button
        type="button"
        onClick={(e) => {
          if (longPressed.current) {
            longPressed.current = false;
            e.preventDefault();
            return;
          }
          onOpen?.();
        }}
        onPointerDown={selectable ? () => {
          longPressed.current = false;
          clearTimer();
          timer.current = setTimeout(() => {
            longPressed.current = true;
            onToggleSelect?.();
          }, LONG_PRESS_MS);
        } : undefined}
        onPointerUp={selectable ? clearTimer : undefined}
        onPointerLeave={selectable ? clearTimer : undefined}
        onPointerCancel={selectable ? clearTimer : undefined}
        onContextMenu={selectable ? (e) => e.preventDefault() : undefined}
        className="flex min-w-0 flex-1 items-start gap-3 p-4 text-left"
        aria-label={`${intent.payee}, ${formatApprox(intent.totalAmount, intent.approximate, currency)}. Details`}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{intent.payee}</span>
            <span className="tabular shrink-0 font-medium">
              {intent.direction === "inflow" ? "+" : ""}
              {formatApprox(intent.totalAmount, intent.approximate, currency)}
            </span>
          </div>
          <div className="truncate text-sm text-muted-foreground">{summary || "—"}</div>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            <span>{formatDate(intent.date)}</span>
            <Badge
              variant={status === "stale" ? "destructive" : status === "review" ? "default" : "secondary"}
              className={cn("capitalize", status === "stale" && "bg-warn-soft text-warn")}
            >
              {status}
            </Badge>
            {progress && <span>{progress}</span>}
            {intent.placeholder.status !== "none" && <span>{PLACEHOLDER_LABEL[intent.placeholder.status]}</span>}
          </div>
          {(intent.status === "pending" || intent.status === "partial") && <PrecisionChip precision={intent.precision} className="pt-1" />}
        </div>
        <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
      </button>
      </div>
      {actions && <div className="flex flex-wrap gap-2 border-t px-4 py-3">{actions}</div>}
    </div>
  );
}
