# Build notes (WP1 → WP2–WP6)

What WP1 actually set up, and every place it differs from or adds to `DESIGN.md`. Read this before
starting a package. §6–§8 contracts are unchanged except for the additive type aliases listed in §3.

## 1. Commands

| Command | Notes |
|---|---|
| `npm run typecheck` | `tsc -b --noEmit` over three projects (see §4). |
| `npm test` | `vitest run`: projects `unit`, `worker`, `client` (see §5). `npx vitest run --project unit` runs one. Coverage: `npx vitest run --project unit --coverage` (`@vitest/coverage-v8` is installed). |
| `npm run build` | `tsc -b && vite build` → `dist/ai_boost_for_ynab` (worker) + `dist/client` (SPA). |
| `npm run dev` | Vite + workerd. **Needs `npx wrangler login`** because the Workers AI binding is remote-only. Without credentials use `CF_LOCAL_ONLY=1 npm run dev` (everything works except `env.AI`). |
| `npm run db:migrate:local` | Applies `migrations/` to the local D1 (`.wrangler/`, gitignored). |
| `npm run cf-typegen` | `wrangler types --strict-vars=false`. Re-run after editing `wrangler.jsonc`. |
| `npm run deploy` | Not run by WP1. |

**Every dependency for every package is already installed** (all §1.1 pins exist and are used exactly). Do not run
`npm install <pkg>`; if you truly need a new dependency, say so in your PR. Extras installed beyond §1.1:
`@types/react@19.3.0`, `@types/react-dom@19.3.0`, `@types/node@22.20.5`, `jsdom@31.0.1`,
`@testing-library/react@16.3.3`, `@testing-library/user-event@14.6.12`, `@testing-library/jest-dom@7.0.1`,
`@vitest/coverage-v8@5.1.0`, and for shadcn/ui: `radix-ui@1.8.1` (unified Radix package), `class-variance-authority@0.7.1`,
`clsx@2.1.1`, `tailwind-merge@3.7.0`, `lucide-react@1.73.0`, `tw-animate-css@1.4.0`, plus the `shadcn@4.23.0` CLI as a devDependency.

## 2. Config deviations

- **`wrangler.jsonc`**
  - `database_id` is the placeholder `00000000-0000-0000-0000-000000000000` (a literal `<wrangler d1 create>` would not parse as an id). Replace before the first remote deploy.
  - `APP_ORIGIN` is `https://ai-boost-for-ynab.example.workers.dev`; set the real one before deploying.
  - `"ai": { "binding": "AI", "remote": true }` — `remote: true` only silences wrangler's "AI is always remote" warning; behaviour is unchanged.
  - Cron is `0 */6 * * *` (owner decision).
- **Env type:** `worker-configuration.d.ts` is generated with `--strict-vars=false`, so vars are typed `string`, not literal `""` types (tests and `isAllowed` need to treat them as arbitrary strings). It also declares `GlobalProps.mainModule`, so `exports.default.fetch` from `cloudflare:workers` is typed in tests.
- **`.dev.vars.example`** sets `APP_ORIGIN=http://localhost:5173` for local dev (CSRF/originGuard compare against it).

## 3. Shared code (`src/shared`)

- `money.ts`, `dates.ts`, `schemas.ts`, `api.ts` are §6 verbatim.
- **Additive type aliases only** in `schemas.ts` (same names as the zod consts, no runtime change):
  `FlagColor`, `IntentStatus`, `PlaceholderStatus`, `ReviewKind`, `InboxSuggestion`, `PossibleIntent`, `AdminUser`.
  §8.3 (`FlagColor | null`) and §10.1 (`PlaceholderStatus`, `ReviewKind`) use these names as types, so the text now compiles as written.
- `payee.ts` implements §10.4:
  - Processor prefixes are stripped repeatedly ("pos debit …").
  - "Trailing 2-letter US state token" uses a fixed list of US state codes + DC, and only when more than one token remains.
  - Aliases match on a **token boundary** (`s === prefix || s.startsWith(prefix + " ")`), so "targetx" is not "target".
  - Empty normalized strings score 0.
- Imports: the `@shared/*` alias is configured in TS, Vite and Vitest, but WP1 code uses relative imports. Either works.

## 4. TypeScript layout

`tsconfig.json` references three projects that extend `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes: false`, `verbatimModuleSyntax`, `noImplicitOverride`, `noEmit`):

