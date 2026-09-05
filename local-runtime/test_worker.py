"""Protocol and format checks only; no MLX imports or model inference."""

import importlib.util
import json
import os
import tempfile
import threading
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "worker", Path(__file__).with_name("worker.py")
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTest(unittest.TestCase):
    def test_vocabulary_is_bounded_and_uses_only_canonical_spellings(self):
        entries = [
            {"word": "OpenSuperwhisper", "aliases": ["weapon super whisper"]},
            {"word": "opensuperwhisper", "aliases": []},
            {"word": " Tailscale ", "aliases": []},
        ]
        self.assertEqual(
            worker.vocabulary_words(entries), ["OpenSuperwhisper", "Tailscale"]
        )
        for invalid in [
            None,
            {},
            ["word"],
            [{"word": "x" * 81}],
            [{"word": "two\nlines"}],
            [{"word": "x"}] * 33,
        ]:
            with self.assertRaises(ValueError):
                worker.vocabulary_words(invalid)

    def test_s1_receives_exact_trained_controls_without_vocabulary_instructions(self):
        engine = worker.Engine("qwen", "s1", ".", lambda _message: None)
        engine.mx = types.SimpleNamespace(synchronize=lambda: None)
        engine.editor = object()
        observed = []
        engine.tokenizer = types.SimpleNamespace(
            apply_chat_template=lambda messages, **_kwargs: (
                observed.append(messages) or "prompt"
            )
        )
        modules = {
            "mlx_lm": types.SimpleNamespace(
                load=lambda _path: self.fail("editor already loaded"),
                stream_generate=lambda *_args, **_kwargs: iter(
                    [types.SimpleNamespace(text="Cleaned.")]
                ),
            ),
            "mlx_lm.sample_utils": types.SimpleNamespace(
                make_sampler=lambda **_kwargs: None
            ),
        }
        with patch.dict("sys.modules", modules):
            for format in ["prose", "paragraphs", "list", "unexpected instruction"]:
                self.assertEqual(engine.clean("Original", format=format), "Cleaned.")
        for messages in observed:
            self.assertEqual(
                messages[0], {"role": "system", "content": worker.S1_SYSTEM}
            )
        self.assertEqual(observed[0][1]["content"], worker.S1_CONTROLS + "Original")
        self.assertEqual(observed[1], observed[0])
        self.assertEqual(
            observed[2][1]["content"],
            "[Styling: semi-formal] [Structure: lists] [Context: general]\nOriginal",
        )
        self.assertEqual(observed[3], observed[0])

    def test_process_passes_hotwords_and_format_without_changing_raw_transcript(self):
        engine = worker.Engine("qwen", "s1", ".", lambda _message: None)
        engine.load_asr = lambda: None
        engine.mx = types.SimpleNamespace(synchronize=lambda: None)
        observed = {}

        def generate(_audio, **kwargs):
            observed["asr"] = kwargs
            return types.SimpleNamespace(text=" Original words ", generation_tokens=2)

        def clean(text, format):
            observed["clean"] = {"text": text, "format": format}
            return "- Edited words"

        engine.asr = types.SimpleNamespace(generate=generate)
        engine.clean = clean
        with patch.object(worker, "validate_wav", return_value=Path("audio.wav")):
            result = engine.process(
                {
                    "audioPath": "audio.wav",
                    "cleanup": True,
                    "format": "list",
                    "vocabulary": [
                        {
                            "word": "OpenSuperwhisper",
                            "aliases": ["weapon super whisper"],
                        }
                    ],
                }
            )
        self.assertEqual(observed["asr"]["hotwords"], ["OpenSuperwhisper"])
        self.assertEqual(
            observed["clean"], {"text": "Original words", "format": "list"}
        )
        self.assertEqual(result["rawText"], "Original words")
        self.assertEqual(result["text"], "- Edited words")
        self.assertEqual(result["cleanupStatus"], "applied")

    def test_app_owned_wave_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "recording.wav"
            with wave.open(str(filename), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * 160)
            self.assertEqual(
                worker.validate_wav(filename, directory), filename.resolve()
            )
            with self.assertRaises(ValueError):
                worker.validate_wav(filename, Path(directory) / "other")
            with wave.open(str(filename), "wb") as audio:
                audio.setnchannels(2)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * 160)
            with self.assertRaises(ValueError):
                worker.validate_wav(filename, directory)

    def test_protocol_processes_coalesced_lines_on_one_thread(self):
        reader, writer = os.pipe()
        observed, responses = [], []

        class FakeEngine:
            def process(self, params):
                observed.append(threading.get_ident())
                return {"rawText": params["text"]}

        for identifier in ["one", "two"]:
            os.write(
                writer,
                (
                    json.dumps(
                        {
                            "v": 1,
                            "id": identifier,
                            "method": "process",
                            "params": {"text": identifier},
                        }
                    )
                    + "\n"
                ).encode(),
            )
        os.close(writer)
        worker.serve(FakeEngine(), reader, responses.append, 0.1)
        os.close(reader)
        self.assertEqual(observed, [threading.get_ident()] * 2)
        self.assertEqual([reply.get("id") for reply in responses], [None, "one", "two"])

    def test_idle_worker_exits_without_loading(self):
        reader, writer = os.pipe()
        responses = []
        worker.serve(None, reader, responses.append, 0.01)
        os.close(reader)
        os.close(writer)
        self.assertEqual(responses, [{"v": 1, "event": "ready"}])

    def test_cleanup_failure_preserves_raw_result(self):
        engine = worker.Engine("qwen", "s1", ".", lambda _message: None)
        engine.load_asr = lambda: None
        engine.mx = type("MX", (), {"synchronize": staticmethod(lambda: None)})
        engine.asr = type(
            "ASR",
            (),
            {
                "generate": staticmethod(
                    lambda *_args, **_kwargs: type(
                        "Result", (), {"text": "Original", "generation_tokens": 1}
                    )()
                )
            },
        )
        engine.clean = lambda _text, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("cleanup failed")
        )
        original = worker.validate_wav
        try:
            worker.validate_wav = lambda *_args: Path("audio.wav")
            result = engine.process({"audioPath": "audio.wav", "cleanup": True})
        finally:
            worker.validate_wav = original
        self.assertEqual(result["rawText"], "Original")
        self.assertEqual(result["text"], "Original")
        self.assertEqual(result["cleanupStatus"], "failed")
        self.assertEqual(result["warning"], "cleanup failed")


if __name__ == "__main__":
    unittest.main()
