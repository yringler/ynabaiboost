// components/AppShell.tsx — WP6: header ("Sync now" + "Last synced …"), status banners, page outlet, BottomNav.
// Sync is manual only (owner decision, D11): nothing here syncs on mount, focus or a timer.
import { useMutationState } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Me, SyncResult } from "../../shared/schemas";
import { useMe } from "../hooks/useMe";
import { useSync } from "../hooks/useSync";
import { formatRelative, formatTimestamp } from "../lib/format";
import { syncMutationKey } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { BottomNav } from "./BottomNav";
import { Button } from "./ui/button";

const SYNC_ERROR_TEXT: Record<string, string> = {
  ynab_subscription_lapsed: "YNAB subscription lapsed",
  ynab_reauth_required: "YNAB needs you to reconnect",
  ynab_rate_limited: "YNAB rate limit reached, retrying later",
  ynab_error: "YNAB returned an error",
  anthropic_billing: "Anthropic: credit balance too low",
  anthropic_key_invalid: "Anthropic: API key rejected",
  anthropic_key_missing: "Anthropic: no API key",
  ai_unavailable: "Claude is unavailable",
  no_plan_selected: "No YNAB plan selected",
};

/** "ynab_subscription_lapsed: …" → "Sync failing: YNAB subscription lapsed". */
export function syncErrorText(raw: string): string {
  const idx = raw.indexOf(":");
  const code = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
  const known = SYNC_ERROR_TEXT[code];
  if (known) return code.startsWith("anthropic") ? known : `Sync failing: ${known}`;
  return `Sync failing: ${idx >= 0 ? raw.slice(idx + 1).trim() || code : raw}`;
}

/** Re-render every 30 s so relative times stay fresh (display only; no network). */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function SyncButton({ me }: { me: Me | undefined }) {
  const sync = useSync();
  const now = useNow();
  const last = me?.lastSyncAt ?? null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-right text-xs leading-tight text-muted-foreground" title={last ? formatTimestamp(last) : undefined}>
        {last ? <>Last synced<br />{formatRelative(last, now)}</> : "Never synced"}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-10"
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
        aria-label="Sync now"
      >
        <RefreshCwIcon className={cn(sync.isPending && "animate-spin")} />
        <span className="hidden min-[380px]:inline">{sync.isPending ? "Syncing…" : "Sync now"}</span>
      </Button>
    </div>
  );
}

function Banner({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "error" }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-destructive/10 text-destructive",
      )}
    >
      <AlertTriangleIcon className="size-4 shrink-0" />
      <div className="flex flex-1 flex-wrap items-center justify-between gap-2">{children}</div>
    </div>
  );
}

export function ReconnectLink({ me }: { me: Me }) {
  if (me.authType === "oauth" && me.oauthAvailable) {
    return (
      <Button asChild size="sm" variant="outline" className="h-9">
        <a href="/auth/ynab/start">Reconnect</a>
      </Button>
    );
  }
  return (
    <Button asChild size="sm" variant="outline" className="h-9">
      <Link to="/login" search={{ pat: true }}>Reconnect</Link>
    </Button>
  );
}

export function StatusBanners({ me }: { me: Me }) {
  const syncResults = useMutationState({
    filters: { mutationKey: syncMutationKey, status: "success" },
    select: (m) => m.state.data as SyncResult | undefined,
  });
  const lastResult = syncResults[syncResults.length - 1];
  const resultErrors = lastResult?.errors ?? [];
  // Avoid repeating the stored error when the manual sync reported the same thing.
  const storedShown = me.lastSyncError !== null && !resultErrors.some((e) => me.lastSyncError?.startsWith(e.code));
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {me.needsReauth && (
        <Banner>
          <span>Your YNAB connection expired.</span>
          <ReconnectLink me={me} />
        </Banner>
      )}
      {storedShown && me.lastSyncError && (
        <Banner tone="error">
          <span>{syncErrorText(me.lastSyncError)}</span>
        </Banner>
      )}
      {resultErrors.map((e) => (
        <Banner tone="error" key={`${e.code}:${e.message}`}>
          <span>{syncErrorText(`${e.code}: ${e.message}`)}</span>
        </Banner>
      ))}
    </div>
  );
}

export function AppShell() {
  const { data: me } = useMe();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="pt-safe sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="px-safe mx-auto flex h-14 max-w-xl items-center justify-between gap-2">
          <Link to="/" className="truncate font-semibold tracking-tight">
            AI Boost <span className="text-muted-foreground">for YNAB</span>
          </Link>
          <SyncButton me={me} />
        </div>
      </header>
      <main className="px-safe mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {me && <StatusBanners me={me} />}
        <Outlet />
      </main>
      <BottomNav counts={me?.counts ?? null} />
    </div>
  );
}
