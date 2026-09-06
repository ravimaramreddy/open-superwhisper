import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  Copy,
  FolderOpen,
  History,
  Laptop,
  LoaderCircle,
  Mic,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { AppState, Profile, Settings, Transcript } from "../desktop/contracts";
import { CaptureController, type CaptureView } from "./capture";
import { shortcutFromEvent } from "./shortcut";
import { TextChanges } from "./TextChanges";
import { ModePicker, WritingOptions } from "./EditingControls";
import { AppRules } from "./AppRules";

const initialCapture: CaptureView = { phase: "idle", level: 0, elapsedMs: 0 };
const shortcutLabel = (value: string) =>
  value
    .replaceAll("CommandOrControl", "⌘")
    .replaceAll("Command", "⌘")
    .replaceAll("Control", "⌃")
    .replaceAll("Alt", "⌥")
    .replaceAll("Option", "⌥")
    .replaceAll("Shift", "⇧")
    .replaceAll("+", " ")
    .replace("Space", "Space");
const timeLabel = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const secondsLabel = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
type VocabularyEntry = Settings["vocabulary"][number];
const cleanTerm = (value: string) => value.trim().replace(/\s+/g, " ");
const termKey = (value: string) => cleanTerm(value).toLocaleLowerCase("en");

function VocabularyForm({
  initial,
  correction = false,
  disabled,
  onSave,
  onCancel,
}: {
  initial?: VocabularyEntry;
  correction?: boolean;
  disabled: boolean;
  onSave: (entry: VocabularyEntry) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [word, setWord] = useState(initial?.word || "");
  const [aliases, setAliases] = useState(initial?.aliases.join("\n") || "");
  const [validation, setValidation] = useState("");
  return (
    <form
      className="vocabulary-form"
      onSubmit={(event) => {
        event.preventDefault();
        const canonical = cleanTerm(word);
        const phrases = aliases.split("\n").map(cleanTerm).filter(Boolean);
        if (!canonical || (correction && !phrases.length)) {
          setValidation(t("vocabularyRequired"));
          return;
        }
        if (canonical.length > 80 || phrases.some((value) => value.length > 80)) {
          setValidation(t("vocabularyLength"));
          return;
        }
        if (phrases.length > 4) {
          setValidation(t("vocabularyAliasLimit"));
          return;
        }
        const unique = [...new Map(phrases.map((value) => [termKey(value), value])).values()];
        if (unique.some((value) => termKey(value) === termKey(canonical))) {
          setValidation(t("vocabularySamePhrase"));
          return;
        }
        setValidation("");
        onSave({ word: canonical, aliases: unique });
      }}
    >
      <div className="vocabulary-fields">
        <label>
          <span>{t("correctSpelling")}</span>
          <input
            autoFocus
            value={word}
            maxLength={80}
            disabled={disabled}
            onChange={(event) => setWord(event.target.value)}
            placeholder={t("wordPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>{t(correction ? "misheardPhrase" : "aliases")}</span>
          {correction ? (
            <input
              value={aliases}
              maxLength={80}
              disabled={disabled}
              onChange={(event) => setAliases(event.target.value)}
              placeholder={t("aliasPlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <textarea
              value={aliases}
              rows={3}
              disabled={disabled}
              onChange={(event) => setAliases(event.target.value)}
              placeholder={t("aliasesPlaceholder")}
              spellCheck={false}
            />
          )}
        </label>
      </div>
      <p className="form-hint">{t(correction ? "rememberDetail" : "aliasesDetail")}</p>
      {validation && (
        <p className="form-error" role="alert">
          {validation}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="small-button save-button" disabled={disabled}>
          <Check size={13} />
          {t(correction ? "remember" : "saveWord")}
        </button>
        <button type="button" className="text-button" disabled={disabled} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

export default function App({ preview = false }: { preview?: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<"dictate" | "history" | "settings">("dictate");
  const [capture, setCapture] = useState(initialCapture);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [shortcutArmed, setShortcutArmed] = useState(false);
  const [vocabularyEditing, setVocabularyEditing] = useState<number | null>(null);
  const [rememberId, setRememberId] = useState<string | null>(null);
  const controller = useRef<CaptureController | null>(null);
  const stateRef = useRef<AppState | null>(null);
  const actionRef = useRef(false);
  const api = window.localWhispr;
  const busy =
    capture.phase !== "idle" || (!!state && !["idle", "recording"].includes(state.phase));
  const locked = busy || action !== null;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const receive = (next: AppState) => {
      if (!active) return;
      stateRef.current = next;
      setState(next);
    };
    const owner = new CaptureController(api, {
      onChange: (next) => {
        if (active) setCapture(next);
      },
      onError: (key, detail) => {
        if (active)
          setError(
            detail instanceof Error && detail.message ? `${t(key)} ${detail.message}` : t(key)
          );
      },
      onComplete: () => {
        if (active)
          void api
            .getState()
            .then(receive)
            .catch(() => {});
      },
    });
    controller.current = owner;
    const unsubscribe = api.onState(receive);
    const unsubscribeCommands = api.onCommand((command) => {
      if (command === "cancel") {
        void owner.cancel();
        return;
      }
      if (actionRef.current) return;
      if (owner.phase === "idle" && stateRef.current?.phase !== "idle") return;
      setError(null);
      void owner.toggle();
    });
    void api
      .getState()
      .then(receive)
      .catch((err) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeCommands();
      if (controller.current === owner) controller.current = null;
      void owner.dispose();
    };
  }, [api, t]);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    let active = true;
    const refresh = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (active)
          setDevices(
            list.filter(
              (device) =>
                device.kind === "audioinput" && device.deviceId && device.deviceId !== "default"
            )
          );
      } catch {
        /* Permission checklist remains the actionable source of truth. */
      }
    };
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
    };
  }, [state?.permissions.microphone]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || shortcutArmed) return;
      if (controller.current?.phase !== "idle") {
        event.preventDefault();
        void controller.current?.cancel();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [shortcutArmed]);

  const perform = useCallback(
    async (name: string, task: () => Promise<unknown>, success?: string) => {
      if (actionRef.current) return;
      actionRef.current = true;
      setAction(name);
      setError(null);
      try {
        await task();
        if (api) setState(await api.getState());
        if (success) setNotice(success);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("requestFailed"));
      } finally {
        actionRef.current = false;
        setAction(null);
      }
    },
    [api, t]
  );
  const save = (patch: Partial<Settings>) => perform("settings", () => api.updateSettings(patch));
  const saveVocabulary = (entry: VocabularyEntry, index: number | null, remembering = false) => {
    void perform(
      "vocabulary",
      async () => {
        const vocabulary = [...(stateRef.current?.settings.vocabulary || [])];
        const existingIndex = vocabulary.findIndex(
          (item) => termKey(item.word) === termKey(entry.word)
        );
        if (remembering && existingIndex !== -1) {
          const existing = vocabulary[existingIndex];
          const aliases = [
            ...new Map(
              [...existing.aliases, ...entry.aliases].map((value) => [termKey(value), value])
            ).values(),
          ];
          if (aliases.length > 4) throw new Error(t("vocabularyAliasLimit"));
          vocabulary[existingIndex] = { ...existing, aliases };
        } else {
          if (existingIndex !== -1 && existingIndex !== index)
            throw new Error(t("vocabularyDuplicate"));
          if (index !== null && index >= 0) vocabulary[index] = entry;
          else {
            if (vocabulary.length >= 32) throw new Error(t("vocabularyLimit"));
            vocabulary.push(entry);
          }
        }
        await api.updateSettings({ vocabulary });
        setVocabularyEditing(null);
        setRememberId(null);
      },
      t("vocabularySaved")
    );
  };
  const toggle = () => {
    setError(null);
    void controller.current?.toggle();
  };
  const cancel = () => {
    void controller.current?.cancel();
  };

  if (!api)
    return (
      <main className="standalone">
        <AudioLines size={34} />
        <h1>{t("desktopOnly")}</h1>
        <p>{t("desktopOnlyDetail")}</p>
      </main>
    );
  if (!state)
    return (
      <main className="standalone">
        <LoaderCircle className="spin" size={26} />
        <p>{error || t("loading")}</p>
      </main>
    );
  const needsSetup =
    state.permissions.microphone !== "granted" ||
    !state.permissions.accessibility ||
    !state.localReady;
  const mainPhase =
    capture.phase === "opening"
      ? "opening"
      : capture.phase === "recording"
        ? "listening"
        : state.phase === "delivering"
          ? "delivering"
          : state.phase === "setup"
            ? "setup"
            : busy
              ? "processing"
              : "ready";
  const visibleError = error || state.error;
  const connectionLabel =
    state.studio === "ready"
      ? t("studioReady")
      : state.studio === "offline"
        ? t("studioOffline")
        : t("connecting");

  function routePicker() {
    return (
      <div className="segmented" role="group" aria-label={t("routeLabel")}>
        {(["auto", "studio", "air"] as Profile[]).map((profile) => (
          <button
            key={profile}
            aria-pressed={state!.settings.profile === profile}
            className={state!.settings.profile === profile ? "selected" : ""}
            disabled={locked}
            onClick={() => void save({ profile })}
          >
            {profile === "auto" ? (
              <AudioLines size={14} />
            ) : profile === "studio" ? (
              <Monitor size={14} />
            ) : (
              <Laptop size={14} />
            )}
            {t(profile)}
          </button>
        ))}
      </div>
    );
  }
  function switchControl(
    label: string,
    detail: string,
    checked: boolean,
    onChange: () => void,
    disabled = false
  ) {
    return (
      <div className="setting-row">
        <div>
          <span className="setting-label">{label}</span>
          <p>{detail}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          className={`switch ${checked ? "on" : ""}`}
          disabled={locked || disabled}
          onClick={onChange}
        >
          <span />
        </button>
      </div>
    );
  }
  function transcriptCard(item: Transcript, latest = false) {
    const rewriteBusy = action === `rewrite-${item.id}`;
    const guarded = !!item.candidateText && !!item.reviewReasons?.length;
    const editedLater = item.edit && item.edit.source !== "dictation";
    return (
      <article className={`transcript-card ${latest ? "latest-card" : ""}`} key={item.id}>
        <div className="transcript-meta">
          <span>
            {latest
              ? t("lastDictation")
              : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
                  new Date(item.createdAt)
                )}
          </span>
          <span className="meta-route">
            {item.actualProfile === "studio" ? <Monitor size={12} /> : <Laptop size={12} />}
            {t(item.actualProfile)}
            <span className="meta-dot">·</span>
            {timeLabel(item.durationMs)}
          </span>
        </div>
        {item.targetApp?.name && <p className="transcript-app">{item.targetApp.name}</p>}
        {latest ? (
          <p className="latest-text">{item.text || t("originalEmpty")}</p>
        ) : (
          <div className="transcript-columns">
            <section>
              <h3>{t("original")}</h3>
              <p>{item.rawText || t("originalEmpty")}</p>
            </section>
            <section>
              <h3>{t(guarded ? "keptText" : "edited")}</h3>
              <p>{item.text || t("originalEmpty")}</p>
            </section>
          </div>
        )}
        <TextChanges before={item.rawText} after={item.text} label={t("changesFromOriginal")} />
        <div className="transcript-notes">
          <span>
            {t(
              guarded
                ? "reviewNeeded"
                : item.cleanupStatus === "applied"
                  ? "cleanupApplied"
                  : item.cleanupStatus === "failed"
                    ? "cleanupFailed"
                    : "cleanupOff"
            )}
          </span>
          {item.fallbackReason && <span>{t("fallbackUsed")}</span>}
          {item.editingMode && <span>{t(`mode_${item.editingMode}`)}</span>}
          {item.style && item.editingMode !== "exact" && <span>{t(`style_${item.style}`)}</span>}
          {item.format && item.editingMode !== "exact" && <span>{t(`format_${item.format}`)}</span>}
        </div>
        {guarded && (
          <details className="review-suggestion">
            <summary>
              <Sparkles size={13} />
              {t("reviewSuggestion")}
            </summary>
            <p className="review-explanation">{t("reviewDetail")}</p>
            <ul>
              {item.reviewReasons!.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
            <div className="transcript-columns">
              <section>
                <h3>{t("keptText")}</h3>
                <p>{item.text}</p>
              </section>
              <section>
                <h3>{t("suggestion")}</h3>
                <p>{item.candidateText}</p>
              </section>
            </div>
            <TextChanges
              before={item.text}
              after={item.candidateText!}
              label={t("suggestedChanges")}
            />
            <div className="suggestion-actions">
              <button
                className="small-button save-button"
                disabled={locked}
                onClick={() =>
                  void perform(
                    `accept-${item.id}`,
                    () => api.acceptSuggestion(item.id),
                    t("suggestionAccepted")
                  )
                }
              >
                <Check size={13} />
                {t("useSuggestion")}
              </button>
              <button
                className="text-button"
                disabled={locked}
                onClick={() =>
                  void perform(
                    `copy-${item.id}`,
                    () => api.copyTranscript(item.id, "suggestion"),
                    t("copied")
                  )
                }
              >
                <Copy size={13} />
                {t("copySuggestion")}
              </button>
            </div>
          </details>
        )}
        {latest && !editedLater && !item.historyEdited && (
          <p className={`delivery ${item.delivery === "dispatched" ? "" : "delivery-attention"}`}>
            {t(
              item.delivery === "dispatched"
                ? "delivered"
                : item.delivery === "clipboard-only"
                  ? "clipboardOnly"
                  : item.delivery === "uncertain"
                    ? "uncertain"
                    : item.delivery === "cancelled"
                      ? "cancelled"
                      : "pending"
            )}
          </p>
        )}
        {(editedLater || item.historyEdited) && (
          <p className="history-action-note">{t("historyEditOnly")}</p>
        )}
        <details className="transcript-performance">
          <summary>{t("processingDetails")}</summary>
          <p>{t("originalRoute", { machine: t(item.actualProfile) })}</p>
          <dl className="timing-list">
            <div>
              <dt>{t("speechTiming")}</dt>
              <dd>{secondsLabel(item.timings.asrMs)}</dd>
            </div>
            <div>
              <dt>{t("cleanupTiming")}</dt>
              <dd>{secondsLabel(item.timings.cleanupMs)}</dd>
            </div>
            <div>
              <dt>{t("totalTiming")}</dt>
              <dd>{secondsLabel(item.timings.totalMs)}</dd>
            </div>
          </dl>
          {item.fallbackReason && (
            <p className="fallback-detail">
              {t("fallbackReason", { reason: item.fallbackReason })}
            </p>
          )}
          {editedLater && (
            <p className="edit-timing">
              {t(
                item.edit!.source === "accepted"
                  ? "acceptedTiming"
                  : item.editingMode === "exact"
                    ? "exactRetry"
                    : "retryTiming",
                {
                  machine: t(item.edit!.profile),
                  time: secondsLabel(item.edit!.elapsedMs),
                }
              )}
            </p>
          )}
          {item.edit?.fallbackReason && (
            <p>{t("retryFallbackReason", { reason: item.edit.fallbackReason })}</p>
          )}
        </details>
        {item.warning && <p className="item-warning">{item.warning}</p>}
        {item.audioWarning && (
          <p className="item-warning" role="alert">
            {item.audioWarning}
          </p>
        )}
        <div className="transcript-actions">
          <button
            className="text-button"
            disabled={locked}
            onClick={() =>
              void perform(
                `copy-${item.id}`,
                () => api.copyTranscript(item.id, "original"),
                t("copied")
              )
            }
          >
            <Copy size={13} />
            {t("copyOriginal")}
          </button>
          <button
            className="text-button"
            disabled={locked}
            onClick={() =>
              void perform(
                `copy-${item.id}`,
                () => api.copyTranscript(item.id, "edited"),
                t("copied")
              )
            }
          >
            <Copy size={13} />
            {t("copyCurrent")}
          </button>
          <button
            className="text-button"
            disabled={locked}
            aria-expanded={rememberId === item.id}
            onClick={() => setRememberId(rememberId === item.id ? null : item.id)}
          >
            <BookOpen size={13} />
            {t("rememberCorrection")}
          </button>
          <button
            className="text-button rewrite-button"
            title={t("rewriteDescription")}
            disabled={locked}
            onClick={() =>
              void perform(
                `rewrite-${item.id}`,
                () => api.rewriteTranscript(item.id),
                t("retryFinished")
              )
            }
          >
            {rewriteBusy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
            {t(rewriteBusy ? "rewriting" : "rewrite")}
          </button>
          {item.previousVersion && (
            <button
              className="text-button"
              disabled={locked}
              title={t("undoDescription")}
              onClick={() =>
                void perform(
                  `undo-${item.id}`,
                  () => api.undoTranscript(item.id),
                  t("undoFinished")
                )
              }
            >
              <Undo2 size={13} />
              {t("undo")}
            </button>
          )}
          {item.audio && (
            <button
              className="text-button"
              disabled={locked}
              onClick={() => void perform(`recording-${item.id}`, () => api.showRecording(item.id))}
            >
              <FolderOpen size={13} />
              {t("showRecording")}
            </button>
          )}
          {!latest && (
            <>
              <button
                className={`${item.audio ? "text-button" : "icon-button"} delete-button`}
                aria-label={t(item.audio ? "deleteWithAudio" : "delete")}
                title={t(item.audio ? "deleteWithAudioDetail" : "delete")}
                disabled={locked}
                onClick={() =>
                  void perform(
                    `delete-${item.id}`,
                    () => api.deleteTranscript(item.id),
                    t(item.audio ? "removedWithAudio" : "removed")
                  )
                }
              >
                <Trash2 size={14} />
                {item.audio && t("deleteWithAudio")}
              </button>
            </>
          )}
        </div>
        <p className="transcript-action-hint">{t("historyActionsDetail")}</p>
        {rememberId === item.id && (
          <div className="remember-form">
            <h3>{t("rememberCorrection")}</h3>
            <VocabularyForm
              key={`remember-${item.id}`}
              correction
              disabled={locked}
              onSave={(entry) => saveVocabulary(entry, null, true)}
              onCancel={() => setRememberId(null)}
            />
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="app-shell">
      {preview && <div className="preview-banner">{t("preview")}</div>}
      <aside className="sidebar">
        <div className="window-drag">
          <span className="traffic-space" />
        </div>
        <div className="brand">
          <span className="brand-mark">
            <AudioLines size={23} strokeWidth={1.7} />
          </span>
          <span>
            Open<span className="brand-word">Superwhisper</span>
          </span>
        </div>
        <nav aria-label="Main">
          {(
            [
              { id: "dictate", Icon: Mic },
              { id: "history", Icon: History },
              { id: "settings", Icon: Settings2 },
            ] as const
          ).map(({ id, Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon size={17} strokeWidth={1.75} />
              {t(id)}
              {page === id && <ChevronRight size={13} className="nav-chevron" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="status-line">
            <span
              className={`status-dot ${state.studio === "ready" ? "good" : state.studio === "unknown" ? "waiting" : ""}`}
            />
            <span>{connectionLabel}</span>
          </div>
          <div className="status-line">
            <Laptop size={12} />
            <span>{t(state.localReady ? "localReady" : "localMissing")}</span>
          </div>
          <p>{t("personal")}</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="titlebar window-drag">
          <span>{t(page)}</span>
          <button
            className="icon-button"
            aria-label={t("refresh")}
            title={t("refresh")}
            disabled={locked}
            onClick={() => void perform("connection", () => api.checkConnections())}
          >
            <RefreshCw size={14} className={action === "connection" ? "spin" : ""} />
          </button>
        </header>
        <main className={`page page-${page}`}>
          {visibleError && (
            <div className="error-banner" role="alert">
              <span>{visibleError}</span>
              {error && (
                <button
                  className="icon-button"
                  aria-label={t("dismiss")}
                  onClick={() => setError(null)}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          {page === "dictate" && (
            <>
              <div className="dictation-heading">
                <div className="eyebrow">
                  <span className={`status-dot ${mainPhase === "listening" ? "live" : "good"}`} />
                  {t(
                    mainPhase === "listening"
                      ? "listeningTitle"
                      : state.settings.profile === "air"
                        ? "air"
                        : state.settings.profile === "studio"
                          ? "studio"
                          : "automaticDetail"
                  )}
                </div>
                <h1>{t(`${mainPhase}Title`)}</h1>
                <p>{t(`${mainPhase}Detail`)}</p>
              </div>
              <div className={`recording-stage ${mainPhase === "listening" ? "is-listening" : ""}`}>
                <div className="waveform" aria-hidden="true">
                  {Array.from({ length: 21 }, (_, index) => (
                    <span
                      key={index}
                      style={{
                        height: `${7 + (capture.phase === "recording" ? capture.level * (26 + (Math.sin(index * 2.6) + 1) * 24) : (Math.sin(index * 1.7) + 1) * 5)}px`,
                      }}
                    />
                  ))}
                </div>
                <button
                  className={`record-button ${capture.phase === "recording" ? "recording" : ""}`}
                  disabled={
                    action !== null ||
                    !["idle", "opening", "recording"].includes(capture.phase) ||
                    (capture.phase === "idle" && state.phase !== "idle")
                  }
                  onClick={toggle}
                  aria-label={t(
                    capture.phase === "recording"
                      ? "stop"
                      : capture.phase === "opening"
                        ? "cancel"
                        : "start"
                  )}
                >
                  {capture.phase === "recording" ? (
                    <Square size={26} fill="currentColor" strokeWidth={0} />
                  ) : mainPhase !== "ready" ? (
                    <LoaderCircle className="spin" size={31} strokeWidth={1.6} />
                  ) : (
                    <Mic size={32} strokeWidth={1.5} />
                  )}
                </button>
                <div className="recording-caption" aria-live="polite">
                  {capture.phase === "recording" ? (
                    <>
                      <span className="elapsed">{timeLabel(capture.elapsedMs)}</span>
                      <span>{t("listeningDetail")}</span>
                    </>
                  ) : (
                    <>
                      <span>{t(mainPhase === "ready" ? "start" : `${mainPhase}Title`)}</span>
                      {mainPhase === "ready" && (
                        <span className="shortcut-hint">
                          {t("shortcutHint")} <kbd>{shortcutLabel(state.settings.hotkey)}</kbd>
                        </span>
                      )}
                    </>
                  )}
                </div>
                {busy && capture.phase !== "idle" && (
                  <button className="text-button cancel-recording" onClick={cancel}>
                    <X size={13} />
                    {t("cancel")}
                    <kbd>Esc</kbd>
                  </button>
                )}
              </div>
              <div className="dictation-controls">
                {routePicker()}
                <ModePicker
                  value={state.settings.editingMode}
                  disabled={locked}
                  onChange={(editingMode) => void save({ editingMode })}
                />
              </div>
              <p className="mode-detail">{t(`modeDetail_${state.settings.editingMode}`)}</p>
              {state.settings.editingMode !== "exact" && (
                <p className="model-mode-detail">{t("compactEditorDetail")}</p>
              )}
              {!!state.settings.appRules?.length && (
                <p className="model-mode-detail">{t("appRulesActive")}</p>
              )}
              {state.settings.retainAudio && (
                <p className="model-mode-detail">{t("audioSavingOn")}</p>
              )}
              <p className="recording-limit">
                {state.phase === "setup" && state.progress ? state.progress : t("durationLimit")}
              </p>
              {needsSetup && (
                <section className="setup-card">
                  <h2>{t("setupHeading")}</h2>
                  <p>{t("setupBody")}</p>
                  <div className="checklist">
                    {(
                      [
                        {
                          id: "microphone",
                          ready: state.permissions.microphone === "granted",
                          label: "microphone",
                          detail: "microphoneDetail",
                        },
                        {
                          id: "accessibility",
                          ready: state.permissions.accessibility,
                          label: "accessibility",
                          detail: "accessibilityDetail",
                        },
                      ] as const
                    ).map((item) => (
                      <div className="checklist-row" key={item.id}>
                        <span className={`check-indicator ${item.ready ? "done" : ""}`}>
                          {item.ready ? <Check size={14} /> : <Circle size={14} />}
                        </span>
                        <div>
                          <span>{t(item.label)}</span>
                          <p>{t(item.detail)}</p>
                        </div>
                        {item.ready ? (
                          <span className="ready-label">{t("allowed")}</span>
                        ) : (
                          <button
                            className="small-button"
                            disabled={locked}
                            onClick={() =>
                              void perform(item.id, () => api.requestPermission(item.id))
                            }
                          >
                            {t(item.id === "accessibility" ? "openSettings" : "enable")}
                          </button>
                        )}
                      </div>
                    ))}
                    <div className="checklist-row">
                      <span className={`check-indicator ${state.localReady ? "done" : ""}`}>
                        {state.localReady ? <Check size={14} /> : <Laptop size={14} />}
                      </span>
                      <div>
                        <span>{t("fallback")}</span>
                        <p>{t("fallbackDetail")}</p>
                      </div>
                      {state.localReady ? (
                        <span className="ready-label">{t("ready")}</span>
                      ) : (
                        <button
                          className="small-button"
                          disabled={locked}
                          onClick={() => void perform("prepare", () => api.prepareLocal())}
                        >
                          {action === "prepare" && <LoaderCircle size={12} className="spin" />}
                          {t(action === "prepare" ? "preparing" : "prepare")}
                        </button>
                      )}
                    </div>
                  </div>
                  {state.progress && state.phase === "setup" && (
                    <p className="setup-progress" aria-live="polite">
                      {state.progress}
                    </p>
                  )}
                </section>
              )}
              {state.latest && transcriptCard(state.latest, true)}
            </>
          )}
          {page === "history" && (
            <>
              <div className="page-heading">
                <h1>{t("historyTitle")}</h1>
                <p>{t("historyDetail")}</p>
              </div>
              {!state.settings.historyEnabled && (
                <p className="inline-note">{t("noHistoryNotice")}</p>
              )}
              {state.history.length ? (
                <div className="history-list">
                  {state.history.map((item) => transcriptCard(item))}
                </div>
              ) : (
                <div className="empty-state">
                  <History size={28} strokeWidth={1.3} />
                  <h2>{t("emptyHistory")}</h2>
                  <p>{t("emptyHistoryDetail")}</p>
                  <button className="primary-button" onClick={() => setPage("dictate")}>
                    <Mic size={14} />
                    {t("dictate")}
                  </button>
                </div>
              )}
            </>
          )}
          {page === "settings" && (
            <>
              <div className="page-heading">
                <h1>{t("settingsTitle")}</h1>
                <p>{t("settingsDetail")}</p>
              </div>
              <section className="settings-group">
                <h2>{t("connectionGroup")}</h2>
                <div className="settings-card">
                  <div className="setting-row route-setting">
                    <div>
                      <span className="setting-label">{t("routeLabel")}</span>
                      <p>
                        {t(
                          state.settings.profile === "auto"
                            ? "automaticDetail"
                            : `${state.settings.profile}Detail`
                        )}
                      </p>
                    </div>
                    {routePicker()}
                  </div>
                  <div className="setting-row editing-setting">
                    <div>
                      <span className="setting-label">{t("defaultEditing")}</span>
                      <p>{t(`modeDetail_${state.settings.editingMode}`)}</p>
                    </div>
                    <ModePicker
                      value={state.settings.editingMode}
                      disabled={locked}
                      onChange={(editingMode) => void save({ editingMode })}
                    />
                    <WritingOptions
                      id="defaults"
                      value={state.settings}
                      disabled={locked}
                      onChange={(patch) => void save(patch)}
                    />
                    <p className="setting-explanation">
                      {t("compactEditorDetail")} {t("formatDetail")}
                    </p>
                  </div>
                </div>
              </section>
              <AppRules
                settings={state.settings}
                transcripts={state.latest ? [state.latest, ...state.history] : state.history}
                disabled={locked}
                onChange={(appRules) => void save({ appRules })}
              />
              <section className="settings-group">
                <h2>{t("vocabularyGroup")}</h2>
                <div className="settings-card vocabulary-card">
                  <div className="vocabulary-heading">
                    <div>
                      <span className="setting-label">{t("vocabularyTitle")}</span>
                      <p>{t("vocabularyDetail")}</p>
                    </div>
                    <button
                      className="small-button"
                      disabled={locked || state.settings.vocabulary.length >= 32}
                      onClick={() => setVocabularyEditing(-1)}
                    >
                      <Plus size={13} />
                      {t("addWord")}
                    </button>
                  </div>
                  {vocabularyEditing === -1 && (
                    <VocabularyForm
                      key="new-word"
                      disabled={locked}
                      onSave={(entry) => saveVocabulary(entry, null)}
                      onCancel={() => setVocabularyEditing(null)}
                    />
                  )}
                  <div className="vocabulary-list">
                    {state.settings.vocabulary.map((entry, index) => (
                      <div className="vocabulary-entry" key={entry.word}>
                        {vocabularyEditing === index ? (
                          <VocabularyForm
                            key={`edit-${entry.word}`}
                            initial={entry}
                            disabled={locked}
                            onSave={(next) => saveVocabulary(next, index)}
                            onCancel={() => setVocabularyEditing(null)}
                          />
                        ) : (
                          <>
                            <div className="vocabulary-term">
                              <span>{entry.word}</span>
                              {entry.aliases.length > 0 && (
                                <p>{t("aliasesPreview", { aliases: entry.aliases.join(" · ") })}</p>
                              )}
                            </div>
                            <button
                              className="icon-button"
                              aria-label={t("editWord", { word: entry.word })}
                              disabled={locked}
                              onClick={() => setVocabularyEditing(index)}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              className="icon-button delete-button"
                              aria-label={t("removeWord", { word: entry.word })}
                              disabled={locked}
                              onClick={() =>
                                void perform(
                                  "vocabulary",
                                  async () => {
                                    await api.updateSettings({
                                      vocabulary: state.settings.vocabulary.filter(
                                        (_, current) => current !== index
                                      ),
                                    });
                                    setVocabularyEditing(null);
                                  },
                                  t("vocabularyRemoved")
                                )
                              }
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  {!state.settings.vocabulary.length && vocabularyEditing === null && (
                    <p className="vocabulary-empty">{t("vocabularyEmpty")}</p>
                  )}
                  <p className="vocabulary-footnote">
                    {t("vocabularyRules")}{" "}
                    <span>{t("vocabularyCount", { count: state.settings.vocabulary.length })}</span>
                  </p>
                </div>
              </section>
              <section className="settings-group">
                <h2>{t("inputGroup")}</h2>
                <div className="settings-card">
                  <div className="setting-row">
                    <div>
                      <label htmlFor="microphone-select" className="setting-label">
                        {t("microphoneSelect")}
                      </label>
                      <p>{t("microphoneHint")}</p>
                    </div>
                    <select
                      id="microphone-select"
                      value={state.settings.microphoneId || "default"}
                      disabled={locked}
                      onChange={(event) => void save({ microphoneId: event.target.value })}
                    >
                      <option value="default">{t("systemDefault")}</option>
                      {devices.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || t("unnamedMicrophone", { number: index + 1 })}
                        </option>
                      ))}
                      {state.settings.microphoneId &&
                        state.settings.microphoneId !== "default" &&
                        !devices.some(
                          (device) => device.deviceId === state.settings.microphoneId
                        ) && <option value={state.settings.microphoneId}>{t("notAllowed")}</option>}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div>
                      <span className="setting-label">{t("hotkey")}</span>
                      <p>{t("hotkeyDetail")}</p>
                    </div>
                    <button
                      className={`shortcut-button ${shortcutArmed ? "armed" : ""}`}
                      disabled={locked}
                      aria-label={t("changeShortcut")}
                      onClick={() => setShortcutArmed(true)}
                      onBlur={() => setShortcutArmed(false)}
                      onKeyDown={(event) => {
                        if (!shortcutArmed) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          setShortcutArmed(false);
                          return;
                        }
                        if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
                        const hotkey = shortcutFromEvent(event);
                        if (!hotkey) {
                          setError(t("shortcutInvalid"));
                          return;
                        }
                        setShortcutArmed(false);
                        void save({ hotkey });
                      }}
                    >
                      <kbd>
                        {shortcutArmed ? t("pressShortcut") : shortcutLabel(state.settings.hotkey)}
                      </kbd>
                    </button>
                  </div>
                </div>
              </section>
              <section className="settings-group">
                <h2>{t("preferencesGroup")}</h2>
                <div className="settings-card">
                  {switchControl(
                    t("launchAtLogin"),
                    t("launchDetail"),
                    state.settings.launchAtLogin,
                    () => void save({ launchAtLogin: !state.settings.launchAtLogin })
                  )}
                  {switchControl(
                    t("historyEnabled"),
                    t("historySettingDetail"),
                    state.settings.historyEnabled,
                    () => void save({ historyEnabled: !state.settings.historyEnabled })
                  )}
                  {switchControl(
                    t("retainAudio"),
                    t("retainAudioDetail"),
                    state.settings.retainAudio,
                    () => void save({ retainAudio: !state.settings.retainAudio }),
                    !state.settings.historyEnabled
                  )}
                  <div className="setting-row">
                    <div>
                      <span className="setting-label">{t("savedRecordings")}</span>
                      <p>
                        {t(
                          state.settings.historyEnabled ? "audioArchiveDetail" : "audioNeedsHistory"
                        )}
                      </p>
                    </div>
                    <button
                      className="small-button"
                      disabled={action !== null}
                      onClick={() => void perform("audio-folder", () => api.openAudioFolder())}
                    >
                      <FolderOpen size={13} />
                      {t("openAudioFolder")}
                    </button>
                  </div>
                </div>
              </section>
              <p className="privacy-note">
                <ShieldCheck size={15} />
                {t("privacyNote")}
              </p>
              <p className="model-attribution">{t("localAttribution")}</p>
            </>
          )}
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
    </div>
  );
}
