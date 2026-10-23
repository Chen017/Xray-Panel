#!/usr/bin/env python3
"""Isolated Linux integration driver. Never installs services or touches system firewall."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('panel_agent', REPO / 'agent/agent.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
workers = []
# Public probes and firewall inventory are tested separately; integration fixtures
# must never inspect the host firewall or depend on external networking.
mod.system_report.addresses = lambda: {'checkedAt': '2026-01-01T00:00:00Z'}
mod.system_report.firewall = lambda *args: {'status': 'unsupported', 'sources': []}
mod.probes.run_plan = lambda plan: {'planId': plan['id'], 'results': []}


def handle(msg):
    action = msg['action']
    root = Path(msg.get('root', '/tmp/unused'))
    if action == 'init':
        assert '.local' in root.parts and root.is_absolute(), 'Fixture must be under .local'
        root.mkdir(parents=True, exist_ok=True)
        (root / 'bin').mkdir(exist_ok=True)
        (root / 'test-state').mkdir(exist_ok=True)
        (root / 'test-state/active').touch()
        core = Path(msg['core'])
        for name in ['xray', 'geoip.dat', 'geosite.dat']:
            dst = root / 'bin' / name
            if not dst.exists():
                dst.symlink_to(core.parent / name)
        shutil.copytree(REPO / 'vendor/xray-script', root / 'sh', dirs_exist_ok=True)
        driver = root / 'test-driver.sh'
        driver.write_text('''export TEST_STATE="$is_core_dir/test-state"
systemctl() {
 case "$1" in
  is-active) [[ -f "$TEST_STATE/active" ]] && echo active;;
  restart|start)
   echo "$1" >> "$TEST_STATE/service.commands"
   if [[ -f "$TEST_STATE/fail-restart" ]]; then rm "$TEST_STATE/fail-restart"; return 1; fi
   touch "$TEST_STATE/active";;
  stop) rm -f "$TEST_STATE/active";;
  *) return 0;;
 esac
}
firewall_sync() {
 [[ ${config_staging:-0} == 1 ]] && return 0
 if [[ -f "$TEST_STATE/fail-firewall" ]]; then rm "$TEST_STATE/fail-firewall"; return 1; fi
 echo sync >> "$TEST_STATE/firewall.commands"
}
''')
        mod.write_bundle(root, msg['bundle'])
        return {'version': subprocess.check_output([str(root / 'bin/xray'), 'version'], text=True).splitlines()[0]}
    if action == 'once':
        cfg = msg['config']
        cfg.update({'testDriver': str(root / 'test-driver.sh'), 'xrayRoot': str(root), 'stateDir': str(root / 'agent-state')})
        agent = mod.Agent(cfg)
        original_report = agent.report
        def fixture_report():
            r = original_report()
            r['active'] = (root / 'test-state/active').exists()
            return r
        agent.report = fixture_report
        with contextlib.redirect_stdout(sys.stderr):
            agent.once()
        return {'hash': mod.bundle_hash(mod.read_bundle(root)), 'bundle': mod.read_bundle(root)}
    if action == 'fail':
        assert msg['kind'] in {'restart', 'firewall'}
        (root / ('test-state/fail-' + msg['kind'])).touch()
        return {'ok': True}
    if action == 'external-change':
        b = mod.read_bundle(root)
        b['files']['config.json'].setdefault('log', {})['loglevel'] = 'error'
        mod.write_bundle(root, b)
        return {'bundle': b}
    if action == 'vlessenc':
        raw = subprocess.check_output([msg['core'], 'vlessenc'], text=True)
        import re
        dec = re.search(r'"decryption"\s*:\s*"([^"]+)"', raw).group(1)
        enc = re.search(r'"encryption"\s*:\s*"([^"]+)"', raw).group(1)
        return {'decryption': dec, 'encryption': enc}
    if action == 'mihomo-start':
        folder = Path(msg['folder'])
        folder.mkdir(parents=True, exist_ok=True)
        cfg = folder / 'config.yaml'
        cfg.write_text(msg['yaml'])
        log = (folder / 'mihomo.log').open('w')
        proc = subprocess.Popen([msg['binary'], '-d', str(folder), '-f', str(cfg)], stdout=log, stderr=subprocess.STDOUT)
        workers.append((proc, log))
        return {'pid': proc.pid}
    if action == 'http':
        req = urllib.request.Request(msg['url'], method=msg.get('method', 'GET'), headers=msg.get('headers', {}))
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return {'status': r.status, 'body': r.read(2 * 1024 * 1024).decode()}
        except Exception as exc:
            return {'status': 0, 'error': str(exc)}
    if action == 'mihomo-decrypt':
        folder = Path(msg['folder'])
        encrypted = folder / 'provider.age'
        encrypted.write_text(msg['ciphertext'])
        out = subprocess.check_output([msg['binary'], 'age', 'decrypt', msg['identity'], str(encrypted), '-'], text=True)
        return {'plaintext': out}
    if action == 'read-log':
        return {'output': (Path(msg['folder']) / 'mihomo.log').read_text()[-16000:]}
    if action == 'shutdown':
        for proc, log in workers:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            log.close()
        return {'ok': True}
    raise ValueError('Unknown test driver operation')


for line in sys.stdin:
    try:
        result = handle(json.loads(line))
        print(json.dumps({'ok': True, 'result': result}), flush=True)
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'ok': False, 'error': str(exc)}), flush=True)
