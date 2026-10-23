import metadata from '../package.json' with {type:'json'};
export const agentSourceRef = 'v'+metadata.version;
export const managerCommand = `(set -e; w=$(mktemp); trap 'rm -f "$w"' EXIT; curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 https://raw.githubusercontent.com/Chen017/Xray-Panel/${agentSourceRef}/deploy/bootstrap.sh -o "$w"; bash "$w")`;
export function agentEnrollmentConfig(value, clientId = '', clientSecret = '') {
  const config=JSON.parse(value),id=clientId.trim(),secret=clientSecret.trim();
  if (!!id!==!!secret) throw Error('请同时填写 Cloudflare Client ID 和 Secret');
  if(id){config['CF-Access-Client-Id']=id;config['CF-Access-Client-Secret']=secret;}
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.nodeId??'')||!/^[A-Za-z0-9_-]{43}$/.test(config.token??''))throw Error('Agent 节点 ID 或 Token 无效');
  let url;try{url=new URL(config.url);}catch{throw Error('Agent 地址必须是 HTTPS 域名');}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.pathname!=='/'||/[\s\\?#]/.test(config.url))throw Error('Agent 地址必须是 HTTPS 域名，不能带路径、查询或登录凭据');
  if(!!config['CF-Access-Client-Id']!==!!config['CF-Access-Client-Secret'])throw Error('请同时填写 CF Client ID 和 Secret');
  for(const key of ['CF-Access-Client-Id','CF-Access-Client-Secret'])if(config[key]&&(typeof config[key]!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(config[key])))throw Error('Cloudflare 凭据不能包含空白、换行或非 ASCII 字符');
  return Object.fromEntries(Object.entries({...config,url:url.origin}).filter(([key])=>['nodeId','token','url','CF-Access-Client-Id','CF-Access-Client-Secret'].includes(key)));
}
export function agentEnrollmentText(config){
  const raw=JSON.stringify(agentEnrollmentConfig(JSON.stringify(config)));
  return 'XRAY-PANEL-ENROLLMENT-1:'+btoa(Array.from(new TextEncoder().encode(raw),b=>String.fromCharCode(b)).join(''));
}
export function agentInstallScript(config){
  const text=agentEnrollmentText(config);
  // Credentials stay on stdin. The bootstrap and manager own all installation logic.
  return `#!/usr/bin/env bash
(
set -euo pipefail
set +x
umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 'https://raw.githubusercontent.com/Chen017/Xray-Panel/${agentSourceRef}/deploy/bootstrap.sh' -o "$work/bootstrap.sh"
printf '%s' '${text}' | bash "$work/bootstrap.sh" agent install --stdin --version ${metadata.version}
)
`;
}
