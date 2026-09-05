export type Profile = "auto" | "studio" | "air";
export interface VocabularyEntry {
  word: string;
  aliases: string[];
}
export interface Settings {
  profile: Profile;
  cleanup: boolean;
  format: "prose" | "paragraphs" | "list";
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
export interface Transcript {
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
