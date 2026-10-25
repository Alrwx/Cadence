import { useEffect, useRef } from "react";

const BARS = 30;
const STEP_MS = 60;

/** A rolling row of bars, newest on the right, fed by `level()` (0 to 1). Updates the bars directly, not through React. */
export function LevelMeter({ level }: { level: () => number }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const history = new Array<number>(BARS).fill(0);
    let last = 0;
    let frame = 0;
    const tick = (now: number) => {
      if (now - last >= STEP_MS) {
        last = now;
        history.push(level());
        history.shift();
        history.forEach((value, i) => bars.current[i]?.style.setProperty("--level", String(value)));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level]);

  return (
    <div className="meter" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}