| Project | Includes | Types |
|---|---|---|
| `tsconfig.worker.json` | `worker-configuration.d.ts`, `src/worker`, `src/shared`, `test/{setup,worker,unit,shared,msw,fixtures}`, `test/env.d.ts` | workerd runtime + `@cloudflare/vitest-plugin/types` (`cloudflare:test`) |
| `tsconfig.client.json` | `src/client`, `src/shared`, `test/client` | DOM, `vite/client`, `jsx: react-jsx` |
| `tsconfig.node.json` | `vite.config.ts`, `vitest.config.ts` | node |

New test files must live in one of those directories or typecheck will not see them.
`verbatimModuleSyntax` is on: use `import type` for type-only imports. `noImplicitOverride` is on: e.g. `override name` on Error subclasses.

## 5. Tests

- **`unit`** (node): `test/unit/**/*.test.ts` (WP5 domain) and `test/shared/**/*.test.ts`.
- **`worker`** (workerd via `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })`): `test/worker/**/*.test.ts`.
  - `remoteBindings: false`: there are no Cloudflare credentials, so **`env.AI` is not usable in tests**; WP4 must stub it (e.g. pass a fake `Env` with an `AI` object to `transcribe`, or `vi.spyOn(env.AI, "run")`).
  - `test/setup/apply-migrations.ts` applies `migrations/*.sql` (via the `TEST_MIGRATIONS` binding, typed in `test/env.d.ts`) before each test file. D1 state is shared between tests **within** a file; use unique ids or `reset()` from `cloudflare:test`.
  - Test bindings: `APP_ORIGIN = "https://app.test"`, `ENCRYPTION_KEY = SESSION_SECRET = "AAAA…AAA="` (32 zero bytes, base64), `YNAB_CLIENT_SECRET = "disabled"`; `ADMIN_USER_IDS`/`ALLOWED_USER_IDS`/`YNAB_CLIENT_ID` are `""` from wrangler.jsonc — pass a modified env (`{ ...env, ALLOWED_USER_IDS: "*" }`) where a test needs other values.
  - Route tests: `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch(new Request("https://app.test/...", { headers: { "Sec-Fetch-Site": "same-origin", ... } }))`. Non-GET requests **must** carry `Sec-Fetch-Site: same-origin` (or `Origin: https://app.test`) or originGuard returns 403.
  - MSW: `setupNetwork()` from `@msw/cloudflare` with `msw@3` handlers. `test/msw/` and `test/fixtures/` exist (empty) for WP3/WP4.
  - `deps.optimizer.ssr.include: ["ynab"]` pre-bundles the ynab SDK (its `node-fetch` dependency otherwise warns in the pool).
