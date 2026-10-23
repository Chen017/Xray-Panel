#!/usr/bin/env python3
"""One implementation behind xray-panel and the Xray Script Agent submenu."""
import argparse
import base64
import contextlib
import datetime
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

REPO = Path(__file__).resolve().parent.parent
VERSION = json.loads((REPO / 'package.json').read_text())['version']
IMAGE = 'ghcr.io/chen017/xray-panel'
HOME = Path('/opt/xray-panel-manager')
AGENT = Path('/opt/xray-panel-agent')
PANEL = Path('/opt/xray-panel')
CONFIG = Path('/etc/xray-panel-agent/config.json')
UNIT = Path('/etc/systemd/system/xray-panel-agent.service')
SERVICE = 'xray-panel-agent'


def run(args, **kw):
    result = subprocess.run(args, capture_output=True, **kw)
    if result.returncode:
        # Do not include command arguments or arbitrary response bodies in errors.
        raise RuntimeError(args[0] + ' 操作失败，退出码 ' + str(result.returncode))
    return result.stdout


def write(path, value, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(4))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'w') as output:
        output.write(value)
    os.replace(temporary, path)


def safe_url(value):
    if re.search(r'[\s\\?#]', value):
        raise ValueError('HTTPS 地址不能包含空白、反斜杠、查询或片段')
    url = urllib.parse.urlsplit(value.strip())
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('请输入不带路径、查询或登录凭据的 HTTPS 域名')
    return 'https://' + url.netloc


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def enrollment(value):
    value = value.strip()
    if value.startswith('XRAY-PANEL-ENROLLMENT-1:'):
        value = base64.b64decode(value.partition(':')[2], validate=True).decode('utf-8')
    config = json.loads(value)
    if str(uuid.UUID(config.get('nodeId', ''))) != config.get('nodeId', '').lower() or not re.fullmatch(r'[A-Za-z0-9_-]{43}', config.get('token', '')):
        raise ValueError('节点接入信息不完整')
    config['url'] = safe_url(config.get('url', ''))
    for key in ('CF-Access-Client-Id', 'CF-Access-Client-Secret'):
        if config.get(key) and not re.fullmatch(r'[\x21-\x7e]{1,4096}', config[key]):
            raise ValueError('CF 凭据格式无效')
    if bool(config.get('CF-Access-Client-Id')) != bool(config.get('CF-Access-Client-Secret')):
        raise ValueError('请同时提供 CF Client ID 和 Secret')
    # Never accept a test driver, a custom interpreter or filesystem paths from enrollment.
    return {key: config[key] for key in ('nodeId', 'url', 'token', 'CF-Access-Client-Id', 'CF-Access-Client-Secret') if key in config}


def verify_agent(config):
    headers = {'Authorization': 'Bearer ' + config['token'], 'X-Node-ID': config['nodeId']}
    headers.update({key: config[key] for key in ('CF-Access-Client-Id', 'CF-Access-Client-Secret') if config.get(key)})
    opener = urllib.request.build_opener(NoRedirect())
    for path in ('/health', '/v1/agent/status'):
        request = urllib.request.Request(config['url'] + path, headers=headers)
        try:
            with opener.open(request, timeout=15) as response:
                result = json.loads(response.read(8192))
            if path == '/health' and result.get('service') != 'agent':
                raise ValueError('地址不是 Agent 入口')
        except urllib.error.HTTPError as exc:
            # The old server authenticates this prefix before returning its 404 page.
            if path.endswith('/status') and exc.code == 404:
                continue
            sample = exc.read(2048).decode('utf-8', 'replace')
            code = re.search(r'(?:error code:|Error)\s*(\d{4,5})', sample, re.I)
            hint = '请检查 CF Service Auth 和源站校验' if exc.code == 403 else '请检查节点 ID 和面板 Token'
            if code and code.group(1) == '1010':
                hint = 'Cloudflare BIC 拦截：为 Agent/订阅机器域名配置 BIC 例外'
            raise RuntimeError('连接检查 HTTP ' + str(exc.code) + (' / CF ' + code.group(1) if code else '') + '；' + hint) from None


