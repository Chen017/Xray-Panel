#!/usr/bin/env python3
"""Outbound-only Xray Panel Agent. Python 3.10+, no pip dependencies."""
import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import math
import struct
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
_report_spec = importlib.util.spec_from_file_location('xray_system_report', HERE / 'system_report.py')
system_report = importlib.util.module_from_spec(_report_spec)
_report_spec.loader.exec_module(system_report)
_probe_spec = importlib.util.spec_from_file_location('xray_probes', HERE / 'probes.py')
probes = importlib.util.module_from_spec(_probe_spec)
_probe_spec.loader.exec_module(probes)
ROOT_FILES = {'config.json', 'relay.json', 'custom_rules.json', 'firewall_ports.json'}
SAFE_CONF = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.json\Z')
ACTIONS = {'deploy', 'inspect', 'detect-addresses', 'firewall-status', 'validate', 'dump', 'logs', 'start', 'stop', 'restart', 'enable', 'disable', 'update-core', 'update-script', 'update-geodata', 'maintenance', 'bbr', 'diagnostics', 'relay-test', 'relay-keygen', 'uninstall', 'install-standard', 'install-landing'}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def bundle_hash(value):
    def stable(v):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if not math.isfinite(v):
                raise ValueError('Non-finite configuration number')
            return 'n' + struct.pack('>d', 0.0 if v == 0 else float(v)).hex()
        if isinstance(v, list):
            return '[' + ','.join(stable(item) for item in v) + ']'
        if isinstance(v, dict):
            return '{' + ','.join(canonical(k) + ':' + stable(v[k]) for k in sorted(v, key=lambda k: k.encode('utf-16-be', 'surrogatepass'))) + '}'
        return canonical(v)
    return hashlib.sha256(stable(value).encode()).hexdigest()


def no_links(root):
    root = Path(root).absolute()
    for parent in [root, *root.parents]:
        if parent.is_symlink():
            raise ValueError('Xray root must not contain symlinks')
    if (root / 'conf').is_symlink():
        raise ValueError('conf must not be a symlink')
    for name in ROOT_FILES:
        if (root / name).is_symlink():
            raise ValueError('configuration symlinks are not supported')
    if (root / 'conf').is_dir():
        for p in (root / 'conf').iterdir():
            if (p.name.endswith('.json') or p.name == 'is_v6_uplink') and p.is_symlink():
                raise ValueError('configuration symlinks are not supported')


def read_bundle(root):
    root = Path(root)
    no_links(root)
    if not (root / 'config.json').is_file():
        return None
    files = {}
    for name in ROOT_FILES:
        p = root / name
        if p.is_file():
            files[name] = json.loads(p.read_text('utf-8'))
    if (root / 'conf').is_dir():
        for p in sorted((root / 'conf').iterdir()):
            if SAFE_CONF.fullmatch(p.name) and p.is_file():
                files['conf/' + p.name] = json.loads(p.read_text('utf-8'))
        if (root / 'conf/is_v6_uplink').exists():
            files['conf/is_v6_uplink'] = True
    return {'files': files}


def validate_bundle(bundle):
    if not isinstance(bundle, dict) or not isinstance(bundle.get('files'), dict) or 'config.json' not in bundle['files']:
        raise ValueError('Invalid configuration bundle')
    if len(bundle['files']) > 100:
        raise ValueError('Too many configuration files')
    for name, value in bundle['files'].items():
        if name not in ROOT_FILES and name != 'conf/is_v6_uplink' and not (name.startswith('conf/') and SAFE_CONF.fullmatch(name[5:])):
            raise ValueError('Disallowed configuration path')
        if name == 'conf/is_v6_uplink':
            if value is not True:
                raise ValueError('Invalid direction flag')
        elif not isinstance(value, (dict, list)):
            raise ValueError('Invalid JSON configuration')
    return bundle


