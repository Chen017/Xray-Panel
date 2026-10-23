#!/bin/bash

author=Chen017
# https://github.com/Chen017/Xray

# ─── bash fonts colors ────────────────────────────────────
red='\e[31m'
yellow='\e[33m'
gray='\e[90m'
green='\e[92m'
blue='\e[94m'
magenta='\e[95m'
cyan='\e[96m'
bold='\e[1m'
dim='\e[2m'
none='\e[0m'

_red() { echo -e "${red}$*${none}"; }
_blue() { echo -e "${blue}$*${none}"; }
_cyan() { echo -e "${cyan}$*${none}"; }
_green() { echo -e "${green}$*${none}"; }
_yellow() { echo -e "${yellow}$*${none}"; }
_magenta() { echo -e "${magenta}$*${none}"; }
_gray() { echo -e "${gray}$*${none}"; }
_bold() { echo -e "${bold}$*${none}"; }
_red_bg() { echo -e "\e[41m$*${none}"; }

# ─── formatted output helpers ─────────────────────────────
_line() { echo -e "${gray}──────────────────────────────────────────────────${none}"; }
_section() { echo -e "${cyan} ── $* ──${none}"; }
_menu() { printf "  ${green}%2s.${none} %s\n" "$1" "$2"; }
_kv() { printf "  ${gray}%-14s${none}%b\n" "$1" "$2"; }

# Status Badges
b_ok="${green}[OK]${none}"
b_warn="${yellow}[WARN]${none}"
b_err="${red}[ERROR]${none}"
b_info="${cyan}[INFO]${none}"

_ok() { echo -e "  ${b_ok} $*"; }
_fail() { echo -e "  ${b_err} $*"; }
_info() { echo -e "  ${b_info} $*"; }
_step() { echo -e "  ${blue}>>>${none} $*"; }

is_err="${b_err}"
is_warn="${b_warn}"

err() {
    echo -e "\n  ${b_err} $*\n"
    exit 1
}

warn() {
    echo -e "\n  ${b_warn} $*\n"
}

# ─── Standard Prompts ─────────────────────────────────────
# prompt_confirm: Prompts user for Y/n confirmation. Returns 0 for Y, 1 for N.
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

# prompt_input: Prompts for a string input with an optional default.
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

# pause
pause() {
    echo
    echo -ne "  ${gray}按 ${green}Enter${gray} 返回主菜单, 或 ${red}Ctrl+C${gray} 退出脚本 ...${none}"
    read -rs -d $'\n'
    echo
}

# load bash script.
load() {
    . "$is_sh_dir/src/$1"
}

# Bounded downloads with normal TLS certificate verification.
_wget() {
    wget --timeout=15 --tries=2 "$@"
}

# yum or apt-get
cmd=$(type -P apt-get || type -P yum)

# x64
case $(arch) in
amd64 | x86_64)
    is_core_arch="64"
    ;;
*aarch64* | *armv8*)
    is_core_arch="arm64-v8a"
    ;;
*)
    err "此脚本仅支持 64 位系统..."
    ;;
esac

is_core=xray
is_core_name=Xray
is_core_dir=/usr/local/etc/$is_core
is_core_bin=$is_core_dir/bin/$is_core
is_core_repo=xtls/$is_core-core
is_conf_dir=$is_core_dir/conf
is_log_dir=/var/log/$is_core
is_sh_bin=/usr/local/bin/$is_core
is_sh_dir=$is_core_dir/sh
is_sh_repo=$author/$is_core
is_pkg="wget curl unzip jq flock logrotate ip"

check_dependencies() {
    local missing_pkgs=""
    for pkg in $is_pkg; do
        if ! command -v "$pkg" &>/dev/null; then
            case "$pkg" in
                flock) missing_pkgs="$missing_pkgs util-linux" ;;
                ip)
                    if [[ $cmd =~ yum ]]; then missing_pkgs="$missing_pkgs iproute"
                    else missing_pkgs="$missing_pkgs iproute2"; fi
                    ;;
                *) missing_pkgs="$missing_pkgs $pkg" ;;
            esac
        fi
    done
    if [[ -n "$missing_pkgs" ]]; then
        _info "正在安装缺失的依赖:$missing_pkgs ..."
        $cmd update -y &>/dev/null || true
        $cmd install -y $missing_pkgs &>/dev/null || true
        for pkg in $is_pkg; do
            if ! command -v "$pkg" &>/dev/null; then
                err "依赖安装失败: $pkg, 请手动安装后再运行。"
            fi
        done
    fi
}

# Agent lifecycle does not run Xray migration, dependency repair or restart paths.
if [[ ${1:-} == agent ]]; then
    load panel.sh
    shift
    panel_agent_menu "$@"
    exit $?
fi
check_dependencies
is_config_json=$is_core_dir/config.json
is_relay_state_file=$is_core_dir/relay.json
load runtime.sh
load firewall.sh
load core.sh
load maintenance.sh
load routing.sh
load diagnostics.sh
load status.sh
load export.sh
load menus.sh

case "${1:-}" in
    --update|update)
        load download.sh
        safe_update sh
        exit $?
        ;;
esac

is_core_ver=$("$is_core_bin" version | awk 'NR==1 {print $2}')
install_maintenance || warn "维护任务安装失败，请在更新与维护菜单重试"
migrate_installation || warn "配置迁移未完成，原配置已保留；请查看诊断结果后重试"
is_main_menu
