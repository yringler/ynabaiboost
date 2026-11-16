# AI Boost for YNAB

A small, private web app that sits next to [YNAB](https://www.ynab.com). You say or type what you spent
("about 200 at Costco, groceries and household"). Claude turns the note into a draft transaction and the app
adds a placeholder to YNAB. When the bank import arrives a few days later, the app matches it to your note,
sets the categories (it splits the transaction if the note had several), and removes the placeholder.

It also handles:

- **Amazon orders.** Paste the order page (or give exact item prices, tax and the total). When every number checks
  out against what you pasted and only one assignment fits, each shipment's charge is split by category
  automatically; otherwise you get a ranked one-tap review. Gift cards and points always go to review.
- **Precision check.** Claude only extracts facts; deterministic code decides whether an amount is exact (its
  digits must be in your text). The confirm screen and pending cards show "Exact — will auto-match" or
  "Approximate — may ask you". Exact amounts are matched to the cent.
- **Edit by voice or text.** On the Pending screen, select items (or none) and say what changed: "that was
  actually the 13th", "make it 212.47", "split off 30 for household", "delete these", "oh and I also spent 40 at
  Target, gas". Claude proposes the changes, the app checks them and shows a plan you apply with one tap (or
  turn on "Apply voice edits without confirming" in Settings). It only touches the items you selected and asks
  when it isn't sure which one you mean.
- **Reviews.** When a match is not certain, it asks you instead of guessing.

It runs on one Cloudflare Worker with D1, a React SPA, Workers AI for optional server-side speech-to-text, and
Claude (`claude-sonnet-5-5`) using **your own Anthropic API key**. It is not affiliated with or endorsed by YNAB.

- Design: [`docs/DESIGN.md`](docs/DESIGN.md)
- Research: [`docs/RESEARCH.md`](docs/RESEARCH.md)
- Landing page: [`docs/LANDING.md`](docs/LANDING.md)
- Implementation notes: [`docs/BUILD_NOTES.md`](docs/BUILD_NOTES.md)
- Open spikes: [`docs/SPIKES.md`](docs/SPIKES.md)

## How it behaves

- **Sync schedule:** a cron trigger runs every 6 hours (`0 */6 * * *`). For each allowed user it pulls the YNAB
  changes and reconciles notes with imports.
- **No background sync in the browser.** Opening or focusing the app does not sync. A sync happens only when:
  - you tap **Sync now** in the header (`POST /api/sync`, for your account only);
  - you save a new note;
  - the cron runs.
- **What changed in YNAB is labelled.** Every memo the app writes ends with a short note and a tag, e.g.
  `groceries · AI Boost: matched note from Nov 14 [aib:7K2QXM]`; your own memo text is kept in front of it.
- **Secrets** (YNAB tokens and the Anthropic key) are encrypted at rest in D1 with AES-256-GCM, using the
  `ENCRYPTION_KEY` Worker secret.
- **Access:** only YNAB user ids listed in `ADMIN_USER_IDS` or `ALLOWED_USER_IDS` can use the app.
  `ALLOWED_USER_IDS="*"` allows anyone.
- **Visitors who are not signed in** and open `/` are sent to the landing page at `/welcome`.

## Prerequisites

- Node 22+ and npm.
- A Cloudflare account. The **Workers Paid** plan is needed for the cron's CPU budget.
- A YNAB account. You sign in with either a **Personal Access Token** or a **YNAB OAuth app** (see below).
- An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com). Each user enters their own
  key in the app during onboarding. It is never set as a Worker secret.

## Setup

```bash
npm install
npx wrangler login
npx wrangler d1 create ai-boost-for-ynab   # copy the printed database_id into wrangler.jsonc
npm run cf-typegen                         # only needed after editing wrangler.jsonc
```

### Sign-in option A: YNAB Personal Access Token (simplest)

In YNAB, go to **Account Settings → Developer Settings → New Token**. Paste the token on the app's sign-in page.
The app checks the token with YNAB, encrypts it and stores it. You don't need any server configuration for this.

### Sign-in option B: YNAB OAuth app

