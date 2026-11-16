// routes/inbox.tsx — WP6 (DESIGN §11.2 "/inbox"): imports nobody explained. One tap ✓ approves with the suggested
// category; tap the chip to pick another; "Possible match" → Link first; "Approve all high-confidence"; "Get suggestions".
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, HistoryIcon, Loader2Icon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Category, CurrencyFormat, InboxItem } from "../../shared/schemas";
import { PageTitle } from "../components/Page";
import { CategoryChip, CategoryPicker } from "../components/CategoryPicker";
import { TxnRow } from "../components/TxnRow";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { useCatalog } from "../hooks/useCatalog";
import { useMe } from "../hooks/useMe";
import { call, errorMessage } from "../lib/api";
import { formatApprox, formatRelative } from "../lib/format";
import { DATA_KEYS, queryKeys } from "../lib/queryKeys";

/** Items safe for the bulk button: a high-confidence category and no possible intent to link instead. */
export function highConfidenceItems(items: InboxItem[]): { transactionId: string; categoryId: string }[] {
  return items.flatMap((i) =>
    i.suggestion?.confidence === "high" && i.suggestion.categoryId && !i.possibleIntent
      ? [{ transactionId: i.transaction.id, categoryId: i.suggestion.categoryId }]
      : [],
  );
}

function SourceIcon({ source }: { source: NonNullable<InboxItem["suggestion"]>["source"] }) {
  if (source === "claude") return <SparklesIcon className="size-3.5" aria-label="Suggested by Claude" />;
  if (source === "history") return <HistoryIcon className="size-3.5" aria-label="From your history" />;
  return <span className="text-[10px] font-semibold" aria-label="Set in YNAB">YNAB</span>;
}

interface RowProps {
  item: InboxItem;
  currency: CurrencyFormat | null;
  categories: Category[];
  recentIds: string[];
  override: string | undefined;
  onPick: (categoryId: string) => void;
  onApprove: (categoryId: string) => void;
  onDismiss: () => void;
  onLink: () => void;
  busy: boolean;
}

