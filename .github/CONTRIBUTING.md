# Contributing to OpenSuperwhisper

This is a personal Apple silicon macOS dictation fork of
[OpenWhispr](https://github.com/OpenWhispr/openwhispr). Contributions target
[`ravimaramreddy/open-superwhisper`](https://github.com/ravimaramreddy/open-superwhisper),
not the upstream project. Start with the [README](../README.md) and
[local architecture](../docs/LOCAL_ARCHITECTURE.md).

## Scope and workflow

The active application lives in `desktop/`, `local-ui/` and `local-runtime/`.
It uses fixed local models and existing Studio services over app-owned SSH
forwards. Upstream `src/` and legacy tooling remain as reference and are excluded
from the active application and package. Keep changes within that architecture.

1. Fork this repository and create a focused branch from `main`.
2. Make the change in the active code or its documentation. Preserve upstream
   attribution, the [MIT license](../LICENSE) and
   [third-party/model notices](../THIRD_PARTY_NOTICES.md).
3. Run the relevant checks below and describe the behavior changed, reproduction
   steps and validation in your pull request.
4. Open the pull request against
   [`ravimaramreddy/open-superwhisper:main`](https://github.com/ravimaramreddy/open-superwhisper/pulls).

Repository issues are disabled. Submit routine, non-sensitive fixes through pull
requests. For sensitive vulnerabilities, follow [SECURITY.md](../SECURITY.md)
before sharing details publicly. Remove private transcripts, audio, host details
and credentials from examples or logs; never commit `machine.json` or app data.

## Local setup

Use an Apple silicon Mac with Node 24+, Xcode command-line tools and
[uv](https://docs.astral.sh/uv/getting-started/installation/) for local inference.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run dev
```

Prepare the local models and configure Studio as described in the
[README](../README.md). Studio integration requires working noninteractive SSH
and the expected services; running the app does not install them.

## Validation and packaging

```sh
npm run quality-check
npm run lint:python
npm test
npm run test:python
npm run pack       # release/mac-arm64/OpenSuperwhisper.app
npm run build:mac  # also produce a DMG
```

Run checks relevant to the changed files; verify packaging when changing the
build or shipped files. Automated tests do not establish real model inference,
microphone permission or paste behavior. Check those separately on an installed
app when affected, using a controlled text field and non-sensitive sample audio.

For UI-only work, `npm run dev:ui` starts the renderer. Append `?preview=1` for
labeled sample data; preview does not record and is excluded from production.
