// routes/settings.tsx — WP6 (DESIGN §11.2 "/settings"): user id, YNAB connection, plan, defaults, toggles,
// Anthropic key, voice mode, links, log out, delete my data.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AnthropicKeyReq } from "../../shared/api";
import { FlagColor, SettingsShape, type Me, type Settings, type SettingsPatch } from "../../shared/schemas";
import { ReconnectLink } from "../components/AppShell";
import { PageTitle } from "../components/Page";
import { AccountSelect } from "../components/AccountSelect";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { useCatalog } from "../hooks/useCatalog";
import { useMe } from "../hooks/useMe";
import { call, errorMessage } from "../lib/api";
import { DATA_KEYS, queryKeys } from "../lib/queryKeys";
import { copyText } from "../lib/clipboard";

/** PATCH /api/settings and keep the cached `me` in step. */
export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => call("patchSettings", { body: patch }),
    onSuccess: async (settings, patch) => {
      qc.setQueryData<Me>(queryKeys.me, (me) => (me ? { ...me, settings } : me));
      if (patch.planId !== undefined) {
        qc.removeQueries({ queryKey: queryKeys.catalog });
        await Promise.all(DATA_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
      } else {
        await qc.invalidateQueries({ queryKey: queryKeys.me });
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Every IANA zone the browser knows (falls back to the current one). */
export function timezones(current: string): string[] {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    list = [];
  }
  return list.includes(current) ? list : [current, ...list];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={htmlFor} className="flex flex-col items-start gap-0.5 font-normal">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </Label>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange, disabled }: {
  label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </Row>
  );
}

/** Integer/percent field validated by the SettingsShape field; saves on blur or Enter. */
function NumberRow({ label, hint, field, value, scale = 1, suffix, onSave }: {
  label: string; hint?: string; field: "staleAfterDays" | "amazonWindowDays" | "maxTaxRate"; value: number;
  scale?: number; suffix: string; onSave: (v: number) => void;
}) {
  const id = useId();
  const shown = String(Math.round(value * scale * 100) / 100);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const parsed = Number(text.replace(",", "."));
  const candidate = Number.isFinite(parsed) ? parsed / scale : NaN;
  const valid = text.trim() !== "" && SettingsShape.shape[field].safeParse(candidate).success;
  const commit = () => {
    if (!valid) {
      setText(shown);
      return;
    }
    if (candidate !== value) onSave(candidate);
  };
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          aria-invalid={!valid || undefined}
          className="tabular h-11 w-20 text-right text-base"
        />
        <span className="w-8 text-sm text-muted-foreground">{suffix}</span>
      </div>
    </Row>
  );
}

export function AnthropicKeyForm({ hasKey, onDone }: { hasKey: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(!hasKey);
  const [key, setKey] = useState("");
  const valid = AnthropicKeyReq.safeParse({ apiKey: key }).success;
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.me });
  const put = useMutation({
    mutationFn: (apiKey: string) => call("putAnthropicKey", { body: { apiKey } }),
    onSuccess: async () => {
      setKey("");
      setEditing(false);
      toast.success("Anthropic key saved");
      await refresh();
      onDone?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: () => call("delAnthropicKey"),
    onSuccess: async () => {
      setEditing(true);
      toast.success("Anthropic key removed");
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  useEffect(() => setEditing(!hasKey), [hasKey]);

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">Anthropic API key <Badge variant="secondary">set</Badge></span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-10" onClick={() => setEditing(true)}>Replace</Button>
          <Button variant="ghost" size="sm" className="h-10 text-destructive" disabled={del.isPending} onClick={() => del.mutate()}>
            Remove
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) put.mutate(key.trim());
      }}
    >
      <Label htmlFor="anthropic-key" className="font-medium">Anthropic API key</Label>
      <Input
        id="anthropic-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-ant-…"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="h-11 font-mono text-base"
      />
      <p className="text-xs text-muted-foreground">
        Create one in the{" "}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
          Anthropic Console <ExternalLinkIcon className="size-3" />
        </a>
        . We check it, store it encrypted, and never show it again.
      </p>
      <div className="flex gap-2">
        <Button type="submit" className="h-11 flex-1" disabled={!valid || put.isPending}>
          {put.isPending ? "Checking…" : "Save key"}
        </Button>
        {hasKey && (
          <Button type="button" variant="ghost" className="h-11" onClick={() => setEditing(false)}>Cancel</Button>
        )}
      </div>
    </form>
  );
}

