// routes/privacy.tsx — WP6 (DESIGN §11.2 "/privacy", D19): static policy, public.
import { Link } from "@tanstack/react-router";
import { PlainPage } from "../components/Page";

export const PRIVACY_LAST_UPDATED = "November 16, 2026";

export function PrivacyPage() {
  return (
    <PlainPage className="max-w-2xl gap-5 leading-relaxed">
      <Link to="/welcome" className="text-sm text-muted-foreground hover:underline">← AI Boost for YNAB</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Privacy policy</h1>
      <p className="text-sm text-muted-foreground">Last Updated: {PRIVACY_LAST_UPDATED}</p>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">What this app is</h2>
        <p>
          AI Boost for YNAB is a small personal tool. It is not affiliated with, endorsed by, or sponsored by YNAB. YNAB is a
          trademark of YNAB LLC.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">What we store</h2>
        <ul className="list-disc pl-5">
          <li>Your YNAB user id, your settings and a session record (we store only a hash of the session token).</li>
          <li>
            Your YNAB access and refresh tokens (or personal access token) and your Anthropic API key, each encrypted with AES-256-GCM
            using a key that lives only in the server's secret configuration.
          </li>
          <li>
            A cache of your YNAB plan needed to match purchases: categories, accounts, payees and recent transactions, plus the
            purchases you describe, the matches we make and an activity log of every change we write to YNAB.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">What goes to Anthropic</h2>
        <p>
          Only after you turn on AI data consent: the text you type or dictate and your category, account and payee names
          are sent to Anthropic's Claude API, using your own API key, to parse purchases into categorized entries. Anthropic's commercial terms apply to that key.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Voice</h2>
        <p>
          By default your browser's speech recognition turns speech into text (your browser vendor may process the audio). If the
          owner enabled server transcription for you, the audio clip is sent to Cloudflare Workers AI, which does not keep it, and
          is not stored by this app.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Deleting your data</h2>
        <p>
          Settings → <strong>Delete my data</strong> removes your account and everything above from this app immediately. Your YNAB
          budget itself is never deleted.
        </p>
        <p>
          Deleting data here does not revoke YNAB OAuth access, because YNAB has no API for that. If you connected with YNAB, also
          revoke “AI Boost for YNAB” under YNAB → Account Settings → Developer Settings → Authorized Applications. If you used a
          personal access token, you can delete that token on the same page.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">No tracking</h2>
        <p>No analytics, ads or third-party trackers. A single first-party session cookie keeps you signed in.</p>
      </section>
    </PlainPage>
  );
}
