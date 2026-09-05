import type { AppState, LocalWhisprAPI, Transcript } from "../desktop/contracts";

/** Imported only by an explicitly requested Vite development preview. */
export function createPreviewAPI(): LocalWhisprAPI {
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
  };
  const guardedSample: Transcript = {
    ...sample,
    id: "preview-review",
    rawText: "please keep fifteen seats for the review not fifty",
    text: "please keep fifteen seats for the review not fifty",
    candidateText: "Please keep fifty seats for the review.",
    reviewReasons: ["The suggested edit may have changed a number or removed a negation."],
    cleanupStatus: "applied",
    delivery: "dispatched",
    durationMs: 6100,
  };
  let state: AppState = {
    settings: {
      profile: "auto",
      cleanup: true,
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
      launchAtLogin: false,
    },
    permissions: { microphone: "not-determined", accessibility: false },
    localReady: false,
    studio: "ready",
    phase: "idle",
    progress: "",
    history: [guardedSample, sample],
    latest: guardedSample,
    error: null,
  };
  const listeners = new Set<(state: AppState) => void>();
  const snapshot = () => structuredClone(state);
  const emit = () => {
    listeners.forEach((callback) => callback(snapshot()));
    return snapshot();
  };
  return {
    getState: async () => snapshot(),
    updateSettings: async (patch) => {
      state = { ...state, settings: { ...state.settings, ...patch } };
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
    checkConnections: async () => emit(),
    beginRecording: async () => {
      throw new Error("Recording is disabled in the design preview.");
    },
    transcribe: async () => null,
    cancel: async () => {},
    copyTranscript: async () => {},
    rewriteTranscript: async (id) => state.history.find((item) => item.id === id)!,
    deleteTranscript: async (id) => {
      state = {
        ...state,
        history: state.history.filter((item) => item.id !== id),
        latest: state.latest?.id === id ? null : state.latest,
      };
      return emit();
    },
    hideWindow: async () => {},
    onState: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    onCommand: () => () => {},
  };
}
