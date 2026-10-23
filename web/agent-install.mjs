// Pinned Agent source: update deliberately when the Agent installer changes.
export const agentSourceRef = '04278f6a4a700feb8ac7a6fc55346c248ec40038';
export function agentInstallScript(config) {
  if (!config.nodeId || !config.token || !/^https:\/\/[^\s]+$/.test(config.url)) throw Error('Agent 配置不完整或不是 HTTPS');
  if (!!config['CF-Access-Client-Id'] !== !!config['CF-Access-Client-Secret']) throw Error('请同时填写 Cloudflare Client ID 和 Secret');
  const data = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(config))));
  return `#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
[[ $EUID == 0 ]] || { echo '请使用 sudo bash 安装脚本.sh'; exit 1; }
command -v systemctl >/dev/null || { echo '需要 systemd 的 Linux 主机'; exit 1; }
missing=0
for tool in curl tar python3 jq flock; do command -v "$tool" >/dev/null || missing=1; done
if [[ $missing == 1 ]]; then
  command -v apt-get >/dev/null || { echo '请先安装 curl tar python3 jq util-linux ca-certificates'; exit 1; }
  apt-get update
  apt-get install -y curl tar python3 jq util-linux ca-certificates
fi
python3 -c 'import sys; assert sys.version_info >= (3,10), "需要 Python >= 3.10"'
exec 9>/run/xray-panel-agent-install.lock
flock -n 9 || { echo '另一个安装任务正在运行'; exit 1; }
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
echo '正在下载固定版本 Agent…'
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --max-time 180 \\
  'https://github.com/Chen017/Xray-Panel/archive/${agentSourceRef}.tar.gz' -o "$work/source.tar.gz"
tar -xzf "$work/source.tar.gz" -C "$work"
repo="$work/Xray-Panel-${agentSourceRef}"
[[ -f "$repo/deploy/install-agent.sh" && -f "$repo/agent/agent.py" ]] || { echo '下载内容不完整'; exit 1; }
printf '%s' '${data}' | python3 -c 'import sys,base64,json; raw=base64.b64decode(sys.stdin.read(),validate=True); json.loads(raw); sys.stdout.buffer.write(raw)' > "$work/config.json"
install -d -m 700 /etc/xray-panel-agent
if [[ -f /etc/xray-panel-agent/config.json ]]; then
  cp -p /etc/xray-panel-agent/config.json "/etc/xray-panel-agent/config.json.backup-$(date +%s)-$$"
fi
install -m 600 "$work/config.json" /etc/xray-panel-agent/config.json
bash "$repo/deploy/install-agent.sh"
systemctl is-active --quiet xray-panel-agent
echo 'Agent 已安装并启动。请回到面板等待在线；如未连接，查看 journalctl -u xray-panel-agent -n 50。'
`;
}
