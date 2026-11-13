#!/bin/bash

choose_outbound_strategy() {
    _info "当前: $(outbound_label "$(outbound_strategy)")"
    _info "解析顺序不等于连接失败回退；连接竞速只作用于域名目标的 TCP。"
    ask list ip_pref "IPv4解析 IPv6解析 IPv4解析优先 IPv6解析优先 双栈竞速IPv4先尝试 双栈竞速IPv6先尝试" "\n  请选择出站策略:"
    [[ $REPLY != 0 ]] || return
    local strategies=(UseIPv4 UseIPv6 UseIPv4v6 UseIPv6v4 HappyEyeballs4 HappyEyeballs6)
    config_transaction set_outbound_strategy "${strategies[$REPLY-1]}"
}

toggle_route_mode() {
    if [[ -f "$is_conf_dir/is_v6_uplink" ]]; then
        rm -f "$is_conf_dir/is_v6_uplink"
    else
        : > "$is_conf_dir/is_v6_uplink"
    fi
}

rules_apply() {
    local operation="$1" index="${2:-0}" rule="${3:-null}" destination="${4:-0}" rules
    rules=$(load_custom_rules) || return 1
    rules=$(jq --arg operation "$operation" --argjson index "$index" --argjson rule "$rule" --argjson destination "$destination" '
        if type != "array" then error("rules must be an array") else . end |
        if $operation == "add" then . + [$rule]
        elif $index < 0 or $index >= length then error("invalid index")
        elif $operation == "edit" then .[$index] = $rule
        elif $operation == "delete" then del(.[$index])
        elif $operation == "move" then
            if $destination < 0 or $destination >= length then error("invalid destination") else
                .[$index] as $moving | del(.[$index]) | .[:$destination] + [$moving] + .[$destination:]
            end
        else error("unknown operation") end
    ' <<< "$rules") || return 1
    save_custom_rules "$rules" && rebuild_main_config
}

prompt_rule() {
    local input tag=direct
    echo
    echo -e "  ${cyan}支持的规则格式:${none}"
    echo -e "    ${green}DOMAIN${none},example.com         精确域名匹配"
    echo -e "    ${green}DOMAIN-SUFFIX${none},example.com  域名后缀匹配"
    echo -e "    ${green}DOMAIN-KEYWORD${none},example     域名关键词匹配"
    echo -e "    ${green}IP-CIDR${none},1.2.3.0/24         IP 段匹配"
    echo -e "    ${green}GEOSITE${none},category            GeoSite 规则集"
    echo -e "    ${green}GEOIP${none},code                  GeoIP 规则集"
    echo
    echo -ne "  请输入规则 (例: ${green}DOMAIN-SUFFIX,kimi.ai${none}) [${red}0 返回${none}]: "
    read -r input || return 1
    [[ -n "$input" && $input != 0 ]] || return 1
    [[ "$input" == *,* ]] && parse_rule_input "$input" || { _fail "无法识别规则格式"; return 1; }
    ask list action "直连 IPv4解析 IPv6解析 阻止" "\n  请选择规则动作:"
    [[ $REPLY != 0 ]] || return 1
    case "$REPLY" in 2) tag=direct-v4 ;; 3) tag=direct-v6 ;; 4) tag=block ;; esac
    prompted_rule=$(jq -n --arg field "$_rule_field" --arg value "$_rule_value" --arg tag "$tag" \
        '{type:"field", ($field):[$value], outboundTag:$tag}')
}

manage_custom_rules() {
    local rules count choice index destination entry field value tag
    while :; do
        clear
        echo
        _line
        echo -e "  ${bold}${cyan}自定义分流规则管理${none}"
        _line
        rules=$(load_custom_rules)
        count=$(jq -er 'if type == "array" then length else error("invalid rules") end' <<< "$rules") || return 1
        if (( count )); then
            echo -e "  ${cyan}当前自定义规则 ($count 条):${none}"
            echo
        fi
        index=1
        while IFS= read -r entry; do
            [[ -n "$entry" ]] || continue
            IFS=$'\t' read -r field value tag < <(jq -r '[
                (if .domain then "domain" elif .ip then "ip" else "protocol" end),
                (.domain[0] // .ip[0] // .protocol[0] // ""), .outboundTag] | @tsv' <<< "$entry")
            printf "  ${green}%2s)${none} %s\n" "$index" "$(rule_to_display "$field" "$value" "$tag")"
            ((index+=1))
        done < <(jq -c '.[]' <<< "$rules")
        (( count )) || echo -e "  ${gray}暂无自定义规则${none}"
        echo
        _section "操作"
        _menu 1 添加规则
        _menu 2 删除规则
        _menu 3 修改规则
        _menu 4 调整规则顺序
        echo
        echo -ne "  请选择 [${green}1-4${none}] [${red}0 返回${none}]: "
        read -r choice || return
        [[ $choice != 0 && -n $choice ]] || return
        case "$choice" in
            1)
                if prompt_rule; then config_transaction rules_apply add 0 "$prompted_rule"; fi
                ;;
            2|3|4)
                (( count )) || { _info "没有可操作的规则"; pause; continue; }
                prompt_input "规则序号（0 返回）" index
                [[ $index != 0 ]] || continue
                [[ $index =~ ^[1-9][0-9]*$ ]] && (( index <= count )) || { _fail "无效序号"; pause; continue; }
                ((index-=1))
                case "$choice" in
                    2) config_transaction rules_apply delete "$index" ;;
                    3) if prompt_rule; then config_transaction rules_apply edit "$index" "$prompted_rule"; fi ;;
                    4)
                        prompt_input "移动到第几条（1-$count，0 返回）" destination
                        [[ $destination != 0 ]] || continue
                        [[ $destination =~ ^[1-9][0-9]*$ ]] && (( destination <= count )) || { _fail "无效目标序号"; pause; continue; }
                        config_transaction rules_apply move "$index" null "$((destination-1))"
                        ;;
                esac
                ;;
            *) _fail "无效操作" ;;
        esac
        pause
    done
}

