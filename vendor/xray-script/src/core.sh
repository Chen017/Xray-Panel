#!/bin/bash

change_list=(
    "更改端口"
    "更改 xhttp 路径"
    "重新生成 UUID"
    "重新生成密钥"
    "更改 v4 目标域名 (SNI/Dest)"
    "更改 v6 目标域名 (SNI/Dest)"
    "重新生成 v4 Short IDs"
    "重新生成 v6 Short IDs"
    "切换分离类型"
    "管理自定义分流规则"
    "切换出站 IP 优先"
)
# 默认 SNI: 上行固定 hahuma.com，下行固定 dodoshort.com
DEFAULT_UPLINK_SNI="hahuma.com"
DEFAULT_DOWNLINK_SNI="dodoshort.com"

# 纯 CDN 厂商黑名单（仅 fallback 场景使用，排除同时提供云主机的厂商如 Akamai/Amazon/Google/Microsoft）
CDN_BLACKLIST_STRICT="Cloudflare|Fastly|CloudFront|Incapsula|Imperva|Edgecast|StackPath|KeyCDN"

msg() {
    echo -e "$*"
}

msg_ul() {
    echo -e "\e[4m$*\e[0m"
}

get_uuid() {
    tmp_uuid=$("$is_core_bin" uuid)
}

get_short_ids() {
    is_short_id_8=$(openssl rand -hex 4)
    is_short_id_16=$(openssl rand -hex 8)
    is_short_ids='["'$is_short_id_8'","'$is_short_id_16'"]'
}

get_ip() {
    [[ $ip || $is_dont_get_ip || $is_get_ip_done ]] && return
    export is_get_ip_done=1

    local is_local_ip=$(ip route get 1.1.1.1 2>/dev/null | grep -Eo 'src [0-9.]+' | awk '{print $2}')
    if [[ $is_local_ip ]] && ! echo "$is_local_ip" | grep -qE '^(10|127|192\.168|172\.(1[6-9]|2[0-9]|3[0-1])|100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7]))\.'; then
        export ip=$is_local_ip
    else
        export "$(_wget -T 2 -4 -qO- https://one.one.one.one/cdn-cgi/trace | grep ip=)" &>/dev/null
    fi

    [[ ! $ip ]] && export "$(_wget -T 2 -6 -qO- https://one.one.one.one/cdn-cgi/trace | grep ip=)" &>/dev/null
    [[ ! $ip ]] && {
        err "获取服务器 IP 失败"
    }
}

get_ipv6() {
    [[ $ipv6 || $is_dont_get_ip || $is_get_ipv6_done ]] && return
    export is_get_ipv6_done=1

    local is_local_ipv6=$(ip route get 2606:4700:4700::1111 2>/dev/null | grep -Eo 'src [0-9a-fA-F:]+' | awk '{print $2}')
    if [[ $is_local_ipv6 ]] && ! echo "$is_local_ipv6" | grep -qE '^(fe80|fd|fc|::1)'; then
        export ipv6=$is_local_ipv6
    else
        export "ipv6=$(_wget -T 2 -6 -qO- https://one.one.one.one/cdn-cgi/trace | grep ip= | cut -d= -f2)" &>/dev/null
    fi
}

# Go's "tcp" wildcard listeners can both become dual-stack SO_REUSEPORT sockets.
# Bind the v4 entry to a concrete local address so the two REALITY SNIs cannot mix.
node_ipv4_listen_address() {
    local candidate
    command -v ip >/dev/null || { _fail "无法确定 IPv4 监听地址：需要 ip 命令"; return 1; }
    candidate=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") {print $(i+1); exit}}')
    if relay_validate_ipv4 "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
    while IFS= read -r candidate; do
        if relay_validate_ipv4 "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
    done < <(ip -o -4 address show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]}')
    # An IPv6-only host still needs a non-overlapping, local-only v4 entry.
    printf '%s\n' 127.0.0.1
}

get_port() {
    tmp_port=443
    if [[ $(is_test port_used 443) ]]; then
        _yellow "  [警告] 标准 HTTPS 端口 (443) 已被占用，回落至备用端口 (8443)"
        tmp_port=8443
        if [[ $(is_test port_used 8443) ]]; then
            err "标准端口 (443) 与备用端口 (8443) 均被占用!\n         为保障协议伪装的安全性和隐蔽性，本脚本仅支持这两个端口。\n         请释放端口后再试。"
        fi
    fi
}

get_pbk() {
    is_tmp_pbk=($($is_core_bin x25519 | sed 's/.*://'))
    is_private_key=${is_tmp_pbk[0]}
    is_public_key=${is_tmp_pbk[1]}
}

get_default_sni() {
    # 根据路由模式分配默认 SNI，确保上行始终为 hahuma.com，下行始终为 dodoshort.com
    if [[ $is_v6_uplink ]]; then
        # v6 上行模式：v6_sni 是上行，v4_sni 是下行
        tmp_v4_sni=$DEFAULT_DOWNLINK_SNI
        tmp_v6_sni=$DEFAULT_UPLINK_SNI
    else
        # v4 上行模式（默认）：v4_sni 是上行，v6_sni 是下行
        tmp_v4_sni=$DEFAULT_UPLINK_SNI
        tmp_v6_sni=$DEFAULT_DOWNLINK_SNI
    fi
}

# 多 DNS 视角 CDN 检测：向多个地理分散的公共 DNS 查询，去重后 IP > 1 即判定为 CDN


show_list() {
    local i=0
    for v in "$@"; do
        ((i++))
        printf "  ${green}%2s)${none} %s\n" "$i" "$v"
    done
    echo
}

is_test() {
    case $1 in
    number)
        [[ $2 =~ ^[1-9][0-9]*$ ]] && echo "$2"
        ;;
    port)
        if [[ $(is_test number $2) ]]; then
            [[ $2 -le 65535 ]] && echo ok
        fi
        ;;
    port_used)
        [[ $(is_port_used $2) && ! $is_cant_test_port ]] && echo ok
        ;;
    domain)
        [[ $2 =~ ^([a-zA-Z0-9][a-zA-Z0-9-]*\.)+[a-zA-Z][a-zA-Z0-9-]*$ && ${#2} -le 253 ]] && echo "$2"
        ;;
    path)
        echo $2 | grep -E -i '^\/\w(\w|\-|\/)?+\w$'
        ;;
    uuid)
        echo "$2" | grep -E -i '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ;;
    esac

}

is_port_used() {
    if [[ $(type -P netstat) ]]; then
        [[ ! $is_used_port ]] && is_used_port="$(netstat -tunlp | sed -n 's/.*:\([0-9]\+\).*/\1/p' | sort -nu)"
        echo $is_used_port | sed 's/ /\n/g' | grep ^${1}$
        return
    fi
    if [[ $(type -P ss) ]]; then
        [[ ! $is_used_port ]] && is_used_port="$(ss -tunlp | sed -n 's/.*:\([0-9]\+\).*/\1/p' | sort -nu)"
        echo $is_used_port | sed 's/ /\n/g' | grep ^${1}$
        return
    fi
    is_cant_test_port=1
    _fail "无法检测端口是否可用"
    _info "请执行: $(_yellow "${cmd} update -y; ${cmd} install net-tools -y") 来修复此问题"
}

# ─── list managed regular node configs (excludes 99_relay_in.json) ───
list_managed_node_configs() {
    local file pattern="${1:-\.json$}"
    for file in "$is_conf_dir"/*.json; do
        [[ -f "$file" && ${file##*/} != 99_relay_in.json ]] || continue
        [[ ${file##*/} =~ $pattern ]] && printf '%s\n' "${file##*/}"
    done
    return 0
}


# ask input a string or pick a option for list.
ask() {
    case $1 in
    set_change_list)
        is_tmp_list=()
    for v in "${is_can_change[@]}"; do
            is_tmp_list+=("${change_list[$v]}")
        done
        is_opt_msg="\n  请选择更改:\n"
        is_ask_set=is_change_str
        is_opt_input_msg=$3
        ;;
    string)
        is_ask_set=$2
        is_opt_input_msg=$3
        ;;
    list)
        is_ask_set=$2
        [[ ! $is_tmp_list ]] && is_tmp_list=($3)
        is_opt_msg=$4
        is_opt_input_msg=$5
        ;;
    get_config_file)
        is_tmp_list=("${is_all_json[@]}")
        is_opt_msg="\n  请选择配置:\n"
        is_ask_set=is_config_file
        ;;
    esac
    msg $is_opt_msg
    [[ ! $is_opt_input_msg ]] && is_opt_input_msg="  请选择 [\e[91m1-${#is_tmp_list[@]}\e[0m] [0 返回]:"
    [[ $is_tmp_list ]] && show_list "${is_tmp_list[@]}"
    while :; do
        echo -ne "$is_opt_input_msg "
        read -r REPLY || { REPLY=0; unset is_tmp_list is_default_arg; return 1; }
        [[ $REPLY == "0" ]] && {
            unset is_opt_msg is_opt_input_msg is_tmp_list is_ask_result is_default_arg
            return
        }
        [[ ! $REPLY && $is_default_arg ]] && {
            [[ $is_default_arg != "empty_allowed" ]] && export $is_ask_set="$is_default_arg"
            break
        }
        if [[ ! $is_tmp_list ]]; then
            [[ $(grep port <<<$is_ask_set) ]] && {
                [[ ! $(is_test port "$REPLY") ]] && {
                    _fail "请输入正确的端口, 可选 (1-65535)"
                    continue
                }
                if [[ $(is_test port_used $REPLY) && $is_ask_set != 'door_port' ]]; then
                    _fail "无法使用 ($REPLY) 端口"
                    continue
                fi
            }
            [[ $(grep path <<<$is_ask_set) && ! $(is_test path "$REPLY") ]] && {
                [[ ! $tmp_uuid ]] && get_uuid
                _fail "请输入正确的路径, 例如: /$tmp_uuid"
                continue
            }
            [[ $(grep uuid <<<$is_ask_set) && ! $(is_test uuid "$REPLY") ]] && {
                [[ ! $tmp_uuid ]] && get_uuid
                _fail "请输入正确的 UUID, 例如: $tmp_uuid"
                continue
            }
            [[ $(grep ^y$ <<<$is_ask_set) ]] && {
                [[ $(grep -i ^y$ <<<"$REPLY") ]] && break
                _info "请输入 (y)"
                continue
            }
            [[ $REPLY ]] && export "$is_ask_set=$REPLY" && _ok "使用: ${!is_ask_set}" && break
        else
            [[ $(is_test number "$REPLY") ]] && is_ask_result=${is_tmp_list[$REPLY - 1]}
            [[ $is_ask_result ]] && export $is_ask_set="$is_ask_result" && _ok "选择: ${!is_ask_set}" && break
        fi

        _fail "输入有误，请重试"
    done
    unset is_opt_msg is_opt_input_msg is_tmp_list is_ask_result is_default_arg
}

