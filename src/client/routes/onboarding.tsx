// routes/onboarding.tsx — WP6 (DESIGN §11.2 "/onboarding"): (1) plan, (2) default account, (3) timezone,
// (4) Anthropic key, (5) AI data consent naming Anthropic. Finishing returns to "/".
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Me } from "../../shared/schemas";
import { PlainPage } from "../components/Page";
import { AccountSelect } from "../components/AccountSelect";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { useCatalog } from "../hooks/useCatalog";
import { meQueryOptions, needsOnboarding, useMe } from "../hooks/useMe";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/utils";
import { AnthropicKeyForm, PlanSelect, timezones, usePatchSettings } from "./settings";

const STEPS = ["Plan", "Account", "Time zone", "Anthropic key", "Consent"] as const;

export function firstStep(me: Me): number {
  if (!me.settings.planId) return 0;
  if (!me.hasAnthropicKey) return 3;
  if (!me.settings.aiDataConsent) return 4;
  return 0;
}

const browserTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function OnboardingPage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const patch = usePatchSettings();
  const [step, setStep] = useState<number | null>(null);
  const [tz, setTz] = useState(browserTz);
  const [consent, setConsent] = useState(false);
  const catalog = useCatalog({ enabled: !!me?.settings.planId && (step ?? 0) >= 1 });
  const tzList = useMemo(() => timezones(tz), [tz]);

  if (!me) return <PlainPage><Skeleton className="h-64 w-full" /></PlainPage>;
  const current = step ?? firstStep(me);
  const next = () => setStep(Math.min(current + 1, STEPS.length - 1));

  const finish = async () => {
    try {
      await patch.mutateAsync({ aiDataConsent: true });
    } catch {
      return; // usePatchSettings already toasted the error
    }
    // The shell guard reads the cached `me`: refresh it before leaving.
    const fresh = await qc.fetchQuery({ ...meQueryOptions, staleTime: 0 });
    if (!needsOnboarding(fresh)) await navigate({ to: "/" });
    else setStep(firstStep(fresh));
  };

  return (
    <PlainPage>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">AI Boost for YNAB</p>
        <h1 className="text-2xl font-semibold tracking-tight">Set up</h1>
      </div>
      <ol className="flex gap-1" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className="flex-1">
            <button
              type="button"
              onClick={() => i <= current && setStep(i)}
              className={cn("h-1.5 w-full rounded-full", i <= current ? "bg-primary" : "bg-muted")}
              aria-label={`${i + 1}. ${label}`}
              aria-current={i === current ? "step" : undefined}
            />
          </li>
        ))}
      </ol>

      <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
        <h2 className="text-lg font-semibold">{current + 1}. {STEPS[current]}</h2>

        {current === 0 && (
          <>
            <p className="text-sm text-muted-foreground">Which YNAB plan should the app work in?</p>
            <PlanSelect
              value={me.settings.planId}
              {...(me.plan ? { currentName: me.plan.name } : {})}
              onChange={(planId) => patch.mutate({ planId })}
            />
            <Button className="h-11" disabled={!me.settings.planId || patch.isPending} onClick={next}>Next</Button>
          </>
        )}

        {current === 1 && (
          <>
            <p className="text-sm text-muted-foreground">
              Placeholders go to this account when you don't name one. Accounts without a bank import get final entries instead.
            </p>
            {catalog.isPending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> Reading your plan from YNAB…
              </div>
            )}
            {catalog.isError && <p className="text-sm text-destructive">{errorMessage(catalog.error)}</p>}
            {catalog.data && (
              <AccountSelect
                accounts={catalog.data.accounts}
                value={me.settings.defaultAccountId}
                onChange={(defaultAccountId) => patch.mutate({ defaultAccountId })}
              />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" className="h-11" onClick={next}>Skip</Button>
              <Button className="h-11 flex-1" disabled={!me.settings.defaultAccountId} onClick={next}>Next</Button>
            </div>
          </>
        )}

        {current === 2 && (
          <>
            <p className="text-sm text-muted-foreground">Used for “today” and “yesterday” when you describe a purchase.</p>
            <Select value={tz} onValueChange={setTz}>
              <SelectTrigger className="h-11 w-full" aria-label="Time zone"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-80">
                {tzList.map((z) => <SelectItem key={z} value={z}>{z}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              className="h-11"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ timezone: tz }, { onSuccess: next })}
            >
              Next
            </Button>
          </>
        )}

        {current === 3 && (
          <>
            <p className="text-sm text-muted-foreground">
              Claude reads what you say and suggests categories. You use your own Anthropic API key, billed to your Anthropic account.
            </p>
            <AnthropicKeyForm hasKey={me.hasAnthropicKey} onDone={next} />
            {me.hasAnthropicKey && <Button className="h-11" onClick={next}>Next</Button>}
          </>
        )}

        {current === 4 && (
          <>
            <div className="flex flex-col gap-2 text-sm">
              <p>
                To parse what you say and suggest categories, this app sends data to <strong>Anthropic</strong> (the Claude API)
                using your key:
              </p>
              <ul className="list-disc pl-5 text-muted-foreground">
                <li>the text you type or dictate,</li>
                <li>your YNAB category, account and payee names.</li>
              </ul>
              <p className="text-muted-foreground">You can turn this off in Settings at any time.</p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="consent" className="font-medium">I agree to send this data to Anthropic</Label>
              <Switch id="consent" checked={consent} onCheckedChange={setConsent} />
            </div>
            <Button className="h-11" disabled={!consent || patch.isPending || !me.hasAnthropicKey || !me.settings.planId} onClick={() => void finish()}>
              {patch.isPending ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Finish
            </Button>
            {(!me.hasAnthropicKey || !me.settings.planId) && (
              <p className="text-xs text-destructive">
                {!me.settings.planId ? "Pick a plan first (step 1)." : "Add your Anthropic key first (step 4)."}
              </p>
            )}
          </>
        )}
      </section>
    </PlainPage>
  );
}
