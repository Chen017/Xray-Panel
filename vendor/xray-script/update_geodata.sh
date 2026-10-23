#!/bin/bash
set -o pipefail
is_core=xray
is_core_dir=${XRAY_ROOT:-/usr/local/etc/xray}
is_core_bin="$is_core_dir/bin/xray"
is_config_json="$is_core_dir/config.json"
is_conf_dir="$is_core_dir/conf"
_fail() { printf '[ERROR] %s\n' "$*" >&2; }
_info() { printf '[INFO] %s\n' "$*"; }
_ok() { printf '[OK] %s\n' "$*"; }
. "${BASH_SOURCE[0]%/*}/src/runtime.sh"
. "${BASH_SOURCE[0]%/*}/src/maintenance.sh"
update_geodata
