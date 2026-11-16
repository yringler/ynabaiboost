// components/EditSheet.tsx — conversational edit of pending items (DESIGN §9.6, §11.2): voice or text →
// POST /api/intents/edit → the plan (one line per change, refused changes, Claude's question) → Apply sends only
// the server-issued token. With "Apply voice edits without confirming" the server may apply at once; then the
// summary is a toast.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, SparklesIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { MAX_EDIT_CHARS, type EditRes } from "../../shared/api";
import type { InputMode, Intent } from "../../shared/schemas";
import { useMe } from "../hooks/useMe";
import { useSpeechInput } from "../hooks/useSpeechInput";
import { call, errorMessage } from "../lib/api";
import { DATA_KEYS } from "../lib/queryKeys";
import { MicButton } from "./MicButton";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { Textarea } from "./ui/textarea";

type EditResT = z.infer<typeof EditRes>;
type InputModeT = z.infer<typeof InputMode>;

const appendText = (base: string, add: string) => (base.trim() ? `${base.replace(/\s+$/, "")} ${add}` : add);

/** Toast text for an applied plan. */
export function appliedMessage(res: EditResT): { ok: boolean; text: string } {
  const failed = res.results.filter((r) => !r.ok).length;
  if (failed === 0) return { ok: true, text: res.summary || "Done" };
  return { ok: false, text: `${res.results.length - failed} of ${res.results.length} changes applied` };
}

export function EditSheet({ open, onOpenChange, selected, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; selected: Intent[]; onDone?: () => void;
}) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [text, setText] = useState("");
  const [inputMode, setInputMode] = useState<InputModeT>("typed");
  const [plan, setPlan] = useState<EditResT | null>(null);

  useEffect(() => {
    if (!open) {
      setText("");
      setInputMode("typed");
      setPlan(null);
    }
  }, [open]);

  const speech = useSpeechInput({
    preferServer: !!me?.sttAllowed && me?.settings.voiceMode === "server",
    onText: useCallback((t: string, source: "browser_stt" | "server_stt") => {
      setText((prev) => appendText(prev, t).slice(0, MAX_EDIT_CHARS));
      setInputMode(source);
    }, []),
  });

  const invalidate = () => Promise.all(DATA_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
  const finish = async (res: EditResT) => {
    await invalidate();
    for (const w of res.warnings) toast.warning(w);
    const m = appliedMessage(res);
    if (m.ok) {
      toast.success(m.text);
      onDone?.();
      onOpenChange(false);
    } else {
      toast.warning(m.text);
      setPlan(res);                                   // show which change failed and why
    }
  };

  const preview = useMutation({
    mutationFn: () => call("editIntents", {
      body: { text: text.trim().slice(0, MAX_EDIT_CHARS), selectedIntentIds: selected.map((i) => i.id), inputMode },
    }),
    onMutate: () => setPlan(null),
    onSuccess: async (res) => {
      if (res.applied) await finish(res);
      else setPlan(res);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const apply = useMutation({
    mutationFn: (token: string) => call("applyEdit", { body: { token } }),
    onSuccess: finish,
    onError: (e) => toast.error(errorMessage(e)),
  });

  const busy = preview.isPending || apply.isPending;
  const submit = () => {
    if (!text.trim() || busy) return;
    if (speech.state === "listening") speech.stop();
    preview.mutate();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-safe mx-auto max-h-[90dvh] max-w-xl overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Edit by voice or text</SheetTitle>
          <SheetDescription>
            {selected.length > 0
              ? `Changing: ${selected.map((i) => i.payee).join(", ")}`
              : "Nothing selected: Claude can change any pending item, and asks when it's unsure which."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-4">
          <Textarea
            aria-label="What should change?"
            placeholder={selected.length > 0 ? "e.g. that was actually the 13th · make it 212.47 · delete these" : "e.g. the Costco one was on the Amex · I also spent 40 at Target, gas"}
            value={text}
            maxLength={MAX_EDIT_CHARS}
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value) setInputMode("typed");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            className="min-h-24 resize-none text-base"
            disabled={busy}
          />
          {speech.interim && <p className="text-sm text-muted-foreground italic" aria-live="polite">{speech.interim}</p>}
          <div className="flex items-center gap-3">
            <MicButton speech={speech} />
            <Button type="button" className="h-12 flex-1" onClick={submit} disabled={!text.trim() || busy}>
              {preview.isPending ? <><Loader2Icon className="animate-spin" /> Thinking…</> : <><SparklesIcon /> Preview</>}
            </Button>
          </div>

          {plan && <PlanView plan={plan} />}

          {plan && !plan.applied && (
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="h-11 flex-1" onClick={() => onOpenChange(false)} disabled={apply.isPending}>
                Cancel
              </Button>
              <Button
                type="button"
                className="h-11 flex-1"
                onClick={() => plan.token && apply.mutate(plan.token)}
                disabled={!plan.token || apply.isPending}
              >
                {apply.isPending ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Apply
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PlanView({ plan }: { plan: EditResT }) {
  return (
    <section aria-label="Planned changes" className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      {plan.question && (
        <p role="status" className="rounded-md bg-accent px-3 py-2 text-accent-foreground">{plan.question}</p>
      )}
      {plan.summary && plan.lines.length > 0 && <p className="font-medium">{plan.summary}</p>}
      {plan.lines.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="edit-plan-lines">
          {plan.lines.map((line, k) => {
            const r = plan.applied ? plan.results[k] : undefined;
            return (
              <li key={k} className="flex items-start gap-2">
                {r ? (r.ok ? <CheckIcon className="mt-0.5 size-4 shrink-0 text-ok" aria-label="applied" /> : <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="failed" />) : <span aria-hidden className="mt-0.5">•</span>}
                <span>
                  {line}
                  {r && !r.ok && r.error && <span className="block text-xs text-destructive">{r.error}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {plan.lines.length === 0 && !plan.question && <p className="text-muted-foreground">Nothing to change.</p>}
      {plan.dropped.length > 0 && (
        <div className="rounded-md bg-warn-soft px-3 py-2 text-warn">
          <p className="font-medium">Not included:</p>
          <ul className="list-disc pl-4">{plan.dropped.map((d, k) => <li key={k}>{d}</li>)}</ul>
        </div>
      )}
      {plan.warnings.length > 0 && (
        <ul className="text-xs text-muted-foreground">{plan.warnings.map((w, k) => <li key={k}>{w}</li>)}</ul>
      )}
    </section>
  );
}
