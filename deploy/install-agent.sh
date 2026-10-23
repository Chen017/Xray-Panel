#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo '请以 root 运行'; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd)
[[ -f /etc/xray-panel-agent/config.json ]] || {
  install -d -m 700 /etc/xray-panel-agent
  install -m 600 "$repo/agent/config.example.json" /etc/xray-panel-agent/config.json
  echo '请先将面板生成的 Agent 配置填入 /etc/xray-panel-agent/config.json，再运行本脚本。'
  exit 1
}
python3 -m json.tool /etc/xray-panel-agent/config.json >/dev/null
if [[ $repo != /opt/xray-panel ]]; then
  install -d -m 700 /opt/xray-panel/agent /opt/xray-panel/vendor/xray-script
  cp -a "$repo/agent/." /opt/xray-panel/agent/
  cp -a "$repo/vendor/xray-script/." /opt/xray-panel/vendor/xray-script/
fi
chmod 600 /etc/xray-panel-agent/config.json
chown root:root /etc/xray-panel-agent/config.json /opt/xray-panel
chmod go-w /opt/xray-panel
chown -R root:root /opt/xray-panel/agent /opt/xray-panel/vendor/xray-script
chmod -R go-w /opt/xray-panel/agent /opt/xray-panel/vendor/xray-script
install -m 644 "$repo/deploy/xray-panel-agent.service" /etc/systemd/system/xray-panel-agent.service
systemctl daemon-reload
systemctl enable xray-panel-agent.service
systemctl restart xray-panel-agent.service
echo 'Agent 已启动。查看状态：systemctl status xray-panel-agent；查看日志：journalctl -u xray-panel-agent -n 50'
