#!/bin/sh
# Executed only after the user chooses USB authorization and approves pkexec.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
if [ "$(id -u)" -ne 0 ]; then
  echo '请通过系统授权安装 USB 权限规则。' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
rules="$script_dir/openocd/openocd/contrib/60-openocd.rules"
test -f "$rules"
install -D -m 644 "$rules" /etc/udev/rules.d/60-flashstudio.rules
udevadm control --reload-rules
# Do not trigger every system device. Replugging applies the new USB ACLs.
echo 'USB 权限规则已安装，请重新插拔探针。'
