// components/landing/LandingPage.tsx — LANDING §2, §5, §7: public page for logged-out visitors at /welcome.
// Plain <a> links throughout: /auth/ynab/start must be a full navigation, and the page also works without a router.
import type { ReactNode } from "react";
import "./landing.css";
import { ConnectButton, useConnectTarget } from "./ConnectButton";
import { Hero } from "./Hero";
import { Mic } from "./icons";
import { SplitDemo } from "./SplitDemo";
import { Steps } from "./Steps";

function Header() {
  const t = useConnectTarget();
  return (
    <header className="l-header l-wrap">
      <a className="wordmark" href="/welcome">
        <span className="wordmark-glyph" aria-hidden="true">
          <Mic />
        </span>
        AI Boost for YNAB
      </a>
      <nav aria-label="Site">
        <a className="l-link-muted" href={t.signedIn ? "/" : "/login"}>
          {t.signedIn ? "Open app" : "Sign in"}
        </a>
      </nav>
    </header>
  );
}

function Feature({ id, title, line, children }: { id: string; title: string; line: string; children: ReactNode }) {
  return (
    <section className="l-section" aria-labelledby={id}>
      <div className="l-wrap feature">
        <div className="feature-copy">
          <h2 id={id}>{title}</h2>
          <p>{line}</p>
        </div>
        <div className="feature-demo">{children}</div>
      </div>
    </section>
  );
}

function ClosingCta() {
  const t = useConnectTarget();
  return (
    <section className="l-section closing" aria-labelledby="cta-title">
      <div className="l-wrap">
        <h2 id="cta-title">Try it on your next receipt.</h2>
        <ConnectButton />
        {!t.signedIn && (
          <p>
            <a className="l-link-muted" href="/login?pat=1">
              Use a personal access token
            </a>
          </p>
        )}
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <div className="landing">
      <Header />
      <main>
        <Hero />
        <Steps />
        <Feature id="amazon-title" title="One order, three charges." line="Say what's in the box. It's split across every charge.">
          <SplitDemo />
        </Feature>
        <section className="l-section" aria-labelledby="data-title">
          <div className="l-wrap">
            <h2 id="data-title">Your keys, your budget.</h2>
            <p>
              Connect with YNAB or a personal access token. Tokens are encrypted, and your Anthropic key stays yours.
            </p>
            <p>
              Delete everything from Settings, any time. <a href="/privacy">Privacy</a>
            </p>
          </div>
        </section>
        <ClosingCta />
      </main>
      <footer className="l-footer">
        <div className="l-wrap">
          <p>Not affiliated with, endorsed by, or sponsored by YNAB. YNAB is a trademark of YNAB LLC.</p>
          <nav aria-label="Footer">
            <a href="/privacy">Privacy</a>
            <span aria-hidden="true"> · </span>
            <a href="/login">Sign in</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
