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
_red_bg() { echo -e "\e[41m$*${none}"; }

_line() { echo -e "${gray}────────────────────────────────────────────────${none}"; }
_ok() { echo -e "  ${green}[✓]${none} $*"; }
_fail() { echo -e "  ${red}[✗]${none} $*"; }
_info() { echo -e "  ${cyan}[i]${none} $*"; }
_step() { echo -e "  ${blue}>>>${none} $*"; }
_kv() { printf "  ${gray}%-14s${none}%b\n" "$1" "$2"; }
_section() { echo -e "${cyan} ── $* ──${none}"; }
_menu() { printf "  ${green}%2s.${none} %s\n" "$1" "$2"; }

# ─── Standard Prompts ─────────────────────────────────────
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

is_err="${red}[错误]${none}"
is_warn="${yellow}[警告]${none}"

err() {
    echo -e "\n  ${red}[错误]${none} $*\n" && exit 1
}

warn() {
    echo -e "\n  ${yellow}[警告]${none} $*\n"
}

# root
[[ $EUID != 0 ]] && err "当前非 ${yellow}ROOT用户${none}, 请使用 root 权限运行"

# yum or apt-get, ubuntu/debian/centos
cmd=$(type -P apt-get || type -P yum)
[[ ! $cmd ]] && err "此脚本仅支持 ${yellow}Ubuntu / Debian / CentOS${none}"

# systemd
[[ ! $(type -P systemctl) ]] && {
    err "此系统缺少 ${yellow}systemctl${none}, 请尝试执行:\n         ${yellow}${cmd} update -y; ${cmd} install systemd -y${none}"
}

# wget installed or none
is_wget=$(type -P wget)

# x64
case $(uname -m) in
amd64 | x86_64)
    is_jq_arch=amd64
    is_core_arch="64"
    ;;
*aarch64* | *armv8*)
    is_jq_arch=arm64
    is_core_arch="arm64-v8a"
    ;;
*)
    err "此脚本仅支持 64 位系统"
    ;;
esac

is_core=xray
is_core_name=Xray
is_core_pinned_version=v26.3.27
is_core_dir=/usr/local/etc/$is_core
is_core_bin=$is_core_dir/bin/$is_core
is_core_repo=xtls/$is_core-core
is_conf_dir=$is_core_dir/conf
is_log_dir=/var/log/$is_core
is_sh_bin=/usr/local/bin/$is_core
is_sh_dir=$is_core_dir/sh
is_sh_repo=$author/$is_core
is_pkg="wget curl unzip openssl iptables util-linux logrotate ca-certificates ip"
is_config_json=$is_core_dir/config.json
tmp_var_lists=(
    tmpcore
    tmpsh
    tmpjq
    is_core_ok
    is_sh_ok
    is_jq_ok
    is_pkg_ok
)

# Reserve a private directory and clean up our own background jobs on interruption.
umask 077
tmpdir=$(mktemp -d) || err "无法创建临时目录"
trap 'jobs -pr | xargs -r kill 2>/dev/null; rm -rf "$tmpdir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# set up var
for i in ${tmp_var_lists[*]}; do
    export $i=$tmpdir/$i
done

# load bash script.
load() {
    . $is_sh_dir/src/$1
}

# Bootstrap downloads use normal TLS certificate verification.
_wget() {
    [[ ! $proxy ]] || export https_proxy="$proxy"
    wget --timeout=15 --tries=2 "$@"
}

# print a message
msg() {
    case $1 in
    warn)
        _step "${2}"
        ;;
    err)
        _fail "${2}"
        ;;
    ok)
        _ok "${2}"
        ;;
    esac
}

# show help msg
show_help() {
    echo
    _line
    echo -e "  ${bold}${cyan}$is_core_name${none} ${gray}安装脚本${none}"
    _line
    echo
    echo -e "  用法: $0 [-f xxx | -l | -p xxx | -v xxx | -h]"
    echo
    echo -e "  ${green}-f, --core-file${none} <path>    本地 $is_core_name 压缩包 (仅 $is_core_pinned_version)"
    echo -e "  ${green}-l, --local-install${none}       本地获取安装脚本, 使用当前目录"
    echo -e "  ${green}-p, --proxy${none} <addr>        使用代理下载, e.g., http://127.0.0.1:2333"
    echo -e "  ${green}-v, --core-version${none} <ver>  确认固定版本 $is_core_pinned_version"
    echo -e "  ${green}-m, --mode${none} <standard|landing>  安装模式 (标准节点 / 纯落地机)"
    echo -e "  ${green}--landing${none}                     快捷指定纯落地机模式"
    echo -e "  ${green}-h, --help${none}                显示此帮助界面"
    echo

    exit 0
}

