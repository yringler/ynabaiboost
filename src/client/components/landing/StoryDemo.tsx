// components/landing/StoryDemo.tsx — LANDING §3.1–3.3: the hero story, pure CSS keyframes (landing.css).
// The base style of every element is its final (rested) state; each animation only describes how it got there.
// Replay bumps `run`, which remounts the stage via `key` and so restarts every CSS animation (no JS timers).
// The stage stays paused (no .is-on) until it is 40% in view.
import { useState, type CSSProperties } from "react";
import { useInView } from "../../hooks/useInView";
import { Check, Clock, Mic, Replay } from "./icons";

/** Animation delay in ms, read by landing.css as `calc(var(--d) * 1ms)`. */
export const at = (ms: number): CSSProperties => ({ "--d": String(ms) }) as CSSProperties;

export const STORY_LABEL =
  "You say 'about 200 at Costco, groceries'. It becomes a pending entry. Two days later the bank shows Costco, " +
  "minus $212.47. The entry snaps onto it and it's categorized Groceries.";

export function StoryDemo() {
  const [run, setRun] = useState(0);
  const [ref, inView] = useInView<HTMLElement>(0.4);

  return (
    <figure ref={ref} className={`story${inView ? " is-on" : ""}`}>
      <div className="story-panel">
        <div key={run} data-run={run} className="stage" role="img" aria-label={STORY_LABEL}>
          <div aria-hidden="true">
            <span className="mic" style={at(0)}>
              <Mic />
            </span>
            <span className="wave">
              <i style={at(300)} />
              <i style={at(380)} />
              <i style={at(460)} />
            </span>

            <div className="bubble-in" style={at(900)}>
              <div className="bubble">
                <q>about 200 at Costco, groceries</q>
              </div>
            </div>

            <div className="later">
              <span>
                <Clock /> 2 days later
              </span>
            </div>

            <div className="row">
              <div className="row-main">
                <div className="line">
                  <span className="payee">COSTCO WHSE #0412</span>
                  <span className="amt">−$212.47</span>
                </div>
                <div className="slot">
                  <span className="cat-old">Uncategorized</span>
                  <span className="cat-new chip chip-ok">Groceries</span>
                </div>
              </div>
              <span className="check">
                <Check />
              </span>
            </div>

            <div className="card-drop">
              <div className="card-fade">
                <div className="card">
                  <div className="line">
                    <strong>Costco</strong>
                    <span className="amt">≈ $200</span>
                  </div>
                  <div className="line line-start">
                    <span className="chip chip-ok">Groceries</span>
                    <span className="waiting">
                      <Clock /> waiting for the bank
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <button type="button" className="replay" onClick={() => setRun((r) => r + 1)}>
        <Replay /> Replay
      </button>
    </figure>
  );
}
