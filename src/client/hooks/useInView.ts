// hooks/useInView.ts — WP6 (LANDING §3.2): IntersectionObserver that fires once.
// Without IntersectionObserver (old browsers, jsdom) it reports "in view" immediately.
import { useEffect, useRef, useState, type RefObject } from "react";

export function useInView<T extends Element>(threshold = 0.4): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (typeof IntersectionObserver === "undefined" || !el) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView, threshold]);
  return [ref, inView];
}
