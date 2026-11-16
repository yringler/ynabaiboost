// routes/capture.tsx — WP6 (DESIGN §11.2 "/"): say or type → Parse (Claude) → confirm drafts → Save.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2Icon, PencilIcon, SparklesIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import type { CreateIntentsRes, ParseRes } from "../../shared/api";
import { todayIn } from "../../shared/dates";
import type { InputMode, Intent } from "../../shared/schemas";
import { PageTitle } from "../components/Page";
import { DraftEditor } from "../components/DraftEditor";
import { MicButton } from "../components/MicButton";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { useCatalog } from "../hooks/useCatalog";
import { useMe } from "../hooks/useMe";
import { useSpeechInput } from "../hooks/useSpeechInput";
import { AI_ERROR_CODES, call, errorMessage, isAbort, isApiError } from "../lib/api";
import { draftToState, emptyDraft, stateToIntentCreate, type DraftState } from "../lib/draft";
import { DATA_KEYS } from "../lib/queryKeys";

type ParseResT = z.infer<typeof ParseRes>;
type CreateResT = z.infer<typeof CreateIntentsRes>;
type InputModeT = z.infer<typeof InputMode>;

/** Toast text for a saved intent (§11.2). */
export function savedMessage(i: Intent): string {
  if (i.matchedTransactionIds.length > 0 || i.placeholder.status === "auto_matched") return "Matched to an existing import";
  if (i.placeholder.status === "final") return "Saved · recorded as final (no bank import)";
  if (i.placeholder.status === "created") return "Saved · placeholder created";
  if (i.status === "review") return "Saved · check Review";
  return "Saved";
}

const appendText = (base: string, add: string) => (base.trim() ? `${base.replace(/\s+$/, "")} ${add}` : add);

