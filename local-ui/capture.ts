import type { LocalWhisprAPI, RecordingSession, Transcript } from "../desktop/contracts";
import recordingLimits from "../local-runtime/recording-limits.json";

export type CapturePhase = "idle" | "opening" | "recording" | "stopping" | "processing";
export interface CaptureView {
  phase: CapturePhase;
  level: number;
  elapsedMs: number;
}
export interface RecordedAudio {
  audio: ArrayBuffer;
  durationMs: number;
}
export interface Recorder {
  stop(): Promise<RecordedAudio>;
  cancel(): void;
}
export interface RecorderOptions {
  microphoneId: string;
  signal: AbortSignal;
  onLevel(level: number, elapsedMs: number): void;
  onEnded(): void;
  onLimit(): void;
}
export const MAX_RECORDING_SECONDS = recordingLimits.maxRecordingSeconds;

/** One owner per renderer. Every asynchronous continuation belongs to a generation. */
export class CaptureController {
  private generation = 0;
  private session: RecordingSession | null = null;
  private recorder: Recorder | null = null;
  private abort: AbortController | null = null;
  private view: CaptureView = { phase: "idle", level: 0, elapsedMs: 0 };
  constructor(
    private api: Pick<LocalWhisprAPI, "beginRecording" | "transcribe" | "cancel">,
    private options: {
      createRecorder?: (options: RecorderOptions) => Promise<Recorder>;
      onChange?: (view: CaptureView) => void;
      onError?: (key: string, error?: unknown) => void;
      onComplete?: (transcript: Transcript | null) => void;
    } = {}
  ) {}
  get phase() {
    return this.view.phase;
  }
  private update(patch: Partial<CaptureView>) {
    this.view = { ...this.view, ...patch };
    this.options.onChange?.(this.view);
  }
  async toggle() {
    if (this.phase === "idle") return this.start();
    if (this.phase === "recording") return this.stop();
    if (this.phase === "opening") return this.cancel();
  }
  async start() {
    if (this.phase !== "idle") return;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.update({ phase: "opening", level: 0, elapsedMs: 0 });
    try {
      // Main captures the target application and immutable settings before mic access.
      const session = await this.api.beginRecording();
      if (generation !== this.generation) {
        await this.api.cancel(session.requestId).catch(() => {});
        return;
      }
      this.session = session;
      const recorder = await (this.options.createRecorder ?? createBrowserRecorder)({
        microphoneId: session.settings.microphoneId,
        signal: abort.signal,
        onLevel: (level, elapsedMs) => {
          if (generation === this.generation) this.update({ level, elapsedMs });
        },
        onEnded: () => {
          if (generation !== this.generation) return;
          void this.cancel();
          this.options.onError?.("capture.disconnected");
        },
        onLimit: () => {
          if (generation === this.generation) void this.stop();
        },
      });
      if (generation !== this.generation) {
        recorder.cancel();
        return;
      }
      this.recorder = recorder;
      this.update({ phase: "recording" });
    } catch (error) {
      if (generation !== this.generation) return;
      await this.cancel();
      this.options.onError?.("capture.openFailed", error);
    }
  }
  async stop() {
    if (this.phase !== "recording" || !this.recorder || !this.session) return;
    const generation = this.generation;
    const session = this.session;
    const recorder = this.recorder;
    this.update({ phase: "stopping", level: 0 });
    try {
      const result = await recorder.stop();
      if (generation !== this.generation) return;
      this.recorder = null;
      this.update({ phase: "processing", elapsedMs: result.durationMs });
      const transcript = await this.api.transcribe({ requestId: session.requestId, ...result });
      if (generation !== this.generation) return;
      this.session = null;
      this.abort = null;
      this.update({ phase: "idle", level: 0 });
      this.options.onComplete?.(transcript);
    } catch (error) {
      if (generation !== this.generation) return;
      await this.cancel();
      this.options.onError?.("capture.failed", error);
    }
  }
  async cancel() {
    ++this.generation;
    const requestId = this.session?.requestId;
    const wasActive = this.phase !== "idle";
    this.abort?.abort();
    this.recorder?.cancel();
    this.recorder = null;
    this.session = null;
    this.abort = null;
    this.update({ phase: "idle", level: 0, elapsedMs: 0 });
    if (wasActive) await this.api.cancel(requestId).catch(() => {});
  }
  dispose() {
    return this.cancel();
  }
}

