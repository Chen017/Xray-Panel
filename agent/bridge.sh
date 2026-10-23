#!/bin/bash
# Restricted commands only. All user-supplied configuration travels in JSON files.
set -eo pipefail
umask 077
is_core=xray
is_core_name=Xray
is_core_dir=${XRAY_ROOT:-/usr/local/etc/xray}
is_core_bin="$is_core_dir/bin/xray"
is_config_json="$is_core_dir/config.json"
is_conf_dir="$is_core_dir/conf"
is_log_dir=/var/log/xray
is_relay_state_file="$is_core_dir/relay.json"
is_sh_dir="$is_core_dir/sh"
is_sh_bin=/usr/local/bin/xray
is_core_repo=XTLS/Xray-core
is_sh_repo=Chen017/Xray
case $(uname -m) in x86_64) is_core_arch=64;; aarch64) is_core_arch=arm64-v8a;; *) exit 1;; esac
[[ -d "$is_sh_dir/src" ]] || is_sh_dir="$(cd "$(dirname "$0")/../vendor/xray-script" && pwd)"
_fail() { printf '%s\n' "$*" >&2; }
_ok() { printf '%s\n' "$*"; }
_info() { printf '%s\n' "$*"; }
_step() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
load() { . "$is_sh_dir/src/$1"; }
for module in runtime firewall core maintenance routing diagnostics status download bbr; do load "$module.sh"; done
is_sh_ver=$(sed -n 's/^is_sh_ver=//p' "$is_sh_dir/xray.sh" | head -1)
[[ -z ${PANEL_TEST_DRIVER:-} ]] || . "$PANEL_TEST_DRIVER"
panel_apply() {
    "$PANEL_PYTHON" "$PANEL_AGENT" --check-base "$PANEL_REAL_ROOT" "$PANEL_EXPECTED_HASH" || return 1
    "$PANEL_PYTHON" "$PANEL_AGENT" --write-bundle "${is_config_json%/*}" "$PANEL_CANDIDATE"
}
case ${1:-} in
    deploy) config_transaction panel_apply;;
    validate) validate_config && _ok 'Xray configuration valid';;
    dump) "$is_core_bin" run -dump -config "$is_config_json" -confdir "$is_conf_dir";;
    start|stop|restart|enable|disable) manage "$1";;
    logs) journalctl -u xray --no-pager -n 120; for file in access.log error.log; do [[ ! -f "$is_log_dir/$file" ]] || tail -n 100 "$is_log_dir/$file"; done;;
    update-core) safe_update core;;
    update-script) safe_update sh;;
    update-geodata) update_geodata;;
    maintenance) install_maintenance force && migrate_installation;;
    bbr) _try_enable_bbr;;
    diagnostics)
        first=$(list_managed_node_configs | head -1)
        if [[ -n $first ]]; then
            mapfile -t sni_targets < <(jq -r '.inbounds[0].streamSettings.realitySettings.serverNames[0] // "",.inbounds[1].streamSettings.realitySettings.serverNames[0] // ""' "$is_conf_dir/$first")
            _ov_v4_sni=${sni_targets[0]:-}; _ov_v6_sni=${sni_targets[1]:-}
        fi
        _check_ip_blocked; _check_sni_status
        printf '%b\n' "出站探测: ${_ov_ip_blocked:-}" "IPv4 SNI: ${_ov_v4_sni:-} ${_ov_v4_sni_status:-}" "IPv6 SNI: ${_ov_v6_sni:-} ${_ov_v6_sni_status:-}" "${_ov_sni_warning:-}" "${_ov_cdn_warning:-}"
        system_listening_ports; system_firewall_summary;;
    relay-test)
        [[ $(relay_get_role) == line ]] || { _fail '仅线路机支持中继测试'; exit 1; }
        test_failed=0
        while IFS= read -r landing; do
            mapfile -t fields < <(jq -r '.landing_ip,.landing_port,.transport_uuid,.encryption,.name' <<< "$landing")
            _do_single_relay_test "${fields[@]}" || test_failed=1
        done < <(relay_get_landings | jq -c '.[]')
        exit "$test_failed";;
    relay-keygen) relay_generate_vlessenc && jq -n --arg decryption "$vlessenc_decryption" --arg encryption "$vlessenc_encryption" '{decryption:$decryption,encryption:$encryption}';;
    uninstall)
        [[ $is_core_dir == /usr/local/etc/xray ]] || { _fail 'Uninstall requires the standard Xray root'; exit 1; }
        prompt_confirm() { return 0; }; uninstall;;
    *) _fail 'Command not permitted'; exit 1;;
esac
