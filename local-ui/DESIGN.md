# Dictation UI

The interface is a small Mac utility: one recording action, visible machine choice,
and the original words always within reach. It uses OpenWhispr's blue and system
type on parchment, with white controls and a quiet sidebar. The live microphone
trace is the signature: it responds to measured audio energy, never simulated
production activity. Rounded system display type appears only in page headings;
monospace is reserved for shortcuts and recording time.

Dictate contains recording, route/cleanup controls, initial permissions/fallback
preparation, and the last result. History compares original and edited text.
Settings contains processing location, Clean English and text layout, personal
vocabulary, microphone, shortcut, login launch and history. No account, catalog or
provider settings enter this graph. Prose is the default layout; Studio supports
paragraphs while local cleanup uses prose for that preference.

Personal vocabulary uses the existing white cards and compact system controls.
Each entry has a correct spelling and up to four optional exact mishearings. Add,
edit and remove stay inline. A blank “Remember a correction” form in the latest
result and History lets the user choose a phrase explicitly; a model's edit is
never treated as permission to learn a replacement. Saving changes future
dictations only, and the original transcript stays immutable.

When a meaning check flags a suggested edit, the card says “Edit needs review” and
keeps the suggestion in a disclosure with kept text and suggestion side by side.
The kept text is the original for a first cleanup, or the previous accepted edit
when a later explicit rewrite is flagged.
Copying that suggestion requires its own action. The explanation describes a
best-effort check, without promising that every meaning error can be detected.

The microphone owner is created by one React effect, and disposes subscriptions,
stream and pending recording on cleanup. The owner calls main before acquiring
audio so main can snapshot the insertion target. Stop drains the AudioWorklet;
cancel invalidates every asynchronous continuation. Browser resampling produces
16 kHz mono PCM16 WAV. Capture is limited to five minutes. Backend silence and
transport checks remain required.

`?preview=1` enables explicitly labelled sample data only in Vite development.
It does not record, copy to the system clipboard, or make model requests. A
production renderer without its Electron bridge displays a desktop-only message.
