"""Protocol and format checks only; no MLX imports or model inference."""

import importlib.util
import json
import os
import tempfile
import threading
import unittest
import wave
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "worker", Path(__file__).with_name("worker.py")
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTest(unittest.TestCase):
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
        engine.clean = lambda _text: (_ for _ in ()).throw(
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


if __name__ == "__main__":
    unittest.main()
