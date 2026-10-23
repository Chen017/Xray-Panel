#!/bin/bash
# Shared configuration operations. Callers generate files only in the staged tree.

# ─── Standard Prompts & UI Helpers ────────────────────────
prompt_confirm() {
    local prompt_msg="$1"
    local default="${2:-y}"
    local reply
    if [[ "$default" == "y" ]]; then
        echo -ne "  ${prompt_msg} [${green}Y${none}/n]: "
    else
        echo -ne "  ${prompt_msg} [y/${green}N${none}]: "
    fi
    read -r reply || return 1
    reply=${reply:-$default}
    [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]]
}

prompt_input() {
    local prompt_msg="$1"
    local var_name="$2"
    local default_val="$3"
    printf -v "$var_name" '%s' ''
    if [[ -n "$default_val" ]]; then
        echo -ne "  ${prompt_msg} (默认: ${cyan}${default_val}${none}): "
    else
        echo -ne "  ${prompt_msg}: "
    fi
    local reply
    read -r reply || return 1
    printf -v "$var_name" '%s' "${reply:-$default_val}"
}

_section() { echo -e "${cyan} ── $* ──${none}"; }
_menu() { printf "  ${green}%2s.${none} %s\n" "$1" "$2"; }

service_active() { systemctl is-active --quiet "$is_core"; }

manage() {
    local action="$1" label="$1" manage_fd="" result=0
    case "$action" in
        1|start) action=start; label=启动 ;;
        2|stop) action=stop; label=停止 ;;
        3|r|restart) action=restart; label=重启 ;;
        enable|disable) ;;
        *) _fail "无法识别服务操作: $action"; return 1 ;;
    esac
    [[ ${config_staging:-0} == 1 ]] && return 0
    if [[ -z ${operation_fd:-} ]]; then
        exec {manage_fd}>"$is_core_dir/.operation.lock" || return 1
        if ! flock -n "$manage_fd"; then
            exec {manage_fd}>&-
            _fail "另一项配置或更新操作正在进行"
            return 1
        fi
    fi
    if [[ -n $manage_fd && ( $action == start || $action == restart ) ]]; then
        validate_config || result=1
    fi
    if (( result == 0 )); then
        systemctl "$action" "$is_core" || { _fail "服务${label}失败，请查看错误日志"; result=1; }
    fi
    if (( result == 0 )) && [[ $action == start || $action == restart ]]; then
        sleep 0.2
        service_active || { _fail "服务未能保持运行，请查看错误日志"; result=1; }
    fi
    [[ -z $manage_fd ]] || exec {manage_fd}>&-
    return "$result"
}

