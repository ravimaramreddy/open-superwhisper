"""Check seed/download verification without downloading models or packages."""

import hashlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "setup", Path(__file__).parent.parent / "scripts" / "setup-local-runtime.py"
)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTest(unittest.TestCase):
    def expected(self, content):
        return {
            "name": "weights",
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }

    def test_verified_seed_is_copied_and_independent_of_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seed = root / "seed"
            seed.mkdir()
            (seed / "weights").write_bytes(b"known weights")
            model = {"files": [self.expected(b"known weights")]}
            with patch.object(
                setup.urllib.request,
                "urlopen",
                side_effect=AssertionError("no download"),
            ):
                setup.install_model("sample", model, root / "target", seed)
            (seed / "weights").write_bytes(b"modified")
            self.assertEqual(
                (root / "target" / "weights").read_bytes(), b"known weights"
            )

    def test_corrupt_download_never_becomes_a_finished_model_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = {
                "repo": "public/model",
                "revision": "fixed-revision",
                "files": [self.expected(b"good")],
            }
            with (
                patch.object(
                    setup.urllib.request, "urlopen", return_value=io.BytesIO(b"evil")
                ),
                self.assertRaisesRegex(RuntimeError, "Checksum mismatch"),
            ):
                setup.install_model("sample", model, root / "target")
            self.assertFalse((root / "target" / "weights").exists())
            self.assertFalse((root / "target" / "weights.partial").exists())

    def test_bundle_license_hash_mismatch_is_a_setup_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = {**self.expected(b"license"), "bundled": "missing-license"}
            with self.assertRaisesRegex(RuntimeError, "notice is missing or corrupt"):
                setup.install_model(
                    "sample", {"files": [expected]}, root / "target", resource_dir=root
                )


if __name__ == "__main__":
    unittest.main()
