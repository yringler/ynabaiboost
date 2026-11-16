// components/landing/InboxPeek.tsx — LANDING §2 "Inbox": a static suggestion row (bank payee, amount,
// a sparkle chip, a ✓ button). Decorative; its meaning is in the section text and the aria-label.
import { Check, Sparkle } from "./icons";

export function InboxPeek() {
  return (
    <div
      className="peek"
      role="img"
      aria-label="An imported Target charge of $38.20 with Claude's suggested category, Household, and an approve button."
    >
      <div className="peek-row" aria-hidden="true">
        <span className="split-txn">
          <span className="payee">TARGET T-1849</span>
          <span className="amt">−$38.20</span>
        </span>
        <span className="chip chip-accent chip-ai">
          <Sparkle /> Household
        </span>
        <span className="peek-ok">
          <Check />
        </span>
      </div>
    </div>
  );
}
