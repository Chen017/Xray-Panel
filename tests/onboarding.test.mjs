import test from 'node:test';
import assert from 'node:assert/strict';
import {agentInstallScript,agentSourceRef} from '../web/agent-install.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
import React from 'react';

const config={nodeId:'test-node',token:'test-secret-$(touch /tmp/never-execute)',url:'https://xagent.example.com',name:'测试 VPS', 'CF-Access-Client-Id':'device.access','CF-Access-Client-Secret':'secret\n"\'$(id)'};
test('installer safely round trips credentials and pins HTTPS source',()=>{
  const script=agentInstallScript(config);
  const encoded=script.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64').toString()),config);
  assert.ok(!script.includes(config.token));
  assert.ok(!script.includes(config['CF-Access-Client-Secret']));
  assert.ok(script.includes(`/archive/${agentSourceRef}.tar.gz`));
  assert.ok(script.includes('install -m 600'));
  mkdirSync('.local',{recursive:true});writeFileSync('.local/test-agent-install.sh',script);
});
test('installer rejects insecure or incomplete enrollment',()=>{
  assert.throws(()=>agentInstallScript({...config,url:'http://example.com'}));
  assert.throws(()=>agentInstallScript({...config,token:''}));
  assert.throws(()=>agentInstallScript({...config,'CF-Access-Client-Secret':''}));
});
test('generated installer parses in real Bash',()=>{
  const cmd=process.platform==='win32'?'wsl':'bash';
  const args=process.platform==='win32'?['-d','Debian','--','bash','-n',process.cwd().replace(/^([A-Z]):/,(_,d)=>'/mnt/'+d.toLowerCase()).replaceAll('\\','/')+'/.local/test-agent-install.sh']:['-n','.local/test-agent-install.sh'];
  const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
test('guide renders headings, tables, code and safe links, discarding HTML',async()=>{
  const compiled=ts.transpileModule(readFileSync('web/markdown.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext}}).outputText;
  writeFileSync('.local/test-markdown.mjs',compiled);
  const {Markdown}=await import('../.local/test-markdown.mjs');
  const html=renderToStaticMarkup(React.createElement(Markdown,{source:'# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```bash\necho test\n```\n\n[guide](docs/mihomo.md)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))'}));
  assert.match(html,/<h1>Title<\/h1>/);assert.match(html,/<table>/);assert.match(html,/language-bash/);
  assert.match(html,/github.com\/Chen017\/Xray-Panel\/blob\/codex\/initial-panel\/docs\/mihomo.md/);
  assert.doesNotMatch(html,/<script>|javascript:/);
});
