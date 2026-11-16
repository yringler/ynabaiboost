# Landing page plan

Status: plan only, nothing built yet. Public page for logged-out visitors.

> **Name.** `docs/DESIGN.md` says YNAB's OAuth rules require "for" before "YNAB", so the product
> name is **AI Boost for YNAB**. All copy below uses that name, not "YNAB AI Boost".

## 1. What the reference does (tangentailearning.com/welcome)

Screenshots (1440w and 390w, 6 hero frames 600 ms apart, scroll captures, full page) plus
`dom.html` and `info.json` are in
`/tmp/claude-0/-home-user-ynabaiboost/71aef116-ff0f-571e-b656-d4bd2bbe25b9/scratchpad/landing-ref/`.

- **Structure:** thin header (wordmark left, 3 muted text links right). Hero: H1, a one-line lede,
  two pill buttons, one muted note, and an animated demo panel. On desktop it is 2 columns; on
  phones the panel stacks under the text. Then 5 sections split by 1px rules, then a closing CTA
  and a footer.
- **Words:** about 630 in total, but it still reads as light. The H1 is 8 words and the lede is
  12. Every section is one heading plus 1–2 short sentences, and a picture does the rest. Our
  page will be lighter still (target about 130 words of visible copy).
- **Animation:** pure CSS with no JS, no canvas, no Lottie, no images, and 27 small inline SVG
  icons. The demo is a `<figure>` of ordinary HTML elements. Each one has a short keyframe
  (`dm-in`, `dm-pop`, `dm-cap`, `rg-ring`, `rg-scroll`) chained with `animation-delay`
  (0.3s, 1.2s, 3.1s, ...). The keyframes define only the `from` state, so an element's base style
  is its final state. It plays once and does not loop. Captions in white cards with a smiley icon
  narrate each beat ("You ask one question."). `@media (prefers-reduced-motion: reduce)` sets
  `animation: none`, so the final state shows. The figure has an `aria-label` and its decorative
  parts are `aria-hidden`.
- **Palette:** warm off-white `#fbfbfa` background, near-black `#1d1d1b` text, muted
  `#6b6b66`, border `#e2e2dd`, one blue accent `#2f6fdb` with a soft tint `#e6eefc`, and a
  2-layer soft shadow. Dark mode comes from `prefers-color-scheme` (bg `#161616`, accent
  `#6b9cf0`). There are 4 extra highlight hues, each a solid colour plus a soft tint.
- **Type:** system UI stack, no web fonts. Body 16px/1.6. H1 is `clamp(2rem,7vw,3.1rem)`, weight
  700, line-height 1.1, letter-spacing −0.02em. H2 is `clamp(1.4rem,4vw,1.85rem)`. The lede is
  1.08rem in the muted colour.
- **Spacing:** `.wrap` has max-width 960px and 20px side padding. Sections use 56px vertical
  padding. Buttons are 46px tall pills with 22px side padding. Cards use 12–16px radius.
  Breakpoint at 720px.

What we take from it: one accent colour, a calm off-white page, a single hero demo that tells
the story in under 5 s, short captions, system fonts, and CSS-only motion. We do not reuse its
content, layout specifics, icons, or branding.

## 2. Page, section by section (final copy)

Everything sits in one column and the same column width at all sizes. Only the hero and the
steps change layout at 720px or wider.

**Header**: wordmark `AI Boost for YNAB` on the left, a muted link `Sign in` on the right.

**Hero**
- H1: **Say what you spent.**
- Lede: *We'll categorize it when the bank catches up.*
- Primary button: **Connect YNAB**. Secondary button: **How it works** (anchor to `#how`).
- Note (muted, small): *Bring your own Anthropic API key.*
- Demo: `StoryDemo` (§3), placed right of the text on desktop and below it on phones.

**How it works** (`id="how"`): three numbered tiles, each with a tiny icon.
1. **Say it.** "About 200 at Costco, groceries."
2. **Forget it.** The bank import lands days later.
3. **Done.** Matched and categorized, even if the amount is off.

**Amazon, too**: H2 plus one line and the `SplitDemo` mini-animation (§3.4).
- H2: **One order, three charges.**
- Line: *Say what's in the box. It's split across every charge.*