export function CapturePage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const catalog = useCatalog({ enabled: !!me?.settings.planId });
  const [text, setText] = useState("");
  const [inputMode, setInputMode] = useState<InputModeT>("typed");
  const [drafts, setDrafts] = useState<DraftState[]>([]);
  const [rawText, setRawText] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [aiFailed, setAiFailed] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const abortRef = useRef<AbortController | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const settings = me?.settings;
  const decimals = catalog.data?.currency.decimalDigits ?? me?.plan?.currency.decimalDigits ?? 2;
  const placeholdersEnabled = settings?.createPlaceholders ?? true;
  const today = todayIn(settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  const speech = useSpeechInput({
    preferServer: !!me?.sttAllowed && settings?.voiceMode === "server",
    onText: useCallback((t: string, source: "browser_stt" | "server_stt") => {
      setText((prev) => appendText(prev, t).slice(0, 2000));
      setInputMode(source);
    }, []),
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  const parse = useMutation<ParseResT, unknown, { text: string; inputMode: InputModeT }>({
    mutationFn: (body) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      return call("parse", { body, signal: ac.signal });
    },
    onMutate: () => {
      setQuestion(null);
      setAiFailed(null);
      setWarnings([]);
    },
    onSuccess: (res, vars) => {
      if (res.status === "needs_clarification") {
        setQuestion(res.question ?? "Can you add a bit more detail?");
        return;
      }
      if (res.status === "not_a_transaction" || res.drafts.length === 0) {
        toast("That doesn't look like a purchase. Try e.g. “about 200 at Costco, groceries”.");
        return;
      }
      setRawText(vars.text);
      setDrafts(res.drafts.map((d) => draftToState(d, decimals, placeholdersEnabled)));
      setWarnings(res.warnings);
      setErrors({});
    },
    onError: (e) => {
      if (isAbort(e)) return;
      const msg = errorMessage(e);
      if (isApiError(e) && AI_ERROR_CODES.includes(e.code)) setAiFailed(msg);
      else toast.error(msg);
    },
  });

  const save = useMutation<CreateResT, unknown, void>({
    mutationFn: () => {
      const built = drafts.map((d) => ({ d, r: stateToIntentCreate(d, decimals) }));
      const errs: Record<string, string[]> = {};
      for (const { d, r } of built) if (!r.ok) errs[d.key] = r.errors;
      setErrors(errs);
      if (Object.keys(errs).length > 0) return Promise.reject(new Error("Fix the highlighted fields"));
      const intents = built.flatMap(({ r }) => (r.ok ? [r.value] : []));
      return call("createIntents", { body: { intents, rawText: rawText.slice(0, 2000), inputMode } });
    },
    onSuccess: async (res) => {
      const msgs = [...new Set(res.intents.map(savedMessage))];
      toast.success(msgs.join(" · ") || "Saved");
      for (const w of res.warnings) toast.warning(w);
      setDrafts([]);
      setText("");
      setRawText("");
      setWarnings([]);
      setInputMode("typed");
      await Promise.all(DATA_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey })));
      textRef.current?.focus();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doParse = () => {
    const t = text.trim();
    if (!t || parse.isPending) return;
    if (speech.state === "listening") speech.stop();
    parse.mutate({ text: t.slice(0, 2000), inputMode });
  };

  const enterManually = () => {
    setRawText(text.trim());
    setDrafts([emptyDraft(today, placeholdersEnabled, text.trim())]);
    setAiFailed(null);
    setQuestion(null);
  };

  const hasDrafts = drafts.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>Capture</PageTitle>

      {question && (
        <div role="status" className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
          {question}
        </div>
      )}

      {!hasDrafts && (
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Textarea
              ref={textRef}
              autoFocus
              aria-label="What did you spend?"
              placeholder="About 200 at Costco, groceries and a phone case for 25"
              value={text}
              maxLength={2000}
              onChange={(e) => {
                setText(e.target.value);
                if (!e.target.value) setInputMode("typed");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  doParse();
                }
              }}
              className="min-h-36 resize-none text-base"
              disabled={parse.isPending}
            />
            {speech.interim && (
              <p className="pointer-events-none mt-1 text-sm text-muted-foreground italic" aria-live="polite">
                {speech.interim}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <MicButton speech={speech} />
            {parse.isPending ? (
              <>
                <Button type="button" className="h-12 flex-1" disabled>
                  <Loader2Icon className="animate-spin" /> Thinking…
                </Button>
                <Button type="button" variant="outline" className="h-12" onClick={() => abortRef.current?.abort()} aria-label="Cancel parsing">
                  <XIcon /> Cancel
                </Button>
              </>
            ) : (
              <Button type="button" className="h-12 flex-1 text-base" onClick={doParse} disabled={!text.trim()}>
                <SparklesIcon /> Parse
              </Button>
            )}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="hidden sm:inline">⌘/Ctrl + Enter to parse</span>
            <button type="button" className="min-h-11 underline-offset-4 hover:underline" onClick={enterManually}>
              <PencilIcon className="mr-1 inline size-3" />
              Enter manually
            </button>
          </div>
          {aiFailed && (
            <div role="alert" className="flex flex-col gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              <span>{aiFailed}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-9" onClick={enterManually}>Enter manually</Button>
                {isApiError(parse.error) && parse.error.code.startsWith("anthropic") && (
                  <Button size="sm" variant="ghost" className="h-9" asChild>
                    <Link to="/settings">Settings</Link>
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {hasDrafts && (
        <div className="flex flex-col gap-3">
          {rawText && <p className="text-sm text-muted-foreground">“{rawText}”</p>}
          {warnings.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" role="status">
              {warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {catalog.isPending && <Skeleton className="h-80 w-full rounded-xl" />}
          {catalog.isError && <p className="text-sm text-destructive">{errorMessage(catalog.error)}</p>}
          {catalog.data &&
            drafts.map((d, i) => (
              <DraftEditor
                key={d.key}
                draft={d}
                catalog={catalog.data}
                placeholdersEnabled={placeholdersEnabled}
                errors={errors[d.key] ?? []}
                onChange={(nd) => setDrafts((all) => all.map((x, j) => (j === i ? nd : x)))}
                {...(drafts.length > 1 ? { onRemove: () => setDrafts((all) => all.filter((_, j) => j !== i)) } : {})}
              />
            ))}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-12"
              onClick={() => {
                setDrafts([]);
                setErrors({});
              }}
              disabled={save.isPending}
            >
              Back
            </Button>
            <Button type="button" className="h-12 flex-1 text-base" onClick={() => save.mutate()} disabled={save.isPending || !catalog.data}>
              {save.isPending ? <><Loader2Icon className="animate-spin" /> Saving…</> : drafts.length > 1 ? `Save ${drafts.length}` : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
