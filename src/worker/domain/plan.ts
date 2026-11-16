// domain/plan.ts — WP5 (DESIGN §10.1, §10.5–§10.7, §10.9 pre-pass). PURE: no I/O, no Env, no Date.now().
import { diffDays } from "../../shared/dates";
import { payeeSimilarity } from "../../shared/payee";
import { allocate } from "./allocate";
import { dateWindow, inWindow } from "./dates";
import { fmtAmount, fmtDate, txnPayee } from "./labels";
import { hasTag } from "./memo";
import {
  AUTO, MARGIN, REVIEW_MIN, baseCandidate, isApprovedImport, openLines, scoreDetail, txnNames, type ScoreDetail,
} from "./score";
import { MAX_CHARGES, MAX_LINES, anySubsetFits, enumerateAssignments, fitRange, fits, type PlannedOption } from "./subsets";
import type { DIntent, DTxn, Decision, ReconcileInput } from "./types";

export const AMAZON_PAYEE_MIN = 0.8;
export const YNAB_AUTO_PAYEE_MIN = 0.4;
export const MAX_REVIEW_OPTIONS = 3;
export const MAX_AMAZON_OPTIONS = 5;

const byDateId = <T extends { id: string }>(date: (x: T) => string) => (a: T, b: T): number =>
  date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const number = (opts: PlannedOption[]): PlannedOption[] => opts.map((o, k) => ({ ...o, id: `o${k + 1}` }));

/** Does a charge also fit another open Amazon intent (any subset of its open lines)? */
function fitsOtherAmazon(i: DIntent, t: DTxn, pool: DIntent[], maxTaxRate: number): boolean {
  return pool.some((o) => o.id !== i.id && o.merchantKind === "amazon" && o.direction === i.direction
    && anySubsetFits(Math.abs(t.amount), openLines(o), maxTaxRate));
}

