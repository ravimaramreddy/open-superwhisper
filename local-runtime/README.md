# Local inference runtime

The application runs Qwen3-ASR-1.7B (8-bit MLX) and **S1-mini by Superwhisper** in one Python child process. Models load on first use, remain resident between requests, and leave memory when the worker exits after 120 seconds idle. Cancellation kills that child. The worker never opens a listening port or downloads weights.

Setup uses `uv` to install Python 3.13.14 and the tested package versions in `userData/runtime/.venv`. Model files live in `userData/models/<name>-<revision>`. Every file is SHA-256 checked against `models.lock.json` before setup writes `runtime/ready.json`. Startup checks the completion marker, lock identity, executable and expected file sizes. Run setup again to rehash or repair an installation. The application does not depend on benchmark files in temporary directories.

For a developer setup with existing cached weights:

```sh
uv run --no-project --python 3.13.14 scripts/setup-local-runtime.py \
  --user-data /absolute/path/to/app-data \
  --uv /absolute/path/to/uv \
  --lock local-runtime/models.lock.json \
  --seed-qwen /absolute/path/to/qwen-snapshot \
  --seed-s1 /absolute/path/to/s1-snapshot
```

Seeds are copied only after hash verification. Missing or invalid seed files are downloaded from the pinned public Hugging Face revision. License/card files are bundled and also copied into the model directory. Package installation may use the network. No GPU inference happens during setup.

The worker receives newline-delimited JSON on stdin. Its stdout contains only the versioned protocol; library and native output goes to stderr. A request has `v:1`, a string `id`, `method:"process"`, and `params:{audioPath,cleanup}`. The file must resolve beneath the app's user data directory and contain 16 kHz mono PCM16 WAV, at most 120 seconds. Successful replies have `ok:true` and the application's transcript result. Errors have `ok:false` and `{code,message}`. The worker accepts only one request at a time. Model work stays on the main Python thread.

Correction errors, empty correction output, and correction token-limit exhaustion preserve the raw transcript with a warning. Recognition token-limit exhaustion is an error requiring a shorter recording. These guards do not detect every semantic editing mistake; the application retains the original text for review.

## Studio integration

The desktop client owns an SSH child with two loopback-only forwards to the existing Studio services: speech on `127.0.0.1:8766`, LM Studio on `127.0.0.1:1234`. It creates no remote service and changes no shared settings. The default SSH target is `mac-studio`; the local configuration may override it.

The editor is `google/gemma-4-e4b`, loaded with an app-process-specific `open-superwhisper-e4b-<id>` identifier, an 8192-token context and a 300-second idle TTL. Native `/api/v1/chat` requests use temperature zero, `reasoning:"off"`, `store:false`, and a 512-token output limit. The application only unloads its own identifier. Cancellation aborts HTTP requests and the app's SSH load command. Remote loading can already be in progress when SSH ends; the own-instance unload attempt and idle TTL cover that case. Shared Studio speech keeps its existing lifecycle.

The `auto` profile falls back to the Air only if Studio speech is unavailable. A Studio correction failure keeps the Studio raw text. Forced profiles never switch machines.

## Model provenance and notices

- Qwen MLX conversion: [`a8379a2e2f9e313c9292cdf1af4055ab56d50d55`](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit/tree/a8379a2e2f9e313c9292cdf1af4055ab56d50d55). Its card declares Apache-2.0 and links to the original Qwen model. The package retains the [official upstream model card at `7278e1e…`](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/blob/7278e1e70fe206f11671096ffdd38061171dd6e5/README.md) and [Qwen3-ASR's Apache-2.0 license](https://github.com/QwenLM/Qwen3-ASR/blob/main/LICENSE), pinned by hash in the lock.
- S1-mini: [`88f6b15896c73bbb13a3b596e0afe8ea0d5150b4`](https://huggingface.co/superwhisper/s1-mini/tree/88f6b15896c73bbb13a3b596e0afe8ea0d5150b4). `notices/s1/` retains the exact LICENSE, NOTICE and README. The license adds a mandatory naming term to Apache-2.0; integrations must keep the exact names **S1-mini** and **Superwhisper**.
- LM Studio API fields: [model inventory](https://lmstudio.ai/docs/developer/rest/list), [native chat](https://lmstudio.ai/docs/developer/rest/chat), and [idle TTL](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict).

Protocol/setup tests do not import MLX or run models:

```sh
uv run --no-project --python 3.13.14 python -m unittest discover -s local-runtime -p 'test_*.py'
node --test test/local/inference.test.js test/local/worker-client.test.js
```
