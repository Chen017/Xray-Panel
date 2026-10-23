import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {linuxPath} from './linux.mjs';

test('lifecycle snapshot streams a real WAL database larger than the container tmpfs and removes its temporary file',()=>{
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(path.resolve('.local','snapshot-'));
 try{
  const python=`import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('lifecycle',${JSON.stringify(linuxPath('deploy/lifecycle.py'))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def capture(args):
 print(json.dumps(args[-1]))
 raise InterruptedError()
m.run=capture
try:m.snapshot_panel({'container':'fixture','running':True},Path('/unused'))
except InterruptedError:pass
`;
  const invocation=process.platform==='win32'?['wsl',['-d',process.env.XRAY_TEST_WSL??'Debian','--','python3','-c',python]]:['python3',['-c',python]];
  const captured=spawnSync(...invocation,{encoding:'utf8',timeout:30000});assert.equal(captured.status,0,captured.stderr);
  const script=JSON.parse(captured.stdout.trim()).replaceAll('/app/data',dir.replaceAll('\\','/'));
  const db=new DatabaseSync(path.join(dir,'panel.sqlite'));
  try{
   db.exec('PRAGMA journal_mode=WAL; CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES(zeroblob(33554433));');
   const result=spawnSync(process.execPath,['--input-type=module','-e',script],{maxBuffer:48*1024*1024,timeout:30000});assert.equal(result.status,0,result.stderr.toString());
   const boundary=result.stdout.indexOf(10),owner=JSON.parse(result.stdout.subarray(0,boundary));assert.ok(Number.isInteger(owner.uid));
   const bytes=result.stdout.subarray(boundary+1);assert.ok(bytes.length>32*1024*1024);assert.equal(bytes.subarray(0,16).toString(),'SQLite format 3\0');
   const backup=path.join(dir,'snapshot.sqlite');writeFileSync(backup,bytes);const restored=new DatabaseSync(backup);
   try{assert.equal(restored.prepare('SELECT length(value) AS size FROM payload').get().size,33554433);}finally{restored.close();}
   assert.equal(readdirSync(dir).filter(f=>f.startsWith('.panel-backup-')).length,0);
  }finally{db.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
