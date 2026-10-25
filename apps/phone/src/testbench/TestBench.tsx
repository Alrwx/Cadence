// Desktop test bench: the real phone app (left) and a clickable stand-in for the headset (right), on one session.
// The Quest headset's buttons are 3D objects for pinch and head dwell, so a mouse can't drive it on a laptop.
// This page sends the same events the headset sends, so the gateway (real or mock) can't tell the difference.
// Dev-only tool: its text is inline rather than in locales/en.json.
import type { CadenceState } from "@cadence/shared";
import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { dismissError, log, send, sessionId, shownError, store } from "./headset.ts";

const use = <T,>(select: (s: CadenceState) => T): T => useStore(store, select);

// The headset's instant phrases (apps/headset/src/config.ts, gateway instantText).
const INSTANT: { id: string; label: string }[] = [
  { id: "yes", label: "👍 Yes" },
  { id: "no", label: "👎 No" },
  { id: "wait", label: "✋ Give me a second" },
  { id: "hello", label: "👋 Hello" },
  { id: "laugh", label: "😄 Laugh" },
];

function newSession(): void {
  const id = `test_${Math.random().toString(36).slice(2, 7)}`;
  location.search = `?session=${id}`;
}

export function TestBench() {
  const status = use((s) => s.connection);
  const state = use((s) => s.state);
  const turnId = use((s) => s.turnId);

  return (
    <div className="bench">
      <header>
        <h1>Cadence test bench</h1>
        <span className="pill">session {sessionId}</span>
        <span className={`pill ${status}`}>headset {status}</span>
        <span className="pill">
          {state}
          {turnId ? ` · ${turnId}` : ""}
        </span>
        <button onClick={newSession} title="Starts a fresh session, so the mock's listener scenario plays again">
          New session
        </button>
      </header>
      <main>
        <section className="phone-pane">
          <h2>Phone</h2>
          <iframe
            title="Phone app"
            src={`${import.meta.env.BASE_URL}?session=${encodeURIComponent(sessionId)}`}
            allow="microphone; autoplay; screen-wake-lock"
          />
          <p className="note">Tap Start in the phone first: it unlocks audio and starts the listener scenario.</p>
        </section>
        <section className="headset-pane">
          <h2>Headset (stand-in)</h2>
          <Listener />
          <Suggestions />
          <Instant />
          <Compose />
          <SavedPhrases />
          <LastError />
        </section>
        <section className="log-pane">
          <h2>Events</h2>
          <EventLog />
        </section>
      </main>
    </div>
  );
}

function Listener() {
  const captions = use((s) => s.captions);
  const partial = use((s) => s.partial);
  const online = use((s) => s.connection) === "open";
  const [text, setText] = useState("");

  // Typed instead of spoken: the gateway treats it like a final transcript (listener.say, dev tools only).
  const say = (e: FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean) return;
    if (send("listener.say", { text: clean })) setText("");
  };

  return (
    <div className="card">
      <h3>Listener</h3>
      <form className="buttons" onSubmit={say}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type what the listener says, e.g. Do you want some water?"
          aria-label="What the listener says"
          maxLength={500}
        />
        <button type="submit" className="primary" disabled={!online || !text.trim()}>
          Say
        </button>
      </form>
      <p className="muted small">Or talk near the laptop: the phone's mic still works.</p>
      {captions.length === 0 && !partial && <p className="muted">Nothing said yet.</p>}
      {captions.slice(-3).map((c, i) => (
        <p key={i}>{c}</p>
      ))}
      {partial && <p className="muted">{partial}…</p>}
    </div>
  );
}