relay_apply_landing() {
    local transport_uuid="$1" decryption="${2%%=*}" port="$3" encryption="${4%%=*}" landing_ip="$5" peer="$6" ext_port="${7:-$3}"
    local entry_listen_port="${8:-0}" entry_ext_port="${9:-${8:-0}}" entry_uuid="${10:-}" entry_dec="${11%%=*}" entry_enc="${12%%=*}"
    [[ -n "$entry_listen_port" ]] || entry_listen_port=0
    [[ -n "$entry_ext_port" ]] || entry_ext_port="$entry_listen_port"
    if [[ "$entry_listen_port" != "0" ]]; then
        relay_validate_port "$entry_listen_port" && relay_validate_port "$entry_ext_port" || {
            _fail "NAT v4 过墙端口参数无效"
            return 1
        }
        (( entry_listen_port != port )) || {
            _fail "NAT v4 过墙监听端口不能与落地中继监听端口 ($port) 相同"
            return 1
        }
        (( entry_ext_port != ext_port )) || { _fail "公开入口与互联公网映射端口不能相同"; return 1; }
        if [[ -z "$entry_uuid" ]] || ! relay_validate_uuid "$entry_uuid"; then
            get_uuid
            entry_uuid="$tmp_uuid"
        fi
        if [[ -z "$entry_dec" || -z "$entry_enc" ]] || ! relay_validate_vless_encryption "$entry_dec" || ! relay_validate_vless_encryption "$entry_enc"; then
            relay_generate_vlessenc_entry random || {
                _fail "无法生成方案一 (VLESS Encryption) 密钥参数"
                return 1
            }
            entry_dec="$entry_vlessenc_decryption"
            entry_enc="$entry_vlessenc_encryption"
        fi
    else
        entry_listen_port=0
        entry_ext_port=0
        entry_uuid=""
        entry_dec=""
        entry_enc=""
    fi
    relay_create_landing_inbound "$transport_uuid" "$decryption" "$port" "$entry_listen_port" "$entry_uuid" "$entry_dec" || return 1
    local state
    if (( entry_listen_port > 0 )); then
        state=$(jq -n --arg tuuid "$transport_uuid" --arg dec "$decryption" --argjson port "$port" \
            --argjson ext_port "$ext_port" --arg enc "$encryption" --arg lip "$landing_ip" --arg peer "$peer" \
            --argjson elport "$entry_listen_port" --argjson eext "$entry_ext_port" \
            --arg euuid "$entry_uuid" --arg edec "$entry_dec" --arg eenc "$entry_enc" \
            '{version:1,role:"landing",transport_uuid:$tuuid,decryption:$dec,listen_port:$port,external_port:$ext_port,encryption:$enc,landing_ip:$lip,peer_ip:$peer,entry_listen_port:$elport,entry_external_port:$eext,entry_uuid:$euuid,entry_decryption:$edec,entry_encryption:$eenc}') || return 1
    else
        state=$(jq -n --arg tuuid "$transport_uuid" --arg dec "$decryption" --argjson port "$port" \
            --argjson ext_port "$ext_port" --arg enc "$encryption" --arg lip "$landing_ip" --arg peer "$peer" \
            '{version:1,role:"landing",transport_uuid:$tuuid,decryption:$dec,listen_port:$port,external_port:$ext_port,encryption:$enc,landing_ip:$lip,peer_ip:$peer}') || return 1
    fi
    if (( port == 0 )); then
        if (( entry_listen_port == 0 )); then
            relay_remove_landing_inbound && relay_delete_state && rebuild_main_config
            return
        fi
        state=$(jq -c '.relay_enabled=false | del(.transport_uuid,.decryption,.encryption,.listen_port,.external_port,.peer_ip)' <<< "$state") || return 1
    fi
    local entry_address
    entry_address=$(jq -r '.entry_address // empty' "$is_relay_state_file" 2>/dev/null) || true
    if (( entry_listen_port > 0 )) && [[ -n "$entry_address" ]]; then
        state=$(jq -c --arg addr "$entry_address" '.entry_address=$addr' <<< "$state") || return 1
    fi
    relay_save_state "$state" || return 1
    if [[ -f "$is_config_json" ]] && { (( entry_listen_port > 0 )) || jq -e '.routing.rules[]? | select(.inboundTag == ["relay-entry-v4"])' "$is_config_json" &>/dev/null; }; then
        rebuild_main_config || return 1
    fi
}

