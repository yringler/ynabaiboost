# AI Boost for YNAB: research notes

Research done on 2026-11-16 by four research tracks: YNAB API, Cloudflare stack, speech-to-text, and prior art.

Facts marked **(verified)** were checked against the source, the downloaded package, or a local workerd/vitest run. Facts marked **(unverified)** come from a single secondary source or are inferred. `DESIGN.md` turns these notes into decisions. Where tracks disagreed, the resolution is written next to the conflict.

---

## 1. YNAB API

Primary sources:
- Docs: <https://api.ynab.com> (API v1.91.0, changelog 2026-11-10)
- OpenAPI spec: <https://api.ynab.com/papi/open_api_spec.yaml>
- SDK: npm [`ynab@5.0.0`](https://www.npmjs.com/package/ynab), repo [ynab/ynab-sdk-js](https://github.com/ynab/ynab-sdk-js)
- Support article: [Approving and matching transactions](https://support.ynab.com/en_us/approving-and-matching-transactions-a-guide-ByYNZaQ1i)

### 1.1 Authentication ([docs](https://api.ynab.com/#authentication))

**Personal Access Token (PAT)**
- Created under Account Settings → Developer Settings.
- Never expires. Can be revoked.
- Meant for the owner's personal use.

**OAuth Authorization Code grant**
- Authorize at `https://app.ynab.com/oauth/authorize?response_type=code&client_id&redirect_uri&state[&scope=read-only][&code_challenge&code_challenge_method=S256]`.
- PKCE with S256 is documented.
- Exchange the code with `POST https://app.ynab.com/oauth/token`, sending `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code` and optionally `code_verifier`.
- The response is `{access_token, token_type:"bearer", expires_in:7200, refresh_token}`. **Access tokens last 2 hours.**
- Refresh with `grant_type=refresh_token`. The response has the same shape and includes a new `refresh_token`.
- **(unverified)** Whether refresh tokens rotate or expire is not documented. Treat them as rotating and single-use.

**Implicit grant**
- Returns no refresh token, so it is unusable for cron.

**Scopes**
- Only `read-only` exists. Omitting it gives full read/write access.
- Writes made with a read-only token return 403.3.

**Restricted Mode**
- A new OAuth app can issue only **25 tokens to users other than the owner**.
- YNAB review lifts the limit and takes 2–4 weeks.

**OAuth requirements** ([docs](https://api.ynab.com/#oauth-requirements))
- The app name and domain may not contain "YNAB" unless "for" comes before it. "YNAB AI Boost" fails this rule; **"AI Boost for YNAB"** passes.
- You need a public privacy policy with a "Last Updated" date and a way to request data deletion.
- No data may be passed to third parties without the user knowing. The app must disclose that it sends data to Anthropic.
- Request the minimum permissions.

**Identity**
- `GET /user` returns `{id}`, which stays the same across PAT and OAuth.

### 1.2 Rate limits and errors ([docs](https://api.ynab.com/#rate-limiting))

**Rate limit**
- **200 requests per hour per access token**, over a rolling window. Exceeding it returns 429.
- Since v1.73.0 a 429 response no longer carries a reset header. You need your own counter and backoff.

**Errors**

| Code | Meaning |
|---|---|
| 401 | Not authorized |
| 403.1 | Subscription lapsed |
| 403.2 | Trial expired |
| 403.3 | Unauthorized scope |
| 403.4 | Data limit reached |
| 403.5 | Email unconfirmed |
| 404.1, 404.2 | Not found |
| 409 | Duplicate `import_id` |
| 500 | Server error |
| 503 | Also returned when a request runs longer than 30 s |

### 1.3 Budgets were renamed to plans

- v1.78.0 renamed the `budget_id` parameter to `plan_id`.
- v1.79.0 moved every path to `/plans/{plan_id}` and renamed the response keys to `plans`, `plan` and `default_plan`.
- The old `/budgets` paths still work but are no longer documented.
- `plan_id` accepts `last-used`, and `default` if the app has default plan selection enabled.

### 1.4 Endpoints this product uses

| Endpoint | Notes |
|---|---|
| `GET /user` | |
| `GET /plans` | |
| `GET /plans/{id}` | Supports delta requests. Returns changed accounts, categories, payees, transactions and subtransactions in one call. |
| `GET /plans/{id}/settings` | Currency format. |
| `GET /plans/{id}/accounts`, `/categories`, `/payees` | All support delta requests. Categories carry `hidden`, `deleted` and `internal` (added in v1.84.0). Since v1.78.0 the API can *create* categories; the product must never call that. |
| `GET /plans/{id}/transactions?since_date&until_date&type=uncategorized\|unapproved&last_knowledge_of_server` | **Pending bank charges are excluded.** They stay invisible until they post. `since_date` now defaults to one year ago. |
| `POST /plans/{id}/transactions` | Single or bulk create. Future dates are rejected. 409 or `duplicate_import_ids` on an `import_id` clash. |
| `PATCH /plans/{id}/transactions` | Bulk update by `id` or by `import_id` (not both). |
| `PUT /plans/{id}/transactions/{tid}` | |
| `DELETE /plans/{id}/transactions/{tid}` | |
| `POST /transactions/import` | Deprecated in v1.88.0. Now does nothing. |

### 1.5 Transaction fields and limits (from the spec)

**Amounts and dates**
- Amounts are int64 **milliunits**: $1 = 1000, and outflows are negative. The divisor is always 1000.
- Use `currency_format.decimal_digits` for display.
- Dates are `YYYY-MM-DD`, documented as UTC.

**Field limits and values**
- `memo` ≤ 500 characters. `payee_name` ≤ 200. `import_id` ≤ 36.
- `cleared` is `cleared`, `uncleared` or `reconciled`.
- `approved` defaults to **false** when you create a transaction.
- `flag_color` is `red|orange|yellow|green|blue|purple|""` or null.

**Read-only fields useful for matching**
- `import_id`, `matched_transaction_id`
- `import_payee_name`, `import_payee_name_original` (the raw bank descriptor)
- `transfer_account_id`, `deleted`, `subtransactions[]`

**Payee resolution**
- `payee_name` reuses an existing payee with the same name or creates a new one. Pass `payee_id` when you know it, to avoid clutter.

**Splits**
- To create a split, set `category_id: null` and pass `subtransactions`. Their amounts must add up exactly to the parent.
- On an *existing* split you cannot change `subtransactions`, the amount, the date or the `category_id`.
- Splits are not allowed on tracking accounts or on on-budget transfers.
- **(unverified)** Converting an existing non-split transaction into a split appears to work. The spec implies it, and the [@maro-org/ynab-mcp quirks doc](https://cdn.jsdelivr.net/npm/@maro-org/ynab-mcp@0.8.0/build/methodology/api-quirks.md) says it works. That same doc says edits to an existing split are *silently ignored*, while the spec says they error. Either way, **you only get one chance to split an imported transaction.**
- Never delete and recreate an imported transaction. It loses its `import_id`, and a deleted import does not come back.

### 1.6 Delta sync ([docs](https://api.ynab.com/#deltas))

- Every response includes `server_knowledge`. Pass it back as `last_knowledge_of_server` to get only the changes, including `deleted: true` tombstones.
- One `GET /plans/{id}?last_knowledge_of_server=N` per tick returns all changed entities. At one tick every 15 minutes that is 4 requests per hour.
- **(unverified)** Whether a `server_knowledge` taken from a per-resource endpoint can be passed to the plan endpoint.

### 1.7 YNAB's own import matching

From the support article and the spec's `import_id` description.

**Auto-match rule**
- Same account, **exact same amount**, dates within **±10 days**.
- One side must be user-entered (no `import_id`) and the other imported.
- Payee is not part of the rule.

**What happens on a match**
- YNAB keeps the bank amount and the user's date, payee, category and memo. The article is inconsistent about exactly which fields survive.
- The article says the matched transaction is auto-approved.

**Limits and consequences**
- There is no API to match manually. When amounts differ, the app must update the import and delete the placeholder.
- `import_id` format: `YNAB:[milliunits]:[iso_date]:[occurrence]`. It is unique per account and cannot be changed.
- Placeholders must be created **without** `import_id` so they stay eligible for auto-matching.
- A placeholder only dedupes when it is on the **right account**.
- **(unverified)** How an auto-matched pair looks in a delta: which id survives, whether `matched_transaction_id` is set, and whether `import_id` appears on the placeholder. This must be tested against a live plan. See the spike list in DESIGN §14.

### 1.8 Official JS SDK `ynab@5.0.0` (published 2026-11-03, Apache-2.0)

**What it is**
- Generated from spec 1.88.0 with OpenAPI-generator `typescript-fetch`.
- Ships ESM, CJS and `.d.ts`.
- Exports the `API` facade, every `*Api` class, `Configuration`, models and `utils`.

**Custom transport (verified in the package's `runtime.d.ts`)**
- `new Configuration({ accessToken, basePath, fetchApi, middleware })` is supported.
- So a custom fetch (for retry/backoff and request counting) can be injected by building `PlansApi`, `TransactionsApi` and the other classes directly.
- The high-level `new API(token, endpointUrl?)` facade accepts neither.
- The research tracks disagreed on this point; the type definitions settle it.

**Runs in workerd (verified)**
- The Cloudflare track bundled a Hono Worker importing `ynab@5.0.0` and `@anthropic-ai/sdk@1.9.0`.
- Under `wrangler dev` it reached api.ynab.com and api.anthropic.com and got real 401s back, with and without `nodejs_compat`.
- Bundle size: 1.58 MiB raw, 250 KiB gzipped.
- `require("fetch-ponyfill")` only installs itself when `globalThis.fetch` is missing.

**Gotchas**
- The SDK **throws the parsed JSON body** `{error:{id,name,detail}}` rather than an `Error`.
- It has no OAuth helpers.
- It does no 429 handling.
- **(unverified)** The production build through `@cloudflare/vite-plugin`. Run a smoke test early.

### 1.9 Existing YNAB tools to learn from

| Project | What to take from it |
|---|---|
| [dgalarza/ynab-mcp `prepare_split_for_matching`](https://glama.ai/mcp/servers/dgalarza/ynab-mcp/tools/prepare_split_for_matching) | Closest to our Amazon split flow. |
| [@maro-org/ynab-mcp API quirks](https://cdn.jsdelivr.net/npm/@maro-org/ynab-mcp@0.8.0/build/methodology/api-quirks.md) | Split behaviour. |
| [calebl/ynab-mcp-server](https://glama.ai/mcp/servers/@calebl/ynab-mcp-server/blob/36634cf98bdbea6c86dd237f1b048a51310559b4/README.md) | Never auto-applies or auto-approves suggestions. |
| [Maronato/ynab-mcp](https://github.com/Maronato/ynab-mcp) | Batch operations and undo. |
| [dizzlkheinz/ynab-mcpb](https://github.com/dizzlkheinz/ynab-mcpb) (**AGPL-3.0**: ideas only, do not copy code) | Receipt itemization: tax spread across categories by the largest-remainder method in the smallest currency unit. Reconciliation score: 50 + date×0.15 + payee×0.35, with payee scored as the best of several fuzzball ratios. Confidence tiers; keeps the top 3 candidates. |

---

## 2. Cloudflare stack

Checked with `npm view` on 2026-11-16. A scratch project was run under `wrangler dev` and `@cloudflare/vitest-plugin`.

### 2.1 Platform choices

| Area | Finding |
|---|---|
| Hosting | **Workers with Static Assets**, not Pages. Pages now has a migration guide to Workers. Set `assets.not_found_handling: "single-page-application"` and `run_worker_first` for `/api/*` and `/auth/*`. Asset requests are free. ([SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)) |
| Build | `vite@8.3.8` + `@cloudflare/vite-plugin@1.69.1` + `@vitejs/plugin-react@6.3.0` give one dev server running real workerd with local D1 and AI bindings. Starting point: [Hono + React + Vite template](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/). |
| API framework | `hono@4.13.19` has built-in `hono/cookie` (with `prefix:'host'`), `hono/csrf` and `hono/secure-headers`. `@hono/zod-validator@0.9.1`. |
| DB | **D1 + `drizzle-orm@0.45.4`**, with `drizzle-kit@0.31.11` used only for SQL generation. Apply migrations with `wrangler d1 migrations apply` (verified). D1 has no interactive transactions; `db.batch([...])` runs as one atomic transaction ([D1](https://developers.cloudflare.com/d1/reference/migrations/)). Drizzle 1.0 is still RC. `kysely-d1` is unmaintained. |
| Background work | A Cron Trigger calling `scheduled()`. On the Paid plan, cron gets up to 15 minutes of CPU. Add Queues only once there are many users. |
| Types | `wrangler types` generates `Env`; `@cloudflare/workers-types` is no longer needed. `typescript@7.0.2` type-checked the Worker in strict mode with `noUncheckedIndexedAccess` (verified). Fall back to 6.0.3 if tooling breaks. |
| Tests | `@cloudflare/vitest-plugin@1.8.3` (renamed from `@cloudflare/vitest-pool-workers`, [changelog](https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/)) with `vitest@5.1.0`, plus `readD1Migrations`/`applyD1Migrations` and `import { env, exports } from "cloudflare:workers"`. Mock outbound HTTP with `msw@3.0.6` + `@msw/cloudflare@0.2.0`; the old `fetchMock` was removed. All of this was verified. |
| Secrets config | `secrets.required` in `wrangler.jsonc` checks that secrets exist in dev and at deploy, and feeds the generated types ([docs](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets-configuration-property)). |
| Plan | **Workers Paid ($5/mo)**. The Free plan allows 10 ms CPU and 50 external subrequests per invocation, which cron reconciliation will exceed ([limits](https://developers.cloudflare.com/workers/platform/limits/)). |
| New `cf` CLI | Beta (`cf@1.0.0-rc.0`), and its config may change ([announcement](https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/)). Stay on `wrangler@4.163.0` for now and run `cf migrate` later. |

### 2.2 OAuth library

The research tracks disagreed:
- The Cloudflare track suggested `arctic@3.7.0`.
- The prior-art track found that `arctic` and `@oslojs/*` are **marked deprecated on npm**.

**Resolution:** use [`oauth4webapi@3.8.8`](https://github.com/panva/oauth4webapi) (by panva). It is standards-based, has no dependencies, runs on WebCrypto, and handles PKCE, the code exchange and refresh with a generic authorization server.

### 2.3 Secret storage

- Cron must read the YNAB tokens and the Anthropic key when no browser is present, so HttpOnly cookies cannot hold them.
- Encrypt them with AES-256-GCM (WebCrypto) in D1 under a master key held as a Worker secret. Use a random 12-byte IV and AAD = `userId:kind`.
- An AES-GCM round trip with AAD was verified in vitest-plugin.
- Cloudflare Secrets Store is account-level and does not suit per-user values.

---

## 3. Speech-to-text

### 3.1 Browser Web Speech API ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json))

**Browser support**
- **Chrome/Edge:** unprefixed since 139, `webkitSpeechRecognition` since 33. Recognition runs on a server, so it needs a network connection.
- **Chrome Android:** `continuous` has no effect ([crbug 41297427](https://crbug.com/41297427)). Restart recognition on `end`.
- **Safari/iOS:** `webkitSpeechRecognition` since 14.1/14.5. Needs Siri/Dictation enabled. Interim results are unreliable ([Apple forum 775699](https://developer.apple.com/forums/thread/775699)). Not available in WKWebView ([WebKit 225298](https://bugs.webkit.org/show_bug.cgi?id=225298)). Support in standalone PWAs is contested.
- **Firefox 160:** listed in BCD only and unverified. Treat as absent.
- MDN marks the API "Limited availability", not Baseline.

**Requirements and fallback**
- Needs HTTPS and a user gesture.
- iOS asks for both microphone and speech recognition permission.
- **Fallback:** keyboard dictation into a `<textarea>` always works.

### 3.2 Workers AI models ([catalog](https://developers.cloudflare.com/workers-ai/models/), [limits](https://developers.cloudflare.com/workers-ai/platform/limits/): 720 ASR requests per minute)

| Model | Price | Input | Output | Notes |
|---|---|---|---|---|
| [`@cf/openai/whisper-large-v3-turbo`](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/) | $0.000513 per audio minute | `audio`: **raw base64** (no `data:` prefix). Optional `language`, `vad_filter`, `initial_prompt`, `condition_on_previous_text`, and more. | `text`, `segments`, `transcription_info` | Multilingual. Cloudflare-hosted with zero data retention. **(unverified)** Which audio containers it accepts (WebM/Opus, MP4/AAC). |
| [`@cf/deepgram/nova-3`](https://developers.cloudflare.com/workers-ai/models/nova-3/) | $0.0052 per minute over HTTP | `audio:{body, contentType}`, plus `smart_format`, `numerals`, `keyterm` | `results.channels[0].alternatives[0].transcript` | [Detects 100+ formats](https://developers.deepgram.com/docs/supported-audio-formats), including WebM and MP4. The tracks disagreed on whether it is English-only; check the model page before relying on other languages. **(unverified)** Whether the binding expects `body` as base64 or as a stream. |

- Long audio: Cloudflare's [chunking tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking/) uses ~1 MB chunks. Notes of 5–60 s don't need chunking.
- `workers-ai-provider` is **deprecated on npm**. Call `env.AI.run` directly.

### 3.3 Recording in the browser

- Call `getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}})`.
- Choose a MIME type with `isTypeSupported`, in this order:
  1. `audio/webm;codecs=opus`
  2. `audio/mp4;codecs=mp4a.40.2`
  3. `audio/mp4`
  4. `audio/ogg;codecs=opus`
- Chrome records WebM/Opus. iOS Safari 14.1–18.3 records MP4/AAC only. 18.4+ reportedly also records WebM, with early bugs ([WebKit 290223](https://bugs.webkit.org/show_bug.cgi?id=290223)).
- Recording settings:
  - `audioBitsPerSecond: 32000`
  - `start()` without a timeslice
  - a cap of about 60 s
  - stop the tracks afterwards
- POST the raw Blob.

---

## 4. Prior art

### 4.1 Matching Amazon orders to charges

**[jprouty/mint-amazon-tagger](https://pypi.org/project/mint-amazon-tagger)** is the best reference. The code was read.
- **Pass 1:** match one charge exactly to one transaction.
- **Pass 2:** for orders with 2–20 unmatched charges, enumerate every combination of size ≥2 and index them by sum.
- **Tie-break:** the transaction must fall 0–5 days after the last shipment, and the closest one wins.
- **Reconcile fixes:** misc charges, shipping errors, per-unit tax rounding.
- Ships Knuth's **Algorithm U** for set partitions.
- Category learning: reuses the most common category for the same item description.
- Uses integer micro-USD.

**[YNAmazon](https://github.com/WoosterTech/YNAmazon)**
- Matches on exact amount against a sentinel payee ("Amazon - Needs Memo").
- When an order has several charges, it puts the same memo on each and adds a warning. It does not split.

**[GraysonCAdams/amazon-ynab-sync](https://github.com/GraysonCAdams/amazon-ynab-sync)** (archived)
- Parses order emails over IMAP.
- Tolerances: $0.50 on amount and 6 days on date.
- Only writes to transactions with a blank memo, which keeps it idempotent.
- Keeps no state, so a crash loop can burn the rate limit.

**Other tools:** [lineitem](https://addons.mozilla.org/hr/firefox/addon/lineitem/) (commercial, splits after user approval) and [dbinit/ynab-amazon-import](https://beta.pkg.go.dev/github.com/dbinit/ynab-amazon-import).

**What Amazon says:** an order is split into several charges because items ship separately ([Amazon Business](https://business.amazon.com/en/blog/match-orders-split-charges)).

**Gap:** every existing tool depends on Amazon's own data. **None match approximate, user-stated item prices to charges within a tolerance.** Our approach is new, so expect ambiguity: identical prices, promotions, gift-card or points partial payments, Subscribe & Save, refunds.

### 4.2 LLM categorization

**[sakowicz/actual-ai](https://github.com/sakowicz/actual-ai)** (TypeScript, for Actual Budget)
- The prompt includes payee, imported payee, amount, date, notes and the grouped categories.
- Tags its results `#actual-ai` or `#actual-ai-miss`.
- Runs dry by default and rate-limits itself.
- **Pitfall:** it auto-creates categories. We forbid that.

**[aelzeiny/YNAB_GPT](https://www.github.com/aelzeiny/YNAB_GPT)**
- Only touches uncategorized transactions.
- Marks AI-set transactions with a blue flag.
- Keeps local state so it doesn't repeat calls.

### 4.3 Voice and quick entry

- YNAB itself offers fixed Siri phrases and iOS Shortcuts ([support](https://support.ynab.com/en_us/using-siri-and-spotlight-with-ynab-B1Me9dj5ge.md)).
- [Firefly III Pico "Ramble"](https://newreleases.io/project/github/cioraneanu/firefly-pico/release/1.12.0) has the same flow we plan: free text or dictation goes to an LLM, the result is matched to existing accounts and categories, and the user reviews it before saving.
- No open-source YNAB natural-language entry tool exists.

### 4.4 Lessons we adopt

1. Match in tiers: exact single → single within tolerance → combinations within an order (capped) → user review. Score each candidate on date distance and payee similarity.
2. Cap the combinatorics. Above the cap, send it to manual review.
3. Mark everything the app touches: a memo tag, a flag, and D1 state. Never overwrite categories or memos the user set.
4. Keep an audit and undo log.
5. Make cron idempotent and track the rate limit.
6. Split tax using largest-remainder rounding in integer minor units.

---

## 5. Claude API (from the bundled SDK docs, `claude-api/typescript` + `shared/tool-use-concepts.md`)

**Structured output**
- Call `client.messages.parse({ output_config: { format: zodOutputFormat(Schema), effort } })`, importing `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`.
- The result is in `response.parsed_output`, which **may be null**.

**Model `claude-opus-5-5`**
- Thinking is always on. `thinking:{type:"disabled"}` returns 400. Control depth with `output_config.effort` (`low|medium|high|xhigh|max`; the default is `medium`).
- Forced `tool_choice` (`any` or `tool`) returns 400. Use `auto` with `strict: true`, or use structured outputs.
- Thinking tokens count against `max_tokens`.

**Schema limits**
- Every object needs `additionalProperties:false`. Zod objects get it automatically.
- Recursive schemas, numeric min/max and string length limits are not supported. The SDK strips them and validates on the client side.
- Use `nullable` instead of optional fields.
- A new schema compiles once and is then cached for 24 h. A per-user `enum` of category ids would recompile every time categories change, so **use short string refs and validate in code**.

**Stop reasons**
- `refusal`: the output may not match the schema. Check `stop_details`.
- `max_tokens`: the output may be truncated. Retry with a larger limit.

**Errors**
- Use the typed classes: `Anthropic.AuthenticationError`, `RateLimitError`, `BadRequestError`, `APIError`.

**Prompt caching**
- Put `cache_control:{type:"ephemeral"}` on the last stable system block.
- Don't put volatile values such as dates in the system prompt.

---

## 6. Open risks to settle with spikes

These are tracked in DESIGN §14.

1. How a YNAB auto-matched placeholder and its import appear in a delta.
2. Whether PUT/PATCH with `subtransactions` works on an imported transaction that isn't split yet.
3. Whether YNAB rejects a placeholder dated "today" in the user's timezone as a future date.
4. Whether a `server_knowledge` value can be reused across the per-resource endpoints and the plan endpoint.
5. Whether YNAB refresh tokens rotate.
6. Which audio containers whisper-large-v3-turbo decodes, and the nova-3 body encoding.
7. Whether `ynab@5` builds cleanly under `vite build` with `@cloudflare/vite-plugin`.
