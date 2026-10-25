// Saved-phrase management (AGENTS(GH).md §7, Dev 2): add, edit, delete and reorder groups, and add, edit and
// delete phrases, over the phrase.* events. The headset only speaks, edits-before-speaking and bookmarks.
import type { PhrasesGroup, PhrasesGroupItem } from "@cadence/protocol";
import {
  groupNameProblem,
  MAX_GROUP_NAME_LENGTH,
  MAX_PHRASE_LENGTH,
  movedGroupOrder,
  phraseProblem,
  cleanPhraseText,
  type CadenceState,
  type CadenceStore,
  type GatewayConnection,
  type TextProblem,
} from "@cadence/shared";
import { t } from "@cadence/shared/i18n";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { Icon, type IconName } from "./ui.tsx";

interface Props {
  store: CadenceStore;
  connection: GatewayConnection;
  onClose: () => void;
}

function problemText(problem: TextProblem, kind: "phrase" | "group"): string {
  if (problem === "empty") return t("phrases.problem.empty");
  if (problem === "duplicate")
    return t(kind === "phrase" ? "phrases.problem.duplicatePhrase" : "phrases.problem.duplicateGroup");
  return kind === "phrase"
    ? t("phrases.problem.phraseTooLong", { max: MAX_PHRASE_LENGTH })
    : t("phrases.problem.groupTooLong", { max: MAX_GROUP_NAME_LENGTH });
}

function phraseCount(count: number): string {
  return count === 1 ? t("phrases.countOne") : t("phrases.count", { count });
}

export function PhraseManager({ store, connection, onClose }: Props) {
  const use = <T,>(select: (s: CadenceState) => T): T => useStore(store, select);
  const groups = use((s) => s.phraseGroups);
  const status = use((s) => s.connection);
  const lastError = use((s) => s.lastError);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(groups.length > 0);
  const online = status === "open";

  // The gateway answers a rejected change with an error event; show the ones that arrive while this screen is open.
  const seenError = useRef(lastError);
  useEffect(() => {
    if (lastError && lastError !== seenError.current) setGatewayError(lastError.message);
    seenError.current = lastError;
  }, [lastError]);
  // An empty list is "loading" until the first phrases event, which the gateway sends on connect.
  useEffect(() => store.subscribe((s, prev) => s.phraseGroups !== prev.phraseGroups && setLoaded(true)), [store]);

  const send: GatewayConnection["send"] = (type, data, turnId) => {
    setGatewayError(null);
    return connection.send(type, data, turnId);
  };

  return (
    <div className="phrases">
      <nav className="nav">
        <button className="btn btn-text back" onClick={onClose}>
          <Icon name="back" />
          {t("phrases.back")}
        </button>
      </nav>
      <div>
        <h1>{t("phrases.title")}</h1>
        <p className="subtitle">{t("phrases.intro")}</p>
      </div>
      {!online && <p className="notice">{t("phrases.offline")}</p>}
      {gatewayError && (
        <p className="notice" role="alert">
          {t("phrases.gatewayError", { message: gatewayError })}
        </p>
      )}

      {!loaded && groups.length === 0 ? (
        <p className="muted status-text">{t("phrases.loading")}</p>
      ) : groups.length === 0 ? (
        <p className="muted status-text">{t("phrases.empty")}</p>
      ) : (
        groups.map((group) => <GroupCard key={group.id} group={group} groups={groups} online={online} send={send} />)
      )}

      <NewGroup groups={groups} online={online} send={send} />
    </div>
  );
}

type Send = GatewayConnection["send"];

