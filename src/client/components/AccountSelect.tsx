// components/AccountSelect.tsx — WP6: account picker. Accounts without bank import are labelled "no import: entries are final".
import type { Account } from "../../shared/schemas";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";

const AUTO = "__auto";

export interface AccountSelectProps {
  accounts: Account[];
  value: string | null;
  onChange: (accountId: string | null) => void;
  /** Label of the "no explicit account" entry; omit to require an account. */
  autoLabel?: string;
  placeholder?: string;
  id?: string;
  className?: string;
}

export function usableAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => !a.closed && a.onBudget);
}

export function AccountSelect({ accounts, value, onChange, autoLabel, placeholder = "Choose an account", id, className }: AccountSelectProps) {
  const list = usableAccounts(accounts);
  const linked = list.filter((a) => a.directImportLinked);
  const unlinked = list.filter((a) => !a.directImportLinked);
  return (
    <Select value={value ?? (autoLabel ? AUTO : "")} onValueChange={(v) => onChange(v === AUTO ? null : v)}>
      <SelectTrigger id={id} className={className ?? "h-11 w-full"} aria-label="Account">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {autoLabel && <SelectItem value={AUTO}>{autoLabel}</SelectItem>}
        {linked.length > 0 && (
          <SelectGroup>
            <SelectLabel>Bank import</SelectLabel>
            {linked.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectGroup>
        )}
        {unlinked.length > 0 && (
          <SelectGroup>
            <SelectLabel>No import: entries are final</SelectLabel>
            {unlinked.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name} <span className="text-xs text-muted-foreground">(no import)</span>
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
