#!/bin/bash
# Read-only connectivity check shared by Script and Panel Agent. No Xray changes.
probe_domestic() {
    local host
    for host in sh-cm-dualstack.ip.zstaticcdn.com sh-cu-dualstack.ip.zstaticcdn.com sh-ct-dualstack.ip.zstaticcdn.com; do
        if timeout 2 bash -c 'echo > /dev/tcp/"$1"/80' _ "$host" &>/dev/null; then return 0; fi
    done
    return 1
}
probe_global() {
    local ip
    for ip in 1.1.1.1 1.0.0.1; do
        # ICMP may be disabled: a successful Cloudflare TCP connection is also evidence.
        if timeout 3 ping -n -c 1 -W 2 "$ip" &>/dev/null; then return 0; fi
        if timeout 2 bash -c 'echo > /dev/tcp/"$1"/443' _ "$ip" &>/dev/null; then return 0; fi
    done
    return 1
}
probe_network() (
    local work domestic=false global=false code=network_unreachable pid
    local -a pids=()
    work=$(mktemp -d) || return 1
    trap 'for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf -- "$work"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    (if probe_domestic; then echo true; else echo false; fi) > "$work/domestic" & pids+=("$!")
    (if probe_global; then echo true; else echo false; fi) > "$work/global" & pids+=("$!")
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    pids=()
    domestic=$(cat "$work/domestic"); global=$(cat "$work/global")
    [[ $domestic == true || $domestic == false ]] && [[ $global == true || $global == false ]] || return 1
    if [[ $domestic == true && $global == true ]]; then code=ok
    elif [[ $global == true ]]; then code=domestic_unreachable
    elif [[ $domestic == true ]]; then code=global_unreachable; fi
    printf '{"domestic":%s,"global":%s,"code":"%s"}\n' "$domestic" "$global" "$code"
)
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    [[ ${1:-} == --json && $# == 1 ]] || { echo 'Usage: network_probe.sh --json' >&2; exit 2; }
    probe_network
fi
