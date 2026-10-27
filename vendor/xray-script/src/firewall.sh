#!/bin/bash
# Own chains only: never flush INPUT/FORWARD, change their policies, or save others' rules.

firewall_ports_file=${firewall_ports_file:-$is_core_dir/firewall_ports.json}

firewall_tool_available() {
    local tool="$1"
    command -v "$tool" >/dev/null || return 1
    "$tool" -w 2 -S >/dev/null 2>&1
}

firewall_sync() {
    [[ ${config_staging:-0} == 1 ]] && return 0
    local role="" peer="" relay_port="" ports state='{"open":[],"closed":[]}' tool active next p signature cached=1
    [[ ! -f "$firewall_ports_file" ]] || state=$(cat "$firewall_ports_file")
    if [[ -f "$is_relay_state_file" ]]; then
        # A non-whitespace separator preserves an empty peer field.
        IFS='|' read -r role peer relay_port < <(jq -r '[.role // "", .peer_ip // "", (.listen_port // 0 | tostring)] | join("|")' "$is_relay_state_file")
    fi
    if ! firewall_tool_available iptables; then
        if [[ $role == landing ]]; then
            _info "当前环境不支持或缺少 iptables 权限（如无特权 LXC 容器），跳过落地机防火墙来源限制"
            return 0
        fi
        _info "当前环境不支持或缺少 iptables 权限，跳过防火墙规则配置"
        return 0
    fi
    ports=$(jq -sr --argjson state "$state" '
        ([.[] | .inbounds[]? | select(.streamSettings.security == "reality") | .port] + $state.open) |
        unique - $state.closed | .[]' "$is_conf_dir"/*.json 2>/dev/null) || return 1
    signature=$(printf '%s\n' firewall-v2 "$ports" "$state" "$role" "$peer" "$relay_port" | sha256sum | awk '{print $1}')
    if [[ $(cat "$is_core_dir/.firewall-signature" 2>/dev/null) == "$signature" ]]; then
        for tool in iptables ip6tables; do
            firewall_tool_available "$tool" || continue
            "$tool" -w 5 -C INPUT -j XRAY-SCRIPT 2>/dev/null || cached=0
        done
        (( ! cached )) || return 0
    fi
    # A partial dual-stack commit must never leave the previous cache valid.
    rm -f "$is_core_dir/.firewall-signature" || return 1
    for tool in iptables ip6tables; do
        firewall_tool_available "$tool" || continue
        "$tool" -w 5 -N XRAY-SCRIPT 2>/dev/null || "$tool" -w 5 -S XRAY-SCRIPT >/dev/null || return 1
        active=$("$tool" -w 5 -S XRAY-SCRIPT | awk '$1=="-A" {print $4; exit}')
        next=XRAY-PORTS-A
        [[ $active != XRAY-PORTS-A ]] || next=XRAY-PORTS-B
        "$tool" -w 5 -N "$next" 2>/dev/null || "$tool" -w 5 -F "$next" || return 1
        # Guard the private relay port even when the system INPUT policy is ACCEPT.
        if [[ $role == landing && $tool == iptables ]]; then
            if [[ "$relay_port" =~ ^[0-9]+$ ]] && (( relay_port >= 1 && relay_port <= 65535 )); then
                if [[ -n "$peer" && "$peer" =~ ^[0-9.]+$ ]]; then
                    "$tool" -w 5 -A "$next" -p tcp -s "$peer/32" --dport "$relay_port" -j ACCEPT || return 1
                    "$tool" -w 5 -A "$next" -p tcp --dport "$relay_port" -j DROP || return 1
                elif [[ -z "$peer" ]]; then
                    "$tool" -w 5 -A "$next" -p tcp --dport "$relay_port" -j ACCEPT || return 1
                else
                    _fail "落地机来源地址无效，保留原规则"
                    return 1
                fi
            fi
        fi
        while read -r p; do
            [[ -n "$p" ]] || continue
            "$tool" -w 5 -A "$next" -p tcp --dport "$p" -j DROP || return 1
            "$tool" -w 5 -A "$next" -p udp --dport "$p" -j DROP || return 1
        done < <(jq -r '.closed[]' <<< "$state")
        while read -r p; do
            [[ -n "$p" ]] || continue
            "$tool" -w 5 -A "$next" -p tcp --dport "$p" -j ACCEPT || return 1
            "$tool" -w 5 -A "$next" -p udp --dport "$p" -j ACCEPT || return 1
        done <<< "$ports"
        "$tool" -w 5 -A "$next" -j RETURN || return 1
        if [[ -n $active ]]; then
            "$tool" -w 5 -R XRAY-SCRIPT 1 -j "$next" || return 1
        else
            "$tool" -w 5 -A XRAY-SCRIPT -j "$next" || return 1
        fi
        "$tool" -w 5 -C INPUT -j XRAY-SCRIPT 2>/dev/null || "$tool" -w 5 -I INPUT 1 -j XRAY-SCRIPT || return 1
        if [[ $active == XRAY-PORTS-A || $active == XRAY-PORTS-B ]]; then
            "$tool" -w 5 -F "$active" && "$tool" -w 5 -X "$active" || return 1
        fi
    done
    printf '%s\n' "$signature" > "$is_core_dir/.firewall-signature"
}

firewall_set_port() {
    local action="$1" p="$2" state='{"open":[],"closed":[]}'
    [[ "$p" =~ ^[0-9]{1,5}$ ]] && (( 10#$p > 0 && 10#$p <= 65535 )) || return 1
    if [[ $(relay_get_role) == landing && $(jq -r '.listen_port' "$is_relay_state_file") == "$((10#$p))" ]]; then
        _fail "该端口用于落地互联，请在互联菜单调整或移除；来源限制由脚本维护"
        return 1
    fi
    [[ ! -f "$firewall_ports_file" ]] || state=$(cat "$firewall_ports_file")
    state=$(jq --arg action "$action" --argjson p "$((10#$p))" '
        .open -= [$p] | .closed -= [$p] |
        if $action == "open" then .open += [$p] elif $action == "close" then .closed += [$p] else error("unknown action") end
    ' <<< "$state") || return 1
    atomic_json "$firewall_ports_file" "$state"
}

open_port() {
    # Node edits derive their firewall rules from the staged config at commit.
    [[ ${config_staging:-0} == 1 ]] && return 0
    firewall_tool_available iptables || { _fail "当前环境不支持或缺少 iptables 权限"; return 1; }
    config_transaction firewall_set_port open "$1"
}
close_port() {
    [[ ${config_staging:-0} == 1 ]] && return 0
    firewall_tool_available iptables || { _fail "当前环境不支持或缺少 iptables 权限"; return 1; }
    config_transaction firewall_set_port close "$1"
}

relay_open_firewall() { [[ ${config_staging:-0} == 1 ]] || firewall_sync; }
relay_close_firewall() { [[ ${config_staging:-0} == 1 ]] || firewall_sync; }

firewall_remove() {
    local tool chain
    for tool in iptables ip6tables; do
        firewall_tool_available "$tool" || continue
        while "$tool" -w 5 -C INPUT -j XRAY-SCRIPT 2>/dev/null; do
            "$tool" -w 5 -D INPUT -j XRAY-SCRIPT || return 1
        done
        "$tool" -w 5 -F XRAY-SCRIPT 2>/dev/null || true
        for chain in XRAY-PORTS-A XRAY-PORTS-B XRAY-SCRIPT; do
            "$tool" -w 5 -F "$chain" 2>/dev/null || true
            "$tool" -w 5 -X "$chain" 2>/dev/null || true
        done
    done
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    is_core_dir=${XRAY_ROOT:-/usr/local/etc/xray}
    is_conf_dir="$is_core_dir/conf"
    is_relay_state_file="$is_core_dir/relay.json"
    firewall_ports_file="$is_core_dir/firewall_ports.json"
    _fail() { printf '%s\n' "$*" >&2; }
    _info() { printf '%s\n' "$*"; }
    firewall_sync
fi