relay_keep_nat_entries() {
    local state="$1" entries
    entries=$(jq -c '.nat_entries // {}' "$is_relay_state_file" 2>/dev/null) || entries='{}'
    state=$(jq -c --argjson entries "$entries" '
        (.landings // [] | map(.id) + ["direct"]) as $routes |
        ($entries | with_entries(select(.key as $route | $routes | index($route)))) as $kept |
        if ($kept|length)>0 then .nat_entries=$kept else . end' <<< "$state") || return 1
    if [[ $(jq -r '.role' <<< "$state") == none && $(jq -r '.nat_entries|length' <<< "$state") == 0 ]]; then
        relay_delete_state
    else
        relay_save_state "$state"
    fi
}

relay_apply_line() {
    local lip="$1" port="$2" tuuid="$3" enc="${4%%=*}" cuuid="$5" name="$6" entry_port="${7:-0}" entry_uuid="${8:-}" entry_enc="${9%%=*}" entry_address="${10:-}"
    [[ "$entry_port" =~ ^[0-9]+$ ]] && (( entry_port >= 1 && entry_port <= 65535 )) || entry_port=0
    if (( entry_port == 0 )); then
        entry_uuid=""
        entry_enc=""
    elif ! relay_validate_uuid "$entry_uuid" || ! relay_validate_vless_encryption "$entry_enc"; then
        _fail "公开入口需要独立 UUID 和加密参数，请导入落地机完整中继配置"
        return 1
    fi
    local landings='[]'
    local existing_failover='{"enabled":false,"interval":"60s","order":[]}'
    if [[ -f "$is_relay_state_file" ]]; then
        landings=$(relay_get_landings)
        existing_failover=$(relay_get_failover)
    fi

    local count next_id
    count=$(jq -r 'length' <<< "$landings" 2>/dev/null || echo 0)
    next_id=$((count + 1))
    while jq -e --arg id "$next_id" '.[] | select(.id == $id)' <<< "$landings" &>/dev/null; do
        ((next_id++))
    done
    [[ -n "$name" ]] || name="落地${next_id}"

    local new_landing
    new_landing=$(jq -n --arg id "$next_id" --arg name "$name" \
        --arg lip "$lip" --argjson port "$port" --arg tuuid "$tuuid" \
        --arg enc "$enc" --arg cuuid "$cuuid" --argjson eport "$entry_port" \
        --arg euuid "$entry_uuid" --arg eenc "$entry_enc" '
        {id:$id, name:$name, landing_ip:$lip, landing_port:$port, transport_uuid:$tuuid, encryption:$enc, client_uuid:$cuuid} +
        (if $eport > 0 then {entry_port:$eport} + (if ($euuid | length) > 0 then {entry_uuid:$euuid} else {} end) + (if ($eenc | length) > 0 then {entry_encryption:$eenc} else {} end) else {} end)
    ') || return 1

    local new_landings
    new_landings=$(jq --argjson item "$new_landing" '. + [$item]' <<< "$landings") || return 1

    local updated_failover
    updated_failover=$(jq --arg nid "$next_id" '
        if .order and (.order | length > 0) then
            .order = (.order | if index($nid) then . else . + [$nid] end)
        else
            .
        end
    ' <<< "$existing_failover") || updated_failover="$existing_failover"

    local state
    state=$(jq -n --argjson landings "$new_landings" --argjson fo "$updated_failover" '
        {version:2, role:"line", landings:$landings, landing_ip:$landings[0].landing_ip, landing_port:$landings[0].landing_port, transport_uuid:$landings[0].transport_uuid, encryption:$landings[0].encryption, client_uuid:$landings[0].client_uuid, failover:$fo} +
        (if ($landings[0].entry_port // 0) > 0 then {entry_port:$landings[0].entry_port} + (if ($landings[0].entry_uuid // "") != "" then {entry_uuid:$landings[0].entry_uuid} else {} end) + (if ($landings[0].entry_encryption // "") != "" then {entry_encryption:$landings[0].entry_encryption} else {} end) else {} end)
    ') || return 1

    if (( entry_port > 0 )) && [[ -n "$entry_address" ]]; then
        state=$(jq -c --arg address "$entry_address" '.landings[-1].entry_address=$address' <<< "$state") || return 1
    fi
    relay_keep_nat_entries "$state" && relay_sync_client_identities && rebuild_main_config
}

relay_apply_line_entry_port() {
    local target_id="$1" entry_port="${2:-0}" entry_uuid="${3:-}" entry_enc="${4%%=*}" entry_address="${5:-}"
    if [[ ! -f "$is_relay_state_file" ]] || [[ "$(relay_get_role)" != "line" ]]; then
        _fail "仅线路机支持设置落地机 NAT v4 方案一过墙参数"
        return 1
    fi
    if [[ -z "$entry_port" || "$entry_port" == "0" ]]; then
        entry_port=0
        entry_uuid=""
        entry_enc=""
    elif ! relay_validate_port "$entry_port"; then
        _fail "无效的 v4 过墙端口"
        return 1
    fi
    if (( entry_port > 0 )); then
        if [[ -z "$entry_uuid" || -z "$entry_enc" ]]; then
            _fail "公开入口需要独立 UUID 和加密参数，请粘贴落地机导出的完整中继配置"
            return 1
        fi
        if ! relay_validate_uuid "$entry_uuid"; then
            _fail "无效的过墙 UUID"
            return 1
        fi
        if ! relay_validate_vless_encryption "$entry_enc"; then
            _fail "无效的 VLESS Encryption 密钥参数"
            return 1
        fi
    fi
    local landings existing_failover updated_landings state
    landings=$(relay_get_landings)
    if ! jq -e --arg id "$target_id" '.[] | select(.id == $id)' <<< "$landings" &>/dev/null; then
        _fail "未找到指定的落地机 (ID: $target_id)"
        return 1
    fi
    existing_failover=$(relay_get_failover)
    updated_landings=$(jq --arg id "$target_id" --argjson eport "$entry_port" --arg euuid "$entry_uuid" --arg eenc "$entry_enc" '
        map(if .id == $id then (
            if $eport > 0 then
                . + {entry_port:$eport} +
                (if ($euuid | length) > 0 then {entry_uuid:$euuid} else {} end) +
                (if ($eenc | length) > 0 then {entry_encryption:$eenc} else {} end)
            else
                del(.entry_port, .entry_uuid, .entry_encryption)
            end
        ) else . end)
    ' <<< "$landings") || return 1
    state=$(jq -n --argjson landings "$updated_landings" --argjson fo "$existing_failover" '
        {version:2, role:"line", landings:$landings, landing_ip:$landings[0].landing_ip, landing_port:$landings[0].landing_port, transport_uuid:$landings[0].transport_uuid, encryption:$landings[0].encryption, client_uuid:$landings[0].client_uuid, failover:$fo} +
        (if ($landings[0].entry_port // 0) > 0 then {entry_port:$landings[0].entry_port} + (if ($landings[0].entry_uuid // "") != "" then {entry_uuid:$landings[0].entry_uuid} else {} end) + (if ($landings[0].entry_encryption // "") != "" then {entry_encryption:$landings[0].entry_encryption} else {} end) else {} end)
    ') || return 1
    if (( entry_port > 0 )) && [[ -n "$entry_address" ]]; then
        state=$(jq -c --arg id "$target_id" --arg address "$entry_address" '(.landings[] | select(.id==$id) | .entry_address)=$address' <<< "$state") || return 1
    fi
    relay_keep_nat_entries "$state"
}

relay_apply_remove() {
    case "$1" in
        line)
            local target_id="${2:-all}"
            if [[ ! -f "$is_relay_state_file" ]]; then
                return 0
            fi
            local landings=$(relay_get_landings)
            local existing_failover=$(relay_get_failover)
            local remaining='[]'
            if [[ "$target_id" != "all" && -n "$target_id" ]]; then
                remaining=$(jq --arg id "$target_id" '[.[] | select(.id != $id)]' <<< "$landings")
            fi
            local count=$(jq -r 'length' <<< "$remaining" 2>/dev/null || echo 0)
            if (( count == 0 )); then
                relay_keep_nat_entries '{"version":1,"role":"none"}' && relay_remove_client_identity && rebuild_main_config
            else
                local updated_failover
                updated_failover=$(jq --argjson remaining "$remaining" '
                    ($remaining | map(.id)) as $rem_ids |
                    .order = (.order // [] | map(select(. as $o | $rem_ids | index($o))))
                ' <<< "$existing_failover") || updated_failover="$existing_failover"

                local state
                state=$(jq -n --argjson landings "$remaining" --argjson fo "$updated_failover" '
                    {version:2, role:"line", landings:$landings, landing_ip:$landings[0].landing_ip, landing_port:$landings[0].landing_port, transport_uuid:$landings[0].transport_uuid, encryption:$landings[0].encryption, client_uuid:$landings[0].client_uuid, failover:$fo} +
                    (if ($landings[0].entry_port // 0) > 0 then {entry_port:$landings[0].entry_port} + (if ($landings[0].entry_uuid // "") != "" then {entry_uuid:$landings[0].entry_uuid} else {} end) + (if ($landings[0].entry_encryption // "") != "" then {entry_encryption:$landings[0].entry_encryption} else {} end) else {} end)
                ') || return 1
                relay_keep_nat_entries "$state" && relay_sync_client_identities && rebuild_main_config
            fi
            ;;
        landing)
            relay_remove_landing_inbound && relay_delete_state || return 1
            if [[ -f "$is_config_json" ]] && jq -e '.routing.rules[]? | select(.inboundTag == ["relay-entry-v4"])' "$is_config_json" &>/dev/null; then
                rebuild_main_config || return 1
            fi
            ;;
        *) return 1 ;;
    esac
}

relay_apply_failover() {
    local enabled="$1" interval="$2" order_json="${3:-[]}"
    if [[ ! -f "$is_relay_state_file" ]]; then
        _fail "未找到中继状态文件"
        return 1
    fi
    local role
    role=$(relay_get_role)
    if [[ "$role" != "line" ]]; then
        _fail "仅线路机支持配置故障转移"
        return 1
    fi

    [[ "$enabled" == "true" || "$enabled" == "false" ]] || enabled="false"
    [[ -n "$interval" ]] || interval="60s"
    [[ "$interval" =~ ^[0-9]+s?$ ]] || interval="60s"
    [[ "$interval" == *s ]] || interval="${interval}s"
    if ! echo "$order_json" | jq -e 'type == "array"' &>/dev/null; then
        order_json='[]'
    fi

    local current_state
    current_state=$(cat "$is_relay_state_file")
    local new_state
    new_state=$(jq --arg enabled "$enabled" --arg interval "$interval" --argjson order "$order_json" '
        .failover = {
            "enabled": ($enabled == "true"),
            "interval": $interval,
            "order": $order
        }
    ' <<< "$current_state") || return 1

    relay_save_state "$new_state" && rebuild_main_config
}

relay_setup_landing() {
    local peer landing_ip port ext_port transport_uuid default_port
    local entry_listen_port=0 entry_ext_port=0 entry_uuid="" entry_dec="" entry_enc="" default_entry_port
    echo
    _section "配置本机为落地机"
    if ! firewall_tool_available iptables; then
        _info "当前环境不支持或缺少 iptables 权限（如无特权 LXC 容器），将跳过防火墙来源 IP 限制"
    fi
    relay_generate_vlessenc || { _fail "内核不支持所需的 VLESS Encryption，请先更新"; return 1; }
    local main_dec="$vlessenc_decryption" main_enc="$vlessenc_encryption"
    echo
    echo -e "  ${cyan}落地机用于接收线路机的中继流量（使用原本的 VLESS Encryption 互联方式）。${none}"
    prompt_input "请输入线路机 IPv4 地址 (用于防火墙白名单，若无防火墙权限直接回车跳过)" peer ""
    if [[ -n "$peer" && "$peer" != "0" ]]; then
        relay_validate_ipv4 "$peer" || { _fail "无效的线路机 IPv4"; return 1; }
    else
        peer=""
    fi
    get_ip &>/dev/null || true
    landing_ip="$ip"
    prompt_input "落地机公网地址 (NAT机器请填写公网IP或域名/DDNS)" landing_ip "$landing_ip"
    [[ -n "$landing_ip" && "$landing_ip" != "0" ]] || { _fail "落地机公网地址不能为空"; return 1; }
    relay_validate_host "$landing_ip" || { _fail "无效的公网地址 (必须为合法 IPv4 地址或域名)"; return 1; }
    [[ -z "$peer" || "$landing_ip" != "$peer" ]] || { _fail "落地公网地址不能与线路机相同"; return 1; }

    default_port=$(relay_get_random_port 2>/dev/null) || default_port=30443
    prompt_input "落地机互联监听端口 [NAT 机器请填写映射端口]" port "$default_port"
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { _fail "无效端口"; return 1; }

    prompt_input "落地机互联公网外网端口 [如果与监听端口相同直接回车]" ext_port "$port"
    [[ "$ext_port" =~ ^[0-9]+$ ]] && (( ext_port >= 1 && ext_port <= 65535 )) || { _fail "无效外网端口"; return 1; }

    if prompt_confirm "是否同时开启 NAT v4 方案一过墙入口 (VLESS Encryption random + 1-RTT Padding)？" n; then
        default_entry_port=$(relay_get_random_port 2>/dev/null) || default_entry_port=$((port == 30443 ? 30444 : 30443))
        (( default_entry_port != port )) || default_entry_port=$((port < 65000 ? port + 1 : port - 1))
        prompt_input "本机 NAT v4 过墙监听端口 [NAT 机器请填写另一映射端口]" entry_listen_port "$default_entry_port"
        relay_validate_port "$entry_listen_port" && (( entry_listen_port != port )) || { _fail "无效端口或与落地互联端口冲突"; return 1; }
        prompt_input "本机 NAT v4 过墙公网外网端口 [如果与监听端口相同直接回车]" entry_ext_port "$entry_listen_port"
        relay_validate_port "$entry_ext_port" || { _fail "无效外网端口"; return 1; }
        get_uuid
        entry_uuid="$tmp_uuid"
        relay_generate_vlessenc_entry random || { _fail "无法生成方案一 VLESS Encryption 密钥"; return 1; }
        entry_dec="$entry_vlessenc_decryption"
        entry_enc="$entry_vlessenc_encryption"
    fi

    get_uuid
    transport_uuid="$tmp_uuid"
    if config_transaction relay_apply_landing "$transport_uuid" "$main_dec" "$port" "$main_enc" "$landing_ip" "$peer" "$ext_port" "$entry_listen_port" "$entry_ext_port" "$entry_uuid" "$entry_dec" "$entry_enc"; then
        if [[ -n "$peer" ]] && firewall_tool_available iptables; then
            _ok "落地中继互联已配置 (原有方式)，只有 $peer 可以访问 TCP $port"
        else
            _ok "落地中继互联已配置 (原有方式)，监听端口: TCP $port (公网外网端口: $ext_port)"
        fi
        if (( entry_listen_port > 0 )); then
            _ok "NAT v4 方案一过墙已开启: 本机 TCP $entry_listen_port (公网: $entry_ext_port, 协议: VLESS Encryption random + 1-RTT Padding)"
        fi
        echo
        _info "在线路机导入以下配置："
        echo
        _green "$(relay_build_profile "$transport_uuid" "$landing_ip" "$ext_port" "$main_enc" "$entry_ext_port" "$entry_uuid" "$entry_enc")"
        echo
    fi
}

relay_configure_landing_entry() {
    local tuuid dec port ext_port enc lip peer cur_elport cur_eext cur_euuid cur_edec cur_eenc
    tuuid=$(jq -r '.transport_uuid // ""' "$is_relay_state_file" 2>/dev/null || true)
    dec=$(jq -r '.decryption // ""' "$is_relay_state_file" 2>/dev/null || true)
    port=$(jq -r '.listen_port // 0' "$is_relay_state_file" 2>/dev/null || true)
    ext_port=$(jq -r '.external_port // .listen_port // 0' "$is_relay_state_file" 2>/dev/null || true)
    enc=$(jq -r '.encryption // ""' "$is_relay_state_file" 2>/dev/null || true)
    lip=$(jq -r '.landing_ip // ""' "$is_relay_state_file" 2>/dev/null || true)
    peer=$(jq -r '.peer_ip // ""' "$is_relay_state_file" 2>/dev/null || true)
    cur_elport=$(jq -r '.entry_listen_port // 0' "$is_relay_state_file" 2>/dev/null || true)
    cur_eext=$(jq -r '.entry_external_port // .entry_listen_port // 0' "$is_relay_state_file" 2>/dev/null || true)
    cur_euuid=$(jq -r '.entry_uuid // ""' "$is_relay_state_file" 2>/dev/null || true)
    cur_edec=$(jq -r '.entry_decryption // ""' "$is_relay_state_file" 2>/dev/null || true)
    cur_eenc=$(jq -r '.entry_encryption // ""' "$is_relay_state_file" 2>/dev/null || true)

    local role
    role=$(relay_get_role)
    [[ -z "$role" || "$role" == none || "$role" == landing ]] || { _fail "请先解除线路机角色"; return 1; }
    if [[ "$role" != landing || $(jq -r '.relay_enabled' "$is_relay_state_file" 2>/dev/null) == false ]]; then
        tuuid=""; dec=""; port=0; ext_port=0; enc=""; peer=""
    fi
    if [[ -z "$lip" ]]; then
        get_ip &>/dev/null || true
        prompt_input "NAT 公开 IPv4 地址或域名" lip "${ip:-}"
        relay_validate_host "$lip" || { _fail "无效的 IPv4 地址或域名"; return 1; }
    fi
    cur_elport=${cur_elport:-0}; cur_eext=${cur_eext:-0}

    echo
    _section "NAT v4 方案一过墙入口设置 (VLESS Encryption)"
    _info "客户端通过 NAT v4 高位端口过墙时，采用方案一 (VLESS + VLESS Encryption"
    _info "random 全随机流 + 100-111-1111.75-0-111.50-0-3333 握手填充)，彻底消除高位端口假 TLS 特征。"
    echo
    if (( cur_elport > 0 )); then
        echo -e "  ${cyan}当前状态:${none} ${green}已开启${none} (监听: ${green}${cur_elport}${none}, 公网: ${green}${cur_eext}${none}, 协议: ${green}VLESS Encryption 方案一${none})"
        echo
        _menu 1 "修改 NAT v4 方案一过墙端口 / 重新生成密钥"
        _menu 2 "关闭 NAT v4 方案一过墙入口"
        echo
        echo -ne "  请选择 [${green}1-2${none}] [${red}0 返回${none}]: "
        local sub_choice
        read -r sub_choice || return 1
        [[ "$sub_choice" == "0" || -z "$sub_choice" ]] && return 0
        if [[ "$sub_choice" == "2" ]]; then
            if config_transaction relay_apply_landing "$tuuid" "$dec" "$port" "$enc" "$lip" "$peer" "$ext_port" 0 0 "" "" ""; then
                _ok "已关闭 NAT v4 方案一过墙入口"
            fi
            return 0
        elif [[ "$sub_choice" != "1" ]]; then
            _fail "无效的选项"
            return 1
        fi
    else
        echo -e "  ${cyan}当前状态:${none} ${gray}未开启${none}"
        echo
    fi

    local new_elport new_eext default_elport
    if (( cur_elport > 0 )); then
        default_elport="$cur_elport"
    else
        default_elport=$(relay_get_random_port 2>/dev/null) || default_elport=$((port == 30443 ? 30444 : 30443))
        (( default_elport != port )) || default_elport=$((port < 65000 ? port + 1 : port - 1))
    fi
    prompt_input "本机 NAT v4 过墙监听端口 [NAT 机器请填写另一映射端口]" new_elport "$default_elport"
    relay_validate_port "$new_elport" && (( new_elport != port )) || { _fail "无效端口或与落地中继监听端口 ($port) 冲突"; return 1; }

    local default_eext="$new_elport"
    (( cur_elport > 0 && cur_eext > 0 && new_elport == cur_elport )) && default_eext="$cur_eext"
    prompt_input "本机 NAT v4 过墙公网外网端口 [如果与监听端口相同直接回车]" new_eext "$default_eext"
    relay_validate_port "$new_eext" || { _fail "无效外网端口"; return 1; }

    local new_euuid="$cur_euuid" new_edec="$cur_edec" new_eenc="$cur_eenc"
    if [[ -z "$new_euuid" || -z "$new_edec" || -z "$new_eenc" ]]; then
        get_uuid
        new_euuid="$tmp_uuid"
        relay_generate_vlessenc_entry random || { _fail "无法生成方案一 VLESS Encryption 密钥"; return 1; }
        new_edec="$entry_vlessenc_decryption"
        new_eenc="$entry_vlessenc_encryption"
    fi

    if config_transaction relay_apply_landing "$tuuid" "$dec" "$port" "$enc" "$lip" "$peer" "$ext_port" "$new_elport" "$new_eext" "$new_euuid" "$new_edec" "$new_eenc"; then
        _ok "已启用 NAT v4 方案一过墙入口: 本机 TCP $new_elport (公网: $new_eext)"
        echo
        _info "在线路机选择 IPv4 接入时粘贴以下配置："
        echo
        _green "$(relay_build_profile "$tuuid" "$lip" "$ext_port" "$enc" "$new_eext" "$new_euuid" "$new_eenc")"
        echo
    fi
}

relay_menu_entry_port() {
    echo
    _section "设置落地机 NAT v4 方案一过墙 (VLESS Encryption)"
    if [[ ! -f "$is_relay_state_file" ]] || [[ "$(relay_get_role)" != "line" ]]; then
        _fail "仅线路机支持此设置"
        return 1
    fi
    local landings count sel_idx=0
    landings=$(relay_get_landings)
    count=$(jq -r 'length' <<< "$landings" 2>/dev/null || echo 0)
    if (( count == 0 )); then
        _fail "当前未绑定任何落地机"
        return 1
    elif (( count > 1 )); then
        echo -e "  当前已绑定的落地机:"
        local i l_name l_ip l_port l_eport e_tag
        for (( i=0; i<count; i++ )); do
            l_name=$(jq -r ".[$i].name // \"落地$((i+1))\"" <<< "$landings")
            l_ip=$(jq -r ".[$i].landing_ip" <<< "$landings")
            l_port=$(jq -r ".[$i].landing_port" <<< "$landings")
            l_eport=$(jq -r ".[$i].entry_port // 0" <<< "$landings")
            if (( l_eport > 0 )); then
                e_tag="${green}[NAT-v4方案一端口:${l_eport}]${none}"
            else
                e_tag="${gray}[未开启NAT-v4方案一]${none}"
            fi
            echo -e "  ${green}$((i+1)))${none} [${cyan}${l_name}${none}] ${l_ip}:${l_port} $e_tag"
        done
        echo
        local choice
        prompt_input "请选择要设置的落地机序号 (0 返回)" choice "1"
        [[ "$choice" != "0" && -n "$choice" ]] || return 0
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
            sel_idx=$((choice - 1))
        else
            _fail "无效的序号"
            return 1
        fi
    fi

    local sel_id sel_name sel_ip cur_eport cur_euuid cur_eenc input_val
    sel_id=$(jq -r ".[$sel_idx].id" <<< "$landings")
    sel_name=$(jq -r ".[$sel_idx].name // \"落地$((sel_idx+1))\"" <<< "$landings")
    sel_ip=$(jq -r ".[$sel_idx].landing_ip" <<< "$landings")
    cur_eport=$(jq -r ".[$sel_idx].entry_port // 0" <<< "$landings")
    cur_euuid=$(jq -r ".[$sel_idx].entry_uuid // \"\"" <<< "$landings")
    cur_eenc=$(jq -r ".[$sel_idx].entry_encryption // \"\"" <<< "$landings")

    _info "支持直接粘贴落地机生成的最新中继配置 （JSON） 自动同步方案一过墙参数，"
    _info "或输入端口 (输入 0 关闭 NAT v4 方案一过墙，恢复本机 v4)。"
    echo
    prompt_input "请粘贴落地机中继配置或输入过墙端口 [输入 0 关闭]" input_val "$cur_eport"
    [[ -n "$input_val" ]] || return 0
    if [[ "$input_val" == "0" ]]; then
        if config_transaction relay_apply_line_entry_port "$sel_id" 0 "" ""; then
            _ok "已关闭 [${sel_name}] 的 NAT v4 方案一过墙，恢复使用本机 v4"
        fi
        return 0
    elif [[ "$input_val" == \{* ]]; then
        if ! relay_parse_profile "$input_val" || [[ -z "$parsed_entry_port" || "$parsed_entry_port" == "0" ]]; then
            _fail "所粘贴的中继配置未包含有效的 NAT v4 方案一过墙端口 (entry_port)"
            return 1
        fi
        if config_transaction relay_apply_line_entry_port "$sel_id" "$parsed_entry_port" "$parsed_entry_uuid" "$parsed_entry_encryption" "$parsed_entry_address"; then
            _ok "已同步 [${sel_name}] NAT v4 方案一过墙 (${sel_ip}:${parsed_entry_port})"
        fi
        return 0
    elif relay_validate_port "$input_val"; then
        local new_eport="$input_val" new_euuid="$cur_euuid" new_eenc="$cur_eenc"
        if [[ -z "$new_euuid" || -z "$new_eenc" ]]; then
            _fail "尚未导入公开入口密钥，不能复用互联密钥；请粘贴落地机完整中继配置"
            return 1
        fi
        if config_transaction relay_apply_line_entry_port "$sel_id" "$new_eport" "$new_euuid" "$new_eenc"; then
            _ok "已设置 [${sel_name}] NAT v4 过墙端口为 ${sel_ip}:${new_eport}"
            _info "请进入 [2. 查看客户端配置] 选择 [${sel_name}] 出口导出配置"
        fi
        return 0
    else
        _fail "无效的输入，请粘贴包含 entry_port 的中继配置、有效端口号或 0"
        return 1
    fi
}

relay_setup_line() {
    local input landing_name
    echo
    _section "配置线路机绑定落地机"
    relay_generate_vlessenc || { _fail "内核不支持所需的 VLESS Encryption，请先更新"; return 1; }
    echo
    echo -e "  ${cyan}请输入在落地机上生成的中继配置（JSON）:${none}"
    prompt_input "中继配置" input
    [[ $input != 0 ]] || return
    relay_parse_profile "$input" && [[ -n "$parsed_landing_port" ]] || { _fail "需要包含有效互联参数的 JSON 配置"; return 1; }

    local landings=$(relay_get_landings)
    local dup=$(jq -r --arg lip "$parsed_landing_ip" --argjson lport "$parsed_landing_port" \
        '.[] | select(.landing_ip == $lip and .landing_port == $lport) | .name' <<< "$landings" 2>/dev/null)
    if [[ -n "$dup" ]]; then
        _fail "已绑定过该落地机 ($parsed_landing_ip:$parsed_landing_port)，备注: $dup"
        return 1
    fi

    local count=$(jq -r 'length' <<< "$landings" 2>/dev/null || echo 0)
    prompt_input "落地机备注名称 (例如 香港/日本/落地$((count+1)))" landing_name "落地$((count+1))"
    [[ -n "$landing_name" && "$landing_name" != "0" ]] || landing_name="落地$((count+1))"

    if [[ -n "$parsed_entry_port" && "$parsed_entry_port" != "0" ]]; then
        _info "检测到落地机已开启 NAT v4 方案一过墙入口: ${parsed_entry_port}"
    fi

    get_uuid
    if config_transaction relay_apply_line "$parsed_landing_ip" "$parsed_landing_port" "$parsed_transport_uuid" "$parsed_encryption" "$tmp_uuid" "$landing_name" "${parsed_entry_port:-0}" "${parsed_entry_uuid:-}" "${parsed_entry_encryption:-}" "${parsed_entry_address:-}"; then
        _ok "成功绑定落地机 [${landing_name}] (${parsed_landing_ip}:${parsed_landing_port})"
        if [[ -n "$parsed_entry_port" && "$parsed_entry_port" != "0" ]]; then
            _ok "已同步 NAT v4 方案一过墙入口: ${parsed_landing_ip}:${parsed_entry_port}"
        fi
        _info "在导出客户端配置时可选择经由 [${landing_name}] 出口"
    fi
}

relay_remove_line() {
    echo
    _section "解除线路机落地绑定"
    local landings=$(relay_get_landings)
    local count=$(jq -r 'length' <<< "$landings" 2>/dev/null || echo 0)
    if (( count == 0 )); then
        _info "当前未绑定任何落地机"
        return
    elif (( count == 1 )); then
        local lname=$(jq -r '.[0].name // "落地机"' <<< "$landings")
        prompt_confirm "确认解除与落地机 [${lname}] 的绑定吗？" n || return
        config_transaction relay_apply_remove line all
    else
        echo -e "  当前已绑定的落地机列表:"
        local i l_name l_ip l_port
        for (( i=0; i<count; i++ )); do
            l_name=$(jq -r ".[$i].name" <<< "$landings")
            l_ip=$(jq -r ".[$i].landing_ip" <<< "$landings")
            l_port=$(jq -r ".[$i].landing_port" <<< "$landings")
            echo -e "  ${green}$((i+1)))${none} [${cyan}${l_name}${none}] ${l_ip}:${l_port}"
        done
        echo
        local choice
        prompt_input "请选择要解除的序号 [输入 A 解除全部, 0 返回]" choice "0"
        [[ "$choice" != "0" && -n "$choice" ]] || return
        if [[ "${choice^^}" == "A" ]]; then
            prompt_confirm "确认解除所有落地机的绑定吗？" n || return
            config_transaction relay_apply_remove line all
        elif [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
            local sel_idx=$((choice - 1))
            local sel_id=$(jq -r ".[$sel_idx].id" <<< "$landings")
            local sel_name=$(jq -r ".[$sel_idx].name" <<< "$landings")
            prompt_confirm "确认解除落地机 [${sel_name}] 的绑定吗？" n || return
            config_transaction relay_apply_remove line "$sel_id"
        else
            _fail "无效的选项"
        fi
    fi
}

relay_remove_landing() {
    echo
    _section "解除落地机配置"
    prompt_confirm "确认解除落地机中继配置吗？" n || return
    config_transaction relay_apply_remove landing
}

install_landing_standalone() {
    _create config.json || return 1
    relay_setup_landing || return 1
}
