// components/MoneyInput.tsx — WP6 (DESIGN §11.1): inputmode=decimal text field with a "≈" (approximate) toggle.
import { useId } from "react";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Toggle } from "./ui/toggle";

export interface MoneyInputProps {
  value: string;
  onChange: (text: string) => void;
  approximate?: boolean;
  /** Omit to hide the ≈ toggle. */
  onApproximateChange?: (approx: boolean) => void;
  invalid?: boolean;
  placeholder?: string;
  label?: string;
  className?: string;
  id?: string;
}

export function MoneyInput({
  value, onChange, approximate = false, onApproximateChange, invalid, placeholder = "0.00", label = "Amount", className, id,
}: MoneyInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {onApproximateChange && (
        <Toggle
          size="sm"
          variant="outline"
          pressed={approximate}
          onPressedChange={onApproximateChange}
          aria-label="Approximate amount"
          title="Approximate amount"
          className="h-11 min-w-11 text-base"
        >
          ≈
        </Toggle>
      )}
      <Input
        id={inputId}
        aria-label={label}
        inputMode="decimal"
        autoComplete="off"
        enterKeyHint="done"
        placeholder={placeholder}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className="tabular h-11 text-right text-base"
      />
    </div>
  );
}
