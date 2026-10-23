#!/bin/bash

# Summarize configured ACCEPT ports reachable from INPUT, including UFW/custom chains.
# This is a rule inventory, not proof that earlier rules, other tables or cloud rules permit traffic.
filter_rule_summary() {
    awk '
        $1 == "-P" && $2 == "INPUT" {policy=$3}
        $1 == "-A" {
            n++; chain[n]=$2
            for (i=3; i<=NF; i++) {
                if ($i == "-j" || $i == "--jump" || $i == "-g" || $i == "--goto") target[n]=$(i+1)
                if (($i == "--dport" || $i == "--destination-port" || $i == "--dports" || $i == "--destination-ports") && $(i-1) != "!") ports[n]=$(i+1)
            }
        }
        END {
            reachable["INPUT"]=1
            do {
                changed=0
                for (i=1; i<=n; i++) if (reachable[chain[i]] && target[i] != "" && !reachable[target[i]]) {
                    reachable[target[i]]=1; changed=1
                }
            } while (changed)
            if (policy == "ACCEPT") print "POLICY ACCEPT"
            for (i=1; i<=n; i++) if (reachable[chain[i]] && target[i] == "ACCEPT" && ports[i] != "") {
                count=split(ports[i],parts,",")
                for (j=1; j<=count; j++) {
                    gsub(":","-",parts[j]); gsub(/"/,"",parts[j])
                    if (parts[j] ~ /^[0-9]+(-[0-9]+)?$/) print "PORT " parts[j]
                }
            }
        }'
}

system_firewall_summary() {
    local tool rules summary ports="" checked=0
    for tool in iptables ip6tables; do
        command -v "$tool" >/dev/null || continue
        if rules=$("$tool" -w 2 -S 2>/dev/null); then
            checked=1
            summary=$(filter_rule_summary <<< "$rules")
            ports+=$(awk '$1=="PORT" {print $2}' <<< "$summary")$'\n'
        fi
    done
    if command -v nft >/dev/null; then
        if rules=$(nft -j list ruleset 2>/dev/null) &&
            summary=$(jq -r -f "$is_sh_dir/src/status.jq" <<< "$rules" 2>/dev/null); then
            if [[ $summary == *CHECKED* ]]; then
                checked=1
                ports+=$(awk '$1=="PORT" {print $2}' <<< "$summary")$'\n'
            fi
        fi
    fi
    if (( ! checked )); then
        if command -v nft >/dev/null; then echo 'nftables（需查看规则）'
        else echo '无法读取系统规则'; fi
        return
    fi
    ports=$(printf '%s' "$ports" | sed '/^$/d' | sort -u | sort -n | paste -sd ',' -)
    printf '%s\n' "${ports:-无}"
}

system_listening_ports() {
    local output ep_min=32768 ep_max=60999
    if [[ -r /proc/sys/net/ipv4/ip_local_port_range ]]; then
        read -r ep_min ep_max < /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null || { ep_min=32768; ep_max=60999; }
    fi
    if command -v ss >/dev/null; then
        output=$(ss -H -lntu 2>/dev/null) || { echo '读取失败'; return; }
        output=$(awk -v min="$ep_min" -v max="$ep_max" '$1 ~ /^(tcp|udp)/ {n=split($5,a,":"); p=a[n]; if (p ~ /^[0-9]+$/) { if ($1 ~ /^udp/ && p >= min && p <= max) next; print p }}' <<< "$output")
    elif command -v netstat >/dev/null; then
        output=$(netstat -lntu 2>/dev/null) || { echo '读取失败'; return; }
        output=$(awk -v min="$ep_min" -v max="$ep_max" '$1 ~ /^(tcp|udp)/ {n=split($4,a,":"); p=a[n]; if (p ~ /^[0-9]+$/) { if ($1 ~ /^udp/ && p >= min && p <= max) next; print p }}' <<< "$output")
    else echo '缺少 ss/netstat'; return; fi
    output=$(printf '%s' "$output" | sed '/^$/d' | sort -nu | paste -sd ',' -)
    printf '%s\n' "${output:-无}"
}
