# Active local dictation build

The fork keeps Electron, React and the macOS keyboard foundation while replacing
the active startup graph. It does not start the upstream account, subscription,
provider catalog, sync, calendar, meeting, chat, search or embedding services.

| Directory                        | Responsibility                                                |
| -------------------------------- | ------------------------------------------------------------- |
| `desktop/main.js` / `preload.js` | Window, tray, shortcut, permissions and narrow IPC bridge     |
| `desktop/controller.js`          | Recording ownership, cancellation, save-before-delivery       |
| `desktop/history.js`             | Atomic, bounded history; immutable original; delivery claims  |
| `desktop/vocabulary.js`          | Bounded dictionary validation and protected phrase matching   |
| `desktop/edit-review.js`         | Best-effort checks; retained text plus reviewable suggestions |
| `desktop/editing-settings.js`    | Bounded app rules and editing choices                         |
| `desktop/native.js`              | Frontmost-app check, clipboard and single paste attempt       |
| `resources/macos-local-paste.mm` | Native target validation and keyboard dispatch                |
| `desktop/inference.js`           | Fixed profiles, fallback, setup and lifetime                  |
| `desktop/studio-client.js`       | App-owned SSH forwards and E4B instance                       |
| `desktop/air-worker-client.js`   | One local worker, cancellation and idle release               |
| `local-runtime/worker.py`        | Serial MLX speech and cleanup over line-delimited JSON        |
| `local-runtime/models.lock.json` | Exact model revisions, file hashes and runtime versions       |
| `scripts/setup-local-runtime.py` | Persistent uv environment and verified model installation     |
| `local-ui/`                      | Dictate, History, Settings and bounded AudioWorklet capture   |

## Recording lifecycle

The main process creates a recording identifier, snapshots settings and captures
the target app before audio capture begins. Capture requests are fenced so a late
microphone permission result cannot restart a cancelled recording. Audio is mono
16 kHz PCM16 WAV, limited to two minutes, validated again in the main process.
Flat silence is rejected; this is not a general background-noise classifier.

Only one inference request owns the recording. Automatic mode first tries Studio
ASR, falls back to local ASR when unavailable, then applies the matching optional
editor. Correction failure retains raw text. Cancellation invalidates the owner
and aborts the local worker/request so late completions cannot initiate delivery.

Settings snapshots include a deep copy of vocabulary, editing mode, style and format.
App rules (at most 32) match the captured bundle identifier; only the app name and
identifier are retained, never its screen or document contents. Rules override
the global editing mode/style/format. Legacy cleanup=false maps to Exact and
cleanup=true to Polished; explicit editingMode takes precedence. The legacy
boolean stays synchronized for compatibility. The reader and writer share a
128 KiB settings limit, checked before applying operating-system preferences.
Older settings receive defaults without replacing saved microphone, shortcut,
login, profile or history preferences. Vocabulary uses the existing serialized,
atomic settings update path and remains private app data.

Studio receives canonical vocabulary as multipart `vocab`; the pinned Air Qwen
runtime receives native `hotwords`. Aliases are not recognition hints. Both
profiles pass successful edits through the same main-process review checks.
Review compares against a spelling-normalized baseline but preserves the actual
raw ASR when it flags an automatic edit. Optional `candidateText`/`reviewReasons`
are stored alongside the retained text in version-1 history. A deliberate rewrite
keeps the previous edited text when flagged; raw ASR is always immutable. Only an
explicit Copy suggestion action copies the candidate, never a second paste.
Use suggestion accepts it in History; Undo restores one previous text version.
The optional previousVersion is nonrecursive and validated, and old records load
without it. Updates preserve identity, ASR text, speech timings and original route.
Every write is bounded by the same 24 MB limit used when reading history; a failed
save leaves the existing file intact. History-disabled results and edits stay in
memory. Word diffs use bounded tokenization and capped work with a plain removed/
added fallback for very large edits, never HTML from model output.

Retry uses immutable rawText with current global settings and the matching app
rule, rather than repeatedly rewriting prior output. Exact bypasses inference.
Text-only retries use Studio/Air routing, with Auto falling back only on a Studio
connection-unavailable result. Air has a dedicated text-only worker method; it
does not rerun ASR. Retry/acceptance provenance and timings are separate from the
original speech run. A separate historyEdited marker survives Undo, including
restoration of raw text with no editor provenance. A flagged retry retains the current text. No History action
claims another automatic delivery.

History is saved before delivery and claims each automatic delivery once. The
native addon checks the focused process immediately before dispatching ⌘V. It
does not refocus another application or retry uncertain delivery. Keyboard
injection confirms dispatch, not acceptance by arbitrary target applications.
The clipboard retains the transcript after dispatch. There is no timed restoration:
a slow target may not consume a posted paste until after an arbitrary delay, and
a later user copy must never be overwritten by a restoration timer.

## Persistent installation

All runtime state is under `~/Library/Application Support/OpenSuperwhisper`:

- `settings.json`, `history.json`: user preferences and transcripts.
- `machine.json`: optional private SSH/runtime setup overrides; never committed.
- `runtime/.venv`, `runtime/python`, `runtime/ready.json`: app-owned Python runtime.
- `models/<name>-<revision>`: verified model files and publisher notices.
- `recordings/`: temporary audio during processing.

The setup script accepts `--seed-qwen` and `--seed-s1` to reuse existing files
only after their hashes match the pinned manifest. Missing files are downloaded
from the exact checkpoint revision. No model inference runs during installation.
Changing the lock invalidates readiness and requires setup again.

Studio speech and LM Studio remain independently managed. Only the app's tunnel
and unique editing instance are app-owned. The Studio CLI is resolved from
`$HOME/.lmstudio/bin/lms` on the remote host, using the authenticated SSH user's
home directory. Remote cancellation stops accepting results; an existing remote
service may finish computation after its client disconnects.

## Packaging boundaries

`package.json` selects `desktop/main.js`. `vite.local.config.mjs` bundles only
`local-ui/`. `electron-builder.local.json` explicitly includes desktop code, the
renderer, the Python worker/setup, native paste addon and notices. It excludes
upstream source and dependencies from the shipped application.

The five direct runtime dependencies are React, React DOM, Lucide, i18next and
react-i18next. They are bundled in the renderer; the desktop process uses Electron
and Node built-ins. There is no app updater or generic model/binary download hook.
Model installation is a separate, explicit local setup operation.

Retained upstream development files, including `CLAUDE.md`'s legacy material,
`src/`, old scripts and `docs/UPSTREAM_PACKAGE.json`, describe the original app.
They are not instructions to restore removed startup services or dependencies.
New work belongs in the active directories above.

The native addon runs inside Electron’s main process, so the permission indicator
and keyboard dispatch use the same macOS identity. It checks both Accessibility
and event-posting access without prompting. The packaged module lives in
`Contents/Frameworks/macos-local-paste.node`. Building uses Node-API v8 and pinned
Node 24.18.0 headers, downloaded and SHA-256 checked by the lockfile-installed
node-gyp. No extra runtime dependency is required.

## Validation

`npm test` covers capture races, routing, cancellation, worker protocol,
history persistence and delivery outcomes without loading GPUs or pasting into
user applications. `npm run quality-check` runs ESLint, TypeScript and formatting.
CI also builds the renderer and compiles the Objective-C++ Node-API addon on macOS.

Real inference, an installed-app launch, microphone permission and delivery into
a controlled text field are separate integration checks; mock tests do not
establish microphone or Accessibility permission on a user's Mac.
