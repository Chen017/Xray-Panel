#!/bin/bash

fetch_file() {
    curl --fail --show-error --location --connect-timeout 10 --max-time 120 \
        --retry 2 --output "$2" "$1"
}

# Both geodata files must pass their published SHA256 and core validation before replacement.
update_geodata() (
    umask 077
    exec {operation_fd}>"$is_core_dir/.operation.lock" || exit 1
    flock -n "$operation_fd" || { _info "另一项配置或更新操作正在进行"; exit 1; }
    local stage name expected actual release changed=0 committed=0 completed=0 was_active=0
    stage=$(mktemp -d "$is_core_dir/.geodata.XXXXXX") || exit 1
    service_active && was_active=1
    cleanup_geodata() {
        local result=$? name
        trap - EXIT INT TERM
        if (( committed && ! completed )); then
            for name in geoip.dat geosite.dat; do
                if [[ -f "$stage/old/$name" ]]; then
                    cp -p "$stage/old/$name" "$is_core_dir/bin/$name.next" &&
                        mv -f "$is_core_dir/bin/$name.next" "$is_core_dir/bin/$name"
                else rm -f "$is_core_dir/bin/$name"; fi
            done
            (( ! was_active )) || manage restart || _fail "旧 geodata 已恢复，但服务恢复失败"
        fi
        for name in geoip.dat geosite.dat; do
            rm -f "$is_core_dir/bin/$name.next" "$is_core_dir/bin/$name.previous.next"
        done
        rm -rf "$stage"
        exit "$result"
    }
    trap cleanup_geodata EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    mkdir -p "$stage/bin" "$stage/old" || exit 1
    fetch_file 'https://api.github.com/repos/Loyalsoldier/v2ray-rules-dat/releases/latest' "$stage/release.json" || exit 1
    release=$(jq -er '.tag_name | select(type == "string" and length > 0) | @uri' "$stage/release.json") || exit 1
    for name in geoip.dat geosite.dat; do
        local url="https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/$release/$name"
        fetch_file "$url" "$stage/bin/$name" && fetch_file "$url.sha256sum" "$stage/$name.sha256sum" || exit 1
        expected=$(awk 'NR==1 {print tolower($1)}' "$stage/$name.sha256sum")
        actual=$(sha256sum "$stage/bin/$name" | awk '{print $1}')
        [[ $expected =~ ^[0-9a-f]{64}$ && $expected == "$actual" ]] || { _fail "$name 校验失败，保留现有数据"; exit 1; }
        if ! cmp -s "$stage/bin/$name" "$is_core_dir/bin/$name"; then changed=1; fi
        [[ ! -f "$is_core_dir/bin/$name" ]] || cp -p "$is_core_dir/bin/$name" "$stage/old/$name" || exit 1
    done
    (( changed )) || { _info "geodata 未变化，无需重启"; exit 0; }
    XRAY_LOCATION_ASSET="$stage/bin" validate_config || exit 1
    for name in geoip.dat geosite.dat; do
        [[ ! -f "$stage/old/$name" ]] || {
            cp -p "$stage/old/$name" "$is_core_dir/bin/$name.previous.next" &&
                mv -f "$is_core_dir/bin/$name.previous.next" "$is_core_dir/bin/$name.previous"
        } || exit 1
    done
    committed=1
    for name in geoip.dat geosite.dat; do
        cp "$stage/bin/$name" "$is_core_dir/bin/$name.next" &&
            mv -f "$is_core_dir/bin/$name.next" "$is_core_dir/bin/$name" || exit 1
    done
    if (( was_active )); then manage restart || exit 1; fi
    completed=1
    _ok "geodata 更新成功"
)

remove_legacy_geodata_cron() {
    command -v crontab >/dev/null || return 0
    local before after
    before=$(crontab -l 2>/dev/null) || return 0
    after=$(awk -v command="$is_sh_dir/update_geodata.sh" '$6 != command {print}' <<< "$before")
    [[ $before == "$after" ]] || printf '%s\n' "$after" | crontab -
}

