// components/landing/Steps.tsx — LANDING §2 "How it works": three numbered tiles, each with a tiny icon.
import type { ReactNode } from "react";
import { Check, Clock, Mic } from "./icons";

const STEPS: { icon: ReactNode; title: string; body: ReactNode }[] = [
  { icon: <Mic />, title: "Say it.", body: <q>About 200 at Costco, groceries.</q> },
  { icon: <Clock />, title: "Forget it.", body: "The bank import lands days later." },
  { icon: <Check />, title: "Done.", body: "Matched and categorized, even if the amount is off." },
];

export function Steps() {
  return (
    <section id="how" className="l-section" aria-labelledby="how-title">
      <div className="l-wrap">
        <h2 id="how-title">How it works</h2>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="step">
              <span className="step-head" aria-hidden="true">
                <span className="step-icon">{s.icon}</span>
                <span className="step-num">{i + 1}</span>
              </span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
