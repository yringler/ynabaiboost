// components/PrecisionChip.tsx — DESIGN §11.1: the deterministic precision of a draft or intent (shared/precision.ts).
import { CheckCircle2Icon, CircleHelpIcon } from "lucide-react";
import { PRECISION_LABEL, type PrecisionInfo } from "../../shared/precision";
import { cn } from "../lib/utils";

export function PrecisionChip({ precision, showNote = true, className }: { precision: PrecisionInfo; showNote?: boolean; className?: string }) {
  const exact = precision.level === "exact";
  return (
    <span className={cn("flex flex-col gap-0.5", className)} data-testid="precision-chip">
      <span
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
          exact ? "bg-ok-soft text-ok" : "bg-muted text-muted-foreground",
        )}
      >
        {exact ? <CheckCircle2Icon className="size-3" aria-hidden /> : <CircleHelpIcon className="size-3" aria-hidden />}
        {PRECISION_LABEL[precision.level]}
      </span>
      {showNote && precision.note && <span className="text-xs text-muted-foreground">{precision.note}</span>}
    </span>
  );
}
