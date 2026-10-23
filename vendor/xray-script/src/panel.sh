#!/bin/bash
# Agent state is checked before bootstrapping; never reinstall Xray or overwrite identity.
panel_agent_present() {
    [[ -f /etc/xray-panel-agent/config.json || -f /etc/systemd/system/xray-panel-agent.service || -f /opt/xray-panel-agent/agent/agent.py || -f /opt/xray-panel/agent/agent.py ]]
}
panel_agent_menu() {
    if panel_agent_present; then
        _info '检测到本地 Agent（兼容旧版目录），将保留现有节点身份和凭据。'
        systemctl is-active xray-panel-agent 2>/dev/null || true
    else
        _info '尚未接入；安装时粘贴面板生成的一段接入信息即可。'
    fi
    if command -v xray-panel >/dev/null; then
        xray-panel agent "${@}"
    else
        local work
        work=$(mktemp -d) || return 1
        # Versioned official entry; credentials are subsequently read from stdin, never URL/args.
        if curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 \
            https://raw.githubusercontent.com/Chen017/Xray-Panel/v1.1.0/deploy/bootstrap.sh -o "$work/bootstrap.sh"; then
            bash "$work/bootstrap.sh" agent "${@}"
            local result=$?
        else
            _fail '无法下载已发布的管理器；请确认 Xray Panel v1.1.0 已发布，原 Agent 未改动。'
            local result=1
        fi
        rm -rf -- "$work"
        return "$result"
    fi
}
