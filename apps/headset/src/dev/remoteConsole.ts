// Dev server only: Quest Browser's console is hard to reach, so warnings and errors are also posted
// to the laptop, where devServerPlugin.ts prints them in the Vite terminal.
const ENDPOINT = "/__dev/log";

export function forwardConsole(): void {
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      post(level, args);
    };
  }
  addEventListener("error", (e) => post("error", [e.message, `${e.filename}:${e.lineno}`]));
  addEventListener("unhandledrejection", (e) => post("error", ["unhandled rejection:", e.reason]));
}

function post(level: string, args: unknown[]): void {
  const text = args.map(format).join(" ");
  void fetch(ENDPOINT, { method: "POST", body: JSON.stringify({ level, text }), keepalive: true }).catch(() => {});
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
