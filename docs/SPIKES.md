# Spikes (DESIGN §14)

Record each spike here: date, who ran it, setup, raw observations (redact tokens and ids), and the
decision it drives. Change §10.7 / §10.11 only through a DESIGN PR that links the entry below.

| # | Status | Owner | Result (one line) |
|---|---|---|---|
| S1 | **blocked** (no YNAB credentials in the build env) | WP3 | Code assumes §10.7 as written; group names `Internal Master Category` / `Credit Card Payments` are constants in `ynab/cache.ts`. |
| S2 | **blocked** (no YNAB credentials) | WP3 | `updateTransactions` sends `subtransactions` in the bulk PATCH; switch to per-txn PUT inside `ynab/client.ts` if S2 fails. |
| S3 | **blocked** (no YNAB credentials) | WP3 | Client passes YNAB 400s through as `ynab_error`; the §10.7 UTC retry lives in WP5. |
| S4 | **blocked** (no YNAB credentials) | WP3 | Initial sync stores the minimum of the four per-resource knowledges, then uses `GET /plans/{id}` deltas. |
| S5 | open | WP2 | |
| S6 | **blocked** (no Cloudflare credentials / phones in the build env) | WP4 | Default stays `STT_MODEL=whisper`; nova3 sends the audio as a stream. Run on real phones before enabling server STT for anyone. |
| S7 | **done** | WP1 | `vite build` bundles `ynab@5` + `@anthropic-ai/sdk@1.9.0` cleanly (see below). |

---

## S1: How does YNAB's auto-match of placeholder + import appear?

- **Question:** which id survives; `matched_transaction_id`, `import_id`, `approved` after the merge? Exact names of
  the internal and "Credit Card Payments" category groups; `direct_import_linked` on a linked vs a cash account.
- **Setup:**
- **Observations:**
- **Status (WP3 build, 2026-11-16):** not run — the build environment has no YNAB token. Run on day 1 of deployment with a PAT on a test plan.
- **Decision (§10.7 detection branch, `safeDeletePlaceholder` guard):**

## S2: Does bulk `PATCH /transactions` with `subtransactions` convert an imported txn into a split?

- **Setup:**
- **Observations:** (PATCH result; PUT result if PATCH ignores it; confirm editing an existing split errors)
- **Status (WP3 build, 2026-11-16):** not run — the build environment has no YNAB token. Run on day 1 of deployment with a PAT on a test plan.
- **Decision (internals of `updateTransactions`):**

## S3: Is a placeholder dated "today" in UTC−8 at 11 pm (tomorrow in UTC) accepted?

- **Setup:**
- **Observations:**
- **Status (WP3 build, 2026-11-16):** not run — the build environment has no YNAB token. Run on day 1 of deployment with a PAT on a test plan.
- **Decision (§10.7 date clamp):**

## S4: Can a `server_knowledge` from per-resource endpoints be used with `GET /plans/{id}`?

- **Setup:**
- **Observations:**
- **Status (WP3 build, 2026-11-16):** not run — the build environment has no YNAB token. Run on day 1 of deployment with a PAT on a test plan.
- **Decision (§10.11 initial sync):**

## S5: Do refresh tokens rotate? Does an old refresh token still work?

- **Setup:**
- **Observations:**
- **Decision (refresh locking strictness):**

## S6: Does whisper-large-v3-turbo accept WebM/Opus and MP4/AAC? Nova-3 `body` encoding? Latency?

- **Setup:** (devices, browsers, MIME types recorded)
- **Observations:**
- **Status (WP4 build, 2026-11-16):** not run. The Workers AI binding is remote-only and the build env has no
  Cloudflare credentials (tests stub `env.AI.run`). To run: `npx wrangler login`, `npm run dev`, enable STT for your
  user in Admin, set Voice → Server in Settings, then record 5–20 s notes on iOS Safari (expect `audio/mp4`) and
  Chrome Android (expect `audio/webm;codecs=opus`) with `STT_MODEL=whisper` and again with `STT_MODEL=nova3`. Record the
  MIME type, HTTP status, transcript quality and the `/api/stt` latency for each.
- **What the code does until then (`src/worker/ai/stt.ts`):**
  - whisper: `audio` = raw base64 (chunked, no `data:` prefix), `vad_filter: true`, `condition_on_previous_text: false`,
    `initial_prompt` = top 30 payees + 30 categories.
  - nova3: `audio: { body: ReadableStream, contentType }` (the binding types `body` as `object`, and Cloudflare's examples
    pass a stream; DESIGN §11.3 said base64, which does not type-check), `smart_format`, `numerals`.
  - Workers AI error 3040 (capacity) is retried once; anything else → `ai_unavailable` (503).
- **Decision (`STT_MODEL` default, client MIME preference):** pending. If whisper rejects `audio/mp4` from iOS, switch
  `STT_MODEL` to `nova3` (D10).

## S7: Does `vite build` with `@cloudflare/vite-plugin` bundle `ynab@5` cleanly?

- **Date / owner:** 2026-11-16, WP1.
- **Setup:** temporarily added a route to `src/worker/index.ts` that constructs `new PlansApi(new Configuration({ accessToken, fetchApi }))`,
  `new Anthropic({ apiKey })` and calls `zodOutputFormat(z.object(...))`; ran `vite build` (vite 8.3.8, @cloudflare/vite-plugin 1.69.1,
  wrangler 4.163.0, compat date 2026-11-01, `nodejs_compat`). The temporary route was then removed.
- **Observations:** build succeeded with no warnings about either SDK. Worker bundle 2,103.51 kB raw / 395.77 kB gzip
  (well under the Workers size limits). `ynab@5` depends on `fetch-ponyfill` → `node-fetch@2`; it bundles fine, and the
  Workers vitest pool needs `deps.optimizer.ssr.include: ["ynab"]` (already in `vitest.config.ts`) to avoid a CJS
  optional-peer (`encoding`) resolution warning. `test/worker/sdk-smoke.test.ts` keeps constructing both SDKs inside workerd.
- **Decision:** keep the official `ynab@5` SDK (no openapi-fetch fallback). Always pass a `fetchApi` so the ponyfill is never used.
