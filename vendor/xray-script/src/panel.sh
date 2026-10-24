#!/bin/bash
# Agent state is checked before bootstrapping; never reinstall Xray or overwrite identity.
panel_agent_present() {
    [[ -f /etc/xray-panel-agent/config.json || -f /etc/systemd/system/xray-panel-agent.service || -f /opt/xray-panel-agent/agent/agent.py || -f /opt/xray-panel/agent/agent.py ]]
}
panel_agent_installed() {
    [[ -f /etc/systemd/system/xray-panel-agent.service ]] || [[ $(systemctl show -p LoadState --value xray-panel-agent 2>/dev/null) == loaded ]]
}
panel_agent_command() {
    if command -v xray-panel >/dev/null; then
        xray-panel agent "$@"
    else
        local work result
        work=$(mktemp -d) || return 1
        # Versioned official entry; credentials are read from stdin, never URL/args.
        if curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 \
            https://raw.githubusercontent.com/Chen017/Xray-Panel/v1.3.2/deploy/bootstrap.sh -o "$work/bootstrap.sh"; then
            bash "$work/bootstrap.sh" agent "$@"
            result=$?
        else
            _fail '无法下载管理器，原 Agent 未改动；请检查网络和正式版本发布状态。'
            result=1
        fi
        rm -rf -- "$work"
        return "$result"
    fi
}
panel_agent_menu() {
    # Direct CLI remains non-interactive and accepts all original lifecycle arguments.
    if (( $# )); then
        if panel_agent_present; then _info '检测到本地 Agent（兼容旧版目录），将保留现有节点身份和凭据。'; fi
        panel_agent_command "$@"
        return $?
    fi
    local installed action status
    while :; do
        installed=0; action=''; status='未安装'
        if panel_agent_installed; then
            installed=1
            if systemctl is-active --quiet xray-panel-agent 2>/dev/null; then status="${green}已安装 · 运行中${none}"
            else status="${yellow}已安装 · 未运行${none}"; fi
        elif panel_agent_present; then
            status="${yellow}未安装服务 · 检测到旧文件或保留凭据${none}"
        fi
        clear
        echo
        _line
        echo -e "  ${bold}${cyan}Xray 集中管理${none}  ${gray}| Script ${is_sh_ver:-未知}${none}"
        _line
        _section 'Panel Agent'
        _kv '本机状态' "$status"
        echo
        if (( installed )); then
            _menu 1 '查看 Agent 状态'
            _menu 2 '更新 / 修复 Agent（保留身份）'
            _menu 3 '查看 Agent 日志'
            _menu 4 '卸载 Agent（保留 Xray 与凭据）'
        else
            _info '接入只导入现有配置，不重装或部署 Xray。'
            _menu 1 '安装 / 接入 Agent'
        fi
        echo
        echo -ne "  请选择 [${green}1-$((installed ? 4 : 1))${none}] [${red}0 返回${none}]: "
        read -r REPLY || return 0
        [[ $REPLY == 0 ]] && return 0
        if (( installed )); then
            case "$REPLY" in
                1) action=status ;;
                2) action=update ;;
                3) action=logs ;;
                4) if prompt_confirm '卸载 Agent？保留 Xray 配置、服务及接入凭据。' n; then action=uninstall; else continue; fi ;;
            esac
        elif [[ $REPLY == 1 ]]; then action=install; fi
        [[ -n $action ]] || continue
        echo
        if panel_agent_command "$action"; then :; else _fail '操作未完成，请查看以上输出。'; fi
        pause
    done
}
