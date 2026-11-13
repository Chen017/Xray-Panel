#!/bin/bash

# JSON string syntax is also a quoted YAML scalar, preserving IDs and aliases.
yaml_string() { jq -cn --arg value "$1" '$value'; }

export_nat_guard_yaml() {
    local name="$1" host="$2" entry_port="$3" entry_uuid="$4" entry_enc="$5"
    cat <<EOF
- name: $(yaml_string "$name")
  type: vless
  server: $(yaml_string "$host")
  port: $entry_port
  uuid: $entry_uuid
  network: tcp
  tls: false
  udp: true
  tfo: false
  mptcp: true
  packet-encoding: xudp
  encryption: $(yaml_string "$entry_enc")
EOF
}

export_landing_vlessenc() {
    if [[ ! -f "$is_relay_state_file" ]] || [[ "$(relay_get_role)" != "landing" ]]; then
        _fail "当前非落地机模式"
        return 1
    fi
    local lip eext euuid eenc
    lip=$(jq -r '.entry_address // .landing_ip // ""' "$is_relay_state_file")
    eext=$(jq -r '.entry_external_port // .entry_listen_port // 0' "$is_relay_state_file")
    euuid=$(jq -r '.entry_uuid // ""' "$is_relay_state_file")
    eenc=$(jq -r '.entry_encryption // ""' "$is_relay_state_file")
    eenc="${eenc%%=*}"
    if [[ ! "$eext" =~ ^[0-9]+$ ]] || (( eext == 0 )) || [[ -z "$euuid" || -z "$eenc" ]]; then
        _info "当前纯落地机尚未开启 NAT v4 方案一过墙入口；请先进入菜单 4 (线路 / 落地互联) 开启"
        return 1
    fi
    export_nat_guard_yaml "NAT-v4-VLESS-Encryption (${lip})" "$lip" "$eext" "$euuid" "$eenc"
    footer_msg
}

