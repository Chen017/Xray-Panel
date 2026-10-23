#!/usr/bin/env bash
# Compatibility entry: the manager preserves existing configuration and identity.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
exec python3 "$repo/deploy/lifecycle.py" agent install --version "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$repo/package.json")" "$@"
