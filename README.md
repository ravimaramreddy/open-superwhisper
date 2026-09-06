# OpenSuperwhisper

Private dictation for macOS, with English cleanup, custom vocabulary and automatic
paste. Built on [OpenWhispr](https://github.com/OpenWhispr/openwhispr).
Press **⌃⌥Space**, speak, then press it again to place the text in your focused app.
Press **Escape** to cancel. Recordings stop after two minutes.

| Mode      | Speech recognition                                         | Optional text cleanup         |
| --------- | ---------------------------------------------------------- | ----------------------------- |
| Automatic | Mac Studio first; this Mac if Studio speech is unavailable | Uses the matching machine     |
| Studio    | Qwen3-ASR 1.7B, 8-bit                                      | Gemma 4 E4B through LM Studio |
| This Mac  | Qwen3-ASR 1.7B, 8-bit through MLX                          | S1-mini by Superwhisper, BF16 |

Automatic mode falls back when Studio speech is unavailable. A correction failure
keeps the original transcript and shows a warning. Choosing Studio explicitly does
not silently switch machines. **Retry from original** uses the current processing
choice and editing settings, without recording or pasting again. Automatic retries
can use this Mac when Studio's editor connection is unavailable; a failed or
invalid edit preserves the previous version.

## Your words and English cleanup

**Settings → Personal vocabulary** saves up to 32 preferred spellings, each with
up to four optional misheard phrases. **Remember a correction** in a transcript
adds a spelling/alias for future dictation without changing the saved transcript.
Keep the list short and relevant. Every built-in name can be edited or removed.

Preferred spellings are sent to Qwen during recognition. Aliases are exact,
case-insensitive whole phrases, not fuzzy guesses. Quote/code spans, URLs, paths
and existing canonical names are protected. A saved alias is an explicit rule:
avoid common words that can legitimately mean something else. Studio also sees
the dictionary when editing. The Air's S1 uses its trained prompt; exact spelling
corrections are applied afterward. **Copy original** retains the untouched ASR
output. **Exact** leaves that output as the delivered text.

Choose **Exact**, **Clean English** (grammar, punctuation and fillers) or
**Polished** (clearer wording and organization). Existing cleanup-enabled settings
become Polished. On Air, Clean and Polished use the same compact S1 editor;
Studio provides the stronger restructuring. S1 does not support a separate
editing-strength instruction.

Choose a neutral, chat or email style, with prose, paragraphs or a list. Paragraph
guidance applies to Studio; Air uses S1's trained prose/list and general/email
controls. **Settings → App preferences** can save separate choices for apps used in
dictation. Record into an app once to make it available, then add its rule. Rules
use the app identity captured at recording start, without reading screen content.
An app rule overrides the global editing choices, including during a retry.

Both paths check selected changes to numbers, negatives/exclusions, dictionary
names and quoted/technical text. A flagged edit keeps the previous text and
stores a suggested edit with reasons. Review highlighted additions and removals,
then explicitly **Use suggestion** or copy it if wanted. **Undo edit** restores
one previous version in History, including an initial cleanup. Retrying always
starts from the original speech text. These actions never change text already
inserted into another app; copy the version you want to use. These are conservative
checks, not a guarantee: they can flag legitimate edits and miss changed meaning,
including unknown names or reordered facts. S1 cleanup is English-only.

## First use

This build targets Apple silicon Macs. Local setup requires
[uv](https://docs.astral.sh/uv/getting-started/installation/), internet access for
the first installation, and roughly 4 GB for the two model weight files, plus
Python packages and installation cache. Keep enough memory free for both models:
a measured M5 Air run peaked around 4.8 GB of MLX allocations. That is not the
whole application's memory use.

1. Open **OpenSuperwhisper.app**.
2. Enable **Microphone** and **Paste into your apps**. macOS manages these
   permissions; Accessibility may require enabling the app in System Settings.
3. Select **Prepare this Mac** to install the pinned runtime and verified model
   files. The models load only when local dictation is used and exit after two
   minutes without use.
4. Use **Check connections** to check Studio. Place your cursor in a text field
   and use the shortcut. Starting from the app's own window copies the result
   for you to paste.

The build is unsigned and intended for personal installation. No account,
subscription, API key, or model catalog is involved.

## Studio connection

Studio uses existing services over a private SSH connection. The app opens
loopback-only forwards to the remote speech service on port 8766 and LM Studio
on port 1234. It does not deploy or reconfigure those services.

The default SSH target is `mac-studio`; noninteractive SSH authentication must
already work. A private override can be placed in
`~/Library/Application Support/OpenSuperwhisper/machine.json`:

```json
{ "studioSshTarget": "your-user@your-studio" }
```

Keep this file out of version control. The speech service must provide
`GET /health` with `status: "healthy"` and `POST /transcribe` accepting a WAV
multipart `file`, optional `vocab` (comma-separated preferred spellings), and
returning `text`. This personal build expects the existing
LM Studio installation and `google/gemma-4-e4b` model on Studio. The app loads an
instance with its own unique identifier, disables reasoning for editing, gives
it a five-minute idle lifetime, and unloads only its own instance when closing.

## Originals and privacy

- History keeps up to 100 original and edited transcripts locally, including
  one previous edit and the destination app's name/identifier. A 24 MB file limit
  also applies; if full, copy the latest result and remove older entries. The
  original stays unchanged when you edit. Turn history off to avoid saving
  new transcripts; existing history remains until you delete it.
- Temporary audio is removed when processing completes or is cancelled.
  App-owned recordings left by a crash are removed on the next launch.
  Raw text is saved before automatic delivery when history is enabled.
- Dictated text stays on the clipboard after paste is sent, so a busy app can
  consume it later. The previous clipboard is not restored on a timer. "Initial
  paste sent" confirms keyboard dispatch, not insertion in the destination.
  An uncertain paste is never automatically retried: check the target first.
- Processing details show speech, cleanup and total durations, the machine used
  and any fallback. History edits have separate timing and machine information.
- Cleanup models can change meaning despite the review checks. Choose Exact when exact wording matters,
  or recover **Copy original** from the latest dictation or History.
- App data lives in `~/Library/Application Support/OpenSuperwhisper` and is
  separate from OpenWhispr. Voice processing uses your Macs; installation obtains
  public packages and model files from their publishers.

## Development

Requires Node 24+, Xcode command-line tools, and uv for local inference.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run dev
```

```sh
npm run quality-check
npm run lint:python
npm test
npm run test:python
npm run pack       # release/mac-arm64/OpenSuperwhisper.app
npm run build:mac  # also produce a DMG
```

`npm run dev:ui` starts the UI alone. Append `?preview=1` to see explicitly labeled
sample data in development. Preview never records or changes system settings;
it is excluded from production builds.

The active application is in `desktop/`, `local-ui/`, and `local-runtime/`.
The original `src/` and upstream tooling remain as reference; they are outside
the active import graph and package allowlist. See
[architecture and packaging](docs/LOCAL_ARCHITECTURE.md) for details and
[the original README](docs/UPSTREAM_README.md) for upstream history.

## Attribution

Application code retains the upstream MIT license. Model weights have separate
terms. This is not an official OpenWhispr or Superwhisper release. See
[third-party notices](THIRD_PARTY_NOTICES.md) and [LICENSE](LICENSE).