def write_bundle(root, bundle):
    """Called only on the staging tree inside the script's operation lock."""
    root = Path(root)
    validate_bundle(bundle)
    no_links(root)
    (root / 'conf').mkdir(parents=True, exist_ok=True)
    current = read_bundle(root)
    for name in (current or {'files': {}})['files']:
        if name not in bundle['files']:
            (root / name).unlink(missing_ok=True)
    for name, value in bundle['files'].items():
        p = root / name
        p.write_text('' if name == 'conf/is_v6_uplink' else json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        p.chmod(0o600)


def command(args, env=None, timeout=600, cwd=None):
    proc = subprocess.Popen(args, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=os.name != 'nt')
    try:
        out = proc.communicate(timeout=timeout)[0]
    except subprocess.TimeoutExpired:
        if os.name == 'nt':
            proc.terminate()
        else:
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            out = proc.communicate(timeout=10)[0]
        except subprocess.TimeoutExpired:
            if os.name == 'nt':
                proc.kill()
            else:
                os.killpg(proc.pid, signal.SIGKILL)
            out = proc.communicate()[0]
        return False, (out[-120000:].decode('utf-8', 'replace') + '\nOperation timed out; inspect node before retrying.')
    return proc.returncode == 0, out[-120000:].decode('utf-8', 'replace')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect refused; use the final Agent HTTPS URL and Cloudflare Service Auth policy')


class Agent:
    def __init__(self, config):
        self.config = config
        self.root = Path(config.get('xrayRoot', '/usr/local/etc/xray')).absolute()
        if self.root in {Path('/'), Path('/etc'), Path('/usr'), Path('/usr/local'), Path('/usr/local/etc')}:
            raise ValueError('Unsafe Xray root')
        self.state = Path(config.get('stateDir', '/var/lib/xray-panel-agent')).absolute()
        self.url = config['url'].rstrip('/')
        parsed = urllib.parse.urlparse(self.url)
        loopback = parsed.hostname in {'127.0.0.1', 'localhost', '::1'}
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}:
            raise ValueError('Agent URL must contain only scheme, host and port')
        if parsed.scheme != 'https' and not (config.get('allowLoopbackHttp') is True and parsed.scheme == 'http' and loopback):
            raise ValueError('Agent requires HTTPS; allowLoopbackHttp is only for local tests')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', config['token']):
            raise ValueError('Invalid agent token')
        no_links(self.root)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.state.is_symlink():
            raise ValueError('Agent state directory must not be a symlink')
        self.state.chmod(0o700)
        self.opener = urllib.request.build_opener(NoRedirect())
        self.cached_network = None
        self.cached_firewall = None
        self.network_at = 0
        self.firewall_at = 0

    def request(self, route, payload):
        headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.config['token'], 'X-Node-ID': self.config['nodeId']}
        for name in ['CF-Access-Client-Id', 'CF-Access-Client-Secret']:
            if self.config.get(name):
                headers[name] = self.config[name]
        req = urllib.request.Request(self.url + route, data=json.dumps(payload).encode(), headers=headers, method='POST')
        with self.opener.open(req, timeout=30) as response:
            return json.loads(response.read(3 * 1024 * 1024))

    def report(self):
        binary = self.root / 'bin/xray'
        installed = binary.is_file() and (self.root / 'config.json').is_file()
        version = ''
        if installed:
            _, out = command([str(binary), 'version'], timeout=10)
            version = out.splitlines()[0] if out else ''
        _, status = command(['systemctl', 'is-active', 'xray'], timeout=10)
        listen4 = '127.0.0.1'
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(('1.1.1.1', 80))
                listen4 = sock.getsockname()[0]
        except OSError:
            pass
        script_version = ''
        entry = self.root / 'sh/xray.sh'
        if entry.is_file():
            match = re.search(r'^is_sh_ver=(.+)$', entry.read_text(), re.MULTILINE)
            script_version = match.group(1) if match else ''
        now = time.monotonic()
        if now - self.network_at >= 300 or self.cached_network is None:
            self.cached_network = system_report.addresses()
            self.network_at = now
        if now - self.firewall_at >= 60 or self.cached_firewall is None:
            try: bundle = read_bundle(self.root)
            except (OSError, ValueError): bundle = None
            self.cached_firewall = system_report.firewall(bundle)
            self.firewall_at = now
        return {'installed': installed, 'version': version, 'scriptVersion': script_version, 'active': status.strip() == 'active', 'hostname': socket.gethostname(), 'listen4': listen4, 'agentVersion': json.loads((HERE.parent / 'package.json').read_text())['version'], 'monitorProtocol': 2, 'monitor': getattr(self, 'monitor_result', None), 'platform': sys.platform, 'network': self.cached_network, 'firewall': self.cached_firewall}

    def snapshot(self):
        """A damaged configuration must not disconnect the management channel."""
        try:
            return read_bundle(self.root), None
        except (OSError, ValueError, UnicodeError) as exc:
            return None, 'Configuration cannot be read (' + type(exc).__name__ + '). Check the node configuration; logs and diagnostics remain available.'

    def current_result(self, job, result):
        current, config_error = self.snapshot()
        fresh = {k: v for k, v in result.items() if k not in {'bundle', 'report'}}
        fresh['report'] = {**self.report(), 'configError': config_error}
        if current is not None:
            fresh['bundle'] = current
        if job['action'] == 'deploy' and (config_error or current is None or bundle_hash(current) != job['payload']['targetHash']):
            fresh['ok'] = False
            fresh['output'] = ('Current configuration no longer matches this deployment; refusing to publish a stale result.\n' + fresh.get('output', ''))[:120000]
        return fresh

    def execute(self, job):
        job_id = str(job['id'])
        if not re.fullmatch(r'[0-9a-f-]{36}', job_id) or job['action'] not in ACTIONS:
            raise ValueError('Unrecognized job')
        signature = hashlib.sha256(canonical({'action': job['action'], 'payload': job.get('payload', {})}).encode()).hexdigest()
        journal = self.state / (job_id + '.json')
        if journal.is_file():
            saved = json.loads(journal.read_text())
            if saved['signature'] != signature:
                raise ValueError('Job ID was reused with different content')
            if 'result' in saved:
                return self.current_result(job, saved['result'])
            current, config_error = self.snapshot()
            if job['action'] == 'deploy' and not config_error and current is not None and bundle_hash(current) == job['payload']['targetHash']:
                return self.current_result(job, {'ok': True, 'output': 'Previous deployment already committed.'})
            if job['action'] not in {'inspect', 'detect-addresses', 'firewall-status', 'validate', 'logs', 'diagnostics'}:
                return self.current_result(job, {'ok': False, 'output': 'Previous execution was interrupted. Refusing to replay this mutation; inspect the node and create a new task.'})
        def save(value):
            tmp = journal.with_suffix('.tmp')
            tmp.write_text(json.dumps(value), encoding='utf-8')
            tmp.chmod(0o600)
            os.replace(tmp, journal)
        save({'signature': signature, 'started': time.time()})
        payload = job.get('payload', {})
        env = os.environ.copy()
        env.update({'XRAY_ROOT': str(self.root), 'PANEL_PYTHON': sys.executable, 'PANEL_AGENT': str(HERE / 'agent.py'), 'PANEL_REAL_ROOT': str(self.root)})
        if self.config.get('testDriver'):
            if str(self.root) == '/usr/local/etc/xray':
                raise ValueError('Test driver forbidden on a real installation')
            env['PANEL_TEST_DRIVER'] = str(Path(self.config['testDriver']).resolve())
        output = ''
        try:
            if job['action'] in {'detect-addresses', 'firewall-status'}:
                if job['action'] == 'detect-addresses': self.network_at = 0; self.cached_network = None
                else: self.firewall_at = 0; self.cached_firewall = None
                report = self.report()
                ok, output = True, json.dumps(report['network' if job['action'] == 'detect-addresses' else 'firewall'], ensure_ascii=False, indent=2)
            elif job['action'] == 'inspect':
                _, config_error = self.snapshot()
                ok, output = not config_error, config_error or 'Imported current Xray configuration.'
            elif job['action'] == 'deploy':
                validate_bundle(payload['bundle'])
                if bundle_hash(payload['bundle']) != payload['targetHash']:
                    raise ValueError('Deployment hash mismatch')
                with tempfile.TemporaryDirectory(prefix='candidate-', dir=self.state) as tmp:
                    candidate = Path(tmp) / 'bundle.json'
                    candidate.write_text(json.dumps(payload['bundle']), encoding='utf-8')
                    candidate.chmod(0o600)
                    env['PANEL_CANDIDATE'] = str(candidate)
                    env['PANEL_EXPECTED_HASH'] = payload['expectedHash']
                    ok, output = command(['bash', str(HERE / 'bridge.sh'), 'deploy'], env=env)
            elif job['action'].startswith('install-'):
                if (self.root / 'bin/xray').exists():
                    raise ValueError('Xray already installed; refusing to overwrite it')
                if str(self.root) != '/usr/local/etc/xray':
                    raise ValueError('Installation is supported only at the standard Xray root')
                env['PANEL_UNATTENDED'] = '1'
                vendor = HERE.parent / 'vendor/xray-script'
                mode = 'landing' if job['action'] == 'install-landing' else 'standard'
                ok, output = command(['bash', str(vendor / 'install.sh'), '--local-install', '--mode', mode], env=env, cwd=vendor)
            else:
                ok, output = command(['bash', str(HERE / 'bridge.sh'), job['action']], env=env)
        except Exception as exc:
            ok, output = False, str(exc)
        result = self.current_result(job, {'ok': ok, 'output': output})
        save({'signature': signature, 'result': result})
        journals = sorted(self.state.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in journals[200:]:
            old.unlink(missing_ok=True)
        return result

    def once(self):
        bundle, config_error = self.snapshot()
        payload = {'report': {**self.report(), 'configError': config_error}}
        if bundle is not None:
            payload['bundle'] = bundle
        response = self.request('/v1/agent/poll', payload)
        job = response.get('job')
        if job:
            result = self.execute(job)
            self.request('/v1/agent/jobs/' + job['id'] + '/result', {**result, 'lease': job['lease']})
            print('job', job['id'], 'succeeded' if result['ok'] else 'failed', flush=True)
        if response.get('monitorPlan'):
            self.monitor_result = probes.run_plan(response['monitorPlan'])

    def run(self):
        while True:
            try:
                self.once()
            except Exception as exc:
                print('Agent connection/operation failed:', connection_error(exc), flush=True)
            time.sleep(5)


def connection_error(exc):
    # Report only status and recognized numeric Cloudflare codes, never arbitrary bodies.
    if isinstance(exc, urllib.error.HTTPError):
        try: body = exc.read(2048).decode('utf-8', 'replace')
        except Exception: body = ''
        match = re.search(r'(?:error code:|Error)\s*(\d{4,5})', body, re.I)
        code = match.group(1) if match else None
        hint = {401: 'check node ID and Panel Agent Token', 403: 'check CF Service Auth policy and origin guard', 404: 'check Agent hostname/path', 429: 'rate limited; retry later'}.get(exc.code, 'check control centre availability')
        if code == '1010': hint = 'Cloudflare BIC blocks machine clients; configure a hostname-scoped BIC exception'
        return 'HTTP ' + str(exc.code) + (' / CF ' + code if code else '') + ': ' + hint
    if isinstance(exc, ValueError) and 'Redirect refused' in str(exc):
        return 'Redirect refused: check HTTPS Agent URL and Service Auth (no browser login)'
    return type(exc).__name__


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/etc/xray-panel-agent/config.json')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--write-bundle', nargs=2, metavar=('ROOT', 'BUNDLE'))
    parser.add_argument('--check-base', nargs=2, metavar=('ROOT', 'HASH'))
    args = parser.parse_args()
    if args.write_bundle:
        root, bundle = args.write_bundle
        write_bundle(root, json.loads(Path(bundle).read_text()))
        return
    if args.check_base:
        root, expected = args.check_base
        if bundle_hash(read_bundle(root)) != expected:
            raise SystemExit('Configuration changed outside the panel. Import it before deploying.')
        return
    cfg = Path(args.config)
    if os.name != 'nt' and cfg.stat().st_mode & 0o077:
        raise SystemExit('Agent configuration must have permissions 600')
    agent = Agent(json.loads(cfg.read_text('utf-8')))
    agent.once() if args.once else agent.run()


if __name__ == '__main__':
    main()