- **`client`** (jsdom + Testing Library): `test/client/**/*.test.{ts,tsx}` and `src/client/**/*.test.{ts,tsx}` (LANDING's `StoryDemo.test.tsx` fits).

## 6. Worker core (WP1-owned, for consumers)

- **`index.ts`** is §4 plus: `app.notFound` → 404 `not_found` ApiErrorBody; the Hono `app` is also a named export.
  Mounting: `authRoutes` at `/auth`; `accountRoutes, syncRoutes, parseRoutes, inboxRoutes, sttRoutes, intentRoutes, reviewRoutes, activityRoutes` at `/api` (so define paths like `/me`, `/sync`, `/intents/:id` inside your router); `adminRoutes` at `/api/admin` (define `/users`, `/users/:id`, and apply `requireAdmin` yourself). `parseRoutes` is mounted before `intentRoutes`, so `/api/intents/parse` wins over `/api/intents/:id`.
- **`hono/csrf` (4.13) also inspects `Sec-Fetch-Site`**: a cross-site non-GET request is refused by csrf (403, message `forbidden`) before originGuard runs. Both produce ApiErrorBody `forbidden` because:
- **`errorHandler`** maps `AppError` → its code; `ZodError` → `validation` 400; **`HTTPException`** (csrf, `bodyLimit`, Hono validator content-type errors) → code by status (400 validation, 401, 403 forbidden, 404, 409, 413 payload_too_large, 415 unsupported_media, 429 rate_limited, 5xx internal); anything else → `internal` 500, logged without request data.
- **`lib/validate.ts` (additive helper):** `validate(target, schema)` wraps `zValidator` so a failed parse throws `AppError("validation")` → ApiErrorBody. Raw `zValidator` returns its own zod-error JSON on 400, which is **not** `ApiErrorBody`; prefer `validate("json", Req)` / `validate("query", API.x.query)`. A wrong `Content-Type` on a JSON route is rejected with 400 `validation` either way.
- **`db/schema.ts`**: columns mirror §5 one to one (parity test: `test/worker/schema-parity.test.ts`). INTEGER 0/1 columns use Drizzle `{ mode: "boolean" }`, so `UserRow.sttAllowed`, `ynabTransactions.approved`, etc. are `boolean`. Enum TEXT columns carry their unions; `audit_log.action` is typed `AuditAction`. JSON columns (`user_settings.json`, `matches.line_ids/allocation`, `reviews.options`, `audit_log.before_json/after_json`) are plain `text`: parse with the shared zod schemas. Partial unique indexes are declared too.
- **`lib/audit.ts`**: `auditStmt` throws if a `txn_categorized | txn_split | txn_approved | inbox_approved` row lacks `before`/`after`. `toSnapshot` drops unknown flag colours to `null`.
- **`lib/ids.ts`**: `newShortRef()` is 6 chars of Crockford base32 (`0-9A-Z` minus `ILOU`).

## 7. Stubs

- Every §8 function throws `new Error("not implemented: <functionName>")`; every route module exports an **empty** `new Hono<AppEnv>()`; middleware stubs throw. Signatures are exactly §8.
- `ynab/types.ts`, `domain/types.ts` (§10.1) and `ai/schemas.ts` (§9.2) are complete, not stubs.
- `ynab/errors.ts`: `YnabApiError` got a constructor `(status, { id, name, detail })` (`name` is declared `override`). WP3 may change the constructor; the frozen fields stay.
- No frozen exports, so the file is `export {}` until its owner fills it: `auth/oauth.ts` (WP2), `ai/prompts.ts` (WP4).
- `domain/{tolerance,dates,score,subsets,allocate,memo}.ts` have stub signatures guessed from §10 pseudo-code. They are **WP5-internal and not frozen**; WP5 may change them freely.
- **Client** (WP6 owns everything; all placeholders):
  - Each `routes/*.tsx` exports `<Name>Page` (`LoginPage`, `OnboardingPage`, `CapturePage`, `PendingPage`, `InboxPage`, `ActivityPage`, `SettingsPage`, `AdminPage`, `PrivacyPage`, `WelcomePage`). Each component file exports a component with the file's name. `landing/icons.tsx` exports `Mic`, `Check`, `Sparkle`.
  - `router.tsx` registers all routes including `/welcome`, with **no guards yet** (WP6 adds: logged-out `/` → `/welcome`, other 401 → `/login`, 403 `not_allowed` → `/login?error=not_allowed`, onboarding redirects).
  - `lib/api.ts` has the typed signature: `call<K extends ApiKey>(key, { params, query, body, signal })` → `Promise<ResOf<K>>`, plus `ApiError(status, code, message)`.
  - `hooks/useSync.ts` documents the owner decision: POST `/api/sync` only from "Sync now" / pull-to-refresh, never on mount or focus.
  - `lib/utils.ts` has the shadcn `cn()` helper. `components.json` and `components/ui/*` are **not** generated yet (WP6: run `npx shadcn init` / `npx shadcn add …`; the CLI and all component deps are installed, so it should not need to install anything).
  - `index.html` and `public/manifest.webmanifest` are minimal (title + description); WP6 adds OG tags and icons.

## 8. Owner decisions reflected in WP1

- Cron `0 */6 * * *` in `wrangler.jsonc`.
- No sync on app open/focus: noted in `useSync.ts`; `POST /api/sync` is the only manual trigger (plus intent creation).
- Secrets encrypted at rest with AES-GCM and `ENCRYPTION_KEY` (WP2 implements `auth/crypto.ts`; test key is 32 zero bytes).
- `/welcome` route exists for the landing page; the `/` → `/welcome` redirect for logged-out visitors is WP6's guard.

## 9. Spike S7

Done; see `docs/SPIKES.md`. `vite build` bundles `ynab@5` and `@anthropic-ai/sdk@1.9.0` (≈ 396 kB gzip together with Hono/zod). Always pass `fetchApi` to the ynab `Configuration`.