function Suggestions() {
  const suggestions = use((s) => s.suggestions);
  const turnId = use((s) => s.turnId);
  return (
    <div className="card">
      <h3>Suggested replies</h3>
      {suggestions.length === 0 && <p className="muted">None for this turn.</p>}
      <div className="buttons column">
        {suggestions.map((s) => (
          <button key={s.id} className="primary" onClick={() => send("select", { suggestionId: s.id }, turnId)}>
            {s.text}
            <span className="tag">
              {s.kind}
              {s.audioReady ? " · audio ready" : " · audio pending"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Instant() {
  return (
    <div className="card">
      <h3>Instant gestures</h3>
      <div className="buttons">
        {INSTANT.map((p) => (
          <button key={p.id} onClick={() => send("instant", { phraseId: p.id })}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Text a saved phrase's "Edit…" hands to "Type my own" once the gateway is in COMPOSING. */
const draft = createStore<{ text: string }>()(() => ({ text: "" }));

function Compose() {
  const state = use((s) => s.state);
  const [text, setText] = useState("");
  const composing = state === "COMPOSING";

  const pending = useStore(draft, (s) => s.text);
  useEffect(() => {
    if (composing && pending) {
      setText(pending);
      draft.setState({ text: "" });
    }
  }, [composing, pending]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const clean = text.trim();
    if (!clean) return;
    send("compose.submit", { text: clean });
    setText("");
  };

  return (
    <div className="card">
      <h3>Type my own</h3>
      {composing ? (
        <form className="buttons" onSubmit={submit}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a reply" autoFocus />
          <button type="submit" className="primary">
            Speak
          </button>
          <button type="button" onClick={() => send("cancel", {})}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="buttons">
          <button onClick={() => send("compose.start", {})}>Type my own</button>
          <button onClick={() => send("cancel", {})}>Cancel (back out)</button>
        </div>
      )}
    </div>
  );
}

function SavedPhrases() {
  const groups = use((s) => s.phraseGroups);
  const [open, setOpen] = useState<string | null>(null);
  const shown = groups.find((g) => g.id === open) ?? groups[0];
  return (
    <div className="card">
      <h3>Saved phrases</h3>
      {groups.length === 0 && <p className="muted">No phrases received yet.</p>}
      <div className="buttons tabs">
        {groups.map((g) => (
          <button key={g.id} className={g.id === shown?.id ? "active" : ""} onClick={() => setOpen(g.id)}>
            {g.name}
          </button>
        ))}
      </div>
      {shown && (
        <div className="buttons column">
          {shown.items.map((p) => (
            <div key={p.id} className="phrase-row">
              <button className="primary" onClick={() => send("phrase.speak", { phraseId: p.id })}>
                {p.text}
                {!p.audioReady && <span className="tag">audio pending</span>}
              </button>
              <button
                title="Edit, then speak: opens Type my own with this text"
                onClick={() => {
                  draft.setState({ text: p.text });
                  send("compose.start", {});
                }}
              >
                Edit…
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LastError() {
  const error = useStore(shownError, (s) => s.error);
  if (!error) return null;
  return (
    <div className="card error" role="alert">
      <div className="card-head">
        <h3>Last error</h3>
        <button className="dismiss" onClick={dismissError} aria-label="Dismiss error">
          ×
        </button>
      </div>
      <p>
        <code>{error.code}</code> {error.message}
        {error.recoverable ? "" : " (not recoverable)"}
      </p>
      <p className="muted small">Clears when your next command goes through, or when the session moves on.</p>
    </div>
  );
}

function EventLog() {
  const entries = useStore(log, (s) => s.entries);
  return (
    <ol className="log" reversed>
      {[...entries].reverse().map((e, i) => (
        <li key={entries.length - i} className={e.dir}>
          <span className="dir">{e.dir === "in" ? "←" : "→"}</span>
          <span className="type">{e.type}</span>
          <Json data={e.data} />
        </li>
      ))}
    </ol>
  );
}

/** Event data, shortened when long; click to expand. */
function Json({ data }: { data: unknown }) {
  const text = JSON.stringify(data);
  if (text.length <= 140) return <code>{text}</code>;
  return (
    <details>
      <summary>
        <code>{text.slice(0, 140)}…</code>
      </summary>
      <code>{text}</code>
    </details>
  );
}