export function PlanSelect({ value, currentName, onChange }: { value: string | null; currentName?: string; onChange: (id: string) => void }) {
  // GET /api/plans is a live YNAB call: only load it when the user opens the picker.
  const [opened, setOpened] = useState(false);
  const plans = useQuery({
    queryKey: queryKeys.plans,
    queryFn: ({ signal }) => call("plans", { signal }),
    enabled: opened || value === null,
    staleTime: 10 * 60_000,
  });
  const items = plans.data?.plans ?? (value && currentName ? [{ id: value, name: currentName }] : []);
  return (
    <Select value={value ?? ""} onValueChange={onChange} onOpenChange={(o) => o && setOpened(true)}>
      <SelectTrigger className="h-11 w-full" aria-label="YNAB plan">
        <SelectValue placeholder={plans.isFetching ? "Loading plans…" : "Choose a plan"} />
      </SelectTrigger>
      <SelectContent>
        {items.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
        {plans.isError && <div className="px-2 py-1.5 text-sm text-destructive">{errorMessage(plans.error)}</div>}
      </SelectContent>
    </Select>
  );
}

export function SettingsPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalog = useCatalog({ enabled: !!me?.settings.planId });
  const patch = usePatchSettings();
  const tzList = useMemo(() => timezones(me?.settings.timezone ?? "UTC"), [me?.settings.timezone]);

  const logout = useMutation({
    mutationFn: () => call("logout"),
    onSettled: async () => {
      qc.clear();
      await navigate({ to: "/welcome" });
    },
  });
  const deleteAccount = useMutation({
    mutationFn: () => call("deleteAccount"),
    onSuccess: async () => {
      qc.clear();
      toast.success("Your data was deleted");
      await navigate({ to: "/welcome" });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!me) return <Skeleton className="h-96 w-full" />;
  const s: Settings = me.settings;
  const save = (p: SettingsPatch) => patch.mutate(p);

  return (
    <div className="flex flex-col gap-6">
      <PageTitle>Settings</PageTitle>

      <Section title="Account">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Your user id</span>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-2 py-2 font-mono text-sm" data-testid="user-id">{me.userId}</code>
            <Button size="icon-lg" variant="outline" className="size-11" onClick={() => void copyText(me.userId)} aria-label="Copy user id">
              <CopyIcon />
            </Button>
          </div>
        </div>
        <Row
          label="YNAB connection"
          hint={me.needsReauth ? "Needs re-authorization" : me.authType === "oauth" ? "Connected with YNAB" : "Personal access token"}
        >
          {me.needsReauth ? <ReconnectLink me={me} /> : <Badge variant="secondary">{me.authType === "oauth" ? "OAuth" : "PAT"}</Badge>}
        </Row>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Plan</span>
          <PlanSelect value={s.planId} {...(me.plan ? { currentName: me.plan.name } : {})} onChange={(planId) => save({ planId })} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Time zone</span>
          <Select value={s.timezone} onValueChange={(timezone) => save({ timezone })}>
            <SelectTrigger className="h-11 w-full" aria-label="Time zone"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-80">
              {tzList.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </Section>

      <Section title="Placeholders & matching">
        <ToggleRow
          label="Create placeholders"
          hint="Add a ≈ entry to YNAB right away"
          checked={s.createPlaceholders}
          onChange={(createPlaceholders) => save({ createPlaceholders })}
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Default account</span>
          {catalog.data ? (
            <AccountSelect
              accounts={catalog.data.accounts}
              value={s.defaultAccountId}
              onChange={(defaultAccountId) => save({ defaultAccountId })}
              autoLabel="None"
            />
          ) : (
            <Skeleton className="h-11 w-full" />
          )}
        </div>
        <ToggleRow
          label="Auto-approve matched imports"
          hint="Only confident matches; everything else goes to Review"
          checked={s.autoApproveMatches}
          onChange={(autoApproveMatches) => save({ autoApproveMatches })}
        />
        <NumberRow label="Stale after" field="staleAfterDays" value={s.staleAfterDays} suffix="days" hint="3–90" onSave={(v) => save({ staleAfterDays: v })} />
        <NumberRow label="Amazon window" field="amazonWindowDays" value={s.amazonWindowDays} suffix="days" hint="3–45" onSave={(v) => save({ amazonWindowDays: v })} />
        <NumberRow label="Max tax" field="maxTaxRate" value={s.maxTaxRate} scale={100} suffix="%" hint="0–25" onSave={(v) => save({ maxTaxRate: v })} />
        <Row label="Flag color" hint="Put on transactions the app changes">
          <Select value={s.flagColor ?? "none"} onValueChange={(v) => save({ flagColor: v === "none" ? null : FlagColor.parse(v) })}>
            <SelectTrigger className="h-11 w-32" aria-label="Flag color"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {FlagColor.options.map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section title="AI">
        <ToggleRow
          label="AI data consent"
          hint="Send purchase text and category and payee names to Anthropic"
          checked={s.aiDataConsent}
          onChange={(aiDataConsent) => save({ aiDataConsent })}
        />
        <Separator />
        <AnthropicKeyForm hasKey={me.hasAnthropicKey} />
      </Section>

      <Section title="Voice">
        <Row label="Voice input" hint={me.sttAllowed ? undefined : "Server transcription is enabled by the owner"}>
          <Select value={s.voiceMode} onValueChange={(v) => save({ voiceMode: v === "server" ? "server" : "browser" })}>
            <SelectTrigger className="h-11 w-36" aria-label="Voice input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="browser">Browser</SelectItem>
              <SelectItem value="server" disabled={!me.sttAllowed}>Server (Whisper)</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <ToggleRow
          label="Apply voice edits without confirming"
          hint="Edits on the Pending screen apply right away. You're still asked when Claude has a question, a change was refused, or more than one item would be deleted."
          checked={s.autoApplyEdits}
          onChange={(autoApplyEdits) => save({ autoApplyEdits })}
        />
      </Section>

      <Section title="More">
        <div className="flex flex-col">
          <Link to="/activity" className="flex min-h-11 items-center">Activity</Link>
          {me.isAdmin && <Link to="/admin" className="flex min-h-11 items-center">Admin</Link>}
          <Link to="/privacy" className="flex min-h-11 items-center">Privacy policy</Link>
        </div>
        <Separator />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-11" onClick={() => logout.mutate()} disabled={logout.isPending}>Log out</Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="h-11 text-destructive">Delete my data</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete all your data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes your tokens, key, settings, pending purchases and history from this app. Your YNAB budget is not
                  touched. If you connected with YNAB, also revoke the app in YNAB → Developer Settings → Authorized Applications.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="h-11">Cancel</AlertDialogCancel>
                <AlertDialogAction className="h-11 bg-destructive text-white hover:bg-destructive/90" onClick={() => deleteAccount.mutate()}>
                  Delete everything
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Section>
    </div>
  );
}
