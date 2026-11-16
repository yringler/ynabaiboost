// components/landing/Hero.tsx — LANDING §2 Hero: H1, lede, CTAs, note, <StoryDemo/>.
import { ConnectButton } from "./ConnectButton";
import { StoryDemo } from "./StoryDemo";

export function Hero() {
  return (
    <section className="hero l-wrap" aria-labelledby="hero-title">
      <div className="hero-copy">
        <h1 id="hero-title">Say what you spent.</h1>
        <p className="lede">We'll categorize it when the bank catches up.</p>
        <div className="ctas">
          <ConnectButton />
          <a className="l-btn l-btn-ghost" href="#how">
            How it works
          </a>
        </div>
        <p className="note">Bring your own Anthropic API key.</p>
      </div>
      <StoryDemo />
    </section>
  );
}
