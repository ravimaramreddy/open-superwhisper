# OpenSuperwhisper

Private dictation for macOS, with English cleanup, custom vocabulary and automatic
paste. Built on [OpenWhispr](https://github.com/OpenWhispr/openwhispr).
Press **⌃⌥Space**, speak, then press it again to place the text in your focused app.
Press **Escape** to cancel. Recordings stop after five minutes.

| Mode      | Speech recognition                                         | Optional text cleanup                  |
| --------- | ---------------------------------------------------------- | -------------------------------------- |
| Gemini    | Gemini 3.8 Flash through Google Cloud                      | Audio and polished text in one request |
| Automatic | Mac Studio first; this Mac if Studio speech is unavailable | Uses the matching machine              |
| Studio    | Qwen3-ASR 1.7B, 8-bit                                      | Gemma 4 E4B through LM Studio          |
| This Mac  | Qwen3-ASR 1.7B, 8-bit through MLX                          | S1-mini by Superwhisper, BF16          |

Automatic mode falls back when Studio speech is unavailable. A correction failure
keeps the original transcript and shows a warning. Choosing Studio explicitly does
not silently switch machines. **Retry from original** uses the current processing
choice and editing settings, without recording or pasting again. Automatic retries
can use this Mac when Studio's editor connection is unavailable; a failed or
invalid edit preserves the previous version.

**Gemini** is an explicit cloud choice. It sends the current recording and writing
preferences to Google Cloud, returning a generated transcript and polished text
together. If configuration, sign-in, networking or the response fails, the same
recording uses Automatic's Studio-then-this-Mac route. Cloud work has a 15-second
deadline; it is not retried for that recording. Cancellation stops all processing
and delivery. Existing Automatic, Studio and This Mac choices do not use Gemini.
When Gemini is selected, **Retry locally** edits the saved transcript through
the local Automatic route; it does not upload a saved recording again.

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

The local paths check selected changes to numbers, negatives/exclusions, dictionary
names and quoted/technical text. A flagged edit keeps the previous text and
stores a suggested edit with reasons. Review highlighted additions and removals,
then explicitly **Use suggestion** or copy it if wanted. **Undo edit** restores
one previous version in History, including an initial cleanup. Retrying always
starts from the original speech text. These actions never change text already
inserted into another app; copy the version you want to use. These are conservative
checks, not a guarantee: they can flag legitimate edits and miss changed meaning,
including unknown names or reordered facts. S1 cleanup is English-only.

Gemini's Polished mode focuses on the complete intended request, allowing fluent
rephrasing and sensible repairs to spoken false starts. It does not use the local
literal-count checks to reject such changes. Its generated transcript is another
model output, not an independently verified reference. Compare it with the
polished version or recording when needed. Exact delivers the generated transcript;
Clean English requests lighter grammar and filler cleanup.

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

The build is unsigned and intended for personal installation. Local modes need
no account or API key. The optional Gemini lane uses an existing Google Cloud
sign-in and billable project, configured privately as described below.

## Optional Gemini connection

Install the [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install) and
sign in with `gcloud auth login`. Use a project with the Vertex AI API enabled and
the intended billing account attached. Google Cloud usage is separately billed;
any promotional credits are subject to their eligibility and expiry.

Add a `gemini` object to the existing app-data `machine.json`, preserving any
other local settings. The following values are **placeholders**:

```json
{
  "gemini": {
    "projectId": "your-cloud-project",
    "billingAccountId": "AAAAAA-BBBBBB-CCCCCC",
    "account": "your-account@example.com",
    "gcloudPath": "/opt/homebrew/bin/gcloud"
  }
}
```

This file belongs at `~/Library/Application Support/OpenSuperwhisper/machine.json`,
outside the checkout. Restrict access to your user (`chmod 600` on the file).
The project and billing-account pin are required. The login account and absolute
CLI path are optional; pinning the account avoids depending on whichever CLI
login is currently active. Restart the app after changing this private file.

Select **Gemini**, then **Check connections**. The app checks the project's billing
attachment before obtaining an access token. This is a connection/authentication
check, not a paid transcription or a credit-balance check. Access tokens and
successful verification stay in main-process memory and are reused for at most
five minutes before rechecking. No credentials are stored in History or renderer
settings. No API-key input or arbitrary endpoint is supported.

Keep This Mac's models prepared so fallback works when both the cloud and Studio
are unavailable. The app does not switch billing accounts, enable APIs, purchase
credits or initiate an interactive login. Missing configuration leaves local
dictation usable. A billing pin is not a spending cap.

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
- Temporary processing audio is removed when processing completes or is cancelled.
  App-owned recordings left by a crash are removed on the next launch.
  Audio is kept beyond processing only if you enable the testing archive below.
  Raw text is saved before automatic delivery when history is enabled.
- Dictated text stays on the clipboard after paste is sent, so a busy app can
  consume it later. The previous clipboard is not restored on a timer. "Initial
  paste sent" confirms keyboard dispatch, not insertion in the destination.
  An uncertain paste is never automatically retried: check the target first.
- Processing details show speech, cleanup and total durations, the route used
  and any fallback. History edits have separate timing and machine information.
  Gemini shows combined audio/cleanup time; fallback keeps the cloud attempt's
  time separate from the subsequent local stages.
- Cleanup models can change meaning despite the review checks. Choose Exact when exact wording matters,
  or recover **Copy original** from the latest dictation or History.
- App data lives in `~/Library/Application Support/OpenSuperwhisper` and is
  separate from OpenWhispr. Local modes process voice on your Macs; Gemini sends
  only the current audio, vocabulary and writing preferences to the official
  Google Cloud global endpoint. It does not send screen content, clipboard text,
  app identity, previous dictations or local file paths. Installation obtains
  public packages and model files from their publishers.
- Google Cloud's [service terms](https://cloud.google.com/terms/service-terms)
  prohibit training on customer data without permission. Its
  [privacy commitments](https://cloud.google.com/privacy/data-protection-impact-assessment)
  exclude using customer content for advertising profiles. Requests remain tied
  to the Cloud account; caching and abuse-monitoring retention can apply. See
  [data retention](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention).
  The app does not establish a zero-retention exemption or alter project privacy settings.

### Save audio for testing

**Settings → Keep audio for testing** is off by default and requires dictation
history. When enabled, future submitted, nonsilent dictations can be retained on
this Mac as a WAV recording and a matching JSON file. The JSON preserves the
initial raw and edited transcript, effective settings and processing timings for
later comparison. Later History edits do not replace that initial snapshot.

- The archive is private app data under
  `~/Library/Application Support/OpenSuperwhisper`, outside the repository.
  **Open saved recordings** opens it even when saving is off. **Show recording**
  reveals the saved clip for a History entry.
- The archive is independent of History's 100-entry limit: automatic History
  rollover leaves older audio and transcript files available.
- Turning audio saving off stops future saves; existing files remain. Turning
  History off also disables future audio saving.
- Saving stops at **1 GiB or 2,000 clips**, with a visible warning. No older
  recordings are automatically deleted to make space.
- **Delete dictation + recording** in History removes that entry and its linked
  WAV/JSON pair. Cancelling a dictation also removes its pair. Older archived
  pairs that have left History can be managed through **Open saved recordings**.
- A failed archive save shows a warning but does not prevent ordinary dictation
  or paste. Keep only recordings you want available for testing.

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