# install dependent pkg
install_pkg() {
    cmd_not_found=
    local package_name
    for i in $*; do
        if [[ ! $(type -P $i) ]]; then
            package_name=$i
            if [[ $i == ip ]]; then
                if [[ $cmd =~ yum ]]; then package_name=iproute; else package_name=iproute2; fi
            fi
            cmd_not_found="$cmd_not_found,$package_name"
        fi
    done
    if [[ $cmd_not_found ]]; then
        pkg=$(echo $cmd_not_found | sed 's/,/ /g')
        _step "正在安装依赖包:${pkg}"
        $cmd install -y $pkg &>/dev/null
        if [[ $? != 0 ]]; then
            [[ $cmd =~ yum ]] && yum install epel-release -y &>/dev/null
            $cmd update -y &>/dev/null
            $cmd install -y $pkg &>/dev/null
            [[ $? == 0 ]] && >$is_pkg_ok
        else
            >$is_pkg_ok
        fi
    else
        >$is_pkg_ok
    fi
}

# download file
download() {
    case $1 in
    core)
        local core_version="$is_core_pinned_version"
        [[ -z $is_core_ver || $is_core_ver == "$core_version" ]] || {
            _fail "内核固定为 $core_version，不能安装 $is_core_ver"; return 1;
        }
        link="https://github.com/${is_core_repo}/releases/download/${core_version}/Xray-linux-${is_core_arch}.zip"
        name=$is_core_name
        tmpfile=$tmpcore
        is_ok=$is_core_ok
        ;;
    sh)
        link=https://github.com/${is_sh_repo}/releases/latest/download/code.zip
        name="$is_core_name 脚本"
        tmpfile=$tmpsh
        is_ok=$is_sh_ok
        ;;
    jq)
        link=https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-$is_jq_arch
        name="jq"
        tmpfile=$tmpjq
        is_ok=$is_jq_ok
        ;;
    esac

    _step "下载 ${name} ..."
    if _wget -t 3 -q --show-progress -c "$link" -O "$tmpfile"; then
        if [[ $1 == core ]]; then
            local expected actual
            _wget -q "$link.dgst" -O "$tmpfile.dgst" || return 1
            expected=$(grep -iE 'sha[-_ ]?(2[-_ ]?)?256' "$tmpfile.dgst" | grep -Eo '[0-9a-fA-F]{64}' | head -1 | tr 'A-F' 'a-f')
            actual=$(sha256sum "$tmpfile" | awk '{print $1}')
            [[ -n $expected && $expected == "$actual" ]] || { _fail "内核 SHA256 校验失败"; return 1; }
        fi
        mv -f "$tmpfile" "$is_ok"
    fi
}

# Check both downloaded and user-supplied archives before changing the installation.
validate_core_archive() {
    local archive="$1" target="$2" actual_version file
    unzip -tq "$archive" >/dev/null || { _fail "内核压缩包损坏"; return 1; }
    if unzip -Z -1 "$archive" | grep -qE '(^/|(^|/)\.\.(/|$)|^[a-zA-Z]:)'; then
        _fail "压缩包包含不安全路径"; return 1
    fi
    mkdir -p "$target" && unzip -qo "$archive" -d "$target" || return 1
    for file in "$is_core" geoip.dat geosite.dat; do
        [[ -s "$target/$file" ]] || { _fail "内核压缩包缺少 $file"; return 1; }
    done
    chmod +x "$target/$is_core" || return 1
    actual_version=$("$target/$is_core" version | awk 'NR==1 && $1 == "Xray" {print $2}')
    [[ "v${actual_version#v}" == "$is_core_pinned_version" ]] || {
        _fail "内核固定为 $is_core_pinned_version，压缩包版本为 ${actual_version:-未知}"; return 1;
    }
}

# get server ip
get_ip() {
    export "$(_wget -T 5 -4 -qO- https://one.one.one.one/cdn-cgi/trace | grep ip=)" &>/dev/null
    [[ -z $ip ]] && export "$(_wget -T 5 -6 -qO- https://one.one.one.one/cdn-cgi/trace | grep ip=)" &>/dev/null
}