info() {
    is_can_change=(0 1 2 3 4 5 6 7 8 9 10)
    if [[ ! $is_protocol ]]; then
        get info $1
    fi
    [[ $is_dont_show_info || $is_dont_auto_exit ]] && return # dont show info

    get addr
    is_color=41

    # Check relay role and prompt outbound choice if line VPS
    local active_uuid=$uuid
    local outbound_mode="direct"
    local selected_landing_name=""
    local selected_route=direct selected_entry=""
    local selected_entry_uuid="" selected_entry_enc=""
    local role=$(relay_get_role)
    if [[ "$role" == "line" && -f $is_relay_state_file ]]; then
        local landings_json=$(relay_get_landings)
        local count=$(jq -r 'length' <<< "$landings_json" 2>/dev/null || echo 0)
        if (( count > 0 )); then
            local -a options=("本机直出")
            local i l_name l_ip
            for (( i=0; i<count; i++ )); do
                l_name=$(jq -r ".[$i].name // \"落地$((i+1))\"" <<< "$landings_json")
                l_ip=$(jq -r ".[$i].landing_ip // \"\"" <<< "$landings_json")
                if [[ "$l_name" == "默认落地" ]]; then
                    options+=("经落地(${l_ip})")
                else
                    options+=("经落地-${l_name}(${l_ip})")
                fi
            done
            echo
            is_tmp_list=("${options[@]}")
            ask list is_outbound_choice null "\n  请选择出口:"
            [[ $REPLY == "0" ]] && return
            if (( REPLY > 1 )); then
                local idx=$((REPLY - 2))
                active_uuid=$(jq -r ".[$idx].client_uuid // empty" <<< "$landings_json")
                [[ $(is_test uuid "$active_uuid") ]] || { _fail "所选落地机的客户端 UUID 无效，请重新绑定"; return 1; }
                selected_landing_name=$(jq -r ".[$idx].name // \"落地$((idx+1))\"" <<< "$landings_json")
                selected_route=$(jq -r ".[$idx].id" <<< "$landings_json")
                selected_entry=$(jq -c ".[$idx] | select(.entry_enabled != false and (.entry_port // 0) > 0) | {address:(.entry_address // .landing_ip),port:.entry_port,uuid:.entry_uuid,encryption:.entry_encryption}" <<< "$landings_json")
                outbound_mode="landing"
            fi
        fi
    fi

    # get active shortId (v4 uses [0], v6 uses [1] to ensure different SIDs in split mode)
    is_v4_sid=$(jq -r '.[0] // ""' <<<$v4_short_ids)
    [[ "$is_v4_sid" == "null" ]] && is_v4_sid=""
    is_v6_sid=$(jq -r '.[1] // .[0] // ""' <<<$v6_short_ids)
    [[ "$is_v6_sid" == "null" ]] && is_v6_sid=""

    get_ipv6
    v6_ip=${ipv6:-""}

    local has_nat_v4_plan1=0 legacy_vision=0 v4_entry_ip v4_entry_port entry_name
    local -a entry_values=() entry_choices=("直连线路 VPS" "粘贴 NAT 入口配置")
    local explicit_entry=""
    if [[ -f "$is_relay_state_file" ]]; then
        explicit_entry=$(jq -c --arg route "$selected_route" '(.nat_entries // {}) | if has($route) then .[$route] else empty end' "$is_relay_state_file")
        [[ -z "$explicit_entry" ]] || selected_entry="$explicit_entry"
    fi
    if [[ -n "$selected_entry" && "$selected_entry" != null ]]; then
        entry_name=$(jq -r '.address // "尚未就绪"' <<< "$selected_entry")
        entry_choices=("使用已配置 NAT 入口 (${entry_name})" "${entry_choices[@]}")
    else
        selected_entry=""
    fi
    is_tmp_list=("${entry_choices[@]}")
    ask list is_entry_choice null "\n  请选择 IPv4 接入:"
    [[ $REPLY == "0" || -z $REPLY ]] && return
    case "$is_entry_choice" in
        使用已配置*)
            mapfile -t entry_values < <(jq -r '.address // "",.port // 0,.uuid // "",.encryption // ""' <<< "$selected_entry")
            v4_entry_ip=${entry_values[0]}; v4_entry_port=${entry_values[1]}
            selected_entry_uuid=${entry_values[2]}; selected_entry_enc=${entry_values[3]}
            [[ -n "$explicit_entry" ]] || legacy_vision=1
            ;;
        粘贴*)
            local entry_input
            prompt_input "NAT 入口配置 JSON" entry_input
            relay_parse_profile "$entry_input" && [[ -n "$parsed_entry_port" ]] || { _fail "需要包含公开 IPv4 入口的配置"; return 1; }
            v4_entry_ip="$parsed_entry_address"; v4_entry_port="$parsed_entry_port"
            selected_entry_uuid="$parsed_entry_uuid"; selected_entry_enc="$parsed_entry_encryption"
            ;;
    esac
    if [[ -n "$selected_entry_uuid" || "$is_entry_choice" == 使用已配置* ]]; then
        relay_validate_host "$v4_entry_ip" && relay_validate_port "$v4_entry_port" &&
            relay_validate_uuid "$selected_entry_uuid" && relay_validate_vless_encryption "$selected_entry_enc" ||
            { _fail "公开 IPv4 入口尚未就绪"; return 1; }
        has_nat_v4_plan1=1
        selected_entry_enc="${selected_entry_enc%%=*}"
    fi

    local is_v6_uplink=""
    [[ ! -f $is_conf_dir/is_v6_uplink ]] || is_v6_uplink=1

    local uplink_port downlink_port
    if [[ $is_v6_uplink ]]; then
        uplink_ip=$v6_ip
        uplink_port=$port
        uplink_sni=$v6_sni
        uplink_sid=$is_v6_sid
        downlink_ip=$is_addr
        downlink_port=$port
        downlink_sni=$v4_sni
        downlink_sid=$is_v4_sid
    else
        uplink_ip=$is_addr
        uplink_port=$port
        uplink_sni=$v4_sni
        uplink_sid=$is_v4_sid
        downlink_ip=$v6_ip
        downlink_port=$port
        downlink_sni=$v6_sni
        downlink_sid=$is_v6_sid
    fi

    echo
    ask list is_deploy_mode "XHTTP双栈分离 XHTTP单栈 仅VisionReality" "\n  请选择部署模式:"
    [[ $REPLY == "0" ]] && return

    local is_v4_choice=0
    if [[ $is_deploy_mode == "仅VisionReality" ]]; then
        # ask which SNI for vision-only
        echo
        ask list is_vision_sni_choice "v4-SNI($v4_sni) v6-SNI($v6_sni)" "\n  请选择 SNI:"
        [[ $REPLY == "0" ]] && return
        if [[ $REPLY == 1 ]]; then
            is_v4_choice=1
            local vision_sni=$v4_sni
            local vision_sid=$is_v4_sid
            local vision_ip=$is_addr
            local vision_port=$port
        else
            local vision_sni=$v6_sni
            local vision_sid=$is_v6_sid
            local vision_ip=$v6_ip
            local vision_port=$port
        fi
    elif [[ $is_deploy_mode == "XHTTP单栈" ]]; then
        # ask which SNI for single stack
        echo
        ask list is_single_sni_choice "v4-SNI($v4_sni) v6-SNI($v6_sni)" "\n  请选择 SNI:"
        [[ $REPLY == "0" ]] && return
        if [[ $REPLY == 1 ]]; then
            is_v4_choice=1
            local single_sni=$v4_sni
            local single_sid=$is_v4_sid
            local single_ip=$is_addr
            local single_port=$port
        else
            local single_sni=$v6_sni
            local single_sid=$is_v6_sid
            local single_ip=$v6_ip
            local single_port=$port
        fi
    fi

    local suffix="Landing"
    [[ -z "$selected_landing_name" || "$selected_landing_name" == "默认落地" ]] || suffix="Landing-${selected_landing_name}"
    local nat_guard_name="${suffix}-NAT-v4-VLESS-Enc"

    if [[ $is_deploy_mode == "XHTTP双栈分离" ]]; then
        # ── XHTTP split mode ──
        local split_name="${is_config_name} (XHTTP-Split)"
        if [[ "$outbound_mode" == "landing" ]]; then
            split_name="${is_config_name} (XHTTP-Split-${suffix})"
        fi

        local split_top_dialer="" split_download_dialer=""
        if (( has_nat_v4_plan1 )); then
            if [[ -z "$is_v6_uplink" ]]; then
                split_top_dialer="  dialer-proxy: $(yaml_string "$nat_guard_name")"$'\n'
                split_download_dialer='      dialer-proxy: ""'$'\n'
            else
                split_download_dialer="      dialer-proxy: $(yaml_string "$nat_guard_name")"$'\n'
            fi
        fi
        cat <<EOF