export function planReconciliation(input: ReconcileInput): Decision[] {
  const out: Decision[] = [];
  const { settings, decimalDigits } = input;
  const intents = input.intents.filter((i) => i.status !== "review" && i.placeholderStatus !== "final").sort(byDateId((i) => i.date));
  const txns = [...input.txns].sort(byDateId((t) => t.date));
  const byId = new Map(txns.map((t) => [t.id, t]));
  const amazonPool = [...intents, ...input.otherOpenAmazonIntents].filter((i) => i.merchantKind === "amazon");
  const done = new Set<string>();      // intents with a decision in this run
  const used = new Set<string>();      // txns claimed in this run
  const alloc = (t: DTxn, i: DIntent, lines = openLines(i)) => allocate(Math.abs(t.amount), lines, i.direction, decimalDigits);
  const desc = (i: DIntent) => `${i.payee} ~${fmtAmount(i.total, decimalDigits)} (${fmtDate(i.date)})`;

  // ── 0. idempotency pre-pass: an import tagged for an open intent but with no live match (crash repair) ──
  for (const i of intents) {
    const open = openLines(i);
    if (open.length === 0) continue;
    const t = txns.find((x) => !x.deleted && x.importId !== null && x.id !== i.placeholderTxnId
      && !input.excluded.has(x.id) && !used.has(x.id) && hasTag(x.memo, i.shortRef));
    if (!t) continue;
    out.push({ kind: "finalize", intentId: i.id, txnId: t.id, lineIds: open.map((l) => l.id) });
    done.add(i.id);
    used.add(t.id);
  }

  // ── 1. YNAB's own auto-match of a placeholder (§10.7) ──
  for (const i of intents) {
    if (done.has(i.id) || i.placeholderStatus !== "created" || i.placeholderTxnId === null) continue;
    const pid = i.placeholderTxnId;
    const p = byId.get(pid);
    const partner = txns.find((t) => !t.deleted && t.id !== pid && t.matchedTransactionId === pid);
    let target: DTxn | undefined;
    if (p && !p.deleted && (p.importId !== null || p.matchedTransactionId !== null)) target = p;
    else if (partner) target = partner;
    else if (!p || p.deleted) {
      out.push({ kind: "placeholder_missing", intentId: i.id });
      continue; // the intent stays pending and may still match an import below
    } else continue;
    if (used.has(target.id) || (target.id !== pid && input.excluded.has(target.id))) continue;
    const open = openLines(i);
    if (open.length === 0) continue;

    // Merged in place, the txn keeps *our* payee name: judge it by the import's names only.
    const importNames = [target.importPayeeNameOriginal, target.importPayeeName].filter((n): n is string => n !== null);
    const names = target.id === pid ? (importNames.length ? importNames : [target.payeeName]) : txnNames(target);
    const sim = payeeSimilarity(i.payee, names);
    const delta = diffDays(target.date, i.date);
    const allocation = alloc(target, i, open);
    done.add(i.id);
    used.add(target.id);
    used.add(pid);
    if (sim < YNAB_AUTO_PAYEE_MIN || !inWindow(delta, dateWindow(i.merchantKind, settings.amazonWindowDays))) {
      out.push({
        kind: "review", intentId: i.id, txnId: target.id, reviewKind: "ynab_matched_other",
        summary: `YNAB matched the placeholder for ${desc(i)} with ${txnPayee(target)} ${fmtAmount(target.amount, decimalDigits)} on ${fmtDate(target.date)}. Is that right?`,
        options: [{ id: "o1", intentId: i.id, transactionId: target.id, lineIds: open.map((l) => l.id), allocation, score: sim }],
      });
      continue;
    }
    out.push({
      kind: "ynab_auto", intentId: i.id, txnId: target.id, allocation,
      needsSplit: new Set(open.map((l) => l.categoryId)).size > 1,
    });
  }

  // ── 2. Amazon multi-item intents (§10.6) ──
  for (const i of intents) {
    const R = openLines(i);
    if (done.has(i.id) || i.merchantKind !== "amazon" || R.length < 2) continue;
    if (R.length > MAX_LINES) {
      out.push({
        kind: "review", intentId: i.id, txnId: null, reviewKind: "too_complex", options: [],
        summary: `${desc(i)} has ${R.length} items, too many to match automatically. Link the charges manually.`,
      });
      done.add(i.id);
      continue;
    }
    const minLo = Math.min(...R.map((l) => fitRange([l], settings.maxTaxRate).lo));
    const maxHi = fitRange(R, settings.maxTaxRate).hi;
    const C = txns
      .filter((t) => {
        if (used.has(t.id) || !baseCandidate(i, t, input)) return false;
        const abs = Math.abs(t.amount);
        return payeeSimilarity(i.payee, txnNames(t)) >= AMAZON_PAYEE_MIN && diffDays(t.date, i.date) >= -2 && minLo <= abs && abs <= maxHi;
      })
      .sort((a, b) => Math.abs(diffDays(a.date, i.date)) - Math.abs(diffDays(b.date, i.date)) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
      .slice(0, MAX_CHARGES);

    // 1) the whole remaining order in one charge, uniquely: the only automatic path
    const W = C.filter((c) => fits(Math.abs(c.amount), R, settings.maxTaxRate));
    const w0 = W[0];
    if (W.length === 1 && w0 && !isApprovedImport(w0, input.uncategorizedIds) && !fitsOtherAmazon(i, w0, amazonPool, settings.maxTaxRate)) {
      out.push({
        kind: "apply", intentId: i.id, txnId: w0.id, lineIds: R.map((l) => l.id), allocation: alloc(w0, i, R),
        score: 1, matchKind: "amazon_subset",
      });
      done.add(i.id);
      used.add(w0.id);
      continue;
    }

    // 2) review options (no auto-apply in v1)
    const opts = enumerateAssignments(i, C, input);
    if (opts.length === 0) continue; // charges not here yet
    const everyFitsOther = opts.every((o) => {
      const c = byId.get(o.transactionId);
      return c !== undefined && fitsOtherAmazon(i, c, amazonPool, settings.maxTaxRate);
    });
    const keyId = opts[0]?.transactionId;
    const key = keyId !== undefined ? byId.get(keyId) : undefined;
    if (everyFitsOther && key) {
      const partners = intents.filter((o) => o.id !== i.id && !done.has(o.id) && o.merchantKind === "amazon"
        && o.direction === i.direction && baseCandidate(o, key, input)
        && anySubsetFits(Math.abs(key.amount), openLines(o), settings.maxTaxRate));
      if (partners.length > 0) {
        const per = [i, ...partners].map((x) => enumerateAssignments(x, [key], input).slice(0, MAX_AMAZON_OPTIONS));
        // Each intent's best option first, then the best of the rest, up to 2 × MAX_AMAZON_OPTIONS.
        const firsts = per.map((p) => p[0]).filter((o): o is PlannedOption => o !== undefined);
        const rest = per.flatMap((p) => p.slice(1)).sort((a, b) => b.score - a.score);
        const options = number([...firsts, ...rest].slice(0, Math.max(firsts.length, 2 * MAX_AMAZON_OPTIONS)));
        out.push({
          kind: "review", intentId: null, txnId: key.id, reviewKind: "amazon_split", options,
          summary: `Amazon charge ${fmtAmount(key.amount, decimalDigits)} on ${fmtDate(key.date)} fits more than one Amazon order. Which one is it?`,
        });
        for (const x of [i, ...partners]) done.add(x.id);
        used.add(key.id);
        continue;
      }
    }
    out.push({
      kind: "review", intentId: i.id, txnId: null, reviewKind: "amazon_split",
      options: number(opts.slice(0, MAX_AMAZON_OPTIONS)),
      summary: `Which Amazon charge pays for which items of ${desc(i)}?`,
    });
    done.add(i.id);
  }

  // ── 3. single-charge intents (§10.5) ──
  type Pair = { i: DIntent; t: DTxn; d: ScoreDetail };
  const pairs: Pair[] = [];
  for (const i of intents) {
    if (done.has(i.id) || openLines(i).length === 0) continue;
    if (i.merchantKind === "amazon" && openLines(i).length >= 2) continue;
    for (const t of txns) {
      if (used.has(t.id)) continue;
      const d = scoreDetail(i, t, input);
      if (d && d.score >= REVIEW_MIN) pairs.push({ i, t, d });
    }
  }
  pairs.sort((a, b) => b.d.score - a.d.score || byDateId<DIntent>((x) => x.date)(a.i, b.i) || byDateId<DTxn>((x) => x.date)(a.t, b.t));
  const assignedI = new Set<string>();
  const assignedT = new Set<string>();
  for (const p of pairs) {
    if (assignedI.has(p.i.id) || assignedT.has(p.t.id)) continue;
    const s = p.d.score;
    // Competing scores among what is still free in this run.
    let secondI = 0;
    let secondT = 0;
    for (const q of pairs) {
      if (q === p) continue;
      if (q.i === p.i && q.t !== p.t && !assignedT.has(q.t.id)) secondI = Math.max(secondI, q.d.score);
      if (q.t === p.t && q.i !== p.i && !assignedI.has(q.i.id)) secondT = Math.max(secondT, q.d.score);
    }
    const amazonGuard = p.i.merchantKind === "amazon" && fitsOtherAmazon(p.i, p.t, amazonPool, settings.maxTaxRate);
    const open = openLines(p.i);
    if (s >= AUTO && s - secondI >= MARGIN && s - secondT >= MARGIN && !p.d.reviewOnly && !amazonGuard) {
      out.push({
        kind: "apply", intentId: p.i.id, txnId: p.t.id, lineIds: open.map((l) => l.id), allocation: alloc(p.t, p.i, open),
        score: s, matchKind: open.length > 1 ? "split" : "single",
      });
      assignedI.add(p.i.id);
      assignedT.add(p.t.id);
      continue;
    }
    const cands = pairs.filter((q) => q.i === p.i && !assignedT.has(q.t.id)).slice(0, MAX_REVIEW_OPTIONS);
    const best = cands[0];
    if (!best) continue;
    const approved = best.d.reviewOnly;
    const catName = best.t.categoryId !== null ? input.categoryNames.get(best.t.categoryId) ?? "another category" : "another category";
    out.push({
      kind: "review", intentId: p.i.id, txnId: null,
      reviewKind: approved ? "approved_import" : "ambiguous_match",
      summary: approved
        ? `Import already approved as ${catName}; apply your split?`
        : cands.length > 1
          ? `${cands.length} possible matches for ${desc(p.i)}`
          : `Possible match for ${desc(p.i)}: please confirm`,
      options: number(cands.map((q) => ({
        id: "", intentId: q.i.id, transactionId: q.t.id, lineIds: open.map((l) => l.id), allocation: alloc(q.t, q.i, open), score: q.d.score,
      }))),
    });
    assignedI.add(p.i.id);
  }
  return out;
}
