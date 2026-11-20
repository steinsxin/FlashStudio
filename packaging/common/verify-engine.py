"""Validate an installed engine with no probe, system OpenOCD or PATH lookup."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PROJECT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("prepare", PROJECT / "scripts/prepare-openocd.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def verify(root, platform):
    root = root.resolve()
    checksum = prepare.LOCK["platforms"][platform]["sha256"]
    if not prepare.verify_tree(root, platform, checksum):
        raise ValueError(f"Missing, modified or wrong-platform engine: {root}")
    executable = root / ("bin/openocd.exe" if platform == "win32-x64" else "bin/openocd")
    env = {key: value for key, value in os.environ.items() if key.upper() not in ("PATH", "OPENOCD_SCRIPTS", "LD_LIBRARY_PATH")}
    env["PATH"] = ""
    for adapter in ("stlink", "jlink", "cmsis-dap"):
        result = subprocess.run([str(executable), "-s", str(root / "openocd/scripts"),
                                 "-f", f"interface/{adapter}.cfg", "-c", "transport select swd",
                                 "-f", "target/stm32f4x.cfg", "-c", "echo BUNDLED_ENGINE_READY; shutdown"],
                                cwd=tempfile.gettempdir(), env=env, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=15)
        output = result.stdout + result.stderr
        if result.returncode or "BUNDLED_ENGINE_READY" not in output:
            raise RuntimeError(f"{adapter}: {output}")
    print(f"Verified installed {platform} engine, full inventory and all three adapters: {root}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: verify-engine.py OPENOCD_DIRECTORY linux-x64|win32-x64")
    verify(Path(sys.argv[1]), sys.argv[2])
