#!/bin/bash

is_core_pinned_version=v26.3.27

get_latest_version() {
    if [[ ${1:-core} == core ]]; then
        latest_ver="$is_core_pinned_version"
        return 0
    fi
    local repo="$is_sh_repo" response
    response=$(curl --fail --silent --show-error --location --connect-timeout 10 --max-time 30 \
        "https://api.github.com/repos/$repo/releases/latest") || return 1
    latest_ver=$(jq -er 'select(.prerelease == false and .draft == false) |
        .tag_name | select(type == "string" and test("^v[0-9]+(\\.[0-9]+){2}$"))' <<< "$response")
}

safe_update() (
    umask 077
    local kind="$1" requested="${2:-}" version current url stage committed=0 completed=0 was_active=0 file expected actual
    case "$kind" in core|sh) ;; *) _fail "未知更新类型"; exit 1 ;; esac
    if [[ -n "$requested" ]]; then version="v${requested#v}"
    else get_latest_version "$kind" || { _fail "无法获取最新版本，现有安装保留"; exit 1; }; version="$latest_ver"; fi
    [[ $version =~ ^v[0-9]+(\.[0-9]+){2}$ ]] || { _fail "版本格式无效"; exit 1; }
    [[ $kind != core || $version == "$is_core_pinned_version" ]] || {
        _fail "内核固定为 $is_core_pinned_version，不能安装 $version"; exit 1;
    }
    current="$is_sh_ver"
    [[ $kind != core ]] || current="v$("$is_core_bin" version | awk 'NR==1 {print $2}' | sed 's/^v//')"
    [[ $current != "$version" ]] || { _info "当前已是 $version"; exit 0; }
    exec {operation_fd}>"$is_core_dir/.operation.lock" || exit 1
    flock -n "$operation_fd" || { _fail "另一项配置或更新操作正在进行"; exit 1; }
    stage=$(mktemp -d "$is_core_dir/.update.XXXXXX") || exit 1
    service_active && was_active=1
    cleanup_update() {
        local result=$?
        trap - EXIT INT TERM
        if (( committed && ! completed )); then
            if [[ $kind == core ]]; then
                cp -p "$stage/old-core" "$is_core_bin.next" && mv -f "$is_core_bin.next" "$is_core_bin"
                (( ! was_active )) || manage restart || _fail "旧内核已恢复，但服务恢复失败"
            elif [[ -d "$stage/old-sh" ]]; then
                rm -rf "$is_sh_dir"
                cp -a "$stage/old-sh" "$is_sh_dir"
                rm -f "$is_sh_bin"
                [[ ! -e "$stage/old-command" && ! -L "$stage/old-command" ]] || cp -a "$stage/old-command" "$is_sh_bin"
            fi
            _fail "更新失败，已恢复原版本"
        fi
        rm -f "$is_core_bin.next" "$is_core_bin.previous.next"
        rm -rf "$stage"
        exit "$result"
    }
    trap cleanup_update EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if [[ $kind == core ]]; then
        url="https://github.com/$is_core_repo/releases/download/$version/Xray-linux-$is_core_arch.zip"
    else
        url="https://github.com/$is_sh_repo/releases/download/$version/code.zip"
    fi
    _step "下载 $kind $version"
    fetch_file "$url" "$stage/archive.zip" || exit 1
    unzip -tq "$stage/archive.zip" >/dev/null || { _fail "下载的压缩包损坏"; exit 1; }
    if unzip -Z -1 "$stage/archive.zip" | grep -qE '(^/|(^|/)\.\.(/|$)|^[a-zA-Z]:)'; then
        _fail "压缩包包含不安全路径"
        exit 1
    fi
    mkdir -p "$stage/candidate" || exit 1
    if [[ $kind == core ]]; then
        fetch_file "$url.dgst" "$stage/archive.dgst" || exit 1
        expected=$(grep -iE 'sha[-_ ]?(2[-_ ]?)?256' "$stage/archive.dgst" | grep -Eo '[0-9a-fA-F]{64}' | head -1 | tr 'A-F' 'a-f')
        actual=$(sha256sum "$stage/archive.zip" | awk '{print $1}')
        [[ -n "$expected" && $expected == "$actual" ]] || { _fail "内核 SHA256 不匹配"; exit 1; }
        unzip -qo "$stage/archive.zip" -d "$stage/candidate" || exit 1
        file="$stage/candidate/$is_core"
        [[ -s "$file" ]] && chmod +x "$file" || exit 1
        [[ "v$("$file" version | awk 'NR==1 {print $2}' | sed 's/^v//')" == "$version" ]] || {
            _fail "内核版本与发布标签不符"; exit 1;
        }
        XRAY_LOCATION_ASSET="$is_core_dir/bin" "$file" run -test -config "$is_config_json" -confdir "$is_conf_dir" || { _fail "新内核无法加载现有配置"; exit 1; }
        cp -p "$is_core_bin" "$stage/old-core" || exit 1
        cp -p "$stage/old-core" "$is_core_bin.previous.next" &&
            mv -f "$is_core_bin.previous.next" "$is_core_bin.previous" || exit 1
        committed=1
        cp -p "$file" "$is_core_bin.next" && mv -f "$is_core_bin.next" "$is_core_bin" || exit 1
        (( ! was_active )) || manage restart || exit 1
    else
        # Overlay preserves user files and any external-script/IPQuality patch modules.
        cp -a "$is_sh_dir/." "$stage/candidate/" || exit 1
        unzip -qo "$stage/archive.zip" -d "$stage/candidate" || exit 1
        unzip -Z -1 "$stage/archive.zip" > "$stage/files" || exit 1
        for file in xray.sh update_geodata.sh src/init.sh src/core.sh src/runtime.sh src/firewall.sh src/maintenance.sh src/menus.sh src/export.sh src/diagnostics.sh src/status.sh src/status.jq src/routing.sh src/download.sh src/node.jq; do
            grep -Fxq "$file" "$stage/files" && [[ -s "$stage/candidate/$file" ]] || { _fail "脚本包缺少 $file"; exit 1; }
        done
        while IFS= read -r file; do
            [[ $file != *.sh ]] || bash -n "$stage/candidate/$file" || { _fail "脚本语法检查失败"; exit 1; }
        done < "$stage/files"
        grep -qx "is_sh_ver=$version" "$stage/candidate/xray.sh" || { _fail "脚本版本与发布标签不符"; exit 1; }
        chmod +x "$stage/candidate/xray.sh" "$stage/candidate/update_geodata.sh"
        cp -a "$is_sh_dir" "$stage/old-sh" || exit 1
        mkdir -p "$is_core_dir/.previous" || exit 1
        rm -rf "$is_core_dir/.previous/sh"
        cp -a "$stage/old-sh" "$is_core_dir/.previous/sh" || exit 1
        [[ ! -e "$is_sh_bin" && ! -L "$is_sh_bin" ]] || cp -a "$is_sh_bin" "$stage/old-command" || exit 1
        committed=1
        rm -rf "$is_sh_dir"
        mv "$stage/candidate" "$is_sh_dir" && ln -sfn "$is_sh_dir/xray.sh" "$is_sh_bin" || exit 1
    fi
    completed=1
    _ok "$kind 已更新到 $version"
)
