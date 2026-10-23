#!/bin/bash

_open_bbr() {
    local file=/etc/sysctl.d/99-xray-bbr.conf
    printf '%s\n' \
        'net.ipv4.tcp_congestion_control = bbr' \
        'net.core.default_qdisc = fq' \
        'net.core.somaxconn = 65535' \
        'net.ipv4.tcp_max_syn_backlog = 8192' > "$file" || return 1
    if sysctl -p "$file" >/dev/null 2>&1 &&
       [[ $(sysctl -n net.ipv4.tcp_congestion_control) == bbr ]]; then
        _ok "BBR 拥塞控制及网络队列优化已启用"
    else
        _info "BBR 设置未生效，请检查内核支持；节点配置不受影响"
        return 1
    fi
}

_try_enable_bbr() {
    modprobe tcp_bbr >/dev/null 2>&1 || true
    if sysctl -n net.ipv4.tcp_available_congestion_control | grep -qw bbr; then
        _open_bbr
    else
        _info "当前内核未提供 BBR，跳过"
    fi
}
