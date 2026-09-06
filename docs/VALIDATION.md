# Local build validation — 2026-09-05

Test hardware: M5 MacBook Air with 24 GB memory; M3 Ultra Mac Studio with 96 GB
for the remote profile. Model weights are installed in
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

## Studio cleanup follow-up (before personal vocabulary)

The original cleanup prompt often made only punctuation-level changes and kept
abandoned starts or explicit corrections. The revised Studio prompt gives
concrete examples of resolving those into the speaker's intended written message.
It preserves substantive uncertainty and exact technical or quoted text.

A small fixed vocabulary and narrow pronunciation hint were tested for app-name
correction. Already-correct names, separate sentences, quotations and literal
uses of the same words took priority over the hint.

Text-only probes ran through the actual `StudioClient.edit` path and Studio E4B,
with the production temperature, reasoning setting and output limit. The final
candidate was checked on 24 nonempty content cases, plus empty and filler-only
inputs. Checks covered false starts, explicit day/quantity/reviewer corrections,
conditions, uncertainty, distinct product names, technical tokens and quotations.
An earlier candidate changed an unrelated Superwhisper mention; it was rejected,
and both that case and a new sentence-boundary control were checked again.

These are curated, iteratively reused prompt-development probes, not a held-out
accuracy benchmark or a new audio/ASR evaluation. The pronunciation hint is a
specific vocabulary fix, not evidence that arbitrary misheard names can be
recovered. The final observed content outputs retained facts and resolved the
reported example; tone can still be smoothed (for example, repeated emphasis).
Empty input returns empty. A filler-only completion was empty, so the existing
runtime treated correction as unavailable and preserved the original. This
fallback behavior has not been changed. Raw transcripts remain available.

That update changed Studio cleanup only. The Air fallback still uses its tested
S1-mini normalizer and existing prompt. No models or services were replaced.

## Personal vocabulary and reviewable edits

The editable dictionary replaces the fixed names and pronunciation exception
described above. The initial eight spellings have no mandatory aliases; users
explicitly save recurring mishearings. No broad word replacement is built in.

Read-only inspection confirmed the running Studio API supports multipart `vocab`
and the installed Air mlx-audio Qwen supports native `hotwords`. Public audiobook
clips succeeded with relevant and unrelated hints on both machines without
observed contamination. Identical transcripts establish compatibility, not an
accuracy improvement. No shared service, model or machine configuration changed.

Real Studio probes cover grammar, vocabulary, distinct app names, list/paragraph
guidance, numeric self-corrections, decimals, negative amounts, code, uncertainty
and quotes. A changed quote was retained for review instead of being applied.
The real Air worker preserved proper names and produced a list using S1's
documented controls. These are development probes, not a held-out personal-speech
evaluation. No personal recordings were collected.

Regression cases cover dictionary limits/collisions, Unicode and quote boundaries,
canonical-name protection, signed amounts, decimal rendering, numeric correction,
negation loss, both route integrations, immutable settings snapshots, additive
history metadata, explicit suggestion copying and no second automatic paste.
Checks remain heuristic: ambiguous spoken years may be flagged, while changed
unknown names, units or reordered facts can escape. Original ASR remains available.

Final follow-up validation: 85 Node tests and 10 Python tests passed, alongside
ESLint, TypeScript, Prettier, Ruff, renderer/native builds and ARM64 packaging.
Independent judge and peer found a path-boundary issue; complete relative paths,
including trailing-slash directories, now preserve casing and trigger review if
the model changes them. Both reviewers checked the fixes without further findings.

Browser preview checks exercised add/edit/limit validation, remembering an alias
without changing history, layout selection and explicit suggestion review. The
installed app's Settings and latest-result controls were visually verified; its
archive, worker, prompt and native addon matched the build. Existing preferences
were byte-for-byte unchanged. No new physical microphone/paste trial was conducted
for this feature; the native paste path is unchanged from the verified earlier fix.

## Editing modes, app preferences and recovery

The current regression suite has 110 Node tests and 14 Python tests. Added cases
cover settings compatibility, target-app snapshots, retries from immutable ASR,
one-level undo across restart, explicit candidate acceptance, accurate current
cleanup status, failed saves, cancellation and no repeated delivery. Diff tests
reconstruct both inputs for 2,000 randomized cases and exercise 100k-character
inputs with bounded comparison work.

A simulated target reads the clipboard 300 ms after dispatch and receives the
dictation. The old 180 ms restoration race is removed; later user copies are
never overwritten by a delayed restoration. This test does not prove that every
destination application accepts synthetic paste events.

Synthetic text-only requests ran through the real Studio and Air clients with
the pinned models. Both corrected tested grammar and retained tested amounts,
exclusions and uncertainty. The resolved name-search example now passes the
production guard and becomes “Is Quartz working?” on Studio. Air kept some
abandoned wording, so the UI explicitly describes its limited restructuring.
Clean/Polished intentionally share S1's trained controls. Studio retry and normal
dictation now use the same mode-aware cleanup prompt; email layout was checked
with a separate greeting/body/sign-off example. Warm short-text edits measured
roughly 0.18–0.46 seconds, excluding ASR; cold starts were slower. These are small,
iteratively reused development checks, not a held-out accuracy benchmark.

Browser preview checks exercised highlighted suggestions, acceptance, Undo,
Retry, separate processing details and an app-specific Exact preference. The
preview makes these changes only to synthetic in-memory records. Native app
launch/packaging checks remain separate from these preview interactions.

Independent review found two integration issues: large Unicode settings could
exceed the old reader limit, and initial-cleanup Undo could lose its History-only
notice. The fix shares a 128 KiB settings read/write limit with a pre-write check,
adds a maximum-size Unicode round-trip regression, and tracks History actions
separately from editor provenance. Preview Undo now visibly retains the copy-to-use
notice while showing original wording.