configuration_content() {
    local root="$1" file
    local -a files=()
    [[ ! -f "$root/config.json" ]] || files+=("$root/config.json")
    for file in "$root/conf"/*.json; do
        [[ ! -f "$file" ]] || files+=("$file")
    done
    if (( ${#files[@]} )); then jq -Scs . "${files[@]}"; else echo '[]'; fi
}

validate_config() {
    local output
    output=$("$is_core_bin" run -test -config "$is_config_json" -confdir "$is_conf_dir" 2>&1) || {
        _fail "配置校验失败，原配置未被替换"
        printf '%s\n' "$output" >&2
        return 1
    }
}

atomic_json() {
    local target="$1" content="$2" temporary
    temporary=$(mktemp "${target}.XXXXXX") || return 1
    if ! printf '%s\n' "$content" | jq -e . > "$temporary"; then
        rm -f "$temporary"
        return 1
    fi
    if ! chmod 600 "$temporary" || ! mv -f "$temporary" "$target"; then
        rm -f "$temporary"
        return 1
    fi
}

# P1 is automatic failure recovery, not a user-facing history/restore feature.
config_transaction() {
    if [[ ${config_staging:-0} == 1 ]]; then
        "$@"
        return $?
    fi
    (
        umask 077
        local real_root="$is_core_dir" stage was_active=0 committed=0 completed=0 item restart_required=0
        local -a owned=(config.json conf relay.json custom_rules.json firewall_ports.json .schema-version)
        mkdir -p "$real_root" || exit 1
        exec {operation_fd}>"$real_root/.operation.lock" || exit 1
        flock -n "$operation_fd" || { _fail "另一项配置或更新操作正在进行，请稍后重试"; exit 1; }
        stage=$(mktemp -d "$real_root/.transaction.XXXXXX") || exit 1
        trap 'rm -rf "$stage"' EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        mkdir -p "$stage/old" "$stage/new" || exit 1
        service_active && was_active=1
        for item in "${owned[@]}"; do
            if [[ -e "$real_root/$item" ]]; then
                cp -a "$real_root/$item" "$stage/old/$item" || exit 1
                cp -a "$real_root/$item" "$stage/new/$item" || exit 1
            fi
        done
        mkdir -p "$stage/new/conf" || exit 1
        # Restore only this script's files and firewall chain on any failed commit/signal.
        transaction_cleanup() {
            local result=$? item
            trap - EXIT INT TERM
            if (( committed && ! completed )); then
                for item in "${owned[@]}"; do
                    rm -rf "$real_root/$item"
                    [[ ! -e "$stage/old/$item" ]] || cp -a "$stage/old/$item" "$real_root/$item"
                done
                is_config_json="$real_root/config.json"
                is_conf_dir="$real_root/conf"
                is_relay_state_file="$real_root/relay.json"
                firewall_ports_file="$real_root/firewall_ports.json"
                config_staging=0
                firewall_sync || _fail "原防火墙规则恢复失败，请检查系统防火墙"
                if (( was_active )); then
                    manage restart || _fail "原配置已恢复，但服务恢复失败，请查看错误日志"
                else
                    systemctl stop "$is_core" >/dev/null 2>&1 || true
                fi
                _fail "操作失败，已恢复原配置"
            fi
            for item in "${owned[@]}"; do rm -f "$real_root/$item.next"; done
            rm -rf "$stage"
            exit "$result"
        }
        trap transaction_cleanup EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM
        local is_config_json="$stage/new/config.json" is_conf_dir="$stage/new/conf"
        local is_relay_state_file="$stage/new/relay.json" is_custom_rules_file="$stage/new/custom_rules.json"
        local firewall_ports_file="$stage/new/firewall_ports.json" config_staging=1
        "$@" || exit 1
        if diff -qr "$stage/old" "$stage/new" >/dev/null 2>&1; then
            _info "配置未变化，无需重启"
            exit 0
        fi
        validate_config || exit 1
        [[ $(configuration_content "$stage/old") == "$(configuration_content "$stage/new")" ]] || restart_required=1
        committed=1
        for item in "${owned[@]}"; do
            if [[ -d "$stage/new/$item" ]]; then
                # The process keeps its old in-memory config until the single restart below.
                rm -rf "$real_root/$item"
                cp -a "$stage/new/$item" "$real_root/$item" || exit 1
            elif [[ -f "$stage/new/$item" ]]; then
                cp -a "$stage/new/$item" "$real_root/$item.next" &&
                    mv -f "$real_root/$item.next" "$real_root/$item" || exit 1
            else
                rm -f "$real_root/$item" || exit 1
            fi
        done
        is_config_json="$real_root/config.json"
        is_conf_dir="$real_root/conf"
        is_relay_state_file="$real_root/relay.json"
        firewall_ports_file="$real_root/firewall_ports.json"
        config_staging=0
        firewall_sync || exit 1
        if (( restart_required && was_active )) || [[ ${is_new_install:-} ]]; then
            manage restart || exit 1
            _ok "配置已保存，服务重启成功"
        elif (( ! was_active )); then
            _ok "配置已保存；服务保持停止状态"
        else
            _ok "设置已保存，无需重启服务"
        fi
        completed=1
    )
}

set_log_level() {
    local json
    json=$(jq --arg level "$1" '.log.loglevel = $level' "$is_config_json") || return 1
    atomic_json "$is_config_json" "$json"
}

supports_happy_eyeballs() {
    local version
    version=$("$is_core_bin" version | awk 'NR==1 {print $2}')
    version=${version#v}
    # Released in v25.6.8; older cores silently ignore unknown JSON fields.
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    [[ $(printf '%s\n' 25.6.8 "$version" | sort -V | head -1) == 25.6.8 ]]
}

set_outbound_strategy() {
    local choice="$1" json
    if [[ $choice == HappyEyeballs4 || $choice == HappyEyeballs6 ]]; then
        supports_happy_eyeballs || { _fail "连接竞速需要 Xray v25.6.8 或更新版本，请先更新内核"; return 1; }
        json=$(jq --argjson prefer "$([[ $choice == HappyEyeballs6 ]] && echo true || echo false)" '
            (.outbounds[] | select(.tag == "direct")) |= (
                .settings.domainStrategy = "AsIs" | .settings.targetStrategy = "AsIs" |
                .streamSettings.sockopt.domainStrategy = "UseIP" |
                .streamSettings.sockopt.happyEyeballs = {
                    tryDelayMs:250, prioritizeIPv6:$prefer, interleave:1, maxConcurrentTry:4
                }
            )' "$is_config_json") || return 1
    else
        case "$choice" in UseIPv4|UseIPv6|UseIPv4v6|UseIPv6v4) ;; *) return 1 ;; esac
        json=$(jq --arg strategy "$choice" '
            (.outbounds[] | select(.tag == "direct")) |= (
                .settings.domainStrategy = $strategy | del(.settings.targetStrategy) |
                del(.streamSettings.sockopt.domainStrategy, .streamSettings.sockopt.happyEyeballs) |
                if .streamSettings.sockopt == {} then del(.streamSettings.sockopt) else . end |
                if .streamSettings == {} then del(.streamSettings) else . end
            )' "$is_config_json") || return 1
    fi
    atomic_json "$is_config_json" "$json"
}

outbound_label() {
    case "$1" in
        HappyEyeballs4) echo '双栈连接竞速（IPv4先尝试）' ;;
        HappyEyeballs6) echo '双栈连接竞速（IPv6先尝试）' ;;
        UseIPv4) echo 'IPv4解析，失败时使用系统解析' ;;
        UseIPv6) echo 'IPv6解析，失败时使用系统解析' ;;
        UseIPv4v6) echo 'IPv4解析优先，无结果时查IPv6' ;;
        UseIPv6v4) echo 'IPv6解析优先，无结果时查IPv4' ;;
        *) printf '%s\n' "$1" ;;
    esac
}

outbound_strategy() {
    jq -r '.outbounds[]? | select(.tag == "direct") |
        if (.streamSettings.sockopt.happyEyeballs.tryDelayMs // 0) > 0 then
            if .streamSettings.sockopt.happyEyeballs.prioritizeIPv6 then "HappyEyeballs6" else "HappyEyeballs4" end
        else .settings.targetStrategy // .settings.domainStrategy // .streamSettings.sockopt.domainStrategy // "AsIs" end' "$is_config_json"
}
