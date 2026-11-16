# Spikes (DESIGN §14)

Record each spike here: date, who ran it, setup, raw observations (redact tokens and ids), and the
decision it drives. Change §10.7 / §10.11 only through a DESIGN PR that links the entry below.

| # | Status | Owner | Result (one line) |
|---|---|---|---|
| S1 | open | WP3 | |
| S2 | open | WP3 | |
| S3 | open | WP3 | |
| S4 | open | WP3 | |
| S5 | open | WP2 | |
| S6 | open | WP4 | |
| S7 | **done** | WP1 | `vite build` bundles `ynab@5` + `@anthropic-ai/sdk@1.9.0` cleanly (see below). |

---

## S1: How does YNAB's auto-match of placeholder + import appear?

- **Question:** which id survives; `matched_transaction_id`, `import_id`, `approved` after the merge? Exact names of
  the internal and "Credit Card Payments" category groups; `direct_import_linked` on a linked vs a cash account.
- **Setup:**
- **Observations:**
- **Decision (§10.7 detection branch, `safeDeletePlaceholder` guard):**

## S2: Does bulk `PATCH /transactions` with `subtransactions` convert an imported txn into a split?

- **Setup:**
- **Observations:** (PATCH result; PUT result if PATCH ignores it; confirm editing an existing split errors)
- **Decision (internals of `updateTransactions`):**

## S3: Is a placeholder dated "today" in UTC−8 at 11 pm (tomorrow in UTC) accepted?

- **Setup:**
- **Observations:**
- **Decision (§10.7 date clamp):**

## S4: Can a `server_knowledge` from per-resource endpoints be used with `GET /plans/{id}`?

- **Setup:**
- **Observations:**
- **Decision (§10.11 initial sync):**

## S5: Do refresh tokens rotate? Does an old refresh token still work?

- **Setup:**
- **Observations:**
- **Decision (refresh locking strictness):**

## S6: Does whisper-large-v3-turbo accept WebM/Opus and MP4/AAC? Nova-3 `body` encoding? Latency?

- **Setup:** (devices, browsers, MIME types recorded)
- **Observations:**
- **Decision (`STT_MODEL` default, client MIME preference):**

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
