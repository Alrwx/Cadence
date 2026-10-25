// Small shared pieces: icons, the sheet that slides over a screen, and the iOS-style switch.
import { useState, type ReactNode } from "react";

// Feather-style line icons, 24 x 24.
const PATHS = {
  back: "M15 18l-6-6 6-6",
  chevron: "M9 18l6-6-6-6",
  up: "M18 15l-6-6-6 6",
  down: "M6 9l6 6 6-6",
  edit: "M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  plus: "M12 5v14M5 12h14",
  check: "M20 6L9 17l-5-5",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  play: "M6 3l14 9-14 9V3z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} pathLength={1} />
    </svg>
  );
}

/**
 * A full-screen layer over the current screen: "sheet" slides up, "push" slides in from the right. Calling the
 * `close` it hands to its children plays the exit animation, then calls `onClosed`.
 */
export function Sheet({
  label,
  variant = "sheet",
  onClosed,
  children,
}: {
  label: string;
  variant?: "sheet" | "push";
  onClosed: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  return (
    <div
      className={`${variant}${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onAnimationEnd={(e) => closing && e.target === e.currentTarget && onClosed()}
    >
      {children(() => setClosing(true))}
    </div>
  );
}

/** Put it inside a <label> and the label's text names it and toggles it. */
export function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
