"""One-thread MLX worker. Its original stdout carries NDJSON only."""

import argparse
import contextlib
import json
import os
import selectors
import sys
import time
import wave
from pathlib import Path

S1_SYSTEM = (
    "You are a text normalizer for speech-to-text transcripts. The input begins "
    "with a control line specifying the styling, structure, and context settings; "
    "clean the transcript to match those settings and output only the cleaned text."
)
S1_CONTROLS = "[Styling: semi-formal] [Structure: prose] [Context: general]\n"
MAX_TOKENS = 512


def validate_wav(filename, audio_root):
    path = Path(filename).resolve(strict=True)
    if not path.is_relative_to(Path(audio_root).resolve()) or not path.is_file():
        raise ValueError("Audio must be an app-owned WAV file")
    with wave.open(str(path), "rb") as audio:
        if (
            audio.getnchannels(),
            audio.getsampwidth(),
            audio.getframerate(),
            audio.getcomptype(),
        ) != (1, 2, 16000, "NONE"):
            raise ValueError("Audio must be 16 kHz mono PCM16 WAV")
        duration = audio.getnframes() / 16000
        if not 0 < duration <= 120:
            raise ValueError("Recording must be between 0 and 120 seconds")
    return path


class Engine:
    def __init__(self, qwen, s1, audio_root, report):
        self.qwen_path, self.s1_path, self.audio_root = qwen, s1, audio_root
        self.report = report
        self.mx = self.asr = self.editor = self.tokenizer = None

    def load_asr(self):
        if self.asr is None:
            self.report("Loading local speech recognition")
            import mlx.core as mx
            from mlx_audio.stt import load

            self.mx = mx
            self.asr = load(self.qwen_path, strict=True)
            mx.synchronize()

    def clean(self, text):
        if not text.strip():
            return ""
        from mlx_lm import load, stream_generate
        from mlx_lm.sample_utils import make_sampler

        if self.editor is None:
            self.report("Loading local correction — S1-mini by Superwhisper")
            self.editor, self.tokenizer = load(self.s1_path)
        self.report("Correcting text locally")
        prompt = self.tokenizer.apply_chat_template(
            [
                {"role": "system", "content": S1_SYSTEM},
                {"role": "user", "content": S1_CONTROLS + text},
            ],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        pieces = []
        for result in stream_generate(
            self.editor,
            self.tokenizer,
            prompt,
            max_tokens=MAX_TOKENS,
            sampler=make_sampler(temp=0.0),
        ):
            pieces.append(result.text)
        self.mx.synchronize()
        cleaned = "".join(pieces).strip()
        if len(pieces) >= MAX_TOKENS:
            raise RuntimeError(
                "Correction reached its length limit; original text kept"
            )
        if not cleaned:
            raise RuntimeError("Correction returned no text; original text kept")
        return cleaned

    def process(self, params):
        audio = validate_wav(params["audioPath"], self.audio_root)
        started = time.perf_counter()
        self.load_asr()
        self.report("Transcribing locally")
        result = self.asr.generate(
            str(audio),
            language="English",
            max_tokens=MAX_TOKENS,
            temperature=0.0,
            verbose=False,
        )
        self.mx.synchronize()
        raw = result.text.strip()
        if (getattr(result, "generation_tokens", 0) or 0) >= MAX_TOKENS:
            raise RuntimeError(
                "Speech recognition reached its length limit. Try a shorter recording."
            )
        after_asr = time.perf_counter()
        text, status, warning = raw, "off", None
        if params.get("cleanup"):
            try:
                text = self.clean(raw)
                status = "applied"
            except Exception as error:  # noqa: BLE001 — every correction failure must preserve the raw transcript.
                status, warning = "failed", str(error)
        finished = time.perf_counter()
        reply = {
            "rawText": raw,
            "text": text,
            "actualProfile": "air",
            "cleanupStatus": status,
            "timings": {
                "asrMs": (after_asr - started) * 1000,
                "cleanupMs": (finished - after_asr) * 1000,
                "totalMs": (finished - started) * 1000,
            },
        }
        if warning:
            reply["warning"] = warning
        return reply


def serve(engine, input_fd, write, idle_seconds):
    selector = selectors.DefaultSelector()
    selector.register(input_fd, selectors.EVENT_READ)
    buffer = b""
    last_finished = time.monotonic()
    write({"v": 1, "event": "ready"})
    try:
        while True:
            remaining = idle_seconds - (time.monotonic() - last_finished)
            if remaining <= 0 or not selector.select(remaining):
                return
            chunk = os.read(input_fd, 65536)
            if not chunk:
                return
            buffer += chunk
            if len(buffer) > 131072:
                raise ValueError("Request exceeds the protocol limit")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                request = {}
                try:
                    request = json.loads(line)
                    if (
                        not isinstance(request, dict)
                        or request.get("v") != 1
                        or not isinstance(request.get("id"), str)
                    ):
                        raise ValueError("Invalid request envelope")
                    if request.get("method") == "shutdown":
                        write({"v": 1, "id": request["id"], "ok": True, "result": None})
                        return
                    if request.get("method") != "process":
                        raise ValueError("Unknown worker method")
                    result = engine.process(request["params"])
                    write({"v": 1, "id": request["id"], "ok": True, "result": result})
                except Exception as error:  # noqa: BLE001 — request boundary isolates model errors from the protocol.
                    identifier = (
                        request.get("id") if isinstance(request, dict) else None
                    )
                    write(
                        {
                            "v": 1,
                            "id": identifier,
                            "ok": False,
                            "error": {
                                "code": "LOCAL_INFERENCE_FAILED",
                                "message": str(error),
                            },
                        }
                    )
                last_finished = time.monotonic()
    finally:
        selector.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--qwen", required=True)
    parser.add_argument("--s1", required=True)
    parser.add_argument("--audio-root", required=True)
    parser.add_argument("--idle-seconds", type=float, default=120)
    args = parser.parse_args()
    # Protect the protocol even from libraries that write directly to fd 1.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

    def write(value):
        protocol.write(json.dumps(value, ensure_ascii=False) + "\n")
        protocol.flush()

    engine = Engine(
        args.qwen,
        args.s1,
        args.audio_root,
        lambda message: write({"v": 1, "event": "progress", "message": message}),
    )
    with contextlib.redirect_stdout(sys.stderr):
        serve(engine, sys.stdin.fileno(), write, args.idle_seconds)


if __name__ == "__main__":
    main()
