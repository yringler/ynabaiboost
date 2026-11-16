// routes/pending.tsx — WP6 (DESIGN §11.2 "/pending"): Review · Pending · Stale tabs, intent detail sheet,
// stale actions (Extend 7d/14d, Keep as final, Delete, Link manually → candidates sheet).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Loader2Icon, MessageSquareTextIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { CurrencyFormat, Intent } from "../../shared/schemas";
import { EditSheet } from "../components/EditSheet";
import { PageTitle } from "../components/Page";
import { IntentCard, intentStatusLabel, matchedProgress, PLACEHOLDER_LABEL } from "../components/IntentCard";
import { ReviewCard } from "../components/ReviewCard";
import { TxnRow } from "../components/TxnRow";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useCatalog } from "../hooks/useCatalog";
import { useMe } from "../hooks/useMe";
import { call, errorMessage } from "../lib/api";
import { formatApprox, formatDate, formatMoney, formatTimestamp } from "../lib/format";
import { DATA_KEYS, queryKeys } from "../lib/queryKeys";
import type { PendingTab } from "../lib/routing";

const routeApi = getRouteApi("/authed/shell/pending");

function useInvalidateAll() {
  const qc = useQueryClient();
  return () => Promise.all(DATA_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** Shared write actions for an intent (each answers with the updated intent). */
function useIntentActions() {
  const invalidate = useInvalidateAll();
  const opts = (ok: string) => ({
    onSuccess: async () => {
      toast.success(ok);
      await invalidate();
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const extend = useMutation({
    mutationFn: ({ id, days }: { id: string; days: number }) => call("extendIntent", { params: { id }, body: { days } }),
    ...opts("Extended"),
  });
  const keep = useMutation({
    mutationFn: (id: string) => call("keepIntent", { params: { id } }),
    ...opts("Kept as final"),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => call("cancelIntent", { params: { id } }),
    ...opts("Deleted"),
  });
  const link = useMutation({
    mutationFn: ({ id, transactionId }: { id: string; transactionId: string }) =>
      call("linkIntent", { params: { id }, body: { transactionId, lineIds: null } }),
    ...opts("Linked"),
  });
  const busy = extend.isPending || keep.isPending || cancel.isPending || link.isPending;
  return { extend, keep, cancel, link, busy };
}

type Actions = ReturnType<typeof useIntentActions>;

function CandidatesSheet({
  intent, currency, open, onOpenChange, actions,
}: { intent: Intent; currency: CurrencyFormat | null; open: boolean; onOpenChange: (o: boolean) => void; actions: Actions }) {
  const q = useQuery({
    queryKey: queryKeys.candidates(intent.id),
    queryFn: ({ signal }) => call("candidates", { params: { id: intent.id }, signal }),
    enabled: open,
    staleTime: 0,
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-safe mx-auto max-h-[85dvh] max-w-xl overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Link {intent.payee}</SheetTitle>
          <SheetDescription>Tap the YNAB transaction this purchase became.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col divide-y px-4 pb-4">
          {q.isPending && <Skeleton className="h-16 w-full" />}
          {q.isError && <p className="text-sm text-destructive">{errorMessage(q.error)}</p>}
          {q.data?.transactions.length === 0 && <p className="py-4 text-sm text-muted-foreground">No likely transactions found.</p>}
          {q.data?.transactions.map((t) => (
            <button
              key={t.id}
              type="button"
              className="text-left disabled:opacity-50"
              disabled={actions.link.isPending}
              onClick={() =>
                actions.link.mutate({ id: intent.id, transactionId: t.id }, { onSuccess: () => onOpenChange(false) })
              }
            >
              <TxnRow txn={t} currency={currency} />
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ConfirmDelete({ intent, open, onOpenChange, actions, onDone }: {
  intent: Intent; open: boolean; onOpenChange: (o: boolean) => void; actions: Actions; onDone?: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{intent.payee}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {intent.placeholder.status === "created"
              ? "The placeholder is removed from YNAB too (unless YNAB already matched a bank import to it)."
              : "The app stops watching for this purchase."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11">Keep</AlertDialogCancel>
          <AlertDialogAction
            className="h-11 bg-destructive text-white hover:bg-destructive/90"
            onClick={() => actions.cancel.mutate(intent.id, { onSuccess: () => onDone?.() })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function StaleActions({ intent, actions, onLink, onDelete }: { intent: Intent; actions: Actions; onLink: () => void; onDelete: () => void }) {
  return (
    <>
      <Button size="sm" variant="outline" className="h-10" disabled={actions.busy} onClick={() => actions.extend.mutate({ id: intent.id, days: 7 })}>
        Extend 7d
      </Button>
      <Button size="sm" variant="outline" className="h-10" disabled={actions.busy} onClick={() => actions.extend.mutate({ id: intent.id, days: 14 })}>
        14d
      </Button>
      {intent.placeholder.status === "created" && (
        <Button size="sm" variant="outline" className="h-10" disabled={actions.busy} onClick={() => actions.keep.mutate(intent.id)}>
          Keep as final
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-10" disabled={actions.busy} onClick={onLink}>
        Link manually
      </Button>
      <Button size="sm" variant="ghost" className="h-10 text-destructive" disabled={actions.busy} onClick={onDelete}>
        Delete
      </Button>
    </>
  );
}

function IntentDetail({ intent, currency, categoryName, actions, onClose, onLink, onDelete, onEdit }: {
  intent: Intent; currency: CurrencyFormat | null; categoryName: (id: string) => string; actions: Actions;
  onClose: () => void; onLink: () => void; onDelete: () => void; onEdit: () => void;
}) {
  const progress = matchedProgress(intent);
  const open = intent.status === "pending" || intent.status === "partial" || intent.status === "review";
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="tabular text-lg font-semibold text-foreground">{formatApprox(intent.totalAmount, intent.approximate, currency)}</span>
        <span>{formatDate(intent.date)}</span>
        <Badge variant="secondary" className="capitalize">{intentStatusLabel(intent)}</Badge>
        {progress && <span>{progress}</span>}
      </div>
      <ul className="flex flex-col divide-y rounded-lg border">
        {intent.lines.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate">{l.description}</div>
              <div className="text-xs text-muted-foreground">{categoryName(l.categoryId)}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="tabular">{formatApprox(l.amount, l.approximate, currency)}</span>
              <span className="text-xs text-muted-foreground">{l.status === "matched" ? "matched" : "waiting"}</span>
            </div>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Placeholder</dt>
        <dd>
          {PLACEHOLDER_LABEL[intent.placeholder.status]}
          {intent.placeholder.amount !== null && intent.placeholder.status === "created" && (
            <span className="tabular text-muted-foreground"> · {formatMoney(intent.placeholder.amount, currency)}</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Watching until</dt>
        <dd>{formatDate(intent.expiresOn)}</dd>
        <dt className="text-muted-foreground">Saved</dt>
        <dd>{formatTimestamp(intent.createdAt)} · ref {intent.shortRef}</dd>
        {intent.memo && (
          <>
            <dt className="text-muted-foreground">Memo</dt>
            <dd>{intent.memo}</dd>
          </>
        )}
      </dl>
      {intent.rawText && <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">“{intent.rawText}”</p>}
      {open && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-11" disabled={actions.busy} onClick={onEdit}>
            <MessageSquareTextIcon /> Edit by voice or text
          </Button>
          {intent.placeholder.status === "created" && (
            <Button
              variant="outline"
              className="h-11"
              disabled={actions.busy}
              onClick={() => actions.keep.mutate(intent.id, { onSuccess: onClose })}
              title="I paid cash: the placeholder becomes the real record"
            >
              Keep as final
            </Button>
          )}
          {intent.isStale && (
            <Button variant="outline" className="h-11" disabled={actions.busy} onClick={() => actions.extend.mutate({ id: intent.id, days: 7 })}>
              Extend 7d
            </Button>
          )}
          <Button variant="outline" className="h-11" disabled={actions.busy} onClick={onLink}>Link manually</Button>
          <Button variant="ghost" className="h-11 text-destructive" disabled={actions.busy} onClick={onDelete}>Cancel intent</Button>
        </div>
      )}
    </div>
  );
}

export function PendingPage() {
  const search = routeApi.useSearch();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const catalog = useCatalog();
  const currency = me?.plan?.currency ?? catalog.data?.currency ?? null;
  const categories = catalog.data?.categories ?? [];
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? "Unknown category";
  const invalidate = useInvalidateAll();
  const actions = useIntentActions();

  const reviews = useQuery({ queryKey: queryKeys.reviews, queryFn: ({ signal }) => call("listReviews", { signal }) });
  const open = useQuery({ queryKey: queryKeys.intents("open"), queryFn: ({ signal }) => call("listIntents", { query: { status: "open" }, signal }) });
  const stale = useQuery({ queryKey: queryKeys.intents("stale"), queryFn: ({ signal }) => call("listIntents", { query: { status: "stale" }, signal }) });

  const resolve = useMutation({
    mutationFn: (v: { id: string; optionId: string } | { id: string; dismiss: true }) =>
      call("resolveReview", { params: { id: v.id }, body: "optionId" in v ? { optionId: v.optionId } : { dismiss: true } }),
    onSuccess: async (_r, v) => {
      toast.success("dismiss" in v ? "Dismissed" : "Applied");
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const [detailId, setDetailId] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // Conversational edit (§9.6): multi-select on the Pending and Stale lists; the sheet works with none selected.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [editIds, setEditIds] = useState<string[] | null>(null);
  const toggle = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const reviewList = reviews.data?.reviews ?? [];
  const pendingList = [...(open.data?.intents ?? [])].filter((i) => !i.isStale).sort((a, b) => b.createdAt - a.createdAt);
  const staleList = [...(stale.data?.intents ?? [])].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
  const allIntents = new Map([...(open.data?.intents ?? []), ...(stale.data?.intents ?? [])].map((i) => [i.id, i]));
  const detail = detailId ? allIntents.get(detailId) : undefined;
  const linking = linkId ? allIntents.get(linkId) : undefined;
  const deleting = deleteId ? allIntents.get(deleteId) : undefined;
  const selected = [...selectedIds].flatMap((id) => {
    const i = allIntents.get(id);
    return i ? [i] : [];
  });
  const editing = (editIds ?? []).flatMap((id) => {
    const i = allIntents.get(id);
    return i ? [i] : [];
  });
  const editBar = (
    <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2" role="toolbar" aria-label="Edit pending items">
      <span className="flex-1 text-sm text-muted-foreground">
        {selected.length > 0 ? `${selected.length} selected` : "Select items, or just say what changed"}
      </span>
      {selected.length > 0 && (
        <Button size="sm" variant="ghost" className="h-10" onClick={() => setSelectedIds(new Set())}>Clear</Button>
      )}
      <Button size="sm" className="h-10" onClick={() => setEditIds(selected.map((i) => i.id))}>
        <MessageSquareTextIcon /> Edit by voice or text
      </Button>
    </div>
  );

  const tab: PendingTab = search.tab ?? (reviewList.length > 0 ? "review" : "pending");

  const loading = (q: { isPending: boolean; isError: boolean; error: unknown }) =>
    q.isPending ? (
      <div className="flex flex-col gap-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>
    ) : q.isError ? (
      <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Pending</PageTitle>
      <Tabs value={tab} onValueChange={(v) => void navigate({ to: "/pending", search: { tab: v as PendingTab }, replace: true })}>
        <TabsList className="grid h-11 w-full grid-cols-3">
          <TabsTrigger value="review">Review{reviewList.length > 0 && ` (${reviewList.length})`}</TabsTrigger>
          <TabsTrigger value="pending">Pending{pendingList.length > 0 && ` (${pendingList.length})`}</TabsTrigger>
          <TabsTrigger value="stale">Stale{staleList.length > 0 && ` (${staleList.length})`}</TabsTrigger>
        </TabsList>

        <TabsContent value="review" className="flex flex-col gap-3 pt-2">
          {loading(reviews)}
          {reviews.data && reviewList.length === 0 && <Empty text="Nothing to review." />}
          {reviewList.map((r) => (
            <ReviewCard
              key={r.id}
              review={r}
              currency={currency}
              categories={categories}
              busy={resolve.isPending}
              onResolve={(optionId) => resolve.mutate({ id: r.id, optionId })}
              onDismiss={() => resolve.mutate({ id: r.id, dismiss: true })}
            />
          ))}
        </TabsContent>

        <TabsContent value="pending" className="flex flex-col gap-3 pt-2">
          {loading(open)}
          {open.data && pendingList.length === 0 && <Empty text="No purchases waiting for the bank." />}
          {open.data && pendingList.length > 0 && editBar}
          {pendingList.map((i) => (
            <IntentCard
              key={i.id}
              intent={i}
              currency={currency}
              categories={categories}
              onOpen={() => setDetailId(i.id)}
              selected={selectedIds.has(i.id)}
              onToggleSelect={() => toggle(i.id)}
            />
          ))}
        </TabsContent>

        <TabsContent value="stale" className="flex flex-col gap-3 pt-2">
          {loading(stale)}
          {stale.data && staleList.length === 0 && <Empty text="Nothing stale." />}
          {stale.data && staleList.length > 0 && editBar}
          {staleList.map((i) => (
            <IntentCard
              key={i.id}
              intent={i}
              currency={currency}
              categories={categories}
              onOpen={() => setDetailId(i.id)}
              selected={selectedIds.has(i.id)}
              onToggleSelect={() => toggle(i.id)}
              actions={<StaleActions intent={i} actions={actions} onLink={() => setLinkId(i.id)} onDelete={() => setDeleteId(i.id)} />}
            />
          ))}
        </TabsContent>
      </Tabs>

      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent side="bottom" className="pb-safe mx-auto max-h-[90dvh] max-w-xl overflow-y-auto rounded-t-2xl">
          {detail && (
            <>
              <SheetHeader>
                <SheetTitle>{detail.payee}</SheetTitle>
                <SheetDescription className="sr-only">Details of this purchase</SheetDescription>
              </SheetHeader>
              <IntentDetail
                intent={detail}
                currency={currency}
                categoryName={categoryName}
                actions={actions}
                onClose={() => setDetailId(null)}
                onLink={() => setLinkId(detail.id)}
                onDelete={() => setDeleteId(detail.id)}
                onEdit={() => {
                  setEditIds([detail.id]);
                  setDetailId(null);
                }}
              />
            </>
          )}
        </SheetContent>
      </Sheet>

      {linking && (
        <CandidatesSheet
          intent={linking}
          currency={currency}
          open
          onOpenChange={(o) => {
            if (!o) {
              setLinkId(null);
              setDetailId(null);
            }
          }}
          actions={actions}
        />
      )}
      {deleting && (
        <ConfirmDelete
          intent={deleting}
          open
          onOpenChange={(o) => !o && setDeleteId(null)}
          actions={actions}
          onDone={() => {
            setDeleteId(null);
            setDetailId(null);
          }}
        />
      )}
      <EditSheet
        open={editIds !== null}
        onOpenChange={(o) => !o && setEditIds(null)}
        selected={editing}
        onDone={() => setSelectedIds(new Set())}
      />
      {actions.busy && <Loader2Icon className="fixed right-4 bottom-24 size-5 animate-spin text-muted-foreground" aria-label="Working" />}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}
