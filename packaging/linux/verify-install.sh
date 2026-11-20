#!/usr/bin/env bash
# Read-only check; optionally inspect an extracted package tree instead of /.
set -euo pipefail
trap 'printf "Installation check failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
prefix="${1:-}"
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test -x "$prefix/usr/bin/flashstudio"
test -r "$prefix/usr/share/applications/FlashStudio.desktop"
test -r "$prefix/usr/share/doc/flashstudio/README.md"
test -r "$prefix/usr/share/doc/flashstudio/THIRD_PARTY_NOTICES.md"
test -r "$prefix/usr/lib/FlashStudio/install-usb-rules.sh"
test -r "$prefix/usr/lib/FlashStudio/THIRD_PARTY_NOTICES.md"
for executable in pkexec udevadm xdg-open; do
  command -v "$executable"
done
libraries="$(ldd "$prefix/usr/bin/flashstudio")"
printf '%s\n' "$libraries"
if [[ "$libraries" == *'not found'* ]]; then
  exit 1
fi
python3 "$project_dir/packaging/common/verify-engine.py" "$prefix/usr/lib/FlashStudio/openocd" linux-x64
