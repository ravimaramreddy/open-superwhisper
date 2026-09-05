# Attribution

OpenSuperwhisper is a personal, macOS-focused fork of
[OpenWhispr](https://github.com/OpenWhispr/openwhispr), originally distributed
under the MIT license. Its copyright and license notice remain in `LICENSE`.
The native keyboard/paste foundation, application assets and retained upstream
source remain attributable to the OpenWhispr contributors. This fork is not an
official OpenWhispr or Superwhisper release.

The application uses **S1-mini by Superwhisper** for optional local English
transcript cleanup. Its weights are distributed separately and retain their
license, model card and naming requirements. The setup process preserves the
checkpoint's license alongside its weights. See
[S1-mini](https://huggingface.co/superwhisper/s1-mini).

Qwen3-ASR 1.7B weights are distributed separately under their model license.
The tested Air conversion is
[`mlx-community/Qwen3-ASR-1.7B-8bit`](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit).
Its checkpoint includes the applicable license and attribution.

Gemma E4B runs through the owner's existing Studio installation. It is not
bundled, downloaded or relicensed by this app. Gemma terms apply to those
separately obtained weights. Electron, React, Lucide, i18next and other build
dependencies retain their respective licenses.