function InboxRow({ item, currency, categories, recentIds, override, onPick, onApprove, onDismiss, onLink, busy }: RowProps) {
  const [picking, setPicking] = useState(false);
  const s = item.suggestion;
  const categoryId = override ?? s?.categoryId ?? null;
  const pi = item.possibleIntent;
  return (
    <li className="border-b last:border-b-0">
      <TxnRow
        txn={item.transaction}
        currency={currency}
        chip={
          <div className="flex flex-col gap-1">
            {pi && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  Possible match: <span className="font-medium">{pi.payee}</span>{" "}
                  <span className="tabular">{formatApprox(pi.totalAmount, true, currency)}</span>
                </span>
                <Button size="sm" className="h-9" disabled={busy} onClick={onLink}>Link</Button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <CategoryChip
                categoryId={categoryId}
                categories={categories}
                confidence={override ? null : (s?.confidence ?? null)}
                onClick={() => setPicking(true)}
                {...(s && !override ? { icon: <SourceIcon source={s.source} /> } : {})}
              />
            </div>
            {s?.reason && !override && <p className="text-xs text-muted-foreground">{s.reason}</p>}
          </div>
        }
        actions={
          <>
            <Button
              size="icon-lg"
              variant={pi ? "outline" : "default"}
              className="size-11 rounded-full"
              disabled={busy || !categoryId}
              onClick={() => categoryId && onApprove(categoryId)}
              aria-label={categoryId ? `Approve as ${categories.find((c) => c.id === categoryId)?.name ?? "category"}` : "Pick a category first"}
            >
              <CheckIcon />
            </Button>
            <Button size="icon-lg" variant="ghost" className="size-11 rounded-full" disabled={busy} onClick={onDismiss} aria-label="Dismiss">
              <XIcon />
            </Button>
          </>
        }
      />
      <CategoryPicker
        open={picking}
        onOpenChange={setPicking}
        categories={categories}
        recentIds={recentIds}
        value={categoryId}
        onSelect={onPick}
      />
    </li>
  );
}

export function InboxPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const catalog = useCatalog();
  const currency = me?.plan?.currency ?? catalog.data?.currency ?? null;
  const categories = catalog.data?.categories ?? [];
  const inbox = useQuery({ queryKey: queryKeys.inbox, queryFn: ({ signal }) => call("inbox", { signal }) });
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const invalidate = () => Promise.all(DATA_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
  const hide = (ids: string[]) => setHidden((h) => new Set([...h, ...ids]));
  const unhide = (ids: string[]) => setHidden((h) => new Set([...h].filter((x) => !ids.includes(x))));

  const approve = useMutation({
    mutationFn: (items: { transactionId: string; categoryId: string }[]) => call("inboxApprove", { body: { items } }),
    onMutate: (items) => hide(items.map((i) => i.transactionId)),
    onSuccess: async (r) => {
      if (r.failed.length > 0) {
        unhide(r.failed.map((f) => f.transactionId));
        toast.error(`${r.failed.length} not approved: ${r.failed[0]?.message ?? ""}`);
      }
      if (r.approved > 0) toast.success(r.approved === 1 ? "Approved" : `Approved ${r.approved}`);
      await invalidate();
    },
    onError: (e, items) => {
      unhide(items.map((i) => i.transactionId));
      toast.error(errorMessage(e));
    },
  });
  const dismiss = useMutation({
    mutationFn: (transactionIds: string[]) => call("inboxDismiss", { body: { transactionIds } }),
    onMutate: (ids) => hide(ids),
    onSuccess: invalidate,
    onError: (e, ids) => {
      unhide(ids);
      toast.error(errorMessage(e));
    },
  });
  const link = useMutation({
    mutationFn: ({ intentId, transactionId }: { intentId: string; transactionId: string }) =>
      call("linkIntent", { params: { id: intentId }, body: { transactionId, lineIds: null } }),
    onMutate: ({ transactionId }) => hide([transactionId]),
    onSuccess: async () => {
      toast.success("Linked");
      await invalidate();
    },
    onError: (e, { transactionId }) => {
      unhide([transactionId]);
      toast.error(errorMessage(e));
    },
  });
  const suggest = useMutation({
    mutationFn: () => call("inboxSuggest"),
    onSuccess: async (r) => {
      toast(r.suggested ? `${r.suggested} suggestions added` : "No new suggestions");
      await qc.invalidateQueries({ queryKey: queryKeys.inbox });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const items = (inbox.data?.items ?? []).filter((i) => !hidden.has(i.transaction.id));
  const bulk = highConfidenceItems(items).filter((i) => !overrides[i.transactionId]);
  const missing = items.some((i) => !i.suggestion);
  const busy = approve.isPending || dismiss.isPending || link.isPending;

  return (
    <div className="flex flex-col gap-4">
      <PageTitle
        action={
          inbox.data?.lastSyncAt ? (
            <span className="text-xs text-muted-foreground">Updated {formatRelative(inbox.data.lastSyncAt)}</span>
          ) : undefined
        }
      >
        Inbox
      </PageTitle>

      {(bulk.length > 0 || missing) && (
        <div className="flex flex-wrap gap-2">
          {bulk.length > 0 && (
            <Button className="h-11" disabled={busy} onClick={() => approve.mutate(bulk.slice(0, 50))}>
              <CheckIcon /> Approve all high-confidence ({bulk.length})
            </Button>
          )}
          {missing && (
            <Button variant="outline" className="h-11" disabled={suggest.isPending} onClick={() => suggest.mutate()}>
              {suggest.isPending ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />} Get suggestions
            </Button>
          )}
        </div>
      )}

      {inbox.isPending && (
        <div className="flex flex-col gap-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
      )}
      {inbox.isError && <p className="text-sm text-destructive">{errorMessage(inbox.error)}</p>}
      {inbox.data && items.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Inbox zero. New bank imports show up here after a sync.
        </p>
      )}
      {items.length > 0 && (
        <ul className="rounded-xl border bg-card px-4">
          {items.map((item) => {
            const id = item.transaction.id;
            return (
              <InboxRow
                key={id}
                item={item}
                currency={currency}
                categories={categories}
                recentIds={catalog.data?.recentCategoryIds ?? []}
                override={overrides[id]}
                busy={busy}
                onPick={(categoryId) => setOverrides((o) => ({ ...o, [id]: categoryId }))}
                onApprove={(categoryId) => approve.mutate([{ transactionId: id, categoryId }])}
                onDismiss={() => dismiss.mutate([id])}
                onLink={() => item.possibleIntent && link.mutate({ intentId: item.possibleIntent.intentId, transactionId: id })}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
