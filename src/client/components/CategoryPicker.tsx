// components/CategoryPicker.tsx — WP6 (DESIGN §11.1): bottom Sheet + Command; "Recent" first; grouped; searchable.
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { Category, ConfidenceT } from "../../shared/schemas";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";

export interface CategoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Category[];
  recentIds?: string[];
  value: string | null;
  onSelect: (categoryId: string) => void;
  title?: string;
}

export function groupCategories(categories: Category[], recentIds: string[] = []): { heading: string; items: Category[] }[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const recent = recentIds.map((id) => byId.get(id)).filter((c): c is Category => !!c);
  const groups = new Map<string, Category[]>();
  for (const c of categories) {
    const list = groups.get(c.groupName) ?? [];
    list.push(c);
    groups.set(c.groupName, list);
  }
  return [
    ...(recent.length ? [{ heading: "Recent", items: recent }] : []),
    ...[...groups.entries()].map(([heading, items]) => ({ heading, items })),
  ];
}

export function CategoryPicker({ open, onOpenChange, categories, recentIds = [], value, onSelect, title = "Category" }: CategoryPickerProps) {
  const groups = useMemo(() => groupCategories(categories, recentIds), [categories, recentIds]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-safe mx-auto max-h-[85dvh] max-w-xl rounded-t-2xl">
        <SheetHeader className="pb-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">Search or pick a category</SheetDescription>
        </SheetHeader>
        <Command className="bg-transparent">
          <CommandInput placeholder="Search categories…" className="h-11 text-base" />
          <CommandList className="max-h-[60dvh]">
            <CommandEmpty>No category found.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.heading} heading={g.heading}>
                {g.items.map((c) => (
                  <CommandItem
                    key={`${g.heading}:${c.id}`}
                    value={`${g.heading}:${c.id}`}
                    keywords={[c.name, c.groupName]}
                    onSelect={() => {
                      onSelect(c.id);
                      onOpenChange(false);
                    }}
                    className="min-h-11"
                  >
                    <span className="flex-1 truncate">{c.name}</span>
                    {g.heading === "Recent" && <span className="text-xs text-muted-foreground">{c.groupName}</span>}
                    {value === c.id && <CheckIcon className="size-4 text-primary" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </SheetContent>
    </Sheet>
  );
}

export interface CategoryChipProps {
  categoryId: string | null;
  categories: Category[];
  confidence?: ConfidenceT | null;
  onClick?: () => void;
  icon?: ReactNode;
  className?: string;
}

/** Tappable category chip. Low-confidence suggestions are outlined with a "?" badge (§11.2). */
export function CategoryChip({ categoryId, categories, confidence, onClick, icon, className }: CategoryChipProps) {
  const cat = categoryId ? categories.find((c) => c.id === categoryId) : undefined;
  const low = confidence === "low";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex min-h-9 max-w-full items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors",
        cat && !low ? "border-transparent bg-accent text-accent-foreground" : "border-dashed bg-transparent",
        !cat && "text-muted-foreground",
        low && "border-warn text-foreground",
        className,
      )}
      aria-label={cat ? `Category: ${cat.name}${low ? " (unsure)" : ""}. Change` : "Pick a category"}
    >
      {icon}
      <span className="truncate">{cat ? cat.name : "Pick category"}</span>
      {low && (
        <Badge variant="outline" className="h-4 rounded-full border-warn px-1 text-[10px] text-warn">?</Badge>
      )}
      <ChevronDownIcon className="size-3 opacity-60" />
    </button>
  );
}
