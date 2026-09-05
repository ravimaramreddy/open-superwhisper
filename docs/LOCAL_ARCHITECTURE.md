# Active local dictation build

The fork keeps Electron, React and the macOS keyboard foundation while replacing
the active startup graph. It does not start the upstream account, subscription,
provider catalog, sync, calendar, meeting, chat, search or embedding services.

| Directory                           | Responsibility                                               |
| ----------------------------------- | ------------------------------------------------------------ |
| `desktop/main.js` / `preload.js`    | Window, tray, shortcut, permissions and narrow IPC bridge    |
| `desktop/controller.js`             | Recording ownership, cancellation, save-before-delivery      |
| `desktop/history.js`                | Atomic, bounded history; immutable original; delivery claims |
| `desktop/native.js`                 | Frontmost-app check, clipboard and single paste attempt      |
| `resources/macos-local-paste.swift` | Native target validation and keyboard dispatch               |
| `desktop/inference.js`              | Fixed profiles, fallback, setup and lifetime                 |
| `desktop/studio-client.js`          | App-owned SSH forwards and E4B instance                      |
| `desktop/air-worker-client.js`      | One local worker, cancellation and idle release              |
| `local-runtime/worker.py`           | Serial MLX speech and cleanup over line-delimited JSON       |
| `local-runtime/models.lock.json`    | Exact model revisions, file hashes and runtime versions      |
| `scripts/setup-local-runtime.py`    | Persistent uv environment and verified model installation    |
| `local-ui/`                         | Dictate, History, Settings and bounded AudioWorklet capture  |

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

History is saved before delivery and claims each automatic delivery once. The
native helper checks the focused process immediately before dispatching ⌘V. It
does not refocus another application or retry uncertain delivery. Keyboard
injection confirms dispatch, not acceptance by arbitrary target applications.

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
and unique editing instance are app-owned. The Studio CLI path reflects this
personal installation; changing hosts may require adapting that path as well as
configuring SSH. Remote cancellation stops accepting results; an existing remote
service may finish computation after its client disconnects.

## Packaging boundaries

`package.json` selects `desktop/main.js`. `vite.local.config.mjs` bundles only
`local-ui/`. `electron-builder.local.json` explicitly includes desktop code, the
renderer, the Python worker/setup, native paste helper and notices. It excludes
upstream source and dependencies from the shipped application.

The five direct runtime dependencies are React, React DOM, Lucide, i18next and
react-i18next. They are bundled in the renderer; the desktop process uses Electron
and Node built-ins. There is no app updater or generic model/binary download hook.
Model installation is a separate, explicit local setup operation.

Retained upstream development files, including `CLAUDE.md`'s legacy material,
`src/`, old scripts and `docs/UPSTREAM_PACKAGE.json`, describe the original app.
They are not instructions to restore removed startup services or dependencies.
New work belongs in the active directories above.

## Validation

`npm test` covers capture races, routing, cancellation, worker protocol,
history persistence and delivery outcomes without loading GPUs or pasting into
user applications. `npm run quality-check` runs ESLint, TypeScript and formatting.
CI also builds the renderer and compiles the Swift helper on macOS.

Real inference, an installed-app launch, microphone permission and delivery into
a controlled text field are separate integration checks; mock tests do not
establish microphone or Accessibility permission on a user's Mac.