function GroupCard({
  group,
  groups,
  online,
  send,
}: {
  group: PhrasesGroup;
  groups: PhrasesGroup[];
  online: boolean;
  send: Send;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "confirmDelete">("view");
  const up = movedGroupOrder(groups, group.id, -1);
  const down = movedGroupOrder(groups, group.id, 1);

  return (
    <section className="card group" aria-label={group.name}>
      {mode === "rename" ? (
        <TextForm
          label={t("phrases.renameLabel")}
          initial={group.name}
          maxLength={MAX_GROUP_NAME_LENGTH}
          problem={(name) => groupNameProblem(name, groups, group.id)}
          kind="group"
          submitLabel={t("phrases.save")}
          disabled={!online}
          onSubmit={(name) => {
            send("phrase.group.save", { groupId: group.id, name });
            setMode("view");
          }}
          onCancel={() => setMode("view")}
        />
      ) : (
        <div className="group-head">
          <div className="group-title">
            <h2>{group.name}</h2>
            <span className="muted small">{phraseCount(group.items.length)}</span>
          </div>
          {mode === "view" && (
            <div className="tools">
              <button
                className="icon-btn"
                disabled={!online}
                onClick={() => setMode("rename")}
                aria-label={`${t("phrases.rename")}: ${group.name}`}
              >
                <Icon name="edit" />
              </button>
              <button
                className="icon-btn"
                disabled={!online || up === null}
                onClick={() =>
                  up !== null && send("phrase.group.save", { groupId: group.id, name: group.name, order: up })
                }
                aria-label={`${t("phrases.moveUp")}: ${group.name}`}
              >
                <Icon name="up" />
              </button>
              <button
                className="icon-btn"
                disabled={!online || down === null}
                onClick={() =>
                  down !== null && send("phrase.group.save", { groupId: group.id, name: group.name, order: down })
                }
                aria-label={`${t("phrases.moveDown")}: ${group.name}`}
              >
                <Icon name="down" />
              </button>
              <button
                className="icon-btn danger"
                disabled={!online}
                onClick={() => setMode("confirmDelete")}
                aria-label={`${t("phrases.delete")}: ${group.name}`}
              >
                <Icon name="trash" />
              </button>
            </div>
          )}
        </div>
      )}

      {mode === "confirmDelete" && (
        <div className="confirm">
          <p>
            {group.items.length === 0
              ? t("phrases.confirmDeleteEmptyGroup", { name: group.name })
              : t("phrases.confirmDeleteGroup", { name: group.name, phrases: phraseCount(group.items.length) })}
          </p>
          <div className="actions">
            <button
              className="btn btn-small btn-danger"
              disabled={!online}
              onClick={() => send("phrase.group.delete", { groupId: group.id })}
            >
              {t("phrases.yesDelete")}
            </button>
            <button className="btn btn-small btn-text" onClick={() => setMode("view")}>
              {t("phrases.cancel")}
            </button>
          </div>
        </div>
      )}

      <ul className="phrase-list">
        {group.items.map((phrase) => (
          <PhraseRow key={phrase.id} phrase={phrase} group={group} online={online} send={send} />
        ))}
      </ul>

      <TextForm
        label={t("phrases.addPhrase")}
        placeholder={t("phrases.addPhrasePlaceholder")}
        maxLength={MAX_PHRASE_LENGTH}
        problem={(text) => phraseProblem(text, group)}
        kind="phrase"
        submitLabel={t("phrases.add")}
        icon="plus"
        disabled={!online}
        clearOnSubmit
        onSubmit={(text) => send("phrase.save", { text, groupId: group.id })}
      />
    </section>
  );
}

function PhraseRow({
  phrase,
  group,
  online,
  send,
}: {
  phrase: PhrasesGroupItem;
  group: PhrasesGroup;
  online: boolean;
  send: Send;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirmDelete">("view");

  if (mode === "edit") {
    return (
      <li className="phrase editing">
        <TextForm
          label={t("phrases.editLabel")}
          initial={phrase.text}
          maxLength={MAX_PHRASE_LENGTH}
          problem={(text) => phraseProblem(text, group, phrase.id)}
          kind="phrase"
          submitLabel={t("phrases.save")}
          disabled={!online}
          hint={t("phrases.editMoves")}
          onSubmit={(text) => {
            // phrase.save has no phrase id yet, so an edit is "save the new text, then delete the old phrase".
            // Both go over the same socket, so the gateway handles them in that order.
            if (text !== phrase.text) {
              send("phrase.save", { text, groupId: group.id });
              send("phrase.delete", { phraseId: phrase.id });
            }
            setMode("view");
          }}
          onCancel={() => setMode("view")}
        />
      </li>
    );
  }
  return (
    <li className="phrase">
      <div className="phrase-main">
        <span className="phrase-text">{phrase.text}</span>
        {!phrase.audioReady && <span className="muted small">{t("phrases.preparing")}</span>}
      </div>
      {mode === "confirmDelete" ? (
        <div className="confirm">
          <p>{t("phrases.confirmDeletePhrase", { text: phrase.text })}</p>
          <div className="actions">
            <button
              className="btn btn-small btn-danger"
              disabled={!online}
              onClick={() => send("phrase.delete", { phraseId: phrase.id })}
            >
              {t("phrases.yesDelete")}
            </button>
            <button className="btn btn-small btn-text" onClick={() => setMode("view")}>
              {t("phrases.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="tools">
          <button
            className="icon-btn"
            disabled={!online}
            onClick={() => setMode("edit")}
            aria-label={`${t("phrases.edit")}: ${phrase.text}`}
          >
            <Icon name="edit" />
          </button>
          <button
            className="icon-btn danger"
            disabled={!online}
            onClick={() => setMode("confirmDelete")}
            aria-label={`${t("phrases.delete")}: ${phrase.text}`}
          >
            <Icon name="trash" />
          </button>
        </div>
      )}
    </li>
  );
}

function NewGroup({ groups, online, send }: { groups: PhrasesGroup[]; online: boolean; send: Send }) {
  return (
    <section className="card new-group">
      <TextForm
        label={t("phrases.newGroup")}
        placeholder={t("phrases.newGroupPlaceholder")}
        maxLength={MAX_GROUP_NAME_LENGTH}
        problem={(name) => groupNameProblem(name, groups)}
        kind="group"
        submitLabel={t("phrases.addGroup")}
        icon="plus"
        disabled={!online}
        clearOnSubmit
        onSubmit={(name) => send("phrase.group.save", { name })}
      />
    </section>
  );
}

interface TextFormProps {
  label: string;
  initial?: string;
  placeholder?: string;
  maxLength: number;
  kind: "phrase" | "group";
  problem: (text: string) => TextProblem | null;
  submitLabel: string;
  /** Shows the submit button as a round icon instead of text. */
  icon?: IconName;
  disabled: boolean;
  hint?: string;
  clearOnSubmit?: boolean;
  onSubmit: (cleanText: string) => void;
  onCancel?: () => void;
}

/** One text field with inline validation; the submitted text is already cleaned like the gateway cleans it. */
function TextForm(p: TextFormProps) {
  const [text, setText] = useState(p.initial ?? "");
  const [touched, setTouched] = useState(false);
  const problem = p.problem(text);
  // Don't nag about an empty field before the user has tried to submit.
  const shown = problem && (touched || problem !== "empty") ? problemText(problem, p.kind) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || p.disabled) return;
    p.onSubmit(cleanPhraseText(text));
    if (p.clearOnSubmit) {
      setText("");
      setTouched(false);
    }
  };

  return (
    <form className="text-form" onSubmit={submit}>
      <div className="text-row">
        <input
          className="input"
          aria-label={p.label}
          value={text}
          placeholder={p.placeholder}
          // A little room over the limit so the "too long" message can show instead of silently cutting text.
          maxLength={p.maxLength + 20}
          onChange={(e) => {
            setText(e.target.value);
            setTouched(false); // "Type something first" only right after an empty submit
          }}
          aria-invalid={shown ? true : undefined}
          autoFocus={p.initial !== undefined}
        />
        <button
          type="submit"
          className={p.icon ? "icon-btn fill" : "btn btn-small btn-primary"}
          aria-label={p.submitLabel}
          disabled={p.disabled}
        >
          {p.icon ? <Icon name={p.icon} /> : p.submitLabel}
        </button>
        {p.onCancel && (
          <button type="button" className="btn btn-small btn-text" onClick={p.onCancel}>
            {t("phrases.cancel")}
          </button>
        )}
      </div>
      {shown && <p className="error-text small">{shown}</p>}
      {p.hint && <p className="muted small">{p.hint}</p>}
    </form>
  );
}
