"""Real Bash bootstrap test. All downloads, CA setup and installations are local."""
import hashlib,json,os,shlex,subprocess,sys,tarfile,tempfile
from pathlib import Path

data=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='xray-bootstrap-test-') as tmp:
    root=Path(tmp);home=root/'manager';bin=root/'bin';bin.mkdir();source=root/'source';(source/'deploy').mkdir(parents=True)
    (source/'package.json').write_text(json.dumps({'version':data['version']}))
    (source/'deploy/lifecycle.py').write_text("import sys,os\nfrom pathlib import Path\nPath(os.environ['TEST_ROOT']+'/received').write_text(sys.stdin.read())\nprint('fixture manager')\n")
    archive=root/'release.tar.gz'
    with tarfile.open(archive,'w:gz') as t:
        for file in source.rglob('*'):t.add(file,arcname=str(file.relative_to(source)),recursive=False)
    (root/'release.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  release.tar.gz\n')
    bootstrap=data['bootstrap'].replace('/opt/xray-panel-manager',str(home)).replace('/usr/local/bin/xray-panel',str(root/'command')).replace('[[ $EUID == 0 ]]','[[ 1 == 1 ]]')
    (root/'bootstrap.sh').write_text(bootstrap)
    mocks={
      'curl': '''for ((i=1;i<=$#;i++)); do if [[ ${!i} == -o ]]; then j=$((i+1)); target=${!j}; fi; done
case "$*" in
 *raw.githubusercontent*) cp "$TEST_ROOT/bootstrap.sh" "$target";;
 *.sha256*) cp "$TEST_ROOT/release.sha256" "$target";;
 *) cp "$TEST_ROOT/release.tar.gz" "$target";;
esac''',
      'apt-get': 'echo "$*" >> "$TEST_ROOT/apt.log"\nif [[ $1 == install ]]; then touch "$TEST_ROOT/ca-ready"; fi',
      'python3': 'if [[ "$*" == *cert_store_stats* ]]; then [[ -f "$TEST_ROOT/ca-ready" ]]; exit $?; fi\nexec '+shlex.quote(sys.executable)+' "$@"'
    }
    for name,text in mocks.items():
        p=bin/name;p.write_text('#!/bin/bash\n'+text+'\n');p.chmod(0o755)
    env={**os.environ,'TEST_ROOT':str(root),'PATH':str(bin)+':'+os.environ['PATH']}
    # A pasted installer must not alter parent traps, shell flags or exit the shell.
    script=data['script']+'\nprintf "parent-alive"\n'
    result=subprocess.run(['bash'],input=script,text=True,capture_output=True,env=env,timeout=30)
    assert result.returncode==0,result.stdout+result.stderr
    assert 'parent-alive' in result.stdout
    assert (root/'received').exists(),result.stdout+result.stderr
    assert (root/'received').read_text()==data['enrollment']
    assert 'ca-certificates' in (root/'apt.log').read_text()
    assert data['secret'] not in result.stdout+result.stderr
    # A pre-1.3 interrupted copy can leave lifecycle.py but omit other files.
    # Never treat mere directory/lifecycle.py existence as a complete cache.
    cached=home/'versions'/data['version']
    (cached/'package.json').unlink()
    (cached/'.release-complete').unlink(missing_ok=True)
    (cached/'deploy/lifecycle.py').write_text("raise SystemExit('partial cache executed')\n")
    # Repeat installation preserves the manager and still delivers credentials once.
    result=subprocess.run(['bash'],input=script,text=True,capture_output=True,env=env,timeout=30)
    assert result.returncode==0,result.stdout+result.stderr
    assert (root/'received').exists(),result.stdout+result.stderr
    assert (root/'received').read_text()==data['enrollment']
    assert json.loads((cached/'package.json').read_text())['version']==data['version']
    assert (cached/'.release-complete').read_text()==hashlib.sha256(archive.read_bytes()).hexdigest()
print('bootstrap shell checks passed')
