export type Profile = "auto" | "studio" | "air";
export type EditingMode = "exact" | "clean" | "polished";
export type WritingStyle = "neutral" | "chat" | "email";
export type TextFormat = "prose" | "paragraphs" | "list";
export interface AppRule {
  bundleId: string;
  name: string;
  editingMode: EditingMode;
  style: WritingStyle;
  format: TextFormat;
}
export interface VocabularyEntry {
  word: string;
  aliases: string[];
}
export interface Settings {
  profile: Profile;
  cleanup: boolean;
  editingMode: EditingMode;
  style: WritingStyle;
  appRules: AppRule[];
  format: TextFormat;
  vocabulary: VocabularyEntry[];
  microphoneId: string;
  hotkey: string;
  historyEnabled: boolean;
  launchAtLogin: boolean;
}
export interface Permissions {
  microphone: string;
  accessibility: boolean;
}
export interface TextVersion {
  text: string;
  cleanupStatus: "off" | "applied" | "failed";
  warning?: string;
  candidateText?: string;
  reviewReasons?: string[];
  editingMode?: EditingMode;
  style?: WritingStyle;
  format?: TextFormat;
  edit?: {
    source: "dictation" | "retry" | "accepted";
    profile: "studio" | "air";
    elapsedMs: number;
    fallbackReason?: string;
  };
}
export interface Transcript extends TextVersion {
  id: string;
  createdAt: string;
  rawText: string;
  text: string;
  actualProfile: "studio" | "air";
  cleanupStatus: "off" | "applied" | "failed";
  fallbackReason?: string;
  warning?: string;
  candidateText?: string;
  reviewReasons?: string[];
  durationMs: number;
  timings: { asrMs: number; cleanupMs: number; totalMs: number };
  delivery: "pending" | "dispatched" | "clipboard-only" | "uncertain" | "cancelled";
  targetApp?: { bundleId: string; name: string };
  previousVersion?: TextVersion;
}
export interface AppState {
  settings: Settings;
  permissions: Permissions;
  localReady: boolean;
  studio: "unknown" | "ready" | "offline";
  phase: "idle" | "recording" | "processing" | "delivering" | "setup";
  progress: string;
  history: Transcript[];
  latest: Transcript | null;
  error: string | null;
}
export interface RecordingSession {
  requestId: string;
  settings: Settings;
}
export interface LocalWhisprAPI {
  getState(): Promise<AppState>;
  updateSettings(patch: Partial<Settings>): Promise<AppState>;
  requestPermission(kind: "microphone" | "accessibility"): Promise<Permissions>;
  prepareLocal(): Promise<AppState>;
  checkConnections(): Promise<AppState>;
  beginRecording(): Promise<RecordingSession>;
  transcribe(request: {
    requestId: string;
    audio: ArrayBuffer;
    durationMs: number;
  }): Promise<Transcript | null>;
  cancel(requestId?: string): Promise<void>;
  copyTranscript(id: string, source: "original" | "edited" | "suggestion"): Promise<void>;
  rewriteTranscript(id: string): Promise<Transcript>;
  undoTranscript(id: string): Promise<Transcript>;
  acceptSuggestion(id: string): Promise<Transcript>;
  deleteTranscript(id: string): Promise<AppState>;
  hideWindow(): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
  onCommand(callback: (command: "toggle" | "cancel") => void): () => void;
}
declare global {
  interface Window {
    localWhispr: LocalWhisprAPI;
  }
}
