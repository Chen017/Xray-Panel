#!/bin/bash

# JSON string syntax is also a quoted YAML scalar, preserving IDs and aliases.
yaml_string() { jq -cn --arg value "$1" '$value'; }

export_landing_vlessenc() {
    if [[ ! -f "$is_relay_state_file" ]] || [[ "$(relay_get_role)" != "landing" ]]; then
        _fail "当前非落地机模式"
        return 1
    fi
    local lip eext euuid eenc
    lip=$(jq -r '.landing_ip // ""' "$is_relay_state_file")
    eext=$(jq -r '.entry_external_port // .entry_listen_port // 0' "$is_relay_state_file")
    euuid=$(jq -r '.entry_uuid // ""' "$is_relay_state_file")
    eenc=$(jq -r '.entry_encryption // ""' "$is_relay_state_file")
    eenc="${eenc%%=*}"
    if [[ ! "$eext" =~ ^[0-9]+$ ]] || (( eext == 0 )) || [[ -z "$euuid" || -z "$eenc" ]]; then
        _info "当前纯落地机尚未开启 NAT v4 方案一过墙入口；请先进入菜单 4 (线路 / 落地互联) 开启"
        return 1
    fi
    echo
    ask list is_output_format "Mihomo配置 VLESS链接" "\n  请选择输出格式:"
    [[ $REPLY == "0" ]] && return
    local node_name="NAT-v4-VLESS-Encryption (${lip})"
    local node_tag
    node_tag=$(printf "%s" "NAT-v4-VLESS-Enc" | jq -Rr @uri)
    if [[ $is_output_format == "Mihomo配置" ]]; then
        cat <<EOF
- name: $(yaml_string "$node_name")
  type: vless
  server: "$lip"
  port: $eext
  uuid: $euuid
  network: tcp
  tls: false
  udp: true
  tfo: true
  mptcp: true
  packet-encoding: xudp
  flow: xtls-rprx-vision
  encryption: $(yaml_string "$eenc")
EOF
    else
        local vless_link="vless://${euuid}@${lip}:${eext}?encryption=${eenc}&security=none&flow=xtls-rprx-vision&type=tcp#${node_tag}"
        echo
        _step "VLESS 分享链接 (NAT v4 方案一 VLESS Encryption 过墙):"
        echo
        printf '%s\n' "$vless_link"
    fi
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
    local selected_landing_ip=""
    local selected_entry_port=0
    local selected_entry_uuid=""
    local selected_entry_enc=""
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
                selected_landing_ip=$(jq -r ".[$idx].landing_ip // empty" <<< "$landings_json")
                selected_entry_port=$(jq -r ".[$idx].entry_port // 0" <<< "$landings_json")
                selected_entry_uuid=$(jq -r ".[$idx].entry_uuid // empty" <<< "$landings_json")
                selected_entry_enc=$(jq -r ".[$idx].entry_encryption // empty" <<< "$landings_json")
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

    local has_nat_v4_plan1=0
    local v4_entry_ip="$is_addr"
    local v4_entry_port="$port"
    if [[ "$outbound_mode" == "landing" && -n "$selected_landing_ip" && "$selected_entry_port" =~ ^[0-9]+$ ]] && (( selected_entry_port >= 1 && selected_entry_port <= 65535 )); then
        has_nat_v4_plan1=1
        v4_entry_ip="$selected_landing_ip"
        v4_entry_port="$selected_entry_port"
        [[ -n "$selected_entry_uuid" ]] || selected_entry_uuid="$active_uuid"
        if [[ -z "$selected_entry_enc" ]]; then
            selected_entry_enc=$(jq -r '.landings[]? | select(.landing_ip == "'"$selected_landing_ip"'") | .encryption // empty' "$is_relay_state_file" 2>/dev/null | head -1)
        fi
        selected_entry_enc="${selected_entry_enc%%=*}"
        _info "已启用 NAT v4 方案一过墙 (VLESS Encryption): NAT v4 走 [${selected_landing_name}] (${v4_entry_ip}:${v4_entry_port})，v6 走本机 (${v6_ip:-$is_addr}:${port})，双机维持原有互联落地"
    fi

    v4_url="$is_protocol://$active_uuid@$is_addr:$port?encryption=none&security=reality&flow=xtls-rprx-vision&type=tcp&sni=${v4_sni}&pbk=$is_public_key&fp=chrome&sid=${is_v4_sid}#233boy-v4-$is_addr"
    v6_url="$is_protocol://$active_uuid@$is_addr:$port?encryption=none&security=reality&flow=xtls-rprx-vision&type=tcp&sni=${v6_sni}&pbk=$is_public_key&fp=chrome&sid=${is_v6_sid}#233boy-v6-$is_addr"

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
            local vision_addr=$is_addr
            local vision_port=$port
        else
            local vision_sni=$v6_sni
            local vision_sid=$is_v6_sid
            local vision_ip=$v6_ip
            local vision_addr=$v6_ip
            local vision_port=$port
        fi
        [[ "$vision_addr" == *:* ]] && vision_addr="[$vision_addr]"
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
            local single_addr=$is_addr
            local single_port=$port
        else
            local single_sni=$v6_sni
            local single_sid=$is_v6_sid
            local single_ip=$v6_ip
            local single_addr=$v6_ip
            local single_port=$port
        fi
        [[ "$single_addr" == *:* ]] && single_addr="[$single_addr]"
    fi

    echo
    ask list is_output_format "Mihomo配置 VLESS链接" "\n  请选择输出格式:"
    [[ $REPLY == "0" ]] && return

    local suffix="Landing"
    [[ -z "$selected_landing_name" || "$selected_landing_name" == "默认落地" ]] || suffix="Landing-${selected_landing_name}"
    local nat_guard_name="${suffix}-NAT-v4-VLESS-Enc"

    if [[ $is_deploy_mode == "XHTTP双栈分离" ]]; then
        # ── XHTTP split mode ──
        local split_name="${is_config_name} (XHTTP-Split)"
        local split_tag="Premium-Split"
        if [[ "$outbound_mode" == "landing" ]]; then
            split_name="${is_config_name} (XHTTP-Split-${suffix})"
            split_tag="Premium-Split-${suffix}"
        fi

        if [[ $is_output_format == "Mihomo配置" ]]; then
            if (( has_nat_v4_plan1 )); then
                local split_top_dialer=""
                [[ -z "$is_v6_uplink" ]] && split_top_dialer="  dialer-proxy: $(yaml_string "$nat_guard_name")"$'\n'
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
      server: "$downlink_ip"
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
- name: $(yaml_string "$nat_guard_name")
  type: vless
  server: "$v4_entry_ip"
  port: $v4_entry_port
  uuid: $selected_entry_uuid
  network: tcp
  tls: false
  udp: true
  tfo: true
  mptcp: true
  packet-encoding: xudp
  flow: xtls-rprx-vision
  encryption: $(yaml_string "$selected_entry_enc")
EOF
            else
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
  reality-opts:
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
      server: "$downlink_ip"
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
            fi
        else
            # generate XHTTP Split VLESS link
            local extra_split_json="{\"uplinkHTTPMethod\":\"PUT\",\"noGRPCHeader\":true,\"xPaddingBytes\":\"100-1000\",\"xPaddingObfsMode\":true,\"xPaddingKey\":\"x_padding\",\"xPaddingHeader\":\"Referer\",\"xPaddingPlacement\":\"queryInHeader\",\"xPaddingMethod\":\"tokenish\",\"sessionPlacement\":\"path\",\"seqPlacement\":\"path\",\"xmux\":{\"maxConcurrency\":\"16-32\",\"cMaxReuseTimes\":0,\"hMaxRequestTimes\":\"600-900\",\"hMaxReusableSecs\":\"1800-3000\",\"hKeepAlivePeriod\":0},\"downloadSettings\":{\"address\":\"$downlink_ip\",\"port\":$downlink_port,\"network\":\"xhttp\",\"security\":\"reality\",\"realitySettings\":{\"fingerprint\":\"firefox\",\"serverName\":\"$downlink_sni\",\"publicKey\":\"$is_public_key\",\"shortId\":\"$downlink_sid\"},\"xhttpSettings\":{\"host\":\"$downlink_sni\",\"path\":\"$v4_path\",\"noGRPCHeader\":true,\"xPaddingBytes\":\"100-1000\",\"xPaddingObfsMode\":true,\"xPaddingKey\":\"x_padding\",\"xPaddingHeader\":\"Referer\",\"xPaddingPlacement\":\"queryInHeader\",\"xPaddingMethod\":\"tokenish\",\"sessionPlacement\":\"path\",\"seqPlacement\":\"path\",\"xmux\":{\"maxConcurrency\":\"8-16\",\"cMaxReuseTimes\":0,\"hMaxRequestTimes\":\"300-600\",\"hMaxReusableSecs\":\"2400-3600\",\"hKeepAlivePeriod\":0}}}}"
            local encoded_extra_split=$(printf '%s' "$extra_split_json" | jq -Rr @uri | tr -d '\n')
            local server_addr="$uplink_ip"
            [[ "$server_addr" == *:* ]] && server_addr="[$server_addr]"
            local encoded_path=$(printf '%s' "$v4_path" | jq -Rr @uri | tr -d '\n')
            local encoded_split_tag=$(printf "%s" "$split_tag" | jq -Rr @uri)
            local vless_link_split="vless://${active_uuid}@${server_addr}:${uplink_port}?encryption=none&security=reality&sni=${uplink_sni}&fp=chrome&pbk=${is_public_key}&sid=${uplink_sid}&alpn=h2&type=xhttp&host=${uplink_sni}&path=${encoded_path}&mode=stream-up&extra=${encoded_extra_split}#${encoded_split_tag}"

            echo
            _step "VLESS 分享链接 (XHTTP 分离):"
            echo
            printf '%s\n' "$vless_link_split"
            if (( has_nat_v4_plan1 )); then
                local nat_tag=$(printf "%s" "$nat_guard_name" | jq -Rr @uri)
                local nat_vless_link="vless://${selected_entry_uuid}@${v4_entry_ip}:${v4_entry_port}?encryption=${selected_entry_enc}&security=none&flow=xtls-rprx-vision&type=tcp#${nat_tag}"
                echo
                _step "NAT v4 方案一过墙分享链接 (VLESS Encryption):"
                echo
                printf '%s\n' "$nat_vless_link"
            fi
        fi
    elif [[ $is_deploy_mode == "XHTTP单栈" ]]; then
        # ── XHTTP single mode ──
        local single_name="${is_config_name} (XHTTP-Single)"
        local single_tag="Premium-Single"
        if [[ "$outbound_mode" == "landing" ]]; then
            single_name="${is_config_name} (XHTTP-Single-${suffix})"
            single_tag="Premium-Single-${suffix}"
        fi

        if [[ $is_output_format == "Mihomo配置" ]]; then
            if (( has_nat_v4_plan1 && is_v4_choice )); then
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
  dialer-proxy: $(yaml_string "$nat_guard_name")
  reality-opts:
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
- name: $(yaml_string "$nat_guard_name")
  type: vless
  server: "$v4_entry_ip"
  port: $v4_entry_port
  uuid: $selected_entry_uuid
  network: tcp
  tls: false
  udp: true
  tfo: true
  mptcp: true
  packet-encoding: xudp
  flow: xtls-rprx-vision
  encryption: $(yaml_string "$selected_entry_enc")
EOF
            else
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
  reality-opts:
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
            fi
        else
            # generate XHTTP Single VLESS link
            local extra_single_json="{\"uplinkHTTPMethod\":\"PUT\",\"noGRPCHeader\":true,\"xPaddingBytes\":\"100-1000\",\"xPaddingObfsMode\":true,\"xPaddingKey\":\"x_padding\",\"xPaddingHeader\":\"Referer\",\"xPaddingPlacement\":\"queryInHeader\",\"xPaddingMethod\":\"tokenish\",\"sessionPlacement\":\"path\",\"seqPlacement\":\"path\",\"xmux\":{\"maxConcurrency\":\"16-32\",\"cMaxReuseTimes\":0,\"hMaxRequestTimes\":\"600-900\",\"hMaxReusableSecs\":\"1800-3000\",\"hKeepAlivePeriod\":0}}"
            local encoded_extra_single=$(printf '%s' "$extra_single_json" | jq -Rr @uri | tr -d '\n')
            local server_addr="$single_ip"
            [[ "$server_addr" == *:* ]] && server_addr="[$server_addr]"
            local encoded_path=$(printf '%s' "$v4_path" | jq -Rr @uri | tr -d '\n')
            local encoded_single_tag=$(printf "%s" "$single_tag" | jq -Rr @uri)
            local vless_link_single="vless://${active_uuid}@${server_addr}:${single_port}?encryption=none&security=reality&sni=${single_sni}&fp=chrome&pbk=${is_public_key}&sid=${single_sid}&alpn=h2&type=xhttp&host=${single_sni}&path=${encoded_path}&mode=stream-up&extra=${encoded_extra_single}#${encoded_single_tag}"

            echo
            _step "VLESS 分享链接 (XHTTP 单栈):"
            echo
            printf '%s\n' "$vless_link_single"
            if (( has_nat_v4_plan1 && is_v4_choice )); then
                local nat_tag=$(printf "%s" "$nat_guard_name" | jq -Rr @uri)
                local nat_vless_link="vless://${selected_entry_uuid}@${v4_entry_ip}:${v4_entry_port}?encryption=${selected_entry_enc}&security=none&flow=xtls-rprx-vision&type=tcp#${nat_tag}"
                echo
                _step "NAT v4 方案一过墙分享链接 (VLESS Encryption):"
                echo
                printf '%s\n' "$nat_vless_link"
            fi
        fi
    else
        # ── Vision Reality / NAT-v4 Plan 1 mode ──
        local vision_name="Vision-Reality"
        local vision_tag="Premium"
        if [[ "$outbound_mode" == "landing" ]]; then
            vision_name="Vision-Reality-${suffix}"
            vision_tag="Premium-${suffix}"
        fi

        if (( has_nat_v4_plan1 && is_v4_choice )); then
            # Direct Plan 1 (VLESS Encryption) over NAT v4 high port
            if [[ $is_output_format == "Mihomo配置" ]]; then
                cat <<EOF
- name: $(yaml_string "$nat_guard_name")
  type: vless
  server: "$v4_entry_ip"
  port: $v4_entry_port
  uuid: $selected_entry_uuid
  network: tcp
  tls: false
  udp: true
  tfo: true
  mptcp: true
  packet-encoding: xudp
  flow: xtls-rprx-vision
  encryption: $(yaml_string "$selected_entry_enc")
EOF
            else
                local nat_tag=$(printf "%s" "$vision_tag" | jq -Rr @uri)
                local vless_link="vless://${selected_entry_uuid}@${v4_entry_ip}:${v4_entry_port}?encryption=${selected_entry_enc}&security=none&flow=xtls-rprx-vision&type=tcp#${nat_tag}"
                echo
                _step "VLESS 分享链接 (NAT v4 方案一 VLESS Encryption 过墙):"
                echo
                printf '%s\n' "$vless_link"
            fi
        else
            if [[ $is_output_format == "Mihomo配置" ]]; then
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
  flow: xtls-rprx-vision
  servername: $vision_sni
  client-fingerprint: chrome
  reality-opts:
    public-key: $is_public_key
    short-id: $(yaml_string "$vision_sid")
EOF
            else
                # generate Vision Reality VLESS link
                vision_tag=$(printf "%s" "$vision_tag" | jq -Rr @uri)
                local vless_link="vless://${active_uuid}@${vision_addr}:${vision_port}?encryption=none&security=reality&flow=xtls-rprx-vision&type=tcp&sni=${vision_sni}&fp=chrome&pbk=${is_public_key}&sid=${vision_sid}#${vision_tag}"

                echo
                _step "VLESS 分享链接 (Vision Reality):"
                echo
                printf '%s\n' "$vless_link"
            fi
        fi
    fi

    is_url="$v4_url\n$v6_url" # for url_qr compatibility

    footer_msg
}
