import test from 'node:test';
import assert from 'node:assert/strict';
import {agentInstallScript,agentEnrollmentConfig,agentSourceRef,agentEnrollmentText} from '../web/agent-install.mjs';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {linuxPath} from './linux.mjs';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
import React from 'react';

const config={nodeId:'3c244755-e889-4e17-a659-d9a179036bad',token:'x'.repeat(43),url:'https://xagent.example.com',name:'测试 VPS', 'CF-Access-Client-Id':'device.access','CF-Access-Client-Secret':'secret"\'$(id)'};
const distro=process.env.XRAY_TEST_WSL??'Debian';
test('installer safely round trips credentials and pins HTTPS source',()=>{
  const script=agentInstallScript(config);
  const enrollment=script.match(/printf '%s' '([^']+)'/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(enrollment.split(':')[1],'base64').toString()),agentEnrollmentConfig(JSON.stringify(config)));
  assert.ok(!script.includes(config.token));
  assert.ok(!script.includes(config['CF-Access-Client-Secret']));
  assert.ok(script.includes(`/${agentSourceRef}/deploy/bootstrap.sh`));
});
test('installer rejects insecure or incomplete enrollment',()=>{
  assert.throws(()=>agentInstallScript({...config,url:'http://example.com'}));
  assert.throws(()=>agentInstallScript({...config,token:''}));
  assert.throws(()=>agentInstallScript({...config,'CF-Access-Client-Secret':''}));
  for(const url of ['https://example.com/path','https://example.com?','https://example.com/#fragment','https://user:pass@example.com','https://example.com\\evil','https://exam\nple.com']) assert.throws(()=>agentInstallScript({...config,url}),url);
  assert.throws(()=>agentInstallScript({...config,'CF-Access-Client-Secret':'secret\nInjected: header'}));
  assert.doesNotThrow(()=>agentInstallScript({...config,url:'https://[::1]:8443/'}));
});
test('partial CF credentials cannot produce a credential-free copyable script',()=>{
  const raw=JSON.stringify({nodeId:config.nodeId,token:config.token,url:config.url});
  assert.throws(()=>agentEnrollmentConfig(raw,'device.access',''));
  assert.throws(()=>agentEnrollmentConfig(raw,'','secret'));
  assert.throws(()=>agentEnrollmentConfig(raw,'  ',' secret '));
  const complete=agentEnrollmentConfig(raw,' device.access ',' secret ');
  assert.equal(complete['CF-Access-Client-Secret'],'secret');
  assert.doesNotThrow(()=>agentInstallScript(complete));
  assert.doesNotThrow(()=>agentInstallScript(agentEnrollmentConfig(raw)));
});
test('generated installer parses in real Bash',()=>{
  const cmd=process.platform==='win32'?'wsl':'bash';
  const args=process.platform==='win32'?['-d',distro,'--','bash','-n']:['-n'];
  const r=spawnSync(cmd,args,{input:agentInstallScript(config),encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
});
test('real Bash sandbox: paste isolation, CA bootstrap and stdin enrollment',()=>{
  const args=[linuxPath('tests/installer_sandbox.py')];
  const options={input:JSON.stringify({script:agentInstallScript(config),enrollment:agentEnrollmentText(config),version:agentSourceRef.slice(1),bootstrap:readFileSync('deploy/bootstrap.sh','utf8'),secret:config['CF-Access-Client-Secret']}),encoding:'utf8',timeout:60000};
  const r=process.platform==='win32'?spawnSync('wsl',['-d',distro,'--','python3',...args],options):spawnSync('python3',args,options);
  assert.equal(r.status,0,r.stdout+r.stderr);
});
test('guide renders headings, tables, code and safe links, discarding HTML',async()=>{
  mkdirSync('.local',{recursive:true});const dir=mkdtempSync(path.resolve('.local','markdown-test-'));
  try {
  const compiled=ts.transpileModule(readFileSync('web/markdown.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext}}).outputText;
  const file=path.join(dir,'markdown.mjs');writeFileSync(file,compiled);
  const {Markdown}=await import(pathToFileURL(file));
  const html=renderToStaticMarkup(React.createElement(Markdown,{source:'# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```bash\necho test\n```\n\n[guide](docs/mihomo.md)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))'}));
  assert.match(html,/<h1>Title<\/h1>/);assert.match(html,/<table>/);assert.match(html,/language-bash/);
  assert.match(html,/github.com\/Chen017\/Xray-Panel\/blob\/codex\/initial-panel\/docs\/mihomo.md/);
  assert.doesNotMatch(html,/<script>|javascript:/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
