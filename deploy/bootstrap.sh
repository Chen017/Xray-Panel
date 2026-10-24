#!/usr/bin/env bash
# Download a versioned, checksum-verified manager. No credentials in URLs or arguments.
(
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo '请以 root 运行'; exit 1; }
version=1.3.6
home=/opt/xray-panel-manager
missing=0
for tool in python3 curl tar; do command -v "$tool" >/dev/null || missing=1; done
if command -v python3 >/dev/null && ! python3 -c 'import ssl; assert ssl.create_default_context().cert_store_stats()["x509_ca"] > 0' 2>/dev/null; then missing=1; fi
if [[ $missing == 1 ]]; then
  command -v apt-get >/dev/null || { echo '请先安装 Python >= 3.10、curl、tar 和 CA 证书'; exit 1; }
  apt-get update </dev/null && apt-get install -y python3 curl tar ca-certificates util-linux </dev/null
fi
python3 -c 'import sys; assert sys.version_info >= (3,10), "需要 Python >= 3.10"'
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
base="https://github.com/Chen017/Xray-Panel/releases/download/v$version/xray-panel-$version.tar.gz"
curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 180 "$base" -o "$work/source.tar.gz"
curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 30 "$base.sha256" -o "$work/source.sha256"
python3 - "$work" "$home" "$version" <<'PY'
from pathlib import Path
import hashlib,json,os,shutil,sys,tarfile,tempfile
work,home,version=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
archive=work/'source.tar.gz'
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
if digest!= (work/'source.sha256').read_text().split()[0]:
    raise SystemExit('发布包 SHA256 不匹配')
source=work/'source';source.mkdir()
with tarfile.open(archive) as tar:
    for item in tar.getmembers():
        if not (source/item.name).resolve().is_relative_to(source) or item.issym() or item.islnk() or not(item.isfile() or item.isdir()):
            raise SystemExit('发布包包含不安全路径')
    tar.extractall(source)
if json.loads((source/'package.json').read_text())['version']!=version:
    raise SystemExit('发布包版本不匹配')
if not (source/'deploy/lifecycle.py').is_file(): raise SystemExit('发布包缺少统一管理器')
destination=home/'versions'/version
if home.is_symlink() or destination.parent.is_symlink() or destination.is_symlink(): raise SystemExit('管理器安装目录不能是符号链接')
destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
try: complete=(destination/'.release-complete').read_text()==digest and json.loads((destination/'package.json').read_text())['version']==version and (destination/'deploy/lifecycle.py').is_file()
except (OSError,ValueError,KeyError): complete=False
if not complete:
    with tempfile.TemporaryDirectory(prefix='.install-',dir=destination.parent) as temp:
        staged,retired=Path(temp)/'release',Path(temp)/'previous'
        shutil.copytree(source,staged)
        (staged/'.release-complete').write_text(digest)
        if destination.exists(): os.replace(destination,retired)
        try: os.replace(staged,destination)
        except BaseException:
            if retired.exists(): os.replace(retired,destination)
            raise
temporary=home/('.current-'+str(os.getpid()));temporary.symlink_to(destination);os.replace(temporary,home/'current')
command=Path('/usr/local/bin/xray-panel')
command.write_text('#!/bin/bash\nexec /usr/bin/python3 /opt/xray-panel-manager/current/deploy/lifecycle.py "$@"\n');command.chmod(0o755)
PY
exec /usr/local/bin/xray-panel "$@"
)
