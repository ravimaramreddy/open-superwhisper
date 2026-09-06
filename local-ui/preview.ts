import type { AppState, LocalWhisprAPI, Transcript, TextVersion } from "../desktop/contracts";

/** Imported only by an explicitly requested Vite development preview. */
export function createPreviewAPI({
  geminiStatus = "ready",
}: { geminiStatus?: Exclude<AppState["gemini"], "unknown"> } = {}): LocalWhisprAPI {
  const sample: Transcript = {
    id: "preview-sample",
    createdAt: new Date().toISOString(),
    rawText:
      "hey can we move the review to thursday afternoon i want to give maya a little more time with the draft",
    text: "Hey, can we move the review to Thursday afternoon? I want to give Maya a little more time with the draft.",
    actualProfile: "studio",
    cleanupStatus: "applied",
    durationMs: 12400,
    timings: { asrMs: 600, cleanupMs: 380, totalMs: 980 },
    delivery: "clipboard-only",
    audio: { fileName: "preview-sample.wav", bytes: 396_844 },
    editingMode: "polished",
    style: "neutral",
    format: "prose",
    targetApp: { bundleId: "com.apple.mail", name: "Mail" },
    edit: { source: "dictation", profile: "studio", elapsedMs: 380 },
  };
  const guardedSample: Transcript = {
    ...sample,
    id: "preview-review",
    rawText: "please keep fifteen seats for the review not fifty",
    text: "please keep fifteen seats for the review not fifty",
    candidateText: "Please keep fifty seats for the review.",
    reviewReasons: ["The suggested edit may have changed a number or removed a negation."],
    cleanupStatus: "failed",
    delivery: "dispatched",
    durationMs: 6100,
    targetApp: { bundleId: "com.openai.codex", name: "Codex" },
  };
  const fallbackSample: Transcript = {
    ...sample,
    id: "preview-fallback",
    rawText: "the preview is ready i will send the notes tomorrow",
    text: "The preview is ready. I will send the notes tomorrow.",
    actualProfile: "air",
    fallbackReason: "Studio did not respond. This dictation finished on this Mac.",
    timings: { asrMs: 1450, cleanupMs: 770, totalMs: 2430 },
    edit: { source: "dictation", profile: "air", elapsedMs: 770 },
    targetApp: { bundleId: "com.apple.MobileSMS", name: "Messages" },
  };
  const geminiSample: Transcript = {
    ...sample,
    id: "preview-gemini",
    rawText: "keep the blue panel but do not change the sidebar",
    text: "Keep the blue panel, but do not change the sidebar.",
    actualProfile: "gemini",
    durationMs: 5300,
    timings: { asrMs: 0, cleanupMs: 0, geminiMs: 1240, totalMs: 1240 },
    edit: { source: "dictation", profile: "gemini", elapsedMs: 0 },
    targetApp: { bundleId: "com.apple.Notes", name: "Notes" },
  };
  for (const item of [sample, fallbackSample, geminiSample]) {
    item.previousVersion = {
      text: item.rawText,
      cleanupStatus: "off",
      editingMode: "exact",
      style: "neutral",
      format: "prose",
    };
  }
  let state: AppState = {
    settings: {
      profile: "auto",
      cleanup: true,
      editingMode: "polished",
      style: "neutral",
      appRules: [],
      format: "prose",
      vocabulary: [
        { word: "OpenSuperwhisper", aliases: [] },
        { word: "OpenWhispr", aliases: [] },
        { word: "Superwhisper", aliases: [] },
        { word: "Qwen", aliases: [] },
        { word: "Gemma", aliases: [] },
        { word: "Tailscale", aliases: [] },
        { word: "Codex", aliases: [] },
        { word: "Mac Studio", aliases: [] },
      ],
      microphoneId: "default",
      hotkey: "CommandOrControl+Shift+Space",
      historyEnabled: true,
      retainAudio: false,
      launchAtLogin: false,
    },
    permissions: { microphone: "not-determined", accessibility: false },
    localReady: false,
    studio: "ready",
    gemini: "unknown",
    phase: "idle",
    progress: "",
    history: [guardedSample, sample, fallbackSample, geminiSample],
    latest: guardedSample,
    error: null,
  };
  const listeners = new Set<(state: AppState) => void>();
  const snapshot = () => structuredClone(state);
  const emit = () => {
    listeners.forEach((callback) => callback(snapshot()));
    return snapshot();
  };
  const find = (id: string) => {
    const item =
      state.history.find((record) => record.id === id) ||
      (state.latest?.id === id ? state.latest : null);
    if (!item) throw new Error("Dictation not found.");
    return item;
  };
  const version = (item: TextVersion): TextVersion => ({
    text: item.text,
    cleanupStatus: item.cleanupStatus,
    warning: item.warning,
    candidateText: item.candidateText,
    reviewReasons: item.reviewReasons,
    editingMode: item.editingMode,
    style: item.style,
    format: item.format,
    edit: item.edit,
  });
  const update = (item: Transcript) => {
    state = {
      ...state,
      history: state.history.map((record) => (record.id === item.id ? item : record)),
      latest: state.latest?.id === item.id ? item : state.latest,
    };
    emit();
    return structuredClone(item);
  };
  return {
    getState: async () => snapshot(),
    updateSettings: async (patch) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
      if (patch.editingMode) state.settings.cleanup = patch.editingMode !== "exact";
      if (!state.settings.historyEnabled) state.settings.retainAudio = false;
      return emit();
    },
    requestPermission: async (kind) => {
      state = {
        ...state,
        permissions: { ...state.permissions, [kind]: kind === "microphone" ? "granted" : true },
      };
      emit();
      return state.permissions;
    },
    prepareLocal: async () => {
      state = { ...state, localReady: true };
      return emit();
    },
    checkConnections: async () => {
      if (state.settings.profile === "gemini") state = { ...state, gemini: geminiStatus };
      return emit();
    },
    beginRecording: async () => {
      throw new Error("Recording is disabled in the design preview.");
    },
    transcribe: async () => null,
    cancel: async () => {},
    copyTranscript: async (id, source) => {
      const item = find(id);
      const text =
        source === "original"
          ? item.rawText
          : source === "suggestion"
            ? item.candidateText
            : item.text;
      if (!text) throw new Error("There is no text to copy.");
      await navigator.clipboard.writeText(text);
    },
    rewriteTranscript: async (id) => {
      const item = find(id);
      const rule = state.settings.appRules.find(
        (entry) => entry.bundleId === item.targetApp?.bundleId
      );
      const options = rule || state.settings;
      let text = item.rawText;
      if (options.editingMode !== "exact") {
        text =
          item.id === "preview-review"
            ? "Please keep fifteen seats for the review, not fifty."
            : item.id === "preview-fallback"
              ? fallbackSample.text
              : item.id === "preview-gemini"
                ? geminiSample.text
                : sample.text;
        if (options.editingMode === "polished" && item.id === "preview-sample") {
          text =
            "Could we move the review to Thursday afternoon? Maya needs a little more time with the draft.";
        }
        if (options.style === "email") text = text.replace(/\? /, "?\n\n");
        if (options.style === "chat") text = text.replace(/\.$/, "");
        if (options.format === "list")
          text = text
            .split(/(?<=[.?]) /)
            .map((line) => `• ${line}`)
            .join("\n");
        if (options.format === "paragraphs" && state.settings.profile !== "air")
          text = text.replace(/\? /, "?\n\n");
      }
      return update({
        ...item,
        previousVersion: version(item),
        historyEdited: true,
        text,
        cleanupStatus: options.editingMode === "exact" ? "off" : "applied",
        candidateText: undefined,
        reviewReasons: undefined,
        warning: undefined,
        editingMode: options.editingMode,
        style: options.style,
        format: options.format,
        edit: {
          source: "retry",
          profile: state.settings.profile === "air" ? "air" : "studio",
          elapsedMs: options.editingMode === "exact" ? 0 : 620,
        },
      });
    },
    undoTranscript: async (id) => {
      const item = find(id);
      if (!item.previousVersion) throw new Error("No previous edit to undo.");
      return update({
        ...item,
        ...version(item.previousVersion),
        previousVersion: undefined,
        historyEdited: true,
      });
    },
    acceptSuggestion: async (id) => {
      const item = find(id);
      if (!item.candidateText) throw new Error("There is no suggestion to accept.");
      return update({
        ...item,
        previousVersion: version(item),
        historyEdited: true,
        text: item.candidateText,
        cleanupStatus: "applied",
        candidateText: undefined,
        reviewReasons: undefined,
        warning: undefined,
        edit: {
          source: "accepted",
          profile: item.edit?.profile || item.actualProfile,
          elapsedMs: item.edit?.elapsedMs || 0,
        },
      });
    },
    deleteTranscript: async (id) => {
      state = {
        ...state,
        history: state.history.filter((item) => item.id !== id),
        latest: state.latest?.id === id ? null : state.latest,
      };
      return emit();
    },
    hideWindow: async () => {},
    openAudioFolder: async () => {},
    showRecording: async () => {},
    onState: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    onCommand: () => () => {},
  };
}
