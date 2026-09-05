"""Install the pinned local runtime; never import or load a model during setup."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


def progress(message):
    print(json.dumps({"event": "progress", "message": message}), flush=True)


def matches(path, expected):
    if not path.is_file() or path.stat().st_size != expected["bytes"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == expected["sha256"]


def install_model(name, model, directory, seed=None, resource_dir=None):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    for expected in model["files"]:
        target = directory / expected["name"]
        progress(f"Checking {name}: {expected['name']}")
        if matches(target, expected):
            continue
        temporary = target.with_name(target.name + ".partial")
        source = Path(seed) / expected["name"] if seed else None
        if expected.get("bundled"):
            source = Path(resource_dir) / expected["bundled"]
            if not matches(source, expected):
                raise RuntimeError(
                    f"Bundled model notice is missing or corrupt: {name}/{expected['name']}"
                )
        if source and matches(source, expected):
            progress(f"Copying verified {name}: {expected['name']}")
            shutil.copyfile(source, temporary)
        else:
            progress(f"Downloading {name}: {expected['name']}")
            url = f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/{expected['name']}"
            request = urllib.request.Request(
                url, headers={"User-Agent": "OpenSuperwhisper-local-setup/1"}
            )
            with (
                urllib.request.urlopen(request, timeout=120) as response,
                temporary.open("wb") as handle,
            ):
                shutil.copyfileobj(response, handle, length=8 * 1024 * 1024)
        if not matches(temporary, expected):
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"Checksum mismatch for {name}/{expected['name']}")
        temporary.chmod(0o600)
        temporary.replace(target)
    return str(directory)


def setup(args):
    os.umask(0o077)
    user_data = Path(args.user_data).expanduser().resolve()
    runtime = user_data / "runtime"
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = Path(args.lock).resolve()
    lock_bytes = lock_path.read_bytes()
    lock = json.loads(lock_bytes)
    complete = runtime / "ready.json"
    complete.unlink(missing_ok=True)
    environment = runtime / ".venv"
    python = environment / "bin" / "python"
    env = {
        **os.environ,
        "UV_CACHE_DIR": str(runtime / "uv-cache"),
        "UV_PYTHON_INSTALL_DIR": str(runtime / "python"),
    }
    progress("Preparing the local Python runtime")
    if not python.exists():
        subprocess.run(
            [args.uv, "venv", "--python", lock["python"], str(environment)],
            env=env,
            check=True,
            stdout=sys.stderr,
        )
    progress("Installing the tested speech and correction packages")
    subprocess.run(
        [
            args.uv,
            "pip",
            "install",
            "--python",
            str(python),
            *[f"{name}=={version}" for name, version in lock["packages"].items()],
        ],
        env=env,
        check=True,
        stdout=sys.stderr,
    )
    versions = json.loads(
        subprocess.check_output(
            [
                str(python),
                "-c",
                "import importlib.metadata as m,json,sys; print(json.dumps({n:m.version(n) for n in sys.argv[1:]}))",
                *lock["packages"].keys(),
            ],
            text=True,
        )
    )
    if versions != lock["packages"]:
        raise RuntimeError("Installed packages do not match the tested runtime")
    paths = {}
    for name, model in lock["models"].items():
        destination = user_data / "models" / f"{name}-{model['revision']}"
        paths[name] = install_model(
            name, model, destination, getattr(args, f"seed_{name}"), lock_path.parent
        )
    ready = {
        "version": 1,
        "lockSha256": hashlib.sha256(lock_bytes).hexdigest(),
        "python": str(python),
        "models": paths,
        "packages": versions,
    }
    temporary = complete.with_suffix(".partial")
    temporary.write_text(json.dumps(ready, indent=2) + "\n")
    temporary.replace(complete)
    progress("Local speech and correction are ready")
    return ready


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-data", required=True)
    parser.add_argument("--uv", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--seed-qwen")
    parser.add_argument("--seed-s1")
    args = parser.parse_args()
    try:
        print(json.dumps({"event": "ready", "result": setup(args)}), flush=True)
    except Exception as error:  # noqa: BLE001 — outer process boundary reports setup failures as NDJSON.
        print(json.dumps({"event": "error", "message": str(error)}), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