def unit_text():
    return '''[Unit]
Description=Xray Panel outbound management agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=root
WorkingDirectory=/opt/xray-panel-agent
ExecStart=/usr/bin/python3 /opt/xray-panel-agent/agent/agent.py --config /etc/xray-panel-agent/config.json
Restart=always
RestartSec=5
UMask=0077
PrivateTmp=true
[Install]
WantedBy=multi-user.target
'''


def service_state():
    return tuple(subprocess.run(['systemctl', action, '--quiet', SERVICE]).returncode == 0 for action in ('is-active', 'is-enabled'))


def agent_install(config, check=True):
    config = enrollment(json.dumps(config))
    if CONFIG.exists():
        previous = json.loads(CONFIG.read_text())
        if previous.get('nodeId') != config['nodeId']:
            raise ValueError('已接入其他节点，拒绝覆盖身份；请先卸载旧 Agent（保留 Xray）')
        for key in ('xrayRoot', 'stateDir', 'CF-Access-Client-Id', 'CF-Access-Client-Secret'):
            if key in previous and key not in config: config[key] = previous[key]
    if check:
        print('正在检查 Agent 入口和两层认证…', flush=True)
        verify_agent(config)
    missing = [tool for tool in ('bash', 'curl', 'jq', 'flock') if not shutil.which(tool)]
    if missing:
        if not shutil.which('apt-get'):
            raise ValueError('请先安装 bash curl jq util-linux ca-certificates')
        run(['apt-get', 'update'], stdin=subprocess.DEVNULL)
        run(['apt-get', 'install', '-y', 'bash', 'curl', 'jq', 'util-linux', 'ca-certificates'], stdin=subprocess.DEVNULL)
    active, enabled = service_state()
    backup = HOME / 'backups' / ('agent-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True, mode=0o700)
    with contextlib.nullcontext():
        paths = [CONFIG, UNIT, AGENT]
        for index, path in enumerate(paths):
            if path.exists():
                if path.is_symlink():
                    raise ValueError('Agent 目录和配置不支持符号链接')
                if path.is_dir(): shutil.copytree(path, backup / str(index))
                else: shutil.copy2(path, backup / str(index))
        try:
            # The legacy /opt/xray-panel checkout is deliberately never removed or replaced.
            AGENT.mkdir(parents=True, exist_ok=True, mode=0o700)
            for name in ('agent', 'vendor/xray-script'):
                target = AGENT / name
                if target.exists(): shutil.rmtree(target)
                shutil.copytree(REPO / name, target)
            shutil.copy2(REPO / 'package.json', AGENT / 'package.json')
            write(CONFIG, json.dumps(config, indent=2) + '\n')
            write(UNIT, unit_text(), 0o644)
            for command in (['systemctl', 'daemon-reload'], ['systemctl', 'enable', SERVICE], ['systemctl', 'restart', SERVICE]): run(command)
            time.sleep(1)
            run(['systemctl', 'is-active', '--quiet', SERVICE])
        except BaseException:
            subprocess.run(['systemctl', 'stop', SERVICE], capture_output=True)
            subprocess.run(['systemctl', 'disable', SERVICE], capture_output=True)
            for index, path in enumerate(paths):
                if path.is_dir(): shutil.rmtree(path)
                else: path.unlink(missing_ok=True)
                saved = backup / str(index)
                if saved.is_dir(): shutil.copytree(saved, path)
                elif saved.exists(): shutil.copy2(saved, path)
            run(['systemctl', 'daemon-reload'])
            if enabled: run(['systemctl', 'enable', SERVICE])
            if active: run(['systemctl', 'restart', SERVICE])
            raise
    print('Agent 已启动，身份与 CF 凭据已保留；请在面板确认心跳。')


def docker_json(args):
    return json.loads(run(['docker', *args]))


def discover_panel():
    found = []
    for container in run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.service=panel']).decode().split():
        item = docker_json(['inspect', container])[0]
        env = dict(value.split('=', 1) for value in item['Config'].get('Env', []) if '=' in value)
        if 'PANEL_MASTER_KEY' not in env:
            continue
        volumes = [mount for mount in item['Mounts'] if mount['Destination'] == '/app/data' and mount['Type'] == 'volume']
        if len(volumes) != 1:
            raise ValueError('现有面板使用自定义数据挂载，请先人工确认迁移')
        labels = item['Config'].get('Labels', {})
        found.append({'container': item['Id'], 'project': labels.get('com.docker.compose.project', 'xray-panel'), 'volume': volumes[0]['Name'], 'image': item['Image'], 'env': env})
    if len(found) > 1:
        raise ValueError('发现多个面板，拒绝自动选择')
    return found[0] if found else None


def compose_text(image, volume, env_file):
    # JSON scalars are YAML-compatible, so host paths and image tags cannot inject YAML.
    return '''services:
  panel:
    image: %s
    restart: unless-stopped
    env_file: [%s]
    environment:
      PANEL_HOST: 0.0.0.0
      PANEL_DB: /app/data/panel.sqlite
    ports: ["127.0.0.1:3000:3000", "127.0.0.1:3001:3001", "127.0.0.1:3002:3002"]
    volumes: ["panel-data:/app/data"]
    read_only: true
    tmpfs: ["/tmp:size=32m,mode=1777"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: [CMD, node, -e, "Promise.all([3000,3001,3002].map(p=>fetch('http://127.0.0.1:'+p+(p===3000?'/api/health':'/health')).then(r=>{if(!r.ok)throw Error()}))).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
volumes:
  panel-data:
    external: true
    name: %s
''' % (json.dumps(image), json.dumps(str(env_file)), json.dumps(volume))


def version_tag(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('必须使用已发布的明确版本号，例如 1.1.0')
    return value


def latest_version():
    request = urllib.request.Request('https://api.github.com/repos/Chen017/Xray-Panel/releases/latest', headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Xray-Panel-Manager'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return version_tag(json.loads(response.read(1024 * 1024))['tag_name'].removeprefix('v'))


def install_manager(version):
    version_tag(version)
    if version.split('.')[0] != VERSION.split('.')[0]:
        raise ValueError('跨主版本更新需先阅读迁移说明')
    destination = HOME / 'versions' / version
    if not (destination / 'deploy/lifecycle.py').exists():
        with tempfile.TemporaryDirectory(prefix='manager-download-') as temp:
            archive = Path(temp) / 'release.tar.gz'
            base = 'https://github.com/Chen017/Xray-Panel/releases/download/v' + version + '/xray-panel-' + version + '.tar.gz'
            for url, file in ((base, archive), (base + '.sha256', archive.with_suffix('.sha256'))):
                run(['curl', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '180', '--output', str(file), url])
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            if archive.with_suffix('.sha256').read_text().split()[0] != digest:
                raise ValueError('发布包校验失败，拒绝安装')
            extracted = Path(temp) / 'source'
            extracted.mkdir()
            with tarfile.open(archive) as source:
                for member in source.getmembers():
                    target = (extracted / member.name).resolve()
                    if not target.is_relative_to(extracted) or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                        raise ValueError('发布包包含不安全路径或链接')
                source.extractall(extracted)
            if json.loads((extracted / 'package.json').read_text())['version'] != version:
                raise ValueError('发布包版本不匹配')
            if not (extracted / 'deploy/lifecycle.py').is_file():
                raise ValueError('此发布包不支持统一管理器，请使用 1.1.0 或更新版本')
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copytree(extracted, destination)
    link = HOME / 'current'
    pending = HOME / ('.current-' + secrets.token_hex(4))
    pending.symlink_to(destination)
    os.replace(pending, link)
    write('/usr/local/bin/xray-panel', '#!/bin/bash\nexec /usr/bin/python3 /opt/xray-panel-manager/current/deploy/lifecycle.py "$@"\n', 0o755)
    return destination


def panel_install(version, domains=None):
    image = IMAGE + ':' + version_tag(version)
    # Keep the existing service running if a version has not been published or cannot be pulled.
    if not shutil.which('docker') or subprocess.run(['docker', 'compose', 'version'], capture_output=True).returncode:
        with tempfile.TemporaryDirectory(prefix='docker-install-') as directory:
            file = Path(directory) / 'docker-install.sh'
            run(['curl', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--output', str(file), 'https://get.docker.com'])
            run(['sh', str(file)])
        run(['systemctl', 'enable', '--now', 'docker'])
    run(['docker', 'compose', 'version'])
    print('正在拉取 Panel ' + version + ' 预构建镜像…', flush=True)
    run(['docker', 'pull', image])
    existing = discover_panel()
    state_file = HOME / 'panel.json'
    saved = json.loads(state_file.read_text()) if state_file.exists() else {}
    project = existing['project'] if existing else saved.get('project', 'xray-panel')
    volume = existing['volume'] if existing else saved.get('volume', 'xray-panel_panel-data')
    env_file = Path(saved.get('envFile', str(PANEL / '.env')))
    compose = HOME / 'panel.compose.yaml'
    backup = HOME / 'backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(parents=True, mode=0o700)
    previous_compose = compose.read_text() if compose.exists() else None
    if existing:
        # A running container is authoritative. A stale source checkout .env must not
        # silently replace its encryption key when migrating a 1Panel deployment.
        if env_file.exists(): shutil.copy2(env_file, backup / 'source.env')
        env_file = HOME / 'panel.env'
        write(env_file, '\n'.join(key + '=' + json.dumps(value.replace('$','$$')) for key, value in existing['env'].items() if key.startswith('PANEL_')) + '\n')
        shutil.copy2(env_file, backup / 'panel.env')
    elif env_file.exists():
        shutil.copy2(env_file, backup / 'panel.env')
    else:
        if saved:
            raise ValueError('保留的数据卷缺少环境配置；请先恢复原 PANEL_MASTER_KEY，拒绝生成新密钥')
        if subprocess.run(['docker','volume','inspect',volume],capture_output=True).returncode == 0:
            raise ValueError('发现已有同名数据卷，拒绝创建新密钥覆盖；请先恢复原配置')
        domains = domains or [input(label + ' HTTPS 域名: ').strip() for label in ('管理', '订阅', 'Agent')]
        origins = [safe_url(value if value.startswith('https://') else 'https://' + value) for value in domains]
        if len(set(origins)) != 3: raise ValueError('三个入口必须使用不同域名')
        write(env_file, 'PANEL_MASTER_KEY=' + secrets.token_hex(32) + '\nPANEL_ADMIN_PASSWORD=' + secrets.token_urlsafe(36) + '\nPANEL_SECURE_COOKIE=true\n' + '\n'.join(key + '=' + value for key, value in zip(('PANEL_ADMIN_ORIGIN', 'PANEL_SUBSCRIPTION_ORIGIN', 'PANEL_AGENT_ORIGIN'), origins)) + '\n')
    if existing:
        # VACUUM INTO makes a consistent snapshot. docker cp cannot read some tmpfs mounts.
        filename = '/tmp/panel-backup-' + secrets.token_hex(8) + '.sqlite'
        run(['docker', 'exec', existing['container'], 'node', '--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/app/data/panel.sqlite');db.exec(\"VACUUM INTO '" + filename + "'\");db.close();"])
        owner = json.loads(run(['docker', 'exec', existing['container'], 'node', '-e', "const s=require('fs').statSync('/app/data/panel.sqlite');console.log(JSON.stringify({uid:s.uid,gid:s.gid}));"]))
        (backup / 'panel.sqlite').write_bytes(run(['docker', 'exec', existing['container'], 'cat', filename]))
        (backup / 'panel.sqlite').chmod(0o600)
        write(backup / 'previous.json', json.dumps({key: value for key, value in existing.items() if key != 'env'}))
    else:
        run(['docker', 'volume', 'create', volume])
    command = ['docker', 'compose', '-p', project, '-f', str(compose)]
    write(compose, compose_text(image, volume, env_file))
    print('备份完成，正在启动并检查面板健康状态…', flush=True)
    try:
        run([*command, 'up', '-d', '--no-build', 'panel'])
        healthy = False
        for _ in range(45):
            ids = run([*command, 'ps', '-q', 'panel']).decode().strip()
            if ids:
                status = docker_json(['inspect', ids])[0]['State']
                if status.get('Health', {}).get('Status') == 'healthy': healthy = True; break
                if status.get('Health', {}).get('Status') == 'unhealthy': break
            time.sleep(2)
        if not healthy: raise RuntimeError('新面板健康检查未通过')
    except BaseException:
        if existing:
            # Restore DB before starting the old image, including future schema migrations.
            subprocess.run([*command, 'stop', 'panel'], capture_output=True)
            restore = "const fs=require('fs');fs.copyFileSync('/backup/panel.sqlite','/data/panel.sqlite');fs.chownSync('/data/panel.sqlite'," + str(owner['uid']) + ',' + str(owner['gid']) + ");for(const x of ['-wal','-shm'])fs.rmSync('/data/panel.sqlite'+x,{force:true});"
            run(['docker', 'run', '--rm', '--network=none', '--user=0', '-v', volume + ':/data', '-v', str(backup) + ':/backup:ro', '--entrypoint', 'node', existing['image'], '-e', restore])
            shutil.copy2(backup / 'panel.env', env_file)
            write(compose, compose_text(existing['image'], volume, env_file))
            run([*command, 'up', '-d', '--no-build', 'panel'])
        else:
            subprocess.run([*command, 'down'], capture_output=True)
            if previous_compose: write(compose, previous_compose)
        raise
    write(state_file, json.dumps({'project': project, 'volume': volume, 'envFile': str(env_file), 'version': version, 'compose': str(compose)}, indent=2))
    print('Panel 已就绪，版本 ' + version + '。配置与初始密码保存在 ' + str(env_file))
    print('1Panel 编排请使用 ' + str(compose) + '；三个网站与 Cloudflare 规则由你配置。备份：' + str(backup))


def uninstall(role, purge=False, confirmation=''):
    if purge and confirmation != 'DELETE-' + role.upper() + '-DATA':
        raise ValueError('彻底清除需显式提供 --confirm DELETE-' + role.upper() + '-DATA')
    if role == 'agent':
        if UNIT.exists() and not any(value in UNIT.read_text() for value in ('/opt/xray-panel-agent/agent/agent.py', '/opt/xray-panel/agent/agent.py')):
            raise ValueError('服务文件不属于本项目，拒绝卸载')
        for args in (['systemctl', 'stop', SERVICE], ['systemctl', 'disable', SERVICE]): subprocess.run(args, capture_output=True)
        UNIT.unlink(missing_ok=True)
        run(['systemctl', 'daemon-reload'])
        if AGENT.exists(): shutil.rmtree(AGENT)
        if purge:
            CONFIG.unlink(missing_ok=True)
            state = Path('/var/lib/xray-panel-agent')
            if state.exists(): shutil.rmtree(state)
        print('Agent 已卸载，Xray 与 /opt/xray-panel 未改动；' + ('凭据已清除' if purge else '凭据和状态已保留'))
    else:
        state = json.loads((HOME / 'panel.json').read_text())
        run(['docker', 'compose', '-p', state['project'], '-f', state['compose'], 'down'])
        if purge:
            run(['docker', 'volume', 'rm', state['volume']])
            Path(state['envFile']).unlink(missing_ok=True)
            (HOME / 'panel.json').unlink(missing_ok=True)
        print('Panel 容器已移除；' + ('当前数据库与环境配置已清除，历史备份仍保留' if purge else '数据卷、环境配置与备份已保留'))


def menu(role=None):
    options = [('panel', 'install', '安装 Panel'), ('panel', 'update', '更新 Panel'), ('panel', 'uninstall', '卸载 Panel'), ('panel', 'status', 'Panel 状态'), ('panel', 'logs', 'Panel 日志'), ('agent', 'install', '安装接入 Agent'), ('agent', 'update', '更新 Agent'), ('agent', 'status', 'Agent 状态'), ('agent', 'logs', 'Agent 日志'), ('agent', 'uninstall', '卸载 Agent（保留 Xray）')]
    if role: options = [item for item in options if item[0] == role]
    while True:
        print('\n\033[36m' + '─' * 48 + '\n  Xray Panel 集中管理\n' + '─' * 48 + '\033[0m')
        print('  Agent: ' + ('已有本地配置（安装/更新均保留节点身份）' if CONFIG.exists() else '未接入'))
        for index, (_, _, label) in enumerate(options, 1): print('  \033[32m' + str(index) + '\033[0m. ' + label)
        choice = input('  请选择 [0 返回]: ').strip()
        if choice == '0': return
        if not choice.isdigit() or not 1 <= int(choice) <= len(options): continue
        selected, action, _ = options[int(choice) - 1]
        if action == 'uninstall' and input('卸载 ' + selected + '，默认保留数据。输入 YES 确认: ') != 'YES': continue
        try:
            subprocess.run([sys.executable, str(Path(__file__).resolve()), selected, action], check=True)
        except Exception as exc: print(str(exc), file=sys.stderr)


def execute(role, action, version, stdin=False, purge=False, confirmation='', domains=None):
    if role == 'panel' and action in ('install', 'update'): return panel_install(version, domains)
    if role == 'agent' and action in ('install', 'update'):
        value = sys.stdin.read() if stdin else CONFIG.read_text() if CONFIG.exists() else getpass.getpass('粘贴面板生成的一段接入信息（隐藏输入）: ')
        return agent_install(enrollment(value))
    if action == 'uninstall': return uninstall(role, purge, confirmation)
    if role == 'agent':
        args = ['systemctl', 'status', SERVICE, '--no-pager'] if action == 'status' else ['journalctl', '-u', SERVICE, '-n', '100', '--no-pager']
    else:
        state = json.loads((HOME / 'panel.json').read_text())
        args = ['docker', 'compose', '-p', state['project'], '-f', state['compose'], *(('ps',) if action == 'status' else ('logs', '--tail', '100', 'panel'))]
    subprocess.run(args, check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=('panel', 'agent'), nargs='?')
    parser.add_argument('action', choices=('install', 'update', 'uninstall', 'status', 'logs'), nargs='?')
    parser.add_argument('--version')
    parser.add_argument('--stdin', action='store_true', help='从标准输入读取接入信息，凭据不进入参数或 URL')
    parser.add_argument('--purge', action='store_true')
    parser.add_argument('--confirm', default='')
    parser.add_argument('--domains', nargs=3)
    args = parser.parse_args()
    if os.geteuid() != 0: raise ValueError('请以 root 运行')
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not args.action: return menu(args.role)
    if not args.role: parser.error('请指定 panel 或 agent')
    version = args.version or (latest_version() if args.action in ('install', 'update') else VERSION)
    if args.action in ('install', 'update') and version != VERSION:
        destination = install_manager(version)
        os.execv(sys.executable, [sys.executable, str(destination / 'deploy/lifecycle.py'), args.role, args.action, '--version', version, *(['--stdin'] if args.stdin else []), *(['--domains', *args.domains] if args.domains else [])])
    with (HOME / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute(args.role, args.action, version, args.stdin, args.purge, args.confirm, args.domains)


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt) as exc:
        print('操作未完成：' + (str(exc) if not isinstance(exc, KeyboardInterrupt) else '已取消'), file=sys.stderr)
        sys.exit(1)
