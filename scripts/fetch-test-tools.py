"""Fetch exact Linux x64 test cores from official releases; keep them under .local."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1] / '.local/tools'
ROOT.mkdir(parents=True, exist_ok=True)


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'xray-panel-local-tests'}), timeout=120) as r:
        return r.read()


target = ROOT / 'v26.3.27'
target.mkdir(exist_ok=True)
url = 'https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip'
data = get(url)
digest = get(url + '.dgst').decode()
matches = re.findall(r'(?im)^.*SHA(?:2-)?256.*?([0-9a-f]{64})\s*$', digest)
if not matches or hashlib.sha256(data).hexdigest() != matches[0].lower():
    raise RuntimeError('Xray official SHA256 mismatch')
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    for name in ['xray', 'geoip.dat', 'geosite.dat']:
        p = target / name
        p.write_bytes(archive.read(name))
        p.chmod(0o755)

release = json.loads(get('https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/v1.19.32'))
asset = next(a for a in release['assets'] if a['name'] == 'mihomo-linux-amd64-compatible-v1.19.32.gz')
data = get(asset['browser_download_url'])
if asset.get('digest') != 'sha256:' + hashlib.sha256(data).hexdigest():
    raise RuntimeError('Mihomo official SHA256 missing or mismatched')
p = ROOT / 'mihomo'
p.write_bytes(gzip.decompress(data))
p.chmod(0o755)
print('Pinned test cores ready under .local/tools: Xray v26.3.27, Mihomo v1.19.32')