# create file
create() { config_transaction _create "$@"; }

_create() {
    case $1 in
    server)
        get new || return 1

        is_config_name=${2}-${port}.json
        is_json_file=$is_conf_dir/$is_config_name


        [[ $(is_test domain "$v4_sni") && $(is_test domain "$v6_sni") ]] || {
            _fail "SNI 必须是有效域名，请检查 IPv4/IPv6 目标域名"
            return 1
        }
        local relay_uuid="" listen4
        listen4=$(node_ipv4_listen_address) || return 1
        if [[ $(relay_get_role) == line ]]; then
            relay_uuid=$(jq -r '.client_uuid // empty' "$is_relay_state_file") || return 1
        fi
        is_new_json=$(jq -n --argjson port "$port" --arg uuid "$uuid" --arg listen4 "$listen4" \
            --arg private_key "$is_private_key" --arg public_key "$is_public_key" \
            --arg sni4 "$v4_sni" --arg sni6 "$v6_sni" \
            --arg path "${v4_path:-/api/v3/updates}" --arg relay_uuid "$relay_uuid" \
            --argjson sid4 "${v4_short_ids:-$is_short_ids}" --argjson sid6 "${v6_short_ids:-$is_short_ids}" \
            -f "$is_sh_dir/src/node.jq") || return 1
        atomic_json "$is_json_file" "$is_new_json" || return 1
        if [[ $(relay_get_role) == line ]]; then
            relay_sync_client_identities || return 1
        fi
        if [[ -n "$is_config_file" && $is_config_file != "$is_config_name" ]]; then
            rm -f "$is_conf_dir/$is_config_file" || return 1
        fi

        if [[ -n "$is_new_install" ]]; then
            echo
            _ok "VLESS-REALITY 节点基础配置生成完毕"
            _kv "监听端口:" "$port"
            _kv "UUID:" "$uuid"
            _kv "分离模式:" "${is_route_mode:-v4上行/v6下行}"
            echo
        fi



        if [[ $is_new_install ]]; then
            create config.json
        else
            return 0
        fi
        ;;
    config.json)
        cat <<EOF >"$is_config_json"
{
    "log": {
        "access": "$is_log_dir/access.log",
        "error": "$is_log_dir/error.log",
        "loglevel": "warning"
    },
    "dns": {
        "servers": [
            "localhost",
            "1.1.1.1",
            "8.8.8.8"
        ]
    },

    "outbounds": [
        {
            "protocol": "freedom",
            "tag": "direct",
            "settings": {
                "domainStrategy": "UseIPv4v6"
            }
        },
        {
            "protocol": "freedom",
            "tag": "direct-v4",
            "settings": {
                "domainStrategy": "UseIPv4"
            }
        },
        {
            "protocol": "freedom",
            "tag": "direct-v6",
            "settings": {
                "domainStrategy": "UseIPv6"
            }
        },
        {
            "protocol": "blackhole",
            "tag": "block"
        }
    ],
    "routing": {
        "domainStrategy": "IPIfNonMatch",
        "rules": [
            {
                "type": "field",
                "domain": [
                    "geosite:cn"
                ],
                "outboundTag": "block"
            },
            {
                "type": "field",
                "ip": [
                    "geoip:cn",
                    "geoip:private"
                ],
                "outboundTag": "block"
            },
            {
                "type": "field",
                "protocol": [
                    "bittorrent"
                ],
                "outboundTag": "block"
            }
        ]
    }
}
EOF
        chmod 644 "$is_config_json"
        # inject custom rules into config.json if they exist
        apply_custom_rules || return 1
        ;;
    esac
}

# ─── relay state management ──────────────────────────────
is_relay_state_file=${is_relay_state_file:-$is_core_dir/relay.json}

relay_state_exists() {
    [[ -f $is_relay_state_file ]]
}

relay_get_role() {
    if relay_state_exists; then
        jq -r '.role // empty' "$is_relay_state_file" 2>/dev/null
    fi
}

relay_get_landings() {
    [[ -f "$is_relay_state_file" ]] || { echo '[]'; return 0; }
    jq -c '
        if .landings and (.landings | type == "array") then
            .landings
        elif .landing_ip then
            [{
                id: "1",
                name: (.name // "默认落地"),
                landing_ip: .landing_ip,
                landing_port: (.landing_port // .listen_port // 0),
                transport_uuid: (.transport_uuid // ""),
                encryption: (.encryption // ""),
                client_uuid: (.client_uuid // "")
            }]
        else
            []
        end
    ' "$is_relay_state_file" 2>/dev/null || echo '[]'
}

relay_get_failover() {
    [[ -f "$is_relay_state_file" ]] || { echo '{"enabled":false,"interval":"60s","order":[]}'; return 0; }
    jq -c '.failover // {"enabled":false,"interval":"60s","order":[]}' "$is_relay_state_file" 2>/dev/null || echo '{"enabled":false,"interval":"60s","order":[]}'
}

relay_save_state() {
    atomic_json "$is_relay_state_file" "$1"
}

relay_delete_state() {
    rm -f "$is_relay_state_file"
}

# ─── custom routing rules management ─────────────────────
is_custom_rules_file=$is_core_dir/custom_rules.json

load_custom_rules() {
    if [[ -f $is_custom_rules_file ]]; then
        cat $is_custom_rules_file
    else
        echo '[]'
    fi
}

save_custom_rules() {
    atomic_json "$is_custom_rules_file" "$1"
}

# parse user input like "DOMAIN-SUFFIX,kimi.ai" into jq-compatible rule fields
# sets: _rule_field ("domain" or "ip" or "protocol"), _rule_value (xray format value)
parse_rule_input() {
    local input="$1"
    local rule_type=$(echo "$input" | cut -d',' -f1 | tr 'a-z' 'A-Z' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    local rule_val=$(echo "$input" | cut -d',' -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    [[ -z "$rule_val" ]] && return 1

    case $rule_type in
    DOMAIN)
        _rule_field="domain"
        _rule_value="full:$rule_val"
        ;;
    DOMAIN-SUFFIX)
        _rule_field="domain"
        _rule_value="domain:$rule_val"
        ;;
    DOMAIN-KEYWORD)
        _rule_field="domain"
        _rule_value="keyword:$rule_val"
        ;;
    IP-CIDR)
        _rule_field="ip"
        _rule_value="$rule_val"
        ;;
    GEOSITE)
        _rule_field="domain"
        _rule_value="geosite:$rule_val"
        ;;
    GEOIP)
        _rule_field="ip"
        _rule_value="geoip:$rule_val"
        ;;
    *)
        return 1
        ;;
    esac
    return 0
}

