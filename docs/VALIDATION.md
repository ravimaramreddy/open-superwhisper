# Local build validation — 2026-09-05

The installed build was checked on an M5 MacBook Air with 24 GB memory, using an
M3 Ultra Studio with 96 GB for the remote profile. Model weights are installed in
the app's persistent data directory; no temporary benchmark directory is required
at runtime. SHA-256 verification succeeded for all locked model and notice files.

## Actual inference

The app's `createInference` implementation processed one public LibriSpeech clip
(`test-clean`, `6930-76324-0003`, 3.385 seconds). These are integration observations,
not a representative speed or accuracy benchmark.

| Path                                  | First request | Warm request | Outcome                            |
| ------------------------------------- | ------------: | -----------: | ---------------------------------- |
| Studio Qwen + E4B                     |        3.51 s |       0.50 s | Original + corrected text returned |
| Air Qwen + S1-mini                    |        6.45 s |       0.85 s | Original + corrected text returned |
| Automatic with unavailable SSH target |        3.20 s |            — | Fell back to Air; reason recorded  |

Cleanup off returned raw text without calling correction. Explicit Studio rewrite
returned edited text. App-owned workers and editor instances were shut down after
testing. Three subsequent independent Studio connection checks succeeded in
0.18–0.38 seconds. An earlier first connection check returned unavailable before
subsequent requests succeeded; the UI exposes refresh and actual successful
transcriptions now update connection state.

Audio source: [LibriSpeech / OpenSLR 12](https://www.openslr.org/12), CC BY 4.0.
The audio and generated transcripts are not included in the app or repository.

## Application and package

The ARM64 package compiled and launched from `~/Applications/OpenSuperwhisper.app`.
Its actual Dictate and Settings screens were visually inspected. The running app
reported Studio connected and local fallback ready. The UI has Dictate, History,
and Settings only; production contains no preview sample-data module.

The app is approximately 265 MB on disk, principally Electron. The active renderer
is approximately 271 kB JavaScript and 13 kB CSS before compression. ASAR inspection
found only the desktop code, renderer, Python runtime/setup, licenses and notices;
no provider SDKs, meeting services, account flows, search database or embedding
models were packaged. Models are separate from the application bundle.

The owner granted Microphone and Accessibility and completed real dictations.
Their initial auto-paste attempts exposed a packaged-helper identity mismatch:
the main app was authorized, but macOS attributed the child helper to a separate
executable-path identity and denied it.

The replacement Objective-C++ Node-API addon checks permission and posts the key
pair inside the main app process. Both native permission checks succeeded under
the existing grant. The installed replacement was then tested against a blank
TextEdit document: it inserted a fixed test sentence exactly once automatically,
and the document's accessibility value confirmed the text. No manual paste was
used. This verifies real OS insertion into TextEdit, not acceptance by every app.

## Automated checks

- 71 Node tests: microphone-opening races, cancellation, PCM/WAV capture, fixed
  routing, fallback, immutable history, durable delivery claims, clipboard format
  restoration, queued delivery cancellation, Python child protocol, Studio load cancellation,
  shortcut normalization, deletion, crash cleanup, setup shutdown races and
  termination of an owned installer process group and ordered application shutdown.
  Native tests cover malformed targets, impossible-target probes and worker-thread rejection.
- 7 Python tests: protocol, WAV ownership/format validation, correction failure,
  and verified model setup behavior. These tests do not import MLX.
- ESLint, TypeScript, Prettier and Ruff passed.
- Objective-C++ Node-API compilation and production renderer build passed.

Review found and corrected cold Studio cancellation, delivery cancellation, atomic
clipboard restoration and initial Studio status. Further committed review and CI
results are attached to the pull request.

Reproduce deterministic checks with:

```sh
npm run quality-check
npm run lint:python
npm run compile:native
npm test
npm run test:python
npm run build:renderer
```

The final installed app was also checked for idle Quit: its window and process
both exited. Shutdown cancels the renderer, closes owned inference, and drains
pending transcript/rewrite cleanup before terminating. Active-work shutdown is
covered by controlled tests; quitting during a live microphone recording remains
a separate manual check.