- name: $(yaml_string "$split_name")
  type: vless
  server: "$uplink_ip"
  port: $uplink_port
  uuid: $active_uuid
  network: xhttp
  tls: true
  udp: true
  tfo: true
  mptcp: true
  packet-encoding: xudp
  encryption: none
  servername: $uplink_sni
  client-fingerprint: chrome
  alpn:
    - h2
${split_top_dialer}  reality-opts:
    public-key: $is_public_key
    short-id: $(yaml_string "$uplink_sid")
  xhttp-opts:
    mode: stream-up
    host: $uplink_sni
    path: $v4_path
    uplink-http-method: PUT
    no-grpc-header: true
    x-padding-bytes: "100-1000"
    x-padding-obfs-mode: true
    x-padding-placement: queryInHeader
    x-padding-method: tokenish
    x-padding-key: x_padding
    x-padding-header: Referer
    session-placement: path
    seq-placement: path
    reuse-settings:
      max-concurrency: "16-32"
      c-max-reuse-times: 0
      h-max-request-times: "600-900"
      h-max-reusable-secs: "1800-3000"
      h-keep-alive-period: 0
    download-settings:
${split_download_dialer}      server: "$downlink_ip"
      port: $downlink_port
      tls: true
      alpn:
        - h2
      servername: $downlink_sni
      client-fingerprint: firefox
      reality-opts:
        public-key: $is_public_key
        short-id: $(yaml_string "$downlink_sid")
      host: $downlink_sni
      path: $v4_path
      reuse-settings:
        max-concurrency: "8-16"
        c-max-reuse-times: 0
        h-max-request-times: "300-600"
        h-max-reusable-secs: "2400-3600"
        h-keep-alive-period: 0