# convert internal rule value back to display format
rule_to_display() {
    local field="$1"
    local value="$2"
    local tag="$3"
    local action="direct"
    [[ "$tag" == "block" ]] && action="block"
    [[ "$tag" == "direct-v4" ]] && action="IPv4解析"
    [[ "$tag" == "direct-v6" ]] && action="IPv6解析"

    local display_type=""
    case $field in
    domain)
        if [[ "$value" == full:* ]]; then
            display_type="DOMAIN"
            value=${value#full:}
        elif [[ "$value" == domain:* ]]; then
            display_type="DOMAIN-SUFFIX"
            value=${value#domain:}
        elif [[ "$value" == keyword:* ]]; then
            display_type="DOMAIN-KEYWORD"
            value=${value#keyword:}
        elif [[ "$value" == geosite:* ]]; then
            display_type="GEOSITE"
            value=${value#geosite:}
        else
            display_type="DOMAIN"
        fi
        ;;
    ip)
        if [[ "$value" == geoip:* ]]; then
            display_type="GEOIP"
            value=${value#geoip:}
        else
            display_type="IP-CIDR"
        fi
        ;;
    esac
    echo "$display_type,$value → $action"
}

# rebuild main config outbounds and routing rules idempotently
rebuild_main_config() {
    [[ ! -f $is_config_json ]] && return 1
    local rules_json role landings_json='[]' failover_json='{"enabled":false,"interval":"60s","order":[]}'
    rules_json=$(load_custom_rules) || rules_json='[]'
    role=$(relay_get_role)
    if [[ "$role" == "line" && -f $is_relay_state_file ]]; then
        landings_json=$(relay_get_landings)
        failover_json=$(relay_get_failover)
    fi

    local tmp_json
    tmp_json=$(jq --arg role "$role" --argjson landings "$landings_json" --argjson custom "$rules_json" --argjson failover "$failover_json" '
        (if (.outbounds | length == 0) or (.outbounds[0].tag != "direct") then
            .outbounds = ([((.outbounds[]? | select(.tag == "direct")) // {"protocol":"freedom","tag":"direct","settings":{"domainStrategy":"UseIPv4v6"}})] + (.outbounds | map(select(.tag != "direct"))))
        else . end) |
        (if (.outbounds | map(select(.tag == "direct-v4")) | length) == 0 then
            .outbounds += [{"protocol": "freedom", "tag": "direct-v4", "settings": {"domainStrategy": "UseIPv4"}}]
        else . end) |
        (if (.outbounds | map(select(.tag == "direct-v6")) | length) == 0 then
            .outbounds += [{"protocol": "freedom", "tag": "direct-v6", "settings": {"domainStrategy": "UseIPv6"}}]
        else . end) |
        (if (.outbounds | map(select(.tag == "block")) | length) == 0 then
            .outbounds += [{"protocol": "blackhole", "tag": "block"}]
        else . end) |
        (.outbounds | map(select((.tag != "relay-out") and (.tag | startswith("relay-out-") | not) and (.tag | startswith("loop-relay-") | not)))) as $base_outbounds |
        ($landings | map(select(.transport_uuid and (.transport_uuid != "") and .landing_ip and .landing_port and ((.landing_port | tonumber? // 0) > 0)))) as $valid |
        ($valid | map(.id)) as $all_ids |
        (($failover.order // []) | map(select(. as $o | $all_ids | index($o)))) as $pref_order |
        ($pref_order + ($all_ids - $pref_order)) as $final_order |
        (
            if $role == "line" and ($valid | length > 0) then
                (
                    [
                        range(0; $valid | length) as $i |
                        $valid[$i] as $item |
                        (if $i == 0 then [{
                            "tag": "relay-out",
                            "protocol": "vless",
                            "settings": {
                                "address": $item.landing_ip,
                                "port": ($item.landing_port | tonumber),
                                "id": $item.transport_uuid,
                                "encryption": $item.encryption,
                                "flow": "xtls-rprx-vision"
                            },
                            "streamSettings": {"network": "raw", "security": "none"},
                            "mux": {"enabled": false},
                            "targetStrategy": "AsIs"
                        }] else [] end) +
                        [{
                            "tag": ("relay-out-" + ($item.id | tostring)),
                            "protocol": "vless",
                            "settings": {
                                "address": $item.landing_ip,
                                "port": ($item.landing_port | tonumber),
                                "id": $item.transport_uuid,
                                "encryption": $item.encryption,
                                "flow": "xtls-rprx-vision"
                            },
                            "streamSettings": {"network": "raw", "security": "none"},
                            "mux": {"enabled": false},
                            "targetStrategy": "AsIs"
                        }]
                    ] | add
                ) as $landing_outs |
                (
                    if ($failover.enabled == true) and ($final_order | length > 1) then
                        [
                            range(0; ($final_order | length - 1)) as $k |
                            $final_order[$k + 1] as $next_id |
                            {
                                "tag": ("loop-relay-" + ($next_id | tostring)),
                                "protocol": "loopback",
                                "settings": {
                                    "inboundTag": ("from-loop-relay-" + ($next_id | tostring))
                                }
                            }
                        ]
                    else [] end
                ) as $loop_outs |
                ($base_outbounds + $landing_outs + $loop_outs)
            else
                $base_outbounds
            end
        ) as $new_outbounds |
        .outbounds = $new_outbounds |
        (
            if ($role == "line") and ($valid | length > 0) and ($failover.enabled == true) then
                .observatory = {
                    "subjectSelector": ((["relay-out"] + ($valid | map("relay-out-" + (.id | tostring)))) | unique),
                    "probeUrl": "http://cp.cloudflare.com/generate_204",
                    "probeInterval": ($failover.interval // "60s"),
                    "enableConcurrency": true
                }
            else
                del(.observatory)
            end
        ) |
        (
            if ($role == "line") and ($valid | length > 0) and ($failover.enabled == true) then
                .routing.balancers = [
                    range(0; $final_order | length) as $k |
                    $final_order[$k] as $cur_id |
                    ($k == ($final_order | length - 1)) as $is_last |
                    {
                        "tag": ("relay-balancer-" + ($cur_id | tostring)),
                        "selector": [("relay-out-" + ($cur_id | tostring))],
                        "strategy": {"type": "leastPing"},
                        "fallbackTag": (if $is_last then "direct" else ("loop-relay-" + ($final_order[$k + 1] | tostring)) end)
                    }
                ]
            else
                del(.routing.balancers)
            end
        ) |
        (
            (
                if ($role == "line") and ($valid | length > 0) then
                    (
                        if ($failover.enabled == true) and ($final_order | length > 1) then
                            [
                                range(1; $final_order | length) as $k |
                                $final_order[$k] as $cur_id |
                                {
                                    "type": "field",
                                    "inboundTag": [("from-loop-relay-" + ($cur_id | tostring))],
                                    "balancerTag": ("relay-balancer-" + ($cur_id | tostring))
                                }
                            ]
                        else [] end
                    ) +
                    (
                        [
                            range(0; $valid | length) as $i |
                            $valid[$i] as $item |
                            {
                                "type": "field",
                                "user": (
                                    [
                                        ("relay-" + ($item.id | tostring) + "-vision-v4"),
                                        ("relay-" + ($item.id | tostring) + "-vision-v6"),
                                        ("relay-" + ($item.id | tostring) + "-xhttp")
                                    ] +
                                    (if ($item.id == "1" or $i == 0) then [
                                        "relay-vision-v4",
                                        "relay-1-vision-v4",
                                        "relay-vision-v6",
                                        "relay-1-vision-v6",
                                        "relay-xhttp",
                                        "relay-1-xhttp"
                                    ] else [] end)
                                ) | unique,
                                "outboundTag": (
                                    if ($failover.enabled == true) then null
                                    else (if $i == 0 then "relay-out" else ("relay-out-" + ($item.id | tostring)) end)
                                    end
                                ),
                                "balancerTag": (
                                    if ($failover.enabled == true) then
                                        ("relay-balancer-" + ($item.id | tostring))
                                    else null
                                    end
                                )
                            } | del(.outboundTag | nulls) | del(.balancerTag | nulls)
                        ]
                    )
                else [] end
            ) as $relay_rules |
            (if ($custom | type) == "array" then $custom else [] end) as $c_rules |
            [
                {"type": "field", "domain": ["geosite:cn"], "outboundTag": "block"},
                {"type": "field", "ip": ["geoip:cn", "geoip:private"], "outboundTag": "block"},
                {"type": "field", "protocol": ["bittorrent"], "outboundTag": "block"}
            ] as $base_blocks |
            .routing.rules = ($relay_rules + $c_rules + $base_blocks)
        )
    ' "$is_config_json")
    if [[ $? -eq 0 && -n "$tmp_json" ]]; then
        atomic_json "$is_config_json" "$tmp_json" || return 1
    else
        _fail "更新配置路由规则失败"
        return 1
    fi
    return 0
}

apply_custom_rules() {
    rebuild_main_config
}


# ─── relay validation helpers ────────────────────────────
relay_validate_ipv4() {
    local ip="$1"
    if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        return 1
    fi
    local IFS='.'
    local -a octets=($ip)
    for octet in "${octets[@]}"; do
        if [[ "$octet" =~ ^0[0-9]+$ ]]; then
            return 1
        fi
        if (( 10#$octet < 0 || 10#$octet > 255 )); then
            return 1
        fi
    done
    if [[ "$ip" == "0.0.0.0" || "$ip" == "255.255.255.255" || "$ip" =~ ^127\. ]]; then
        return 1
    fi
    return 0
}

relay_validate_port() {
    local port="$1"
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 ))
}

relay_validate_uuid() {
    local uuid="$1"
    [[ "$uuid" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

relay_validate_vless_encryption() {
    local enc="$1"
    [[ "$enc" =~ ^[a-z0-9]+\.[a-z0-9]+\.(0rtt|[0-9]+s)\.[A-Za-z0-9_-]{40,}$ ]]
}

relay_validate_domain() {
    local domain="$1"
    [[ -z "$domain" || ${#domain} -gt 253 ]] && return 1
    [[ "$domain" != *.* ]] && return 1
    [[ "$domain" =~ ^[\.-] || "$domain" =~ [\.-]$ ]] && return 1
    local label_regex='^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?$'
    local -a labels
    local IFS='.'
    read -r -a labels <<< "$domain"
    local last_label="${labels[-1]}"
    [[ ! "$last_label" =~ [a-zA-Z] ]] && return 1
    (( ${#last_label} < 2 || ${#last_label} > 63 )) && return 1
    local label
    for label in "${labels[@]}"; do
        [[ ! "$label" =~ $label_regex ]] && return 1
    done
    return 0
}

relay_validate_host() {
    local host="$1"
    relay_validate_ipv4 "$host" || relay_validate_domain "$host"
}

# ─── relay uri builder & parser ──────────────────────────
relay_build_link() {
    local t_uuid="$1"
    local l_ip="$2"
    local l_port="$3"
    local enc="$4"
    echo "vless://${t_uuid}@${l_ip}:${l_port}?encryption=${enc}&security=none&type=tcp&flow=xtls-rprx-vision#Xray-Relay"
}

relay_parse_link() {
    local link="$1"
    parsed_transport_uuid=""
    parsed_landing_ip=""
    parsed_landing_port=""
    parsed_encryption=""

    if [[ "$link" != vless://* ]]; then
        return 1
    fi
    local rest="${link#vless://}"
    rest="${rest%%#*}"

    if [[ "$rest" != *"@"* ]]; then
        return 1
    fi
    local t_uuid="${rest%%@*}"
    local host_and_query="${rest#*@}"

    if [[ "$host_and_query" != *"?"* ]]; then
        return 1
    fi
    local host_port="${host_and_query%%\?*}"
    local query="${host_and_query#*\?}"

    if [[ "$host_port" != *":"* ]]; then
        return 1
    fi
    local l_ip="${host_port%%:*}"
    local l_port="${host_port#*:}"

    if ! relay_validate_uuid "$t_uuid"; then
        return 1
    fi
    if ! relay_validate_host "$l_ip"; then
        return 1
    fi
    if ! relay_validate_port "$l_port"; then
        return 1
    fi

    local p_enc=""
    local p_sec=""
    local p_type=""
    local p_flow=""
    local IFS='&'
    for param in $query; do
        local key="${param%%=*}"
        local val="${param#*=}"
        case "$key" in
        encryption) p_enc="$val" ;;
        security) p_sec="$val" ;;
        type) p_type="$val" ;;
        flow) p_flow="$val" ;;
        esac
    done

    if [[ "$p_sec" != "none" ]]; then
        return 1
    fi
    if [[ "$p_type" != "tcp" && "$p_type" != "raw" ]]; then
        return 1
    fi
    if [[ "$p_flow" != "xtls-rprx-vision" ]]; then
        return 1
    fi
    if ! relay_validate_vless_encryption "$p_enc"; then
        return 1
    fi

    parsed_transport_uuid="$t_uuid"
    parsed_landing_ip="$l_ip"
    parsed_landing_port="$l_port"
    parsed_encryption="$p_enc"
    return 0
}

# ─── relay generation helpers ────────────────────────────
relay_get_random_port() {
    local ssh_p=$(grep -E '^\s*Port\s+[0-9]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -1)
    [[ -z "$ssh_p" ]] && ssh_p=22
    local existing_node_ports=""
    if [[ -d $is_conf_dir ]]; then
        existing_node_ports=$(jq -r '.inbounds[]?.port? // empty' "$is_conf_dir"/*.json 2>/dev/null | sort -u)
    fi

    local retry=0
    while (( retry < 30 )); do
        (( retry++ ))
        local rand_p=""
        if command -v shuf &>/dev/null; then
            rand_p=$(shuf -i 20000-60000 -n 1 2>/dev/null)
        else
            rand_p=$(awk 'BEGIN{srand(); print int(20000 + rand() * 40001)}')
        fi

        [[ -z "$rand_p" ]] && continue
        [[ "$rand_p" == "443" || "$rand_p" == "8443" || "$rand_p" == "$ssh_p" ]] && continue
        if [[ -n "$existing_node_ports" ]] && echo "$existing_node_ports" | grep -qw "$rand_p"; then
            continue
        fi

        local port_busy=0
        if command -v ss &>/dev/null; then
            if ss -tunlp 2>/dev/null | grep -qE ":${rand_p}[[:space:]]"; then
                port_busy=1
            fi
        elif command -v netstat &>/dev/null; then
            if netstat -tunlp 2>/dev/null | grep -qE ":${rand_p}[[:space:]]"; then
                port_busy=1
            fi
        fi
        if [[ $port_busy -eq 0 ]]; then
            echo "$rand_p"
            return 0
        fi
    done
    return 1
}

relay_generate_vlessenc() {
    vlessenc_decryption=""
    vlessenc_encryption=""

    local txt_out
    txt_out=$($is_core_bin vlessenc 2>/dev/null)
    if [[ $? -ne 0 || -z "$txt_out" ]]; then
        return 1
    fi

    local dec=""
    local enc=""

    # 1. Extract specifically under the Authentication: X25519 section
    dec=$(echo "$txt_out" | awk '
        BEGIN { in_x25519=0 }
        tolower($0) ~ /authentication:[ \t]*x25519/ { in_x25519=1; next }
        tolower($0) ~ /authentication:/ { if (in_x25519) exit }
        in_x25519 && /"decryption"/ {
            s = $0
            sub(/^.*"decryption"[ \t]*:[ \t]*"/, "", s)
            sub(/".*$/, "", s)
            print s
            exit
        }
    ' | tr -d '\r\n[:space:]')

    enc=$(echo "$txt_out" | awk '
        BEGIN { in_x25519=0 }
        tolower($0) ~ /authentication:[ \t]*x25519/ { in_x25519=1; next }
        tolower($0) ~ /authentication:/ { if (in_x25519) exit }
        in_x25519 && /"encryption"/ {
            s = $0
            sub(/^.*"encryption"[ \t]*:[ \t]*"/, "", s)
            sub(/".*$/, "", s)
            print s
            exit
        }
    ' | tr -d '\r\n[:space:]')

    # 2. Fallback: if section header not found, extract first "decryption" and "encryption" pair (which is X25519)
    if [[ -z "$dec" ]]; then
        dec=$(echo "$txt_out" | awk '
            /"decryption"/ {
                s = $0
                sub(/^.*"decryption"[ \t]*:[ \t]*"/, "", s)
                sub(/".*$/, "", s)
                print s
                exit
            }
        ' | tr -d '\r\n[:space:]')
    fi
    if [[ -z "$enc" ]]; then
        enc=$(echo "$txt_out" | awk '
            /"encryption"/ {
                s = $0
                sub(/^.*"encryption"[ \t]*:[ \t]*"/, "", s)
                sub(/".*$/, "", s)
                print s
                exit
            }
        ' | tr -d '\r\n[:space:]')
    fi

    if relay_validate_vless_encryption "$dec" && relay_validate_vless_encryption "$enc"; then
        vlessenc_decryption="$dec"
        vlessenc_encryption="$enc"
        return 0
    fi

    return 1
}

# ─── relay firewall helpers ──────────────────────────────


# ─── relay config helpers ────────────────────────────────
relay_create_landing_inbound() {
    local transport_uuid="$1"
    local decryption="$2"
    local port="$3"
    local target_file="$is_conf_dir/99_relay_in.json"

    local json_content=$(cat <<EOF
{
  "inbounds": [
    {
      "tag": "relay-in",
      "listen": "0.0.0.0",
      "port": $port,
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "$transport_uuid",
            "flow": "xtls-rprx-vision",
            "email": "relay-transport"
          }
        ],
        "decryption": "$decryption"
      },
      "streamSettings": {
        "network": "raw",
        "security": "none"
      },
      "sniffing": {
        "enabled": true,
        "destOverride": [
          "http",
          "tls",
          "quic"
        ],
        "routeOnly": true
      }
    }
  ]
}
EOF
)
    if ! echo "$json_content" | jq . &>/dev/null; then
        _fail "生成的 99_relay_in.json 格式异常"
        return 1
    fi
    atomic_json "$target_file" "$json_content"
}

relay_remove_landing_inbound() {
    rm -f "$is_conf_dir/99_relay_in.json"
}

relay_sync_client_identities() {
    local role=$(relay_get_role)
    [[ "$role" == "line" ]] || return 0
    local landings_json
    landings_json=$(relay_get_landings)

    for conf_name in $(list_managed_node_configs); do
        local conf_path="$is_conf_dir/$conf_name"
        [[ -f "$conf_path" ]] || continue
        local updated
        updated=$(jq --argjson landings "$landings_json" '
            .inbounds |= map(
                if (.tag | startswith("public_") and endswith("_v4")) then
                    .settings.clients = (
                        (.settings.clients | map(select(.email | startswith("relay-") | not))) +
                        [
                            $landings[] | select(.client_uuid and (.client_uuid != "")) | {
                                id: .client_uuid,
                                flow: "xtls-rprx-vision",
                                email: (if .id == "1" then "relay-vision-v4" else ("relay-" + (.id | tostring) + "-vision-v4") end)
                            }
                        ]
                    )
                elif (.tag | startswith("public_") and endswith("_v6")) then
                    .settings.clients = (
                        (.settings.clients | map(select(.email | startswith("relay-") | not))) +
                        [
                            $landings[] | select(.client_uuid and (.client_uuid != "")) | {
                                id: .client_uuid,
                                flow: "xtls-rprx-vision",
                                email: (if .id == "1" then "relay-vision-v6" else ("relay-" + (.id | tostring) + "-vision-v6") end)
                            }
                        ]
                    )
                elif (.tag == "local_xhttp_stream_up") then
                    .settings.clients = (
                        (.settings.clients | map(select(.email | startswith("relay-") | not))) +
                        [
                            $landings[] | select(.client_uuid and (.client_uuid != "")) | {
                                id: .client_uuid,
                                email: (if .id == "1" then "relay-xhttp" else ("relay-" + (.id | tostring) + "-xhttp") end)
                            }
                        ]
                    )
                else . end
            )
        ' "$conf_path" 2>/dev/null)
        if [[ $? -eq 0 && -n "$updated" ]]; then
            atomic_json "$conf_path" "$updated" || return 1
        else
            return 1
        fi
    done
    return 0
}

relay_add_client_identity() {
    relay_sync_client_identities
}

relay_remove_client_identity() {
    for conf_name in $(list_managed_node_configs); do
        local conf_path="$is_conf_dir/$conf_name"
        [[ -f "$conf_path" ]] || continue
        local updated=$(jq '
            .inbounds |= map(
                if .settings.clients then
                    .settings.clients |= map(select(
                        .email | startswith("relay-") | not
                    ))
                else . end
            )
        ' "$conf_path" 2>/dev/null)
        if [[ $? -eq 0 && -n "$updated" ]]; then
            atomic_json "$conf_path" "$updated" || return 1
        else
            return 1
        fi
    done
}


# ─── relay transaction helpers ───────────────────────────


# ─── relay operations & menu ─────────────────────────────


_do_single_relay_test() {
    local landing_ip="$1" landing_port="$2" transport_uuid="$3" encryption="$4" landing_name="${5:-落地机}"
    relay_validate_host "$landing_ip" && relay_validate_port "$landing_port" &&
        relay_validate_uuid "$transport_uuid" && relay_validate_vless_encryption "$encryption" || {
        _fail "[$landing_name] 中继状态参数无效，请检查绑定配置"
        return 1
    }

    _step "正在对 [$landing_name] 执行基础 TCP 连通性测试 (${landing_ip}:${landing_port}) ..."
    local tcp_ok=0
    if timeout 3 bash -c "echo > /dev/tcp/${landing_ip}/${landing_port}" &>/dev/null; then
        tcp_ok=1
    elif command -v nc &>/dev/null && nc -z -w 3 "$landing_ip" "$landing_port" &>/dev/null; then
        tcp_ok=1
    fi
    if [[ $tcp_ok -eq 0 ]]; then
        _fail "[$landing_name] TCP 不可达 (${landing_ip}:${landing_port})"
        _info "请检查落地机防火墙是否放行线路机 IP，或落地机 Xray 服务是否正在运行。"
        return 1
    fi
    _ok "[$landing_name] TCP 连接正常"

    _step "正在对 [$landing_name] 执行完整链路端到端出口测试..."
    local test_socks_port=""
    local candidate
    local attempt
    for (( attempt=0; attempt<30; attempt++ )); do
        candidate=$((30000 + RANDOM % 20001))
        if [[ -z "$(is_test port_used $candidate)" ]]; then
            if ! (type -P ss &>/dev/null && ss -tunlp 2>/dev/null | grep -q ":${candidate}\b") && \
               ! (type -P netstat &>/dev/null && netstat -tunlp 2>/dev/null | grep -q ":${candidate}\b"); then
                test_socks_port=$candidate
                break
            fi
        fi
    done
    if [[ -z "$test_socks_port" ]]; then
        _fail "无法获取未占用的临时测试端口"
        return 1
    fi
    local test_dir tmp_test_cfg test_pid=""
    test_dir=$(mktemp -d) || return 1
    tmp_test_cfg="$test_dir/config.json"
    trap '[[ -z "$test_pid" ]] || { kill "$test_pid" 2>/dev/null; wait "$test_pid" 2>/dev/null; }; rm -rf "$test_dir"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    cat <<EOF >"$tmp_test_cfg"
{
  "log": {
    "loglevel": "error"
  },
  "inbounds": [
    {
      "tag": "socks-test",
      "listen": "127.0.0.1",
      "port": $test_socks_port,
      "protocol": "socks",
      "settings": {
        "auth": "noauth",
        "udp": true
      }
    }
  ],
  "outbounds": [
    {
      "tag": "relay-out",
      "protocol": "vless",
      "settings": {
        "address": "$landing_ip",
        "port": $landing_port,
        "id": "$transport_uuid",
        "encryption": "$encryption",
        "flow": "xtls-rprx-vision"
      },
      "streamSettings": {
        "network": "raw",
        "security": "none"
      },
      "mux": {
        "enabled": false
      },
      "targetStrategy": "AsIs"
    }
  ]
}
EOF

    $is_core_bin run -c "$tmp_test_cfg" &>/dev/null &
    test_pid=$!
    sleep 2

    local exit_ip=""
    exit_ip=$(curl -4 -s --socks5-hostname "127.0.0.1:$test_socks_port" --max-time 6 https://one.one.one.one/cdn-cgi/trace 2>/dev/null | grep -E '^ip=' | cut -d= -f2)
    [[ -n "$exit_ip" ]] || exit_ip=$(curl -4 -s --socks5 "127.0.0.1:$test_socks_port" --max-time 6 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | grep -E '^ip=' | cut -d= -f2)
    [[ -n "$exit_ip" ]] || exit_ip=$(curl -4 -s --socks5-hostname "127.0.0.1:$test_socks_port" --max-time 6 https://api.ipify.org 2>/dev/null | tr -d '\r\n[:space:]')

    kill $test_pid &>/dev/null
    wait "$test_pid" 2>/dev/null || true
    test_pid=""

    if [[ "$exit_ip" == "$landing_ip" ]]; then
        _ok "[$landing_name] 完整链路测试成功！数据成功经由落地机转发并直出 Internet (出口 IP: $exit_ip)"
    elif [[ -n "$exit_ip" ]]; then
        if relay_validate_domain "$landing_ip"; then
            _ok "[$landing_name] 完整链路测试成功！数据成功经由落地机 ($landing_ip) 转发并直出 Internet (出口 IP: $exit_ip)"
        else
            warn "[$landing_name] 链路测试成功但出口 IP ($exit_ip) 与登记落地 IP ($landing_ip) 不一致，可能是多 IP VPS 或 NAT 出口"
        fi
    else
        _fail "[$landing_name] 完整链路测试失败：无法通过落地机代理访问外部网络，请检查 transport UUID 或 encryption 是否匹配"
        return 1
    fi
}

relay_test() {
    echo
    _section "中继连通性测试"
    local role=$(relay_get_role)
    if [[ "$role" != "line" ]]; then
        _fail "仅线路机支持执行连通测试"
        return 1
    fi
    if [[ ! -f $is_relay_state_file ]]; then
        _fail "未找到中继状态文件"
        return 1
    fi

    local landings=$(relay_get_landings)
    local count=$(jq -r 'length' <<< "$landings" 2>/dev/null || echo 0)
    if (( count == 0 )); then
        _fail "未绑定任何落地机"
        return 1
    elif (( count == 1 )); then
        local lip=$(jq -r '.[0].landing_ip' <<< "$landings")
        local lport=$(jq -r '.[0].landing_port' <<< "$landings")
        local tuuid=$(jq -r '.[0].transport_uuid' <<< "$landings")
        local enc=$(jq -r '.[0].encryption' <<< "$landings")
        local lname=$(jq -r '.[0].name // "落地机"' <<< "$landings")
        _do_single_relay_test "$lip" "$lport" "$tuuid" "$enc" "$lname"
    else
        echo -e "  当前已绑定的落地机列表:"
        local i l_name l_ip l_port
        for (( i=0; i<count; i++ )); do
            l_name=$(jq -r ".[$i].name // \"落地$((i+1))\"" <<< "$landings")
            l_ip=$(jq -r ".[$i].landing_ip" <<< "$landings")
            l_port=$(jq -r ".[$i].landing_port" <<< "$landings")
            echo -e "  ${green}$((i+1)))${none} [${cyan}${l_name}${none}] ${l_ip}:${l_port}"
        done
        echo
        local choice
        prompt_input "请选择测试序号 [输入 A 测试全部, 0 返回]" choice "A"
        [[ "$choice" != "0" && -n "$choice" ]] || return
        if [[ "${choice^^}" == "A" ]]; then
            for (( i=0; i<count; i++ )); do
                echo
                local lip=$(jq -r ".[$i].landing_ip" <<< "$landings")
                local lport=$(jq -r ".[$i].landing_port" <<< "$landings")
                local tuuid=$(jq -r ".[$i].transport_uuid" <<< "$landings")
                local enc=$(jq -r ".[$i].encryption" <<< "$landings")
                local lname=$(jq -r ".[$i].name // \"落地$((i+1))\"" <<< "$landings")
                _do_single_relay_test "$lip" "$lport" "$tuuid" "$enc" "$lname"
            done
        elif [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
            local sel_idx=$((choice - 1))
            local lip=$(jq -r ".[$sel_idx].landing_ip" <<< "$landings")
            local lport=$(jq -r ".[$sel_idx].landing_port" <<< "$landings")
            local tuuid=$(jq -r ".[$sel_idx].transport_uuid" <<< "$landings")
            local enc=$(jq -r ".[$sel_idx].encryption" <<< "$landings")
            local lname=$(jq -r ".[$sel_idx].name // \"落地$((sel_idx+1))\"" <<< "$landings")
            _do_single_relay_test "$lip" "$lport" "$tuuid" "$enc" "$lname"
        else
            _fail "无效的选项"
        fi
    fi
}

_show_single_landing_info() {
    local landings="$1" idx="$2"
    local lname lip lport tuuid enc cuuid
    lname=$(jq -r ".[$idx].name // \"落地$((idx+1))\"" <<< "$landings")
    lip=$(jq -r ".[$idx].landing_ip // \"\"" <<< "$landings")
    lport=$(jq -r ".[$idx].landing_port // \"\"" <<< "$landings")
    tuuid=$(jq -r ".[$idx].transport_uuid // \"\"" <<< "$landings")
    enc=$(jq -r ".[$idx].encryption // \"\"" <<< "$landings")
    cuuid=$(jq -r ".[$idx].client_uuid // \"\"" <<< "$landings")

    _kv "备注名称:" "$lname"
    _kv "角色:" "线路机 (line)"
    _kv "落地地址:" "$lip"
    _kv "落地端口:" "$lport"
    _kv "中继传输 UUID:" "$tuuid"
    _kv "专属客户端 UUID:" "$cuuid"
    _kv "加密参数:" "$enc"
}

relay_view_info_line() {
    echo
    _section "线路机中继信息"
    if [[ ! -f $is_relay_state_file ]]; then
        _fail "未找到中继状态文件"
        return 1
    fi
    local landings=$(relay_get_landings)
    local count=$(jq -r 'length' <<< "$landings" 2>/dev/null || echo 0)
    if (( count == 0 )); then
        _fail "未绑定任何落地机"
        return 1
    elif (( count == 1 )); then
        _show_single_landing_info "$landings" 0
    else
        echo -e "  ${cyan}已绑定 $count 台落地机:${none}"
        local i l_name l_ip l_port
        for (( i=0; i<count; i++ )); do
            l_name=$(jq -r ".[$i].name // \"落地$((i+1))\"" <<< "$landings")
            l_ip=$(jq -r ".[$i].landing_ip" <<< "$landings")
            l_port=$(jq -r ".[$i].landing_port" <<< "$landings")
            echo -e "  ${green}$((i+1)))${none} [${cyan}${l_name}${none}] ${l_ip}:${l_port}"
        done
        echo
        local choice
        prompt_input "请选择要查看的落地机序号 [输入 A 查看全部, 0 返回]" choice "A"
        [[ "$choice" != "0" && -n "$choice" ]] || return
        if [[ "${choice^^}" == "A" ]]; then
            for (( i=0; i<count; i++ )); do
                echo
                _show_single_landing_info "$landings" "$i"
            done
        elif [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
            _show_single_landing_info "$landings" "$((choice - 1))"
        else
            _fail "无效的选项"
        fi
    fi
}

relay_view_info_landing() {
    echo
    _section "落地机中继信息"
    if [[ ! -f $is_relay_state_file ]]; then
        _fail "未找到中继状态文件"
        return 1
    fi
    local pip=$(jq -r '.peer_ip // ""' "$is_relay_state_file")
    local lport=$(jq -r '.listen_port // ""' "$is_relay_state_file")
    local ext_port=$(jq -r '.external_port // .listen_port // ""' "$is_relay_state_file")
    local tuuid=$(jq -r '.transport_uuid // ""' "$is_relay_state_file")
    local dec=$(jq -r '.decryption // ""' "$is_relay_state_file")
    local enc=$(jq -r '.encryption // ""' "$is_relay_state_file")
    local landing_pub_ip=$(jq -r '.landing_ip // ""' "$is_relay_state_file")

    _kv "角色:" "落地机 (landing)"
    if [[ -n "$pip" ]]; then
        _kv "放行线路 IP:" "$pip"
    else
        _kv "放行线路 IP:" "未限制 (无防火墙限制或未指定)"
    fi
    _kv "落地地址:" "$landing_pub_ip"
    _kv "监听端口:" "$lport"
    [[ "$ext_port" == "$lport" ]] || _kv "外网端口:" "$ext_port"
    _kv "中继传输 UUID:" "$tuuid"
    echo
    _kv "落地解密参数:" "$dec"
    _kv "线路加密参数:" "$enc"
    echo

    if ! relay_validate_host "$landing_pub_ip"; then
        get_ip
        if relay_validate_ipv4 "$ip"; then
            landing_pub_ip="$ip"
        else
            local fetched_v4=$(curl -s4m 3 https://api.ipify.org 2>/dev/null || curl -s4m 3 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | grep -E '^ip=' | cut -d= -f2)
            if relay_validate_ipv4 "$fetched_v4"; then
                landing_pub_ip="$fetched_v4"
            else
                landing_pub_ip=""
            fi
        fi
    fi

    if [[ -z "$landing_pub_ip" ]]; then
        _fail "未能获取到落地机公网地址，无法生成中继链接。"
        echo
        return 1
    fi

    local relay_link=$(relay_build_link "$tuuid" "$landing_pub_ip" "$ext_port" "$enc")
    _step "中继导入链接:"
    echo
    _green "$relay_link"
    echo
}

relay_menu_failover() {
    while :; do
        clear
        echo
        _line
        echo -e "  ${bold}${cyan}落地机故障转移与回退设置${none}"
        _line

        local fo=$(relay_get_failover)
        local enabled=$(jq -r '.enabled // false' <<< "$fo")
        local interval=$(jq -r '.interval // "60s"' <<< "$fo")
        local pref_order_json=$(jq -c '.order // []' <<< "$fo")
        local landings=$(relay_get_landings)
        local count=$(jq -r 'length' <<< "$landings" 2>/dev/null || echo 0)

        local status_str
        if [[ "$enabled" == "true" ]]; then
            status_str="${green}已开启${none}"
        else
            status_str="${gray}已关闭${none}"
        fi

        echo -e "  ${cyan}故障转移状态:${none} $status_str"
        echo -e "  ${cyan}探测周期 / 容忍时间:${none} ${green}$interval${none}"

        local all_ids final_order
        all_ids=$(jq -c '[.[] | .id]' <<< "$landings")
        final_order=$(jq -c --argjson all "$all_ids" --argjson pref "$pref_order_json" '
            ($pref | map(select(. as $o | $all | index($o)))) as $valid_pref |
            ($valid_pref + ($all - $valid_pref))
        ' <<< '{}')

        local order_count=$(jq -r 'length' <<< "$final_order")
        local order_display=""
        local k oid oname
        for (( k=0; k<order_count; k++ )); do
            oid=$(jq -r ".[$k]" <<< "$final_order")
            oname=$(jq -r --arg id "$oid" '.[] | select(.id == $id) | .name // ("落地" + $id)' <<< "$landings")
            if [[ -z "$order_display" ]]; then
                order_display="[${cyan}${oname}${none}]"
            else
                order_display="${order_display} → [${cyan}${oname}${none}]"
            fi
        done
        if [[ -n "$order_display" ]]; then
            order_display="${order_display} → [${yellow}线路直连 direct${none}]"
        else
            order_display="${gray}未绑定落地机${none}"
        fi
        echo -e "  ${cyan}故障转移链:${none} $order_display"
        echo
        _section "操作"
        if [[ "$enabled" == "true" ]]; then
            _menu 1 "关闭故障转移与回退"
        else
            _menu 1 "开启故障转移与回退"
        fi
        _menu 2 "设置探测周期 / 离线容忍时间"
        _menu 3 "调整落地机故障转移优先级顺序"
        echo
        echo -ne "  请选择 [${green}1-3${none}] [${red}0 返回${none}]: "
        read -r REPLY || return
        [[ "$REPLY" == "0" ]] && return

        case "$REPLY" in
        1)
            local new_enabled
            if [[ "$enabled" == "true" ]]; then
                new_enabled="false"
            else
                new_enabled="true"
            fi
            if config_transaction relay_apply_failover "$new_enabled" "$interval" "$final_order"; then
                if [[ "$new_enabled" == "true" ]]; then
                    _ok "已开启落地机故障转移与回退"
                else
                    _ok "已关闭故障转移，恢复标准中继模式"
                fi
            fi
            pause
            ;;
        2)
            echo
            _section "设置探测周期 (容忍离线时间)"
            _info "当探测目标在设定周期内无法连通时，判定该落地机离线并自动切换到下一个节点。"
            echo
            _menu 1 "15 秒 (高敏感，快速切换)"
            _menu 2 "30 秒 (推荐)"
            _menu 3 "60 秒 (默认，稳定)"
            _menu 4 "120 秒 (宽容)"
            _menu 5 "自定义秒数"
            echo
            echo -ne "  请选择 [${green}1-5${none}] [${red}0 取消${none}]: "
            read -r c_int || continue
            [[ "$c_int" == "0" ]] && continue
            local new_interval=""
            case "$c_int" in
            1) new_interval="15s" ;;
            2) new_interval="30s" ;;
            3) new_interval="60s" ;;
            4) new_interval="120s" ;;
            5)
                local custom_sec
                prompt_input "请输入探测秒数 (5 - 600)" custom_sec "60"
                if [[ "$custom_sec" =~ ^[0-9]+$ ]] && (( custom_sec >= 5 && custom_sec <= 600 )); then
                    new_interval="${custom_sec}s"
                else
                    _fail "无效的秒数，必须在 5 - 600 之间"
                    pause
                    continue
                fi
                ;;
            *)
                _fail "无效的选项"
                pause
                continue
                ;;
            esac
            if [[ -n "$new_interval" ]]; then
                if config_transaction relay_apply_failover "$enabled" "$new_interval" "$final_order"; then
                    _ok "探测周期已更新为: $new_interval"
                fi
                pause
            fi
            ;;
        3)
            echo
            _section "调整落地机故障转移顺序"
            if (( count < 2 )); then
                _info "当前仅有 $count 台落地机，无需调整顺序 (故障时自动回退至线路直连)。"
                pause
                continue
            fi
            echo -e "  当前已绑定的落地机:"
            local idx l_id l_name l_ip l_port
            for (( idx=0; idx<count; idx++ )); do
                l_id=$(jq -r ".[$idx].id" <<< "$landings")
                l_name=$(jq -r ".[$idx].name // \"落地$((idx+1))\"" <<< "$landings")
                l_ip=$(jq -r ".[$idx].landing_ip" <<< "$landings")
                l_port=$(jq -r ".[$idx].landing_port" <<< "$landings")
                echo -e "  ${green}$((idx+1)))${none} [ID:${l_id}] ${cyan}${l_name}${none} (${l_ip}:${l_port})"
            done
            echo
            _info "当前优先级顺序: $order_display"
            echo -e "  ${cyan}请输入期望的优先级顺序，用空格分隔序号 (例如: 2 1):${none}"
            local input_order
            prompt_input "输入新顺序 (0 取消)" input_order ""
            [[ "$input_order" == "0" || -z "$input_order" ]] && continue

            input_order=${input_order//,/ }
            local -a selected_ids=()
            local num sel_id
            local valid_input=1
            for num in $input_order; do
                if [[ "$num" =~ ^[0-9]+$ ]] && (( num >= 1 && num <= count )); then
                    sel_id=$(jq -r ".[$((num-1))].id" <<< "$landings")
                    local already=0 existing_id
                    for existing_id in "${selected_ids[@]}"; do
                        if [[ "$existing_id" == "$sel_id" ]]; then
                            already=1; break
                        fi
                    done
                    if [[ $already -eq 0 ]]; then
                        selected_ids+=("$sel_id")
                    fi
                else
                    valid_input=0
                    break
                fi
            done
            if [[ $valid_input -eq 0 || ${#selected_ids[@]} -eq 0 ]]; then
                _fail "输入的顺序序号无效"
                pause
                continue
            fi
            local rem_id
            for (( idx=0; idx<count; idx++ )); do
                rem_id=$(jq -r ".[$idx].id" <<< "$landings")
                local found=0
                for existing_id in "${selected_ids[@]}"; do
                    if [[ "$existing_id" == "$rem_id" ]]; then
                        found=1; break
                    fi
                done
                if [[ $found -eq 0 ]]; then
                    selected_ids+=("$rem_id")
                fi
            done

            local new_order_json
            new_order_json=$(printf '%s\n' "${selected_ids[@]}" | jq -R . | jq -s .)
            if config_transaction relay_apply_failover "$enabled" "$interval" "$new_order_json"; then
                _ok "故障转移顺序更新成功"
            fi
            pause
            ;;
        esac
    done
}

relay_menu() {
    while :; do
        clear
        echo
        _line
        echo -e "  ${bold}${cyan}线路 / 落地互联${none}  ${gray}|${none}  ${is_core_status}"
        _line

        local role=$(relay_get_role)
        if [[ -z "$role" ]]; then
            echo -e "  ${cyan}中继状态:${none} ${gray}未配置${none}"
            echo
            _section "操作"
            _menu 1 "将本机配置为线路机"
            _menu 2 "将本机配置为落地机"
            echo
            echo -ne "  请选择 [${green}1-2${none}] [${red}0 返回主菜单${none}]: "
            read -r REPLY || return 1
            [[ "$REPLY" == "0" ]] && return
            case $REPLY in
            1)
                relay_setup_line
                pause
                ;;
            2)
                relay_setup_landing
                pause
                ;;
            esac
        elif [[ "$role" == "line" ]]; then
            local landings_json=$(relay_get_landings)
            local count=$(jq -r 'length' <<< "$landings_json" 2>/dev/null || echo 0)
            local fo_json=$(relay_get_failover)
            local fo_en=$(jq -r '.enabled // false' <<< "$fo_json")
            local fo_int=$(jq -r '.interval // "60s"' <<< "$fo_json")
            local fo_tag="${gray}[故障转移: 关]${none}"
            if [[ "$fo_en" == "true" ]]; then
                fo_tag="${green}[故障转移: 开(${fo_int})]${none}"
            fi
            echo -e "  ${cyan}角色:${none} ${green}线路机${none} (已绑定 ${green}${count}${none} 台落地机) $fo_tag"
            local i l_name l_ip l_port
            for (( i=0; i<count; i++ )); do
                l_name=$(jq -r ".[$i].name // \"落地$((i+1))\"" <<< "$landings_json")
                l_ip=$(jq -r ".[$i].landing_ip // \"\"" <<< "$landings_json")
                l_port=$(jq -r ".[$i].landing_port // \"\"" <<< "$landings_json")
                echo -e "  ${green}$((i+1)))${none} [${cyan}${l_name}${none}] ${l_ip}:${l_port}"
            done
            echo
            _section "操作"
            _menu 1 "添加新落地机绑定"
            _menu 2 "查看落地信息"
            _menu 3 "测试落地连通性"
            _menu 4 "解除落地绑定"
            _menu 5 "落地故障转移与回退设置"
            echo
            echo -ne "  请选择 [${green}1-5${none}] [${red}0 返回主菜单${none}]: "
            read -r REPLY || return 1
            [[ "$REPLY" == "0" ]] && return
            case $REPLY in
            1)
                relay_setup_line
                pause
                ;;
            2)
                relay_view_info_line
                pause
                ;;
            3)
                relay_test
                pause
                ;;
            4)
                relay_remove_line
                pause
                ;;
            5)
                relay_menu_failover
                ;;
            esac
        elif [[ "$role" == "landing" ]]; then
            local r_pip=$(jq -r '.peer_ip // ""' "$is_relay_state_file" 2>/dev/null)
            local r_lport=$(jq -r '.listen_port // ""' "$is_relay_state_file" 2>/dev/null)
            local r_ext=$(jq -r '.external_port // .listen_port // ""' "$is_relay_state_file" 2>/dev/null)
            echo -e "  ${cyan}角色:${none} ${green}落地机${none}"
            if [[ -n "$r_pip" ]]; then
                echo -e "  ${cyan}线路:${none} ${green}${r_pip}${none}"
            else
                echo -e "  ${cyan}线路:${none} ${gray}未限制白名单${none}"
            fi
            if [[ "$r_ext" != "$r_lport" ]]; then
                echo -e "  ${cyan}监听:${none} ${green}${r_lport}${none} (外网: ${green}${r_ext}${none})"
            else
                echo -e "  ${cyan}监听:${none} ${green}${r_lport}${none}"
            fi
            echo
            _section "操作"
            _menu 1 "查看 / 复制中继链接"
            _menu 2 "解除落地配置"
            echo
            echo -ne "  请选择 [${green}1-2${none}] [${red}0 返回主菜单${none}]: "
            read -r REPLY || return 1
            [[ "$REPLY" == "0" ]] && return
            case $REPLY in
            1)
                relay_view_info_landing
                pause
                ;;
            2)
                relay_remove_landing
                pause
                ;;
            esac
        fi
    done
}

# change landing server config
change_landing() {
    local _cur_out_strategy rules_count
    while :; do
        clear
        echo
        _line
        echo -e "  ${bold}${cyan}落地机配置更改${none}  ${gray}|${none}  ${is_core_status}"
        _line
        echo -e "  ${cyan}[模式]${none} ${green}纯落地机模式 (Relay Landing)${none}"
        _cur_out_strategy=$(outbound_strategy)
        echo -e "  ${cyan}[出站 IP 优先]${none} ${green}$(outbound_label "$_cur_out_strategy")${none}"
        rules_count=0
        if [[ -f "$is_custom_rules_file" ]]; then
            rules_count=$(jq -er 'if type == "array" then length else 0 end' "$is_custom_rules_file" 2>/dev/null || echo 0)
        fi
        echo -e "  ${cyan}[自定义分流规则]${none} ${green}${rules_count}${none} 条"
        echo
        _section "请选择更改项目"
        _menu 1 "管理自定义分流规则"
        _menu 2 "切换出站 IP 优先 (当前: $(outbound_label "$_cur_out_strategy"))"
        echo
        echo -ne "  请选择 [${green}1-2${none}] [${red}0 返回${none}]: "
        read -r REPLY || return 1
        [[ "$REPLY" == "0" || -z "$REPLY" ]] && { REPLY=0; return 0; }
        case $REPLY in
        1)
            manage_custom_rules
            ;;
        2)
            choose_outbound_strategy
            [[ $REPLY != 0 ]] && pause
            ;;
        *)
            _fail "输入有误，请重试"
            pause
            ;;
        esac
    done
}

# change config file
change() {
    local _has_nodes
    _has_nodes=$(list_managed_node_configs)
    if [[ -z "$_has_nodes" && -f "$is_conf_dir/99_relay_in.json" ]]; then
        if [[ -n "$is_change_id" ]]; then
            case "$is_change_id" in
            9) manage_custom_rules; return $? ;;
            10) choose_outbound_strategy; return $? ;;
            *) _fail "纯落地机模式仅支持管理分流规则或切换出站策略"; return 1 ;;
            esac
        fi
        change_landing "$@"
        return $?
    fi

    is_change=1
    is_dont_show_info=1
    {
        [[ $is_change_id ]] && {
            is_change_msg=${change_list[$is_change_id]}
            [[ $is_change_msg ]] && _step "快速执行: $is_change_msg"
        }
        info $1
        [[ $is_auto_get_config ]] && _info "自动选择: $is_config_file"
    }
    net=reality
    # if is_dont_show_info exist, cant show info.
    is_dont_show_info=

    # update change list dynamically for route mode and outbound pref
    if [[ -f $is_conf_dir/is_v6_uplink ]]; then
        change_list[8]="切换分离类型 (当前: v6上行/v4下行)"
    else
        change_list[8]="切换分离类型 (当前: v4上行/v6下行)"
    fi
    # show current outbound strategy in menu
    local _cur_out_strategy
    _cur_out_strategy=$(outbound_strategy)
    change_list[10]="切换出站 IP 优先 (当前: $(outbound_label "$_cur_out_strategy"))"

    # if not prefer args, show change list and then get change id.
    [[ ! $is_change_id ]] && {
        ask set_change_list
        [[ $REPLY == "0" ]] && return
        is_change_id=${is_can_change[$REPLY - 1]}
    }
    case $is_change_id in
    0)
        # new port
        is_new_port=$3
        if [[ $is_new_port && ! $is_auto ]]; then
            if [[ $is_new_port != 443 && $is_new_port != 8443 ]]; then
                err "为保障协议伪装的隐蔽性与安全性，本脚本强制规定仅支持 443 或 8443 端口"
            fi
            [[ $(is_test port_used $is_new_port) ]] && err "无法使用 ($is_new_port) 端口，该端口已被占用"
        fi

        [[ $is_auto ]] && get_port && is_new_port=$tmp_port

        if [[ ! $is_new_port ]]; then
            ask list is_new_port "443 8443" "\n  为保障协议伪装的安全性和隐蔽性，仅支持如下端口:" "  请选择新端口:"
            [[ $REPLY == "0" ]] && return
        fi

        [[ $is_new_port == $port ]] && {
            _fail "新端口与当前端口 ($port) 相同，无需切换"
            return
        }

        if [[ $(is_test port_used $is_new_port) ]]; then
            _fail "目标端口 ($is_new_port) 已被占用，无法切换"
            return
        fi

        add "$net" "$is_new_port"
        ;;
    1)
        # new xhttp path
        is_new_v4_path=$3
        [[ ! $is_reality ]] && err "($is_config_file) 不支持此更改"
        [[ ! $is_new_v4_path ]] && ask string is_new_v4_path "  请输入新 xhttp 路径:"
        [[ $REPLY == "0" ]] && return
        v4_path=$is_new_v4_path
        add "$net"
        ;;
    2)
        # new uuid
        [[ ! $is_reality ]] && err "($is_config_file) 不支持此更改"
        _info "UUID 更新后，现有客户端需要重新导入配置。"
        get_uuid
        is_new_uuid=$tmp_uuid
        add $net auto $is_new_uuid
        ;;
    3)
        # new is_private_key is_public_key
        [[ ! $is_reality ]] && err "($is_config_file) 不支持此更改"
        _info "密钥更新后，现有客户端需要重新导入配置。"
        get_pbk
        add "$net"
        ;;
    4)
        # new v4 sni/dest
        is_new_v4_sni=$3
        [[ ! $is_reality ]] && err "($is_config_file) 不支持此更改"
        [[ ! $is_new_v4_sni ]] && ask string is_new_v4_sni "  请输入新的 v4 目标域名 (SNI/Dest) [0 返回]:"
        [[ $REPLY == "0" ]] && return
        v4_sni=$is_new_v4_sni
        add "$net"
        ;;
    5)
        # new v6 sni/dest
        is_new_v6_sni=$3
        [[ ! $is_reality ]] && err "($is_config_file) 不支持此更改"
        [[ ! $is_new_v6_sni ]] && ask string is_new_v6_sni "  请输入新的 v6 目标域名 (SNI/Dest) [0 返回]:"
        [[ $REPLY == "0" ]] && return
        v6_sni=$is_new_v6_sni
        add "$net"
        ;;
    6)
        # new v4 short ids
        [[ ! $is_reality ]] && err "($is_config_file) 不支持此更改"
        get_short_ids
        v4_short_ids=$is_short_ids
        add "$net"
        ;;
    7)
        # new v6 short ids
        [[ ! $is_reality ]] && err "($is_config_file) 不支持此更改"
        get_short_ids
        v6_short_ids=$is_short_ids
        add "$net"
        ;;
    8)
        config_transaction toggle_route_mode && info
        ;;
    9)
        manage_custom_rules
        ;;
    10)
        choose_outbound_strategy
        ;;
    esac
}

# uninstall
uninstall() (
    prompt_confirm "确认卸载 Xray 及本脚本的配置与日志？" n || return 1
    exec {operation_fd}>"$is_core_dir/.operation.lock" || return 1
    flock -n "$operation_fd" || { _fail "另一项配置或更新操作正在进行，请稍后卸载"; return 1; }
    manage stop && manage disable || return 1
    systemctl disable --now xray-geodata.timer xray-firewall.service >/dev/null 2>&1 || true
    remove_legacy_geodata_cron || return 1
    firewall_remove || return 1
    local root="${XRAY_SYSTEMD_DIR:-/etc/systemd/system}" temporary
    rm -f "$root/xray-firewall.service" "$root/xray-geodata.service" "$root/xray-geodata.timer" "$root/$is_core.service.d/firewall.conf"
    rmdir "$root/$is_core.service.d" 2>/dev/null || true
    rm -f "${XRAY_LOGROTATE_DIR:-/etc/logrotate.d}/xray-script"
    rm -f /etc/sysctl.d/99-xray-bbr.conf
    if [[ -f /root/.bashrc ]]; then
        temporary=$(mktemp) || return 1
        awk -v entry="alias $is_core=$is_sh_bin" '$0 != entry {print}' /root/.bashrc > "$temporary" &&
            cat "$temporary" > /root/.bashrc
        rm -f "$temporary"
    fi
    rm -rf "${is_core_dir:?}" "${is_log_dir:?}"
    rm -f "$is_sh_bin" "/lib/systemd/system/$is_core.service" "/etc/init.d/$is_core"
    systemctl daemon-reload || return 1
    _ok "卸载完成，系统其他防火墙规则保持原样"
)

# add a config
add() {
    is_lower=${1,,}
    if [[ $is_lower ]]; then
        case $is_lower in
        r | reality)
            is_new_protocol=VLESS-REALITY
            ;;
        *)
            err "无法识别 ($1), 目前仅支持: r 或 reality"
            ;;
        esac
    fi

    # no prefer protocol
    [[ ! $is_new_protocol ]] && is_new_protocol=VLESS-REALITY

    is_reality=1
    is_use_port=$2
    is_use_uuid=$3
    is_use_servername=$4
    is_add_opts="[port] [uuid] [sni]"

    # prefer args.
    if [[ $2 ]]; then
        for v in is_use_port is_use_uuid is_use_servername; do
            [[ ${!v} == 'auto' ]] && unset $v
        done

        if [[ $is_use_port ]]; then
            [[ ! $(is_test port ${is_use_port}) ]] && {
                err "($is_use_port) 不是一个有效的端口"
            }
            [[ $(is_test port_used $is_use_port) ]] && {
                err "无法使用 ($is_use_port) 端口"
            }
            port=$is_use_port
        fi
        if [[ $is_use_uuid ]]; then
            [[ ! $(is_test uuid $is_use_uuid) ]] && {
                err "($is_use_uuid) 不是一个有效的 UUID"
            }
            uuid=$is_use_uuid
        fi
        [[ $is_use_servername ]] && is_servername=$is_use_servername
    fi

    # create json
    create server "$is_new_protocol" || return 1

    # show config info.
    info
    # The legacy footer can return nonzero even after a successful creation.
    return 0
}

# get config info
# or somes required args
get() {
    case $1 in
    addr)
        is_addr=$host
        [[ ! $is_addr ]] && {
            get_ip
            is_addr=$ip
            [[ $(grep ":" <<<$ip) ]] && is_addr="[$ip]"
        }
        ;;
    new)
        [[ ! $host ]] && get_ip
        [[ ! $port ]] && get_port && port=$tmp_port
        [[ ! $uuid ]] && get_uuid && uuid=$tmp_uuid
        [[ ! $is_short_ids ]] && get_short_ids
        [[ ! $is_private_key ]] && get_pbk
        if [[ $is_new_install ]]; then
            is_default_arg="v4上行/v6下行"
            ask list is_route_mode "v4上行/v6下行 v6上行/v4下行" "\n  请选择首选的流向模式:" "  请选择 (默认: v4上行/v6下行):"
            [[ $REPLY != 0 ]] || return 1
            if [[ $is_route_mode == "v6上行/v4下行" ]]; then
                export is_v6_uplink=1
                touch "$is_conf_dir/is_v6_uplink"
            fi
            is_default_arg="empty_allowed"
            ask string is_new_v4_sni "  请输入 v4 目标域名 (SNI/Dest) [直接回车使用默认]:"
            [[ $REPLY != 0 ]] || return 1
            [[ $is_new_v4_sni ]] && export v4_sni=$is_new_v4_sni
            is_default_arg="empty_allowed"
            ask string is_new_v6_sni "  请输入 v6 目标域名 (SNI/Dest) [直接回车使用默认]:"
            [[ $REPLY != 0 ]] || return 1
            [[ $is_new_v6_sni ]] && export v6_sni=$is_new_v6_sni
        fi
        if [[ ! $v4_sni || ! $v6_sni ]]; then
            get_default_sni
            [[ ! $v4_sni ]] && v4_sni=$tmp_v4_sni
            [[ ! $v6_sni ]] && v6_sni=$tmp_v6_sni
        fi
        ;;
    file)
        is_file_str=$2
        [[ ! $is_file_str ]] && is_file_str='.json$'
        readarray -t is_all_json <<<"$(list_managed_node_configs "$is_file_str" | head -233)" # limit max 233 lines for show.
        [[ ${#is_all_json[@]} -eq 1 && -z "${is_all_json[0]}" ]] && unset is_all_json
        [[ ! $is_all_json ]] && err "无法找到相关的配置文件: $2"
        [[ ${#is_all_json[@]} -eq 1 ]] && is_config_file=${is_all_json[0]} && is_auto_get_config=1
        [[ ! $is_config_file ]] && {
            [[ $is_dont_auto_exit ]] && return
            ask get_config_file
        }
        ;;
    info)
        get file $2
        if [[ $is_config_file ]]; then
            is_json_str=$(cat $is_conf_dir/"$is_config_file")

            # v4 parsing
            is_protocol=$(jq -r '.inbounds[0].protocol' <<<$is_json_str)
            port=$(jq -r '.inbounds[0].port' <<<$is_json_str)
            uuid=$(jq -r '.inbounds[0].settings.clients[0].id' <<<$is_json_str)
            v4_dest=$(jq -r '.inbounds[0].streamSettings.realitySettings.dest' <<<$is_json_str)
            v4_sni=$(jq -r '.inbounds[0].streamSettings.realitySettings.serverNames[0]' <<<$is_json_str)
            is_private_key=$(jq -r '.inbounds[0].streamSettings.realitySettings.privateKey' <<<$is_json_str)
            is_public_key=$(jq -r '.inbounds[0].streamSettings.realitySettings.publicKey // ""' <<<$is_json_str)
            v4_short_ids=$(jq -c '.inbounds[0].streamSettings.realitySettings.shortIds // [""]' <<<$is_json_str)

            # fallback for older generated config without publicKey in json
            if [[ ! $is_public_key ]]; then
                is_public_key="Unknown(please regenerate config)"
            fi

            # v6 parsing
            v6_dest=$(jq -r '.inbounds[1].streamSettings.realitySettings.dest // ""' <<<$is_json_str)
            v6_sni=$(jq -r '.inbounds[1].streamSettings.realitySettings.serverNames[0] // ""' <<<$is_json_str)
            v6_short_ids=$(jq -c '.inbounds[1].streamSettings.realitySettings.shortIds // [""]' <<<$is_json_str)

            # xhttp parsing
            v4_path=$(jq -r '.inbounds[2].streamSettings.xhttpSettings.path // ""' <<<$is_json_str)
            v6_path=$v4_path

            # core variables
            net=reality
            is_reality=reality
            is_config_name=$is_config_file
        fi
        ;;

    esac
}

# show info


# footer msg
footer_msg() {
    [[ $is_core_stop && ! $is_new_json ]] && warn "$is_core_name 当前处于停止状态"
}

# update core, sh
update() {
    load download.sh
    local kind="$1" requested="${2:-}"
    [[ $kind != 1 ]] || kind=core
    [[ $kind != 2 ]] || kind=sh
    safe_update "$kind" "$requested" || return 1
    if [[ $kind == sh ]]; then
        _ok "脚本更新成功，重新打开菜单"
        exec "$is_sh_bin"
    fi
    is_core_ver=$("$is_core_bin" version | awk 'NR==1 {print $2}')
}

# reset state variables between menu operations