/** Already-resampled mono samples; PCM16 WAV is the only renderer transport. */
export function encodePCM16(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const word = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  word(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  word(8, "WAVE");
  word(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  word(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

export async function createBrowserRecorder(options: RecorderOptions): Promise<Recorder> {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let samples = 0;
  const chunks: Float32Array[] = [];
  let flushed: (() => void) | null = null;
  const check = () => {
    if (options.signal.aborted || closed) throw new DOMException("Cancelled", "AbortError");
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", dispose);
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    source?.disconnect();
    node?.disconnect();
    gain?.disconnect();
    if (node) {
      node.port.onmessage = null;
      node.port.close();
    }
    if (context && context.state !== "closed") void context.close().catch(() => {});
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  try {
    check();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(options.microphoneId && options.microphoneId !== "default"
          ? { deviceId: { exact: options.microphoneId } }
          : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // Acquisition may resolve after cancellation; those late tracks still need closing.
    if (closed || options.signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      check();
    }
    context = new AudioContext();
    await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
    check();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "dictation-pcm", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    gain = context.createGain();
    gain.gain.value = 0;
    source.connect(node);
    node.connect(gain);
    gain.connect(context.destination);
    node.port.onmessage = (event) => {
      if (event.data.type === "flushed") {
        flushed?.();
        return;
      }
      if (closed || !(event.data.samples instanceof Float32Array)) return;
      const remaining = Math.max(0, context!.sampleRate * MAX_RECORDING_SECONDS - samples);
      const chunk = event.data.samples.subarray(0, remaining);
      if (!chunk.length) return;
      chunks.push(chunk);
      samples += chunk.length;
      let energy = 0;
      for (const value of chunk) energy += value * value;
      options.onLevel(
        Math.min(1, Math.sqrt(energy / chunk.length) * 6),
        (samples / context!.sampleRate) * 1000
      );
    };
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => options.onEnded();
    });
    await context.resume();
    check();
    if (stream.getAudioTracks().some((track) => track.readyState === "ended"))
      throw new Error("Microphone disconnected");
    timer = setTimeout(options.onLimit, MAX_RECORDING_SECONDS * 1000);
    let stopPromise: Promise<RecordedAudio> | null = null;
    return {
      cancel: () => {
        dispose();
        chunks.length = 0;
      },
      stop: () => {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          check();
          clearTimeout(timer);
          try {
            await new Promise<void>((resolve, reject) => {
              const flushTimer = setTimeout(
                () => reject(new Error("Microphone did not finish recording")),
                1500
              );
              flushed = () => {
                clearTimeout(flushTimer);
                resolve();
              };
              node!.port.postMessage({ type: "flush" });
            });
            check();
            const sampleRate = context!.sampleRate;
            const durationMs = (samples / sampleRate) * 1000;
            const joined = new Float32Array(samples);
            let offset = 0;
            for (const chunk of chunks) {
              joined.set(chunk, offset);
              offset += chunk.length;
            }
            dispose();
            chunks.length = 0;
            if (samples === 0) throw new Error("No microphone audio was captured");
            // Browser resampler applies its anti-aliasing filter, unlike point decimation.
            const offline = new OfflineAudioContext(
              1,
              Math.max(1, Math.round((samples * 16000) / sampleRate)),
              16000
            );
            const input = offline.createBuffer(1, samples, sampleRate);
            input.copyToChannel(joined, 0);
            const playback = offline.createBufferSource();
            playback.buffer = input;
            playback.connect(offline.destination);
            playback.start();
            const rendered = await offline.startRendering();
            if (options.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            return { audio: encodePCM16(rendered.getChannelData(0)), durationMs };
          } finally {
            dispose();
            chunks.length = 0;
          }
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
