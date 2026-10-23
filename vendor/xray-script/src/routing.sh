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
    local transport_uuid="$1" decryption="$2" port="$3" encryption="$4" landing_ip="$5" peer="$6" ext_port="${7:-$3}"
    relay_create_landing_inbound "$transport_uuid" "$decryption" "$port" || return 1
    local state
    state=$(jq -n --arg tuuid "$transport_uuid" --arg dec "$decryption" --argjson port "$port" \
        --argjson ext_port "$ext_port" --arg enc "$encryption" --arg lip "$landing_ip" --arg peer "$peer" \
        '{version:1,role:"landing",transport_uuid:$tuuid,decryption:$dec,listen_port:$port,external_port:$ext_port,encryption:$enc,landing_ip:$lip,peer_ip:$peer}') || return 1
    relay_save_state "$state"
}

relay_apply_line() {
    local lip="$1" port="$2" tuuid="$3" enc="$4" cuuid="$5" name="$6"
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
        --arg enc "$enc" --arg cuuid "$cuuid" \
        '{id:$id, name:$name, landing_ip:$lip, landing_port:$port, transport_uuid:$tuuid, encryption:$enc, client_uuid:$cuuid}') || return 1

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
    state=$(jq -n --argjson landings "$new_landings" --argjson fo "$updated_failover" \
        '{version:2, role:"line", landings:$landings, landing_ip:$landings[0].landing_ip, landing_port:$landings[0].landing_port, transport_uuid:$landings[0].transport_uuid, encryption:$landings[0].encryption, client_uuid:$landings[0].client_uuid, failover:$fo}') || return 1

    relay_save_state "$state" && relay_sync_client_identities && rebuild_main_config
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
                relay_delete_state && relay_remove_client_identity && rebuild_main_config
            else
                local updated_failover
                updated_failover=$(jq --argjson remaining "$remaining" '
                    ($remaining | map(.id)) as $rem_ids |
                    .order = (.order // [] | map(select(. as $o | $rem_ids | index($o))))
                ' <<< "$existing_failover") || updated_failover="$existing_failover"

                local state
                state=$(jq -n --argjson landings "$remaining" --argjson fo "$updated_failover" \
                    '{version:2, role:"line", landings:$landings, landing_ip:$landings[0].landing_ip, landing_port:$landings[0].landing_port, transport_uuid:$landings[0].transport_uuid, encryption:$landings[0].encryption, client_uuid:$landings[0].client_uuid, failover:$fo}') || return 1
                relay_save_state "$state" && relay_sync_client_identities && rebuild_main_config
            fi
            ;;
        landing)
            relay_remove_landing_inbound && relay_delete_state
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
    echo
    _section "配置本机为落地机"
    if ! firewall_tool_available iptables; then
        _info "当前环境不支持或缺少 iptables 权限（如无特权 LXC 容器），将跳过防火墙来源 IP 限制"
    fi
    relay_generate_vlessenc || { _fail "内核不支持所需的 VLESS Encryption，请先更新"; return 1; }
    echo
    echo -e "  ${cyan}落地机用于接收线路机的中继流量。${none}"
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
    prompt_input "落地机监听端口 [NAT 机器请填写映射端口]" port "$default_port"
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { _fail "无效端口"; return 1; }

    prompt_input "落地机公网外网端口 [如果与监听端口相同直接回车]" ext_port "$port"
    [[ "$ext_port" =~ ^[0-9]+$ ]] && (( ext_port >= 1 && ext_port <= 65535 )) || { _fail "无效外网端口"; return 1; }

    get_uuid
    transport_uuid="$tmp_uuid"
    if config_transaction relay_apply_landing "$transport_uuid" "$vlessenc_decryption" "$port" "$vlessenc_encryption" "$landing_ip" "$peer" "$ext_port"; then
        if [[ -n "$peer" ]] && firewall_tool_available iptables; then
            _ok "落地中继已配置，只有 $peer 可以访问 TCP $port"
        else
            _ok "落地中继已配置，监听端口: TCP $port (公网外网端口: $ext_port)"
        fi
        echo
        _info "在线路机导入以下链接："
        echo
        _green "$(relay_build_link "$transport_uuid" "$landing_ip" "$ext_port" "$vlessenc_encryption")"
        echo
    fi
}

relay_setup_line() {
    local input landing_name
    echo
    _section "配置线路机绑定落地机"
    relay_generate_vlessenc || { _fail "内核不支持所需的 VLESS Encryption，请先更新"; return 1; }
    echo
    echo -e "  ${cyan}请输入在落地机上生成的中继链接 (vless://...):${none}"
    prompt_input "中继链接" input
    [[ $input != 0 ]] || return
    relay_parse_link "$input" || { _fail "链接需要合法公网 IP 或域名、VLESS 加密及 RAW/Vision 参数"; return 1; }

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

    get_uuid
    if config_transaction relay_apply_line "$parsed_landing_ip" "$parsed_landing_port" "$parsed_transport_uuid" "$parsed_encryption" "$tmp_uuid" "$landing_name"; then
        _ok "成功绑定落地机 [${landing_name}] (${parsed_landing_ip}:${parsed_landing_port})"
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
