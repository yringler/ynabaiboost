// routes/login.tsx — WP6 (DESIGN §11.2 "/login"; LANDING §6 honours ?pat=1).
// "Connect with YNAB" only when /auth/config says OAuth is available; PAT form otherwise / on request.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PlainPage } from "../components/Page";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { call, errorMessage, isApiError } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { copyText } from "../lib/clipboard";
import { extractUserId } from "../lib/routing";

const routeApi = getRouteApi("/login");

const ERROR_TEXT: Record<string, string> = {
  // Codes emitted by GET /auth/ynab/callback (src/worker/routes/auth.ts).
  oauth_denied: "YNAB sign-in was cancelled.",
  oauth_state: "That sign-in link expired. Try again.",
  oauth_failed: "YNAB sign-in failed. Try again, or use a personal access token.",
  oauth_unavailable: "YNAB sign-in is not configured. Use a personal access token.",
};

function NotAllowed({ uid }: { uid: string | undefined }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn-soft p-4 text-sm text-warn">
      <p className="font-medium">This app is private.</p>
      {uid ? (
        <>
          <p>Send your user id to the owner:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-foreground">{uid}</code>
            <Button size="icon-lg" variant="outline" className="size-10" onClick={() => void copyText(uid)} aria-label="Copy user id">
              <CopyIcon />
            </Button>
          </div>
        </>
      ) : (
        <p>Ask the owner to add your YNAB user id.</p>
      )}
    </div>
  );
}

export function LoginPage() {
  const search = routeApi.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const config = useQuery({
    queryKey: queryKeys.authConfig,
    queryFn: ({ signal }) => call("authConfig", { signal }),
    staleTime: Infinity,
  });
  const oauth = config.data?.oauthAvailable === true;
  const [patOpen, setPatOpen] = useState(!!search.pat);
  const [token, setToken] = useState("");
  const [deniedUid, setDeniedUid] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: (t: string) => call("patLogin", { body: { token: t } }),
    onSuccess: async (me) => {
      qc.clear();
      qc.setQueryData(queryKeys.me, me);
      setToken("");
      await navigate({ to: search.redirect ?? "/" });
    },
    onError: (e) => {
      if (isApiError(e) && e.code === "not_allowed") {
        setDeniedUid(extractUserId(e.message) ?? "");
        return;
      }
      toast.error(isApiError(e) && e.code === "validation" ? "That token doesn't look right." : errorMessage(e));
    },
  });

  const notAllowed = search.error === "not_allowed" || deniedUid !== null;
  const uid = deniedUid || search.uid;
  const otherError = search.error && search.error !== "not_allowed" ? (ERROR_TEXT[search.error] ?? "Sign-in failed. Try again.") : null;
  const showPat = patOpen || (config.isSuccess && !oauth);
  const tokenValid = token.trim().length >= 20 && token.trim().length <= 200;

  return (
    <PlainPage className="justify-center">
      <div className="flex flex-col gap-1">
        <Link to="/welcome" className="text-sm text-muted-foreground hover:underline">AI Boost for YNAB</Link>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-muted-foreground">Connect your YNAB account to start.</p>
      </div>

      {notAllowed && <NotAllowed uid={uid} />}
      {otherError && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{otherError}</p>}

      {config.isPending && <Loader2Icon className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />}
      {oauth && (
        <Button asChild className="h-12 text-base">
          <a href="/auth/ynab/start">Connect with YNAB</a>
        </Button>
      )}

      <div className="flex flex-col gap-3">
        {oauth && (
          <button
            type="button"
            className="flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={showPat}
            onClick={() => setPatOpen((o) => !o)}
          >
            Use a Personal Access Token
            <ChevronDownIcon className={`size-4 transition-transform ${showPat ? "rotate-180" : ""}`} />
          </button>
        )}
        {showPat && (
          <form
            className="flex flex-col gap-3 rounded-xl border bg-card p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (tokenValid) login.mutate(token.trim());
            }}
          >
            <Label htmlFor="pat">Personal access token</Label>
            <Input
              id="pat"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="h-11 font-mono text-base"
              placeholder="Paste your token"
              autoFocus={!!search.pat}
            />
            <p className="text-xs text-muted-foreground">
              Create one in{" "}
              <a
                href="https://app.ynab.com/settings/developer"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 underline underline-offset-2"
              >
                YNAB → Developer Settings <ExternalLinkIcon className="size-3" />
              </a>
              . It is stored encrypted and never shown again.
            </p>
            <Button type="submit" className="h-11" disabled={!tokenValid || login.isPending}>
              {login.isPending ? <><Loader2Icon className="animate-spin" /> Checking…</> : "Sign in with token"}
            </Button>
          </form>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
      </p>
    </PlainPage>
  );
}