install_maintenance() {
    local root="${XRAY_SYSTEMD_DIR:-/etc/systemd/system}" version=2
    [[ ${1:-} == force || $(cat "$is_core_dir/.maintenance-version" 2>/dev/null) != "$version" ]] || return 0
    mkdir -p "$root/$is_core.service.d" "$is_log_dir" || return 1
    cat > "$root/xray-firewall.service" <<EOF
[Unit]
Description=Xray managed firewall chains
After=network-pre.target netfilter-persistent.service firewalld.service nftables.service ufw.service
Before=xray.service
[Service]
Type=oneshot
ExecStart=/bin/bash $is_sh_dir/src/firewall.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
    cat > "$root/$is_core.service.d/firewall.conf" <<'EOF'
[Unit]
Requires=xray-firewall.service
After=xray-firewall.service
EOF
    cat > "$root/xray-geodata.service" <<EOF
[Unit]
Description=Update Xray geodata safely
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/bin/bash $is_sh_dir/update_geodata.sh
EOF
    cat > "$root/xray-geodata.timer" <<'EOF'
[Unit]
Description=Daily Xray geodata update
[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=5m
Persistent=true
[Install]
WantedBy=timers.target
EOF
    # copytruncate avoids restarting the proxy or requiring an otherwise unused API.
    if command -v logrotate >/dev/null; then
        mkdir -p "${XRAY_LOGROTATE_DIR:-/etc/logrotate.d}" || return 1
        cat > "${XRAY_LOGROTATE_DIR:-/etc/logrotate.d}/xray-script" <<EOF
$is_log_dir/*.log {
    daily
    maxsize 20M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su root root
}
EOF
    fi
    systemctl daemon-reload && systemctl enable --now xray-firewall.service xray-geodata.timer || return 1
    remove_legacy_geodata_cron || return 1
    printf '%s\n' "$version" > "$is_core_dir/.maintenance-version"
}

migrate_dual_stack_listeners() {
    local file json listen4=""
    for file in "$is_conf_dir"/*.json; do
        [[ -f "$file" ]] || continue
        jq -e 'any(.inbounds[]?; (.tag // "" | test("^public_[0-9]+_v[46]$")))' "$file" >/dev/null || continue
        if jq -e 'any(.inbounds[]?; (.tag // "" | test("^public_[0-9]+_v4$")) and .listen=="0.0.0.0")' "$file" >/dev/null; then
            [[ -n "$listen4" ]] || listen4=$(node_ipv4_listen_address) || return 1
        fi
        json=$(jq --arg listen4 "$listen4" '
            (.inbounds[]? | select((.tag // "" | test("^public_[0-9]+_v4$")) and .listen=="0.0.0.0")).listen = $listen4 |
            (.inbounds[]? | select((.tag // "" | test("^public_[0-9]+_v6$")) and .listen=="::")).streamSettings.sockopt.v6only = true
        ' "$file") || return 1
        atomic_json "$file" "$json" || return 1
    done
}

apply_schema_migration() {
    local file json
    # Keep the recent upstream relay fixes; do not remove valid REALITY options or reset DNS preferences.
    if [[ $(relay_get_role) == line ]]; then
        json=$(jq '(.outbounds[]? | select(.tag == "relay-out" or (.tag | startswith("relay-out-")))) |= (
            if .settings.flow == "xtls-rprx-vision-udp443" then .settings.flow = "xtls-rprx-vision" else . end |
            if .settings.vnext then (.settings.vnext[].users[]? | select(.flow == "xtls-rprx-vision-udp443")).flow = "xtls-rprx-vision" else . end |
            del(.streamSettings.sockopt.tcpFastOpen)
        )' "$is_config_json") || return 1
        atomic_json "$is_config_json" "$json" || return 1
    fi
    file="$is_conf_dir/99_relay_in.json"
    if [[ -f "$file" ]]; then
        json=$(jq '(.inbounds[]? | select(.tag == "relay-in")) |= del(.streamSettings.sockopt.tcpFastOpen)' "$file") || return 1
        atomic_json "$file" "$json" || return 1
    fi
    migrate_dual_stack_listeners || return 1
    printf '%s\n' 2 > "${is_config_json%/*}/.schema-version"
}

migrate_installation() {
    [[ $(cat "$is_core_dir/.schema-version" 2>/dev/null) == 2 ]] && return 0
    config_transaction apply_schema_migration
}