**Inbox**: H2 plus one line and a static mini row (bank payee, amount, a sparkle chip
"Household", and a ✓ button).
- H2: **Imports you haven't touched?**
- Line: *Claude suggests a category. One tap to approve.*

**Your data**: H2 plus two short lines.
- H2: **Your keys, your budget.**
- *Connect with YNAB or a personal access token. Tokens are encrypted, and your Anthropic key
  stays yours.* *Delete everything from Settings, any time.* [Privacy](/privacy)

**Closing CTA**: centred.
- H2: **Try it on your next receipt.** Button: **Connect YNAB**. Small link below:
  *Use a personal access token* (to `/login?pat=1`).

**Footer** (muted, small):
*Not affiliated with, endorsed by, or sponsored by YNAB. YNAB is a trademark of YNAB LLC.*
Links: `Privacy · Sign in`.

Brand rules: write "YNAB" only as plain text. Do not use the YNAB logo, colours, typeface,
screenshots, or anything shaped like its UI (the demo rows are generic and do not copy YNAB's
register). No "official" wording. The wordmark is text only, with a small mic glyph of our own.

## 3. Animation

### 3.1 Story (hero `StoryDemo`, about 4.6 s, plays once, then rests)

The panel is a card on the page's sunken background, 18rem tall on phones and 21rem on desktop.
Every position inside it is in rem, so the "snap" distance does not depend on viewport width.

| t (s) | Beat | Element | Keyframe |
|---|---|---|---|
| 0.0 | A mic button pops in and rings twice | `.mic` | `pop` 300ms, `ring` 2×500ms |
| 0.3 | 3 wave bars bounce beside it | `.wave i` | `bar` 3× 240ms, staggered 80ms |
| 0.9 | Speech bubble rises: *"about 200 at Costco, groceries"* | `.bubble` | `rise` 300ms |
| 1.8 | The bubble becomes a card. The bubble fades and shrinks while the card scales up in the same spot: **Costco · ≈ $200 · [Groceries]**, dashed border, small label *waiting for the bank* | `.bubble`, `.card` | `fadeout` 200ms, `morph` 350ms |
| 2.6 | Caption *2 days later* fades in, then out at 3.2 | `.later` | `blink` 900ms |
| 2.8 | Bank row slides in from the right: **COSTCO WHSE #0412 · −$212.47 · Uncategorized** (muted) | `.row` | `slide` 350ms |
| 3.4 | The card drops onto the row with a spring overshoot, and its border turns solid | `.card` | `snap` 450ms, `--ease-spring` |
| 3.9 | The card dissolves into the row. "Uncategorized" crossfades to the **Groceries** chip | `.card`, `.cat-old`, `.cat-new` | `fadeout`/`rise` 250ms |
| 4.1 | A green check pops at the row's right edge and the row border tints green | `.check`, `.row` | `pop` 300ms, `tint` 300ms |

The whole run is under 5 s and plays once, so it meets WCAG 2.2.2 without a pause control. A
small **Replay** text button sits under the panel, outside the `role="img"` element.

### 3.2 How to build it (pure CSS, no dependency)

- Markup: plain `div`/`span`, with inline SVG only for the mic, the check, and the sparkle (each
  under 300 bytes). No images, fonts, Lottie, or motion library. If `motion` is ever wanted,
  it is only worth it for a later shared-layout morph; it is not needed here.
- **The base style is the final (rested) state.** Each keyframe defines only `from`, as the
  reference does: `@keyframes rise { from { opacity:0; transform:translateY(8px) } }`. Elements
  that end hidden (`.bubble`, `.card`, `.later`, `.cat-old`) use a keyframe that ends at
  `opacity:0` with `animation-fill-mode: both`.
- Timing comes from one custom property per element:
  `animation: rise 300ms var(--ease-out) calc(var(--d) * 1ms) both;` with
  `style={{'--d': 900}}`. This keeps the timeline readable as the table above.
