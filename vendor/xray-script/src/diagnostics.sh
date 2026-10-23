#!/bin/bash

# DNS and HTTPS run concurrently; no sequential ASN/API request on menu startup.
_cdn_dns_records() (
    local domain="$1" work ns n=0 pid
    local -a pids=() dns_servers=(8.8.8.8 1.1.1.1 208.67.222.222 9.9.9.9)
    work=$(mktemp -d) || return 1
    trap 'for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf "$work"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if command -v dig >/dev/null; then
        for ns in "${dns_servers[@]}"; do
            dig +short +time=1 +tries=1 A "$domain" @"$ns" > "$work/$n" 2>/dev/null &
            pids+=("$!"); ((n+=1))
        done
    elif command -v nslookup >/dev/null; then
        for ns in "${dns_servers[@]}"; do
            (timeout 2 nslookup -timeout=1 -retry=1 "$domain" "$ns" 2>/dev/null |
                awk '/^Name:/ {answer=1} /canonical name/ {print} answer {print}') > "$work/$n" &
            pids+=("$!"); ((n+=1))
        done
    else
        timeout 2 getent ahosts "$domain" 2>/dev/null > "$work/0" || true
    fi
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    pids=()
    cat "$work/"* 2>/dev/null || true
)

_detect_cdn() {
    local domain="$1" response="${2:-}" records="${3:-}" provider="" evidence="" ips cnames
    [[ $# -ge 3 ]] || records=$(_cdn_dns_records "$domain")
    # Specific response headers or provider CNAME suffixes are evidence; IP count is not.
    if grep -Eiq '(^|[[:cntrl:]])(cf-ray:|server:[[:space:]]*cloudflare([[:space:]]|$))' <<< "$response"; then
        provider=Cloudflare; evidence=HTTP响应头
    elif grep -Eiq '(^|[[:cntrl:]])x-amz-cf-(id|pop):' <<< "$response"; then
        provider=CloudFront; evidence=HTTP响应头
    elif grep -Eiq '(^|[[:cntrl:]])(x-fastly-|server:[[:space:]]*fastly)' <<< "$response"; then
        provider=Fastly; evidence=HTTP响应头
    elif grep -Eiq '(^|[[:cntrl:]])x-iinfo:' <<< "$response"; then
        provider=Imperva; evidence=HTTP响应头
    else
        cnames=$(grep -Eio '(^|[[:space:]])([a-z0-9_-]+\.)*(cloudfront\.net|fastly\.net|fastlylb\.net|cloudflare\.net|edgekey\.net|edgesuite\.net|akamaiedge\.net|incapdns\.net)\.?([[:space:]]|$)' <<< "$records" | tr '[:upper:]' '[:lower:]') || true
        case "$cnames" in
            *'cloudfront.net'*) provider=CloudFront ;;
            *'fastly.net'*|*'fastlylb.net'*) provider=Fastly ;;
            *'cloudflare.net'*) provider=Cloudflare ;;
            *'edgekey.net'*|*'edgesuite.net'*|*'akamaiedge.net'*) provider=Akamai ;;
            *'incapdns.net'*) provider=Imperva ;;
        esac
        [[ -z "$provider" ]] || evidence=DNS别名
    fi
    if [[ -n "$provider" ]]; then
        printf 'CDN:%s|%s\n' "$provider" "$evidence"
        return
    fi
    ips=$(awk '{for(i=1;i<=NF;i++) if ($i ~ /^([0-9]+\.){3}[0-9]+$/ || ($i ~ /:/ && $i ~ /^[0-9a-fA-F:]+$/)) print $i}' <<< "$records")
    if [[ -z "$ips" ]]; then
        echo 'CDN_UNKNOWN|DNS未取得地址，无法判断'
    else
        echo 'CDN_UNCONFIRMED|未发现明确CDN线索；多地址不作为CDN证据'
    fi
}

_probe_sni_target() (
    local domain="$1" prefix="$2" http2="$3" dns_pid result=TLS_FAIL response code=0
    local -a options=()
    [[ -z "$http2" ]] || options+=("$http2")
    _cdn_dns_records "$domain" > "$prefix.dns" &
    dns_pid=$!
    trap 'kill "$dns_pid" 2>/dev/null || true' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # HEAD avoids downloading a page; ALPN and CDN headers share this one connection.
    response=$(curl -s -v -I -m 3 --connect-timeout 2 "${options[@]}" -A "Mozilla/5.0" \
        --dump-header - -o /dev/null -w '\nXRAY_HTTP_VERSION:%{http_version}\n' "https://$domain" 2>&1) || code=$?
    if (( code == 0 )) && grep -q 'TLSv1.3' <<< "$response"; then
        if grep -q '^XRAY_HTTP_VERSION:2\(\.0\)\?$' <<< "$response"; then result=TLS_OK
        elif [[ -z "$http2" ]]; then result=TLS_H2_UNKNOWN
        else result=TLS_H2_FAIL; fi
    fi
    wait "$dns_pid" || true
    trap - EXIT
    printf '%s|%s\n' "$result" "$(_detect_cdn "$domain" "$response" "$(cat "$prefix.dns")")"
)