# check background tasks status
check_status() {
    # dependent pkg install fail
    [[ ! -f $is_pkg_ok ]] && {
        _fail "安装依赖包失败"
        _info "请尝试手动安装: ${yellow}${cmd} update -y; ${cmd} install -y $is_pkg${none}"
        is_fail=1
    }

    # download file status
    if [[ $is_wget ]]; then
        [[ ! -f $is_core_ok ]] && {
            _fail "下载 ${is_core_name} 失败"
            is_fail=1
        }
        [[ ! -f $is_sh_ok ]] && {
            _fail "下载 ${is_core_name} 脚本失败"
            is_fail=1
        }
        [[ ! -f $is_jq_ok ]] && {
            _fail "下载 jq 失败"
            is_fail=1
        }
    else
        [[ ! $is_fail ]] && {
            is_wget=1
            [[ ! $is_core_file ]] && download core
            [[ ! $local_install ]] && download sh
            [[ $jq_not_found ]] && download jq
            get_ip
            check_status
        }
    fi

    # found fail status, remove tmp dir and exit.
    [[ $is_fail ]] && {
        exit_and_del_tmpdir
    }
}

# parameters check
pass_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
        -f | --core-file)
            [[ -z $2 ]] && {
                err "($1) 缺少必需参数, 正确使用示例: $1 /root/$is_core-linux-64.zip"
            } || [[ ! -f $2 ]] && {
                err "($2) 不是一个常规的文件"
            }
            is_core_file=$2
            shift 2
            ;;
        -l | --local-install)
            [[ ! -f ${PWD}/src/core.sh || ! -f ${PWD}/$is_core.sh ]] && {
                err "当前目录 (${PWD}) 非完整的脚本目录"
            }
            local_install=1
            shift 1
            ;;
        -p | --proxy)
            [[ -z $2 ]] && {
                err "($1) 缺少必需参数, 正确使用示例: $1 http://127.0.0.1:2333"
            }
            proxy=$2
            shift 2
            ;;
        -v | --core-version)
            [[ -z $2 ]] && {
                err "($1) 缺少必需参数, 正确使用示例: $1 $is_core_pinned_version"
            }
            is_core_ver=v${2#v}
            [[ $is_core_ver == "$is_core_pinned_version" ]] || {
                err "内核固定为 $is_core_pinned_version，不能安装 $is_core_ver"
            }
            shift 2
            ;;
        -m | --mode)
            case "$2" in
                1|standard|reality) preset_install_mode=1 ;;
                2|landing|relay) preset_install_mode=2 ;;
                *) err "未知安装模式: $2, 支持: standard (标准节点) 或 landing (纯落地机)" ;;
            esac
            shift 2
            ;;
        --landing)
            preset_install_mode=2
            shift 1
            ;;
        --standard)
            preset_install_mode=1
            shift 1
            ;;
        -h | --help)
            show_help
            ;;
        *)
            echo -e "\n  ${red}[错误]${none} ($*) 为未知参数\n"
            show_help
            ;;
        esac
    done
    [[ $is_core_ver && $is_core_file ]] && {
        err "无法同时自定义 ${is_core_name} 版本和 ${is_core_name} 文件"
    }
}

# exit and remove tmpdir
exit_and_del_tmpdir() {
    rm -rf $tmpdir
    [[ ! $1 ]] && {
        echo
        _fail "安装过程出现错误"
        _info "反馈问题: https://github.com/${is_sh_repo}/issues"
        echo
        exit 1
    }
    exit
}