EOF
        if (( has_nat_v4_plan1 )); then
            export_nat_guard_yaml "$nat_guard_name" "$v4_entry_ip" "$v4_entry_port" "$selected_entry_uuid" "$selected_entry_enc"
        fi

    elif [[ $is_deploy_mode == "XHTTP单栈" ]]; then
        # ── XHTTP single mode ──
        local single_name="${is_config_name} (XHTTP-Single)"
        if [[ "$outbound_mode" == "landing" ]]; then
            single_name="${is_config_name} (XHTTP-Single-${suffix})"
        fi

        local single_dialer=""
        if (( has_nat_v4_plan1 && is_v4_choice )); then
            single_dialer="  dialer-proxy: $(yaml_string "$nat_guard_name")"$'\n'
        fi
        cat <<EOF
- name: $(yaml_string "$single_name")
  type: vless
  server: "$single_ip"
  port: $single_port
  uuid: $active_uuid
  network: xhttp
  tls: true
  udp: true
  tfo: true
  mptcp: true
  packet-encoding: xudp
  encryption: none
  servername: $single_sni
  client-fingerprint: chrome
  alpn:
    - h2
${single_dialer}  reality-opts:
    public-key: $is_public_key
    short-id: $(yaml_string "$single_sid")
  xhttp-opts:
    mode: stream-up
    host: $single_sni
    path: $v4_path
    uplink-http-method: PUT
    no-grpc-header: true
    x-padding-bytes: "100-1000"
    x-padding-obfs-mode: true
    x-padding-placement: queryInHeader
    x-padding-method: tokenish
    x-padding-key: x_padding
    x-padding-header: Referer
    session-placement: path
    seq-placement: path
    reuse-settings:
      max-concurrency: "16-32"
      c-max-reuse-times: 0
      h-max-request-times: "600-900"
      h-max-reusable-secs: "1800-3000"
      h-keep-alive-period: 0
EOF
        if (( has_nat_v4_plan1 && is_v4_choice )); then
            export_nat_guard_yaml "$nat_guard_name" "$v4_entry_ip" "$v4_entry_port" "$selected_entry_uuid" "$selected_entry_enc"
        fi

    else
        local vision_name="Vision-Reality"
        if [[ "$outbound_mode" == "landing" ]]; then
            vision_name="Vision-Reality-${suffix}"
        fi
        local vision_dialer=""
        if (( has_nat_v4_plan1 && is_v4_choice )); then
            export_nat_guard_yaml "$nat_guard_name" "$v4_entry_ip" "$v4_entry_port" "$selected_entry_uuid" "$selected_entry_enc"
            if (( legacy_vision )); then footer_msg; return; fi
            vision_dialer="  dialer-proxy: $(yaml_string "$nat_guard_name")"$'\n'
        fi
        cat <<EOF
- name: $(yaml_string "$vision_name")
  type: vless
  server: "$vision_ip"
  port: $vision_port
  uuid: $active_uuid
  network: tcp
  tls: true
  udp: true
  tfo: true
  mptcp: true
  packet-encoding: xudp
  encryption: none
${vision_dialer}  flow: xtls-rprx-vision
  servername: $vision_sni
  client-fingerprint: chrome
  reality-opts:
    public-key: $is_public_key
    short-id: $(yaml_string "$vision_sid")
EOF
    fi

    footer_msg
}
