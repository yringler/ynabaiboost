// components/landing/SplitDemo.tsx — LANDING §3.4: one pasted Amazon order, three charges (about 2.1 s, once, starts in view).
// Same keyframes, tokens and reduced-motion rule as the hero; base styles are the final state.
import { useInView } from "../../hooks/useInView";
import { Check } from "./icons";
import { at } from "./StoryDemo";

const ITEMS = [
  { item: "phone case", amount: "−$24.99" },
  { item: "book", amount: "−$17.45" },
  { item: "diapers", amount: "−$43.12" },
] as const;

export const SPLIT_LABEL =
  "You paste an Amazon order page for $85.56: a phone case, a book and diapers. Three Amazon charges arrive: " +
  "$24.99, $17.45 and $43.12. Each charge gets its matching item.";

export function SplitDemo() {
  const [ref, inView] = useInView<HTMLElement>(0.4);
  return (
    <figure ref={ref} className={`split${inView ? " is-on" : ""}`}>
      <div className="split-panel" role="img" aria-label={SPLIT_LABEL}>
        <div aria-hidden="true">
          <div className="split-order" style={at(0)}>
            <div className="line">
              <strong>Amazon</strong>
              <span className="amt">$85.56</span>
            </div>
            <div className="chips">
              {ITEMS.map((x) => (
                <span key={x.item} className="chip chip-accent">
                  {x.item}
                </span>
              ))}
            </div>
          </div>
          <ul className="split-rows">
            {ITEMS.map((x, i) => (
              <li key={x.item} className="split-row" style={at(300 + i * 150)}>
                <span className="split-txn">
                  <span className="payee">AMAZON MKTPL</span>
                  <span className="amt">{x.amount}</span>
                </span>
                <span className="slot">
                  <span className="cat-old" style={at(1100 + i * 250)}>
                    Uncategorized
                  </span>
                  <span className="cat-new chip chip-accent" style={at(1100 + i * 250)}>
                    {x.item}
                  </span>
                </span>
                <span className="check" style={at(1250 + i * 250)}>
                  <Check />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </figure>
  );
}