# main
main() {

    # check old version
    [[ -f $is_sh_bin && -d $is_core_dir/bin && -d $is_sh_dir && -d $is_conf_dir ]] && {
        err "检测到脚本已安装, 如需重装请先运行 ${green}${is_core}${none} 进入主菜单卸载后重新安装"
    }

    # check parameters
    [[ $# -gt 0 ]] && pass_args "$@"

    # show welcome msg
    clear
    echo
    _line
    echo -e "  ${bold}${cyan}$is_core_name${none} ${gray}安装程序${none}  ${dim}by ${author}${none}"
    _line
    echo

    # start installing...
    _step "开始安装..."
    _info "${is_core_name} 固定版本: ${yellow}$is_core_pinned_version${none}"
    [[ $proxy ]] && _info "使用代理: ${yellow}$proxy${none}"
    # create tmpdir
    mkdir -p $tmpdir
    # if is_core_file, copy file
    [[ $is_core_file ]] && {
        cp -f $is_core_file $is_core_ok
        _info "${is_core_name} 文件: $is_core_file"
    }
    # local dir install sh script
    [[ $local_install ]] && {
        >$is_sh_ok
        _info "本地安装: $PWD"
    }

    # install dependent pkg
    install_pkg $is_pkg &

    # jq
    if [[ $(type -P jq) ]]; then
        >$is_jq_ok
    else
        jq_not_found=1
    fi
    # if wget installed. download core, sh, jq, get ip
    [[ $is_wget ]] && {
        [[ ! $is_core_file ]] && download core &
        [[ ! $local_install ]] && download sh &
        [[ $jq_not_found ]] && download jq &
        get_ip
    }

    # waiting for background tasks is done
    wait

    # check background tasks status
    check_status

    validate_core_archive "$is_core_ok" "$tmpdir/testzip" || exit_and_del_tmpdir

    # get server ip.
    [[ ! $ip ]] && {
        _fail "获取服务器 IP 失败"
        exit_and_del_tmpdir
    }

    # Validate archives before executing any downloaded source.
    if [[ -s "$is_sh_ok" ]]; then
        unzip -tq "$is_sh_ok" >/dev/null || err "下载的压缩包损坏"
        if unzip -Z -1 "$is_sh_ok" | grep -qE '(^/|(^|/)\.\.(/|$)|^[a-zA-Z]:)'; then
            err "压缩包包含不安全路径"
        fi
    fi
    # create sh dir...
    mkdir -p $is_sh_dir
    # copy sh file or unzip sh zip file.
    if [[ $local_install ]]; then
        cp -rf $PWD/* $is_sh_dir
    else
        unzip -qo $is_sh_ok -d $is_sh_dir
    fi

    # create core bin dir
    mkdir -p $is_core_dir/bin
    cp -rf "$tmpdir/testzip/." "$is_core_dir/bin/"

    # add alias
    grep -Fxq "alias $is_core=$is_sh_bin" /root/.bashrc || echo "alias $is_core=$is_sh_bin" >>/root/.bashrc

    # core command
    ln -sf $is_sh_dir/$is_core.sh $is_sh_bin

    # jq
    [[ $jq_not_found ]] && mv -f $is_jq_ok /usr/bin/jq

    # chmod
    chmod +x $is_core_bin $is_sh_bin /usr/bin/jq

    # create log dir
    mkdir -p $is_log_dir

    _ok "正在配置 systemd 守护进程..."

    # create systemd service
    load systemd.sh
    is_new_install=1
    install_service $is_core &>/dev/null

    # Node rules are reconciled by firewall.sh; existing system policies remain intact.
    load runtime.sh
    load firewall.sh
    load maintenance.sh
    load routing.sh
    load export.sh
    # create condf dir
    mkdir -p $is_conf_dir

    load core.sh
    local install_mode="1"
    if [[ -n "$preset_install_mode" ]]; then
        install_mode="$preset_install_mode"
    else
        echo
        _line
        echo -e "  ${bold}${cyan}请选择安装模式:${none}"
        echo -e "   ${green}1)${none} 标准节点 (VLESS-REALITY + XHTTP，适合普通 VPS / 线路机)"
        echo -e "   ${green}2)${none} 纯落地机模式 (仅配置中继互联，无普通节点和XHTTP，适合 NAT / LXC 落地机)"
        echo
        prompt_input "请选择 [1-2]" install_mode "1"
        while [[ "$install_mode" != "1" && "$install_mode" != "2" ]]; do
            _fail "输入有误，请输入 1 或 2"
            prompt_input "请选择 [1-2]" install_mode "1"
        done
    fi

    if [[ "$install_mode" == "2" ]]; then
        _step "正在配置纯落地机节点..."
        install_landing_standalone || exit_and_del_tmpdir
    else
        # create a tcp config
        _step "正在生成节点配置与密钥..."
        add reality || exit_and_del_tmpdir
    fi
    install_maintenance || err "维护任务安装失败，请进入维护菜单重试"
    printf '%s\n' 1 > "$is_core_dir/.schema-version"
    
    # 启用 BBR
    load bbr.sh
    _step "正在启用 BBR 拥塞控制优化..."
    _try_enable_bbr
    
    _step "正在启动 $is_core_name 服务..."
    if service_active; then
        _ok "$is_core_name 服务已成功启动"
    else
        err "$is_core_name 启动失败，请查看错误日志"
    fi
    
    echo
    _line
    _ok "安装完成! 输入 ${green}xray${none} 进入管理面板"
    _line
    echo

    # remove tmp dir and exit.
    exit_and_del_tmpdir ok
}

# start.
main "$@"
