#!/usr/bin/env python3
"""Read-only public address and firewall inventory, also shipped with Xray Script."""
import argparse
import datetime
import ipaddress
import json
from pathlib import Path
import shlex
import shutil
import subprocess


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=8)
        return result.returncode, result.stdout[:200000], result.stderr[:2000]
    except (OSError, subprocess.TimeoutExpired):
        return 1, '', 'unavailable'


def public_ip(value, family):
    try:
        ip = ipaddress.ip_address(value.strip())
        return str(ip) if ip.version == family and ip.is_global and not ip.is_multicast and not ip.is_reserved else None
    except ValueError:
        return None


def addresses(run=command):
    result = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    for family in (4, 6):
        record = {'status': 'failed', 'address': None, 'source': None}
        for url in ('https://one.one.one.one/cdn-cgi/trace', 'https://api64.ipify.org'):
            code, out, _ = run(['curl', '-' + str(family), '--fail', '--silent', '--show-error', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '3', '--proto', '=https', url])
            candidate = next((line[3:] for line in out.splitlines() if line.startswith('ip=')), out.strip())
            value = public_ip(candidate, family) if code == 0 else None
            if value:
                record = {'status': 'ok', 'address': value, 'source': url}
                break
        result['ipv' + str(family)] = record
    return result


def iptables_rules(text, family):
    rules = []
    for line in text.splitlines():
        try: parts = shlex.split(line)
        except ValueError: continue
        if len(parts) < 2 or parts[0] not in ('-A', '-P'): continue
        def option(*names):
            for name in names:
                if name in parts and parts.index(name) + 1 < len(parts): return parts[parts.index(name) + 1]
            return ''
        rules.append({'family': family, 'chain': parts[1], 'protocol': option('-p', '--protocol') or 'any', 'source': option('-s', '--source') or 'any', 'ports': option('--dport', '--dports', '--destination-port'), 'action': parts[2] if parts[0] == '-P' else option('-j', '--jump'), 'rule': line[:2000]})
    return rules


def firewall(bundle=None, run=command, available=shutil.which):
    sources = []
    for tool, family in (('iptables', 'IPv4'), ('ip6tables', 'IPv6')):
        if not available(tool): continue
        code, out, err = run([tool, '-w', '2', '-S'])
        sources.append({'backend': tool, 'status': 'ok' if code == 0 else 'permission-denied' if any(word in err.lower() for word in ('permission', 'not permitted', 'root')) else 'failed', 'rules': iptables_rules(out, family) if code == 0 else []})
    if available('nft'):
        code, out, err = run(['nft', '-j', 'list', 'ruleset'])
        rules, status = [], 'failed'
        if code == 0:
            try:
                for entry in json.loads(out).get('nftables', []):
                    rule = entry.get('rule')
                    if rule: rules.append({'family': rule.get('family', 'unknown'), 'chain': rule.get('chain', ''), 'protocol': '见原始表达式', 'source': '见原始表达式', 'ports': '', 'action': '见原始表达式', 'rule': json.dumps(rule, ensure_ascii=False)[:4000]})
                status = 'ok'
            except ValueError: pass
        elif 'permission' in err.lower() or 'not permitted' in err.lower(): status = 'permission-denied'
        sources.append({'backend': 'nftables', 'status': status, 'rules': rules})
    automatic = []
    files = (bundle or {}).get('files', {})
    relay = files.get('relay.json', {})
    for filename, file in files.items():
        if not filename.startswith('conf/') or not isinstance(file, dict): continue
        for inbound in file.get('inbounds', []):
            if inbound.get('streamSettings', {}).get('security') != 'reality' and inbound.get('tag') != 'relay-in': continue
            port = inbound.get('port')
            if not isinstance(port, int): continue
            relay_in = inbound.get('tag') == 'relay-in'
            listen = inbound.get('listen', '')
            family = 'IPv4' if relay_in or ':' not in listen and listen not in ('', '0.0.0.0') else 'IPv6' if ':' in listen else 'IPv4/IPv6'
            automatic.append({'port': port, 'protocol': 'TCP' if relay_in else 'TCP/UDP', 'family': family, 'source': (relay.get('peer_ip') or 'any') if relay_in else 'any', 'role': 'relay' if relay_in else 'reality'})
    return {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'ok' if any(item['status'] == 'ok' for item in sources) else 'unsupported' if not sources else 'unavailable', 'sources': sources, 'automatic': automatic, 'manual': files.get('firewall_ports.json', {'open': [], 'closed': []}), 'notice': '系统规则清单不等于最终放行结论；不包含云防火墙、上游 ACL 或 NAT 公网可达性。'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=('addresses', 'firewall'))
    args = parser.parse_args()
    bundle = {'files': {}}
    root = Path('/usr/local/etc/xray')
    for path in [root/'relay.json', root/'firewall_ports.json', *root.glob('conf/*.json')]:
        try: bundle['files'][str(path.relative_to(root))] = json.loads(path.read_text())
        except (OSError, ValueError): pass
    print(json.dumps(addresses() if args.kind == 'addresses' else firewall(bundle), ensure_ascii=False))


if __name__ == '__main__': main()
