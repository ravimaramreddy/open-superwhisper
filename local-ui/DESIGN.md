# Dictation UI

The interface is a small Mac utility: one recording action, visible machine choice,
and the original words always within reach. It uses OpenWhispr's blue and system
type on parchment, with white controls and a quiet sidebar. The live microphone
trace is the signature: it responds to measured audio energy, never simulated
production activity. Rounded system display type appears only in page headings;
monospace is reserved for shortcuts and recording time.

Dictate contains recording, route/cleanup controls, initial permissions/fallback
preparation, and the last result. History compares original and edited text.
Settings contains only processing location, cleanup, microphone, shortcut, login
launch and history. No account, catalog or provider settings enter this graph.

The microphone owner is created by one React effect, and disposes subscriptions,
stream and pending recording on cleanup. The owner calls main before acquiring
audio so main can snapshot the insertion target. Stop drains the AudioWorklet;
cancel invalidates every asynchronous continuation. Browser resampling produces
16 kHz mono PCM16 WAV. Capture is limited to two minutes. Backend silence and
transport checks remain required.

`?preview=1` enables explicitly labelled sample data only in Vite development.
It does not record, copy to the system clipboard, or make model requests. A
production renderer without its Electron bridge displays a desktop-only message.
