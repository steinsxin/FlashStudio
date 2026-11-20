"""Fetch a pinned portable engine at BUILD time, preserving libraries and licenses.

No pip dependencies. An offline archive is accepted only with the pinned SHA-256.
The installed application never consults PATH for OpenOCD or downloads anything.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "packaging/openocd.lock.json").read_text(encoding="utf-8"))
DEST = ROOT / "src-tauri/resources/openocd"
WINDOWS_MANIFEST = ROOT / "packaging/windows/openocd.exe.manifest"


def default_platform():
    triple = os.environ.get("TAURI_ENV_TARGET_TRIPLE", "")
    if triple:
        if triple == "x86_64-pc-windows-msvc":
            return "win32-x64"
        if triple == "x86_64-unknown-linux-gnu":
            return "linux-x64"
        raise ValueError(f"Unsupported target: {triple}; supported: Windows x64 / Linux x64")
    if platform.machine().lower() not in ("amd64", "x86_64"):
        raise ValueError("Bundled engines currently support x64 only")
    if sys.platform not in ("linux", "win32"):
        raise ValueError("Supported platforms: Windows x64 / Linux x64")
    return f"{sys.platform}-x64"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else hashlib.sha256(stream.read()).hexdigest()


def relative_member(name, root):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name or not path.parts or path.parts[0] != root:
        raise ValueError(f"Unsafe archive entry: {name}")
    return Path(*path.parts[1:])


def extract(archive, destination):
    root = f"xpack-openocd-{LOCK['version']}"
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as package:
            for member in package.infolist():
                path = destination / relative_member(member.filename, root)
                if member.is_dir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    if stat.S_ISLNK(member.external_attr >> 16):
                        raise ValueError("Unexpected symlink in Windows archive")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with package.open(member) as source, path.open("wb") as target:
                        shutil.copyfileobj(source, target)
    else:
        with tarfile.open(archive) as package:
            for member in package.getmembers():
                path = destination / relative_member(member.name, root)
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                    continue
                if not (member.isfile() or member.issym() or member.islnk()):
                    raise ValueError(f"Unexpected archive entry type: {member.name}")
                if member.issym() or member.islnk():
                    link = member.linkname if member.islnk() else str(PurePosixPath(member.name).parent / member.linkname)
                    relative_member(link, root)
                path.parent.mkdir(parents=True, exist_ok=True)
                # Materialize internal library symlinks: works with Tauri resource
                # copying and on Windows hosts preparing a Linux archive.
                with package.extractfile(member) as source, path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                path.chmod(member.mode & 0o755)


def verify_tree(root, platform_id, sha256):
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        if manifest["platform"] != platform_id or manifest["archiveSha256"] != sha256 or manifest["version"] != LOCK["version"]:
            return False
        # An older, otherwise intact Windows cache still lacks UTF-8 support.
        # Compare with the current compatibility manifest before accepting it.
        if platform_id == "win32-x64" and (root / "bin/openocd.exe.manifest").read_bytes() != WINDOWS_MANIFEST.read_bytes():
            return False
        inventory = manifest["files"]
        expected = set(inventory) | {"manifest.json"}
        actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
        return expected == actual and all(digest(root / path) == checksum for path, checksum in inventory.items())
    except (OSError, ValueError, KeyError):
        return False


def prepare(platform_id, archive=None, destination=DEST):
    spec = LOCK["platforms"][platform_id]
    if verify_tree(destination, platform_id, spec["sha256"]):
        destination.chmod(0o755)
        if platform_id == "linux-x64":
            (destination / "bin/openocd").chmod(0o755)
        print(f"Bundled OpenOCD {LOCK['version']} / {platform_id}: verified")
        return
    cache = ROOT / ".cache/openocd"
    cache.mkdir(parents=True, exist_ok=True)
    if archive is None:
        archive = cache / spec["url"].rsplit("/", 1)[-1]
        if not archive.is_file() or digest(archive) != spec["sha256"]:
            print(f"Downloading {spec['url']}", flush=True)
            temporary = archive.with_suffix(archive.suffix + ".part")
            try:
                request = urllib.request.Request(spec["url"], headers={"User-Agent": "FlashStudio-build"})
                with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as target:
                    shutil.copyfileobj(response, target)
                if digest(temporary) != spec["sha256"]:
                    raise ValueError("OpenOCD archive checksum mismatch; refusing to bundle")
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
    if digest(archive) != spec["sha256"]:
        raise ValueError("OpenOCD archive checksum mismatch; refusing to extract")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".openocd-stage-", dir=destination.parent) as stage:
        stage = Path(stage)
        stage.chmod(0o755)
        extract(archive, stage)
        if platform_id == "win32-x64":
            # Keep the upstream executable unchanged. Windows loads this
            # sidecar on first launch, so ANSI APIs and argv use UTF-8 too.
            shutil.copyfile(WINDOWS_MANIFEST, stage / "bin/openocd.exe.manifest")
        executable = "bin/openocd.exe" if platform_id == "win32-x64" else "bin/openocd"
        for required in (executable, "openocd/scripts/interface/stlink.cfg", "openocd/scripts/interface/jlink.cfg", "openocd/scripts/interface/cmsis-dap.cfg", "openocd/contrib/60-openocd.rules", "distro-info/licenses/openocd-0.12.0/COPYING"):
            if not (stage / required).is_file():
                raise ValueError(f"Incomplete OpenOCD package: {required}")
        manifest = {"platform": platform_id, "version": LOCK["version"], "source": spec["url"], "archiveSha256": spec["sha256"],
                    "files": {p.relative_to(stage).as_posix(): digest(p) for p in sorted(stage.rglob("*")) if p.is_file()}}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(stage, destination)
    print(f"Prepared bundled OpenOCD {LOCK['version']} / {platform_id}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=LOCK["platforms"])
    parser.add_argument("--archive", type=Path, help="Offline archive; pinned checksum still required")
    parser.add_argument("--destination", type=Path, default=DEST)
    args = parser.parse_args()
    try:
        prepare(args.platform or default_platform(), args.archive, args.destination)
    except Exception as error:
        sys.exit(f"OpenOCD preparation failed: {error}")
