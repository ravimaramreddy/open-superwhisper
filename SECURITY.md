# Security policy

This policy covers [OpenSuperwhisper](https://github.com/ravimaramreddy/open-superwhisper),
a personal Apple silicon macOS fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr).
It applies to the active application in `desktop/`, `local-ui/` and `local-runtime/`.
Retained upstream files describe a different application; see
[the local architecture](docs/LOCAL_ARCHITECTURE.md).

## Reporting a vulnerability

Do not publish sensitive details in a pull request or other public discussion.
GitHub private vulnerability reporting is disabled, and this fork has no
documented private disclosure channel. Request a private contact route from the
[maintainer](https://github.com/ravimaramreddy) before sharing sensitive details.
Do not send fork-specific reports to upstream's security address.

Repository issues are disabled. Routine, non-sensitive fixes can be submitted
as [pull requests to this fork](https://github.com/ravimaramreddy/open-superwhisper/pulls).
There is no guaranteed response time or supported-release schedule.

## Security and privacy boundaries

- **Processing:** this Mac uses pinned Qwen3-ASR and S1-mini models through MLX.
  Studio mode sends audio and editing text to the configured Mac Studio through
  app-owned, loopback-only SSH forwards. Automatic mode tries Studio first.
  Existing SSH authentication and Studio services are managed outside the app.
- **Network access:** inference uses your Macs, with no cloud account, API-key
  vault or upstream account services in the active app. Preparing this Mac
  downloads public runtime packages and pinned, hash-verified model files.
- **Local data:** settings, vocabulary, history, runtime files, temporary audio
  and optional saved recordings live in `~/Library/Application Support/OpenSuperwhisper`. Saved text is
  local JSON, without application-level encryption. History retains the latest
  100 transcripts; disabling history does not delete existing entries.
- **Optional audio retention:** Keep audio for testing is off by default and
  requires History. It saves local WAV/JSON pairs with initial transcript,
  settings and timing details, using private file permissions rather than
  application-level encryption. Turning it off stops future saves; automatic
  History rollover retains older archive files. Saving stops at 1 GiB or 2,000
  clips without evicting older files. Explicit History deletion and cancellation
  remove the associated pair; removal failures are reported and can leave files
  for manual cleanup through Open saved recordings.
- **Audio and delivery:** microphone access records up to two minutes. Temporary
  audio is removed after processing or cancellation, with abandoned app-owned
  recordings cleaned on launch; removal failures can leave files behind.
  Delivery uses the system clipboard and macOS Accessibility permission. Text
  may remain on the clipboard, including when automatic pasting cannot finish.
- **Application boundary:** the Electron renderer uses context isolation,
  sandboxing, disabled Node integration and a narrow preload bridge. The native
  paste addon runs in the main process. The personal build is unsigned.

Relevant reports include unsafe IPC, renderer code execution, unintended file
access or data disclosure, SSH/runtime setup flaws, and native paste or dependency
vulnerabilities. Transcription and cleanup can still change meaning; the review
checks are best-effort safeguards, not an accuracy guarantee.
