// routes/activity.tsx — WP6 (DESIGN §11.2 "/activity"): read-only infinite feed (no undo in v1, §10.10).
import { useInfiniteQuery } from "@tanstack/react-query";
import { BotIcon, ClockIcon, UserIcon } from "lucide-react";
import type { ActivityEntry } from "../../shared/schemas";
import { PageTitle } from "../components/Page";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { call, errorMessage } from "../lib/api";
import { formatTimestamp } from "../lib/format";
import { queryKeys } from "../lib/queryKeys";

const ACTOR_ICON = { user: UserIcon, cron: ClockIcon, app: BotIcon } as const;
const ACTOR_LABEL = { user: "You", cron: "Background sync", app: "App" } as const;

/** Groups entries by local calendar day, newest first (entries arrive sorted by `at` desc). */
export function groupByDay(entries: ActivityEntry[]): { day: string; entries: ActivityEntry[] }[] {
  const out: { day: string; entries: ActivityEntry[] }[] = [];
  for (const e of entries) {
    const day = new Date(e.at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const last = out[out.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

export function ActivityPage() {
  const q = useInfiniteQuery({
    queryKey: queryKeys.activity,
    queryFn: ({ pageParam, signal }) =>
      call("activity", { ...(pageParam !== null ? { query: { before: pageParam } } : {}), signal }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Activity</PageTitle>
      {q.isPending && <div className="flex flex-col gap-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}
      {q.isError && <p className="text-sm text-destructive">{errorMessage(q.error)}</p>}
      {q.data && entries.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
      {groupByDay(entries).map((g) => (
        <section key={g.day} className="flex flex-col gap-1">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.day}</h2>
          <ul className="divide-y rounded-xl border bg-card">
            {g.entries.map((e) => {
              const Icon = ACTOR_ICON[e.actor];
              return (
                <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={ACTOR_LABEL[e.actor]} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{e.summary}</p>
                    <p className="text-xs text-muted-foreground">{formatTimestamp(e.at)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {q.hasNextPage && (
        <Button variant="outline" className="h-11" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