- Start and replay: `StoryDemo` holds `run` state and renders the stage with `key={run}`.
  Remounting restarts every CSS animation, with no JS timers. The stage stays
  `animation-play-state: paused` until `useInView` (an IntersectionObserver at threshold 0.4,
  firing once) adds `.is-on`. The hero is usually in view at load, so it starts at once.
- Tokens: `--ease-out: cubic-bezier(.2,.8,.2,1)`, `--ease-spring: cubic-bezier(.34,1.56,.64,1)`.
  Animate only `opacity` and `transform` (plus a one-off `border-color`) so it stays on the
  compositor.
- Keyframes live in `landing.css`, because Tailwind 4 utilities stay for layout and spacing.

### 3.3 Reduced motion and no JS

`@media (prefers-reduced-motion: reduce) { .story * { animation: none !important } }`. With
animation off, the bubble stays visible above the row, the row is shown matched (Groceries chip
and check), and the card and the *2 days later* caption are `display:none`. The result is a
still "before → after" picture. Replay is hidden. The JS-free render looks the same, because the
base styles are already the final state.

### 3.4 `SplitDemo` (Amazon, about 2.2 s, starts when scrolled into view)

A card reads **Amazon ≈ $85** with 3 chips: *phone case · book · diapers*. Below it, three rows
slide in, staggered 150ms: `AMAZON MKTPL −$24.99`, `−$17.45`, `−$43.12`. Then, one row at a
time (staggered 250ms), the matching chip `rise`s into each row's category slot and a check
`pop`s. It uses the same keyframes, tokens and reduced-motion rule as the hero.

## 4. Tokens (in `landing.css`, scoped to `.landing`)

```css
.landing {
  color-scheme: light dark;
  --bg: #fbfaf7;  --bg-elev: #ffffff; --bg-sunken: #f3f1ec;
  --fg: #1c1b19;  --muted: #6b6862;   --border: #e5e2db;
  --accent: #c2410c; --accent-fg: #ffffff; --accent-soft: #fdeee6;   /* mic, primary CTA */
  --ok: #15803d;     --ok-soft: #e7f5ec;                              /* match, check */
  --pending: #8a6a12;                                                 /* dashed card */
  --shadow: 0 1px 2px rgb(0 0 0/.05), 0 12px 32px rgb(0 0 0/.08);
  --radius: 14px; --pill: 999px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --ease-out: cubic-bezier(.2,.8,.2,1); --ease-spring: cubic-bezier(.34,1.56,.64,1);
}
@media (prefers-color-scheme: dark) { .landing {
  --bg: #151514;  --bg-elev: #1e1e1c; --bg-sunken: #111110;
  --fg: #ecebe6;  --muted: #a09d95;   --border: #2f2e2b;
  --accent: #fb8a4c; --accent-fg: #1a0c04; --accent-soft: #3a2116;
  --ok: #4ade80;     --ok-soft: #12301f; --pending: #e3b94f;
  --shadow: 0 1px 2px rgb(0 0 0/.4), 0 12px 32px rgb(0 0 0/.45);
} }
```

- The accent is a warm tangerine. It is chosen to stay clear of YNAB's blue and purple brand
  colours. White on `#c2410c` is about 5.2:1, `#15803d` on white is about 5.0:1, and
  `--muted` on `--bg` is about 5.3:1.
- If the shadcn theme in `index.css` (DESIGN §11) ends up with an accent, alias these tokens to
  it rather than keeping two palettes.
- Type uses system fonts only, with no web font request. H1 is `clamp(2.1rem, 8vw, 3.2rem)`,
  700, line-height 1.08, letter-spacing −0.02em. H2 is `clamp(1.4rem, 4.5vw, 1.8rem)`, 700.
  Body 16px/1.6. Lede 1.1rem in `--muted`. Demo text is 0.95rem. Every amount uses
  `font-variant-numeric: tabular-nums`.

## 5. Layout (mobile-first)

- Container `max-width: 60rem` (960px). Side padding `max(16px, env(safe-area-inset-left))` on
  each side, so there is no horizontal scroll at 320px.
- Phone: header, then H1, lede, CTAs (full-width stacked buttons below 400px, inline above),
  note, then demo, then sections. Section padding is 48px, rising to 64px at 720px or wider.