_collect_sni_checks() (
    local sni4="$1" sni6="$2" work http2="" family domain pid
    local -a pids=()
    work=$(mktemp -d) || return 1
    trap 'for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf "$work"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if curl --version 2>/dev/null | grep -qE '^Features:.*HTTP2'; then http2=--http2; fi
    for family in v4 v6; do
        if [[ $family == v4 ]]; then domain="$sni4"; else domain="$sni6"; fi
        [[ -n "$domain" ]] || continue
        _probe_sni_target "$domain" "$work/$family" "$http2" > "$work/$family.result" &
        pids+=("$!")
    done
    for pid in "${pids[@]}"; do wait "$pid" || true; done
    pids=()
    for family in v4 v6; do
        [[ ! -f "$work/$family.result" ]] || printf '%s|%s\n' "$family" "$(cat "$work/$family.result")"
    done
)

_check_ip_blocked() {
    if [[ $_ov_ip_blocked ]]; then
        return
    fi
    _ov_ip_blocked="检测中..."
    _ov_ip_warning=""
    local check_urls=(
        "sh-cm-dualstack.ip.zstaticcdn.com/80"
        "sh-cu-dualstack.ip.zstaticcdn.com/80"
        "sh-ct-dualstack.ip.zstaticcdn.com/80"
    )
    local is_blocked=1
    for url in "${check_urls[@]}"; do
        if timeout 2 bash -c "echo > /dev/tcp/$url" &>/dev/null; then
            is_blocked=0
            break
        fi
    done
    if [[ $is_blocked == 0 ]]; then
        _ov_ip_blocked="${green}✓${none} "
    else
        _ov_ip_blocked="${red}✗${none} "
        _ov_ip_warning="  [警告] 当前服务器 IP 的部分国内测速节点超时，可能已被 GFW 阻断！\n"
    fi
}

_check_sni_status() {
    local key="${_ov_v4_sni:-}|${_ov_v6_sni:-}" family tls cdn evidence domain label
    [[ ${_ov_sni_checked:-} != "$key" ]] || return 0
    _ov_sni_checked="$key"
    _ov_v4_sni_status=""; _ov_v6_sni_status=""
    _ov_v4_cdn_status=""; _ov_v6_cdn_status=""
    _ov_sni_warning=""; _ov_cdn_warning=""
    [[ -n ${_ov_v4_sni:-}${_ov_v6_sni:-} ]] || return 0
    while IFS='|' read -r family tls cdn evidence; do
        [[ $family == v4 || $family == v6 ]] || continue
        if [[ $family == v4 ]]; then domain="$_ov_v4_sni"; else domain="$_ov_v6_sni"; fi
        case "$tls" in
            TLS_OK) label="${green}✓${none} " ;;
            TLS_H2_UNKNOWN)
                label="${yellow}TLS1.3 / h2未验证${none} "
                _ov_sni_warning+="  [提示] $family 域名 ($domain) TLS 1.3 通过；本机 curl 未提供 HTTP/2，无法验证 h2。\n"
                ;;
            *)
                label="${red}✗${none} "
                _ov_sni_warning+="  [警告] $family 域名 ($domain) 证书、连通性、TLS 1.3 或 h2 检查未通过。\n"
                ;;
        esac
        printf -v "_ov_${family}_sni_status" '%s' "$label"
        case "$cdn" in
            CDN:*)
                printf -v "_ov_${family}_cdn_status" '%s' "${yellow}疑似CDN${none} "
                _ov_cdn_warning+="  [提示] $family 域名 ($domain) 存在 ${cdn#CDN:} CDN 线索 ($evidence)，请核对目标是否适用。\n"
                ;;
            CDN_UNKNOWN)
                printf -v "_ov_${family}_cdn_status" '%s' "${yellow}CDN未知${none} "
                _ov_cdn_warning+="  [提示] $family 域名 ($domain) 的 CDN 状态无法判断：$evidence。\n"
                ;;
        esac
    done < <(_collect_sni_checks "${_ov_v4_sni:-}" "${_ov_v6_sni:-}")
    for family in v4 v6; do
        if [[ $family == v4 ]]; then domain="${_ov_v4_sni:-}"; label="$_ov_v4_sni_status"
        else domain="${_ov_v6_sni:-}"; label="$_ov_v6_sni_status"; fi
        if [[ -n "$domain" && -z "$label" ]]; then
            printf -v "_ov_${family}_sni_status" '%s' "${yellow}检测未完成${none} "
            _ov_sni_warning+="  [提示] $family 域名 ($domain) 检测未完成，请手动刷新。\n"
        fi
    done
}


follow_logs() (
    local pid
    trap '[[ -z ${pid:-} ]] || { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; }; :' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    _info "Enter 返回，Ctrl+C 退出日志查看"
    tail -F "$is_log_dir/access.log" "$is_log_dir/error.log" &
    pid=$!
    read -r _ || true
)