1. In YNAB, go to **Account Settings → Developer Settings → New Application**.
2. Name it **"AI Boost for YNAB"**. YNAB's branding rules forbid names that start with "YNAB".
3. Set the redirect URI to `https://<your host>/auth/ynab/callback`.
4. Set the privacy policy URL to `https://<your host>/privacy`.
5. Leave "default plan selection" off.
6. Put the Client ID in `vars.YNAB_CLIENT_ID` in `wrangler.jsonc`.
7. Set the secret with `npx wrangler secret put YNAB_CLIENT_SECRET`.

If `YNAB_CLIENT_ID` is empty, the OAuth button is hidden and only PAT sign-in is offered.

### Secrets and vars

| Name | Kind | Value |
|---|---|---|
| `ENCRYPTION_KEY` | secret | `openssl rand -base64 32`. **Never rotate it** without a re-encryption migration, or stored tokens and keys become unreadable. |
| `SESSION_SECRET` | secret | `openssl rand -base64 32`. Signs the short-lived OAuth state cookie. |
| `YNAB_CLIENT_SECRET` | secret | The OAuth app secret, or the literal `disabled` when you only use PATs. |
| `APP_ORIGIN` | var | The public origin, e.g. `https://ai-boost-for-ynab.<you>.workers.dev`. CSRF checks compare against it. |
| `ADMIN_USER_IDS` | var | Comma-separated YNAB user ids. Admins are always allowed and can enable server STT per user. |
| `ALLOWED_USER_IDS` | var | Comma-separated YNAB user ids, or `*` for anyone. |
| `YNAB_CLIENT_ID` | var | The OAuth Client ID, or empty for PAT only. |
| `STT_MODEL` | var | `whisper` (default) or `nova3`, for server-side speech-to-text. |

## Local development

```bash
cp .dev.vars.example .dev.vars
# then fill in:
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   SESSION_SECRET=$(openssl rand -base64 32)
#   YNAB_CLIENT_SECRET=disabled
#   APP_ORIGIN=http://localhost:5173
npm run db:migrate:local
npm run dev                 # SPA and API on http://localhost:5173 (needs `wrangler login`; Workers AI is remote-only)
CF_LOCAL_ONLY=1 npm run dev # without Cloudflare credentials: everything except server STT works
```

Sign in locally with a PAT. To trigger the cron by hand:

```bash
curl -X POST "http://localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=ai-boost-for-ynab" \
  -H 'Content-Type: application/json' -d '{"cron":"0 */6 * * *"}'
```

To work on the UI without a backend, run `VITE_MOCK_API=1 npm run dev`. MSW then serves mock data in the browser.

Checks:

```bash
npm run typecheck   # tsc -b over the worker, client and node projects
npm test            # vitest: unit (node), worker (workerd + D1 + msw), client (jsdom)
npm run build       # tsc -b && vite build
npm run eval:parse  # optional live parse eval; needs ANTHROPIC_API_KEY
```

The tests never reach the real YNAB or Anthropic APIs. Both are faked with msw (`test/msw/`).

## Finding your YNAB user id

The app identifies people by their YNAB user id. The first time you sign in, before your id is on the allow-list,
the sign-in page says the app is private and shows **your user id** with a copy button. To allow yourself:

1. Copy the id.
2. Add it to `ADMIN_USER_IDS`: in `.dev.vars` when developing locally, or in `wrangler.jsonc` vars for a deployment.
3. Restart or redeploy, then sign in again.

Once you are signed in, the id is also shown under **Settings**. To let someone else in, ask them to sign in once
and send you the id they see, then add it to `ALLOWED_USER_IDS`.

## Deploy

```bash
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put YNAB_CLIENT_SECRET   # or enter: disabled
# edit wrangler.jsonc: database_id, APP_ORIGIN, ADMIN_USER_IDS, ALLOWED_USER_IDS, YNAB_CLIENT_ID, STT_MODEL
npm run db:migrate:remote
npm run deploy
```

The cron (`"triggers": { "crons": ["0 */6 * * *"] }` in `wrangler.jsonc`) is deployed with the Worker. Each run
processes up to 50 users, the ones that have waited longest first. Use `npx wrangler tail` to see live logs.

## Removing access or data

- **Remove a user:** take their id out of `ALLOWED_USER_IDS` and redeploy. Their sessions are refused from then on
  and the cron skips them.
- **Delete your own data:** use **Settings → Delete my data**. This removes everything the app stored about you.
  It works even after you have been removed from the allow-list. Your data in YNAB is not changed.
- **Revoke OAuth access:** do it in YNAB under **Account Settings → Developer Settings**.