- At 720px or wider: the hero becomes `grid-template-columns: 1.05fr 1fr`, centred vertically,
  and the steps become 3 columns.
- Buttons are 48px tall pills (tap target ≥44px). The demo panel never sets a width wider than
  `100%`.
- The page uses `.landing { background: var(--bg) }` and leaves the app shell alone (no
  BottomNav on this route).

## 6. CTA routes and auth wiring

| Element | Target |
|---|---|
| **Connect YNAB** | If `GET /auth/config` returns `oauthAvailable`, a plain `<a href="/auth/ynab/start">` (full navigation, since it is a Worker-first route). Otherwise `/login`. Before config loads, it renders as `/login`. |
| *Use a personal access token* | `/login?pat=1` (the login page opens the PAT form when it sees `pat`) |
| Sign in (header) | `/login` |
| Privacy | `/privacy` |
| Already signed in | If the cached `me` query succeeds, both CTAs become **Open app** pointing to `/` |

Routing: add the public route **`/welcome`**. Change the router guard "`me` 401 → `/login`" to
"`me` 401 on `/` → `/welcome`". Deep links to other routes still go to `/login`. This edits the
DESIGN §11.2 guard and has to be coordinated with whoever owns `router.tsx`. After OAuth,
`/auth/ynab/callback` already goes to `/` and onboarding.

SEO and shares: the SPA renders nothing without JS, so put a real `<title>AI Boost for
YNAB</title>`, a meta description ("Say what you spent. It's categorized when the bank catches
up."), and OG tags in `index.html`. Prerendering is optional later.

## 7. Accessibility

- Landmarks: one `header` (`nav aria-label="Site"`), `main`, `footer`. One `h1`, and `h2` for
  each section. Steps are an `ol`.
- The demo stage is `role="img"` with `aria-label`: "You say 'about 200 at Costco, groceries'.
  It becomes a pending entry. Two days later the bank shows Costco, minus $212.47. The entry
  snaps onto it and it's categorized Groceries." Everything inside it is `aria-hidden`. Replay
  is a real `<button>` outside it. The SplitDemo gets the same treatment.
- No autoplaying sound, no loops, nothing flashes more than 3 times a second, and the run is
  under 5 s. Reduced motion is honoured (§3.3).
- Visible `:focus-visible` ring (`2px solid var(--accent)`, offset 3px). Contrast is AA in both
  themes (§4). The ✓ in the inbox row is decorative (`aria-hidden`), and its meaning is in the
  text.
- Mark up the copy's quotes as `<q>` and the money as text, so screen readers read "$212.47".

## 8. Files to implement

```
src/client/routes/welcome.tsx                     public route; renders <LandingPage/>
src/client/components/landing/LandingPage.tsx     header, sections, footer; imports landing.css
src/client/components/landing/landing.css         tokens (§4), keyframes, reduced-motion rules
src/client/components/landing/Hero.tsx            H1, lede, CTAs, note, <StoryDemo/>
src/client/components/landing/StoryDemo.tsx       §3.1–3.3; run/key replay, useInView start
src/client/components/landing/SplitDemo.tsx       §3.4
src/client/components/landing/Steps.tsx           "How it works" ol
src/client/components/landing/InboxPeek.tsx       static suggestion row
src/client/components/landing/ConnectButton.tsx   authConfig + me aware href/label (§6)
src/client/components/landing/icons.tsx           Mic, Check, Sparkle inline SVGs
src/client/hooks/useInView.ts                     IntersectionObserver, once
src/client/router.tsx                             (edit) add /welcome, 401 on / → /welcome
src/client/routes/login.tsx                       (edit) honour ?pat=1
index.html                                        (edit) title, description, OG tags
src/client/components/landing/StoryDemo.test.tsx  renders final state; aria-label present;
                                                  Replay remounts stage (key changes)
```

Acceptance checks: Lighthouse a11y ≥ 95. No horizontal scroll at 320, 390 and 1440 widths.
Playwright screenshots at 390w and 1440w in light, dark and reduced motion. Landing JS + CSS
adds no more than 8 KB gzip over the shell. There are no network requests besides the app bundle
and `/auth/config`.
