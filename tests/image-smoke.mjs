import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const image=process.argv[2]??'xray-panel:smoke';
const password='Disposable-image-smoke-password!';
function docker(...args){
  const result=spawnSync('docker',args,{encoding:'utf8'});
  if(result.status!==0)throw Error(`docker ${args[0]} failed: ${result.stderr||result.error}`);
  return result.stdout.trim();
}
const container=docker('run','-d','--read-only','--cap-drop=ALL',
  '--security-opt','no-new-privileges',
  '--tmpfs','/tmp:rw,size=32m,mode=1777',
  '--tmpfs','/app/data:rw,uid=1000,gid=1000,mode=0700',
  '-p','127.0.0.1::3000','-p','127.0.0.1::3001','-p','127.0.0.1::3002',
  '-e',`PANEL_MASTER_KEY=${randomBytes(32).toString('hex')}`,
  '-e',`PANEL_ADMIN_PASSWORD=${password}`,'-e','PANEL_SECURE_COOKIE=false',image);
try{
  const origins=[3000,3001,3002].map(port=>{
    const binding=docker('port',container,`${port}/tcp`);
    assert.match(binding,/^127\.0\.0\.1:\d+$/);
    return `http://${binding}`;
  });
  for(let attempt=0;;attempt++){
    try{
      const results=await Promise.all(origins.map((origin,i)=>fetch(origin+(i===0?'/api/health':'/health'))));
      if(results.every(response=>response.ok))break;
    }catch{}
    if(attempt>=29)throw Error(`Container did not become healthy:\n${docker('logs',container)}`);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const homepage=await fetch(origins[0]+'/');
  assert.ok(homepage.ok,'homepage');
  const html=await homepage.text();
  assert.ok(html.includes('Xray Panel'));
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]);
  assert.ok(assets.length>=2,'built JS and CSS');
  for(const asset of assets)assert.ok((await fetch(origins[0]+asset)).ok,asset);
  const login=await fetch(origins[0]+'/api/login',{method:'POST',headers:{Origin:'http://127.0.0.1:3000','Content-Type':'application/json'},body:JSON.stringify({password})});
  assert.ok(login.ok,`login: ${login.status} ${await login.text()}`);
  const cookie=login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie,'login cookie');
  const docs=await fetch(origins[0]+'/api/docs',{headers:{Cookie:cookie}});
  const guide=await docs.json();
  assert.ok(docs.ok&&guide.nodes.includes('所有节点')&&guide.cloudflare.includes('Service Auth')&&guide.mihomo.includes('hidden: true')&&guide.telegram.includes('国内'),'guides');
  for(const origin of origins.slice(0,2)){
    const source=await fetch(origin+'/source.tar.gz');
    assert.ok(source.ok&&source.headers.get('content-disposition')?.includes('source'),'source download');
    assert.ok((await source.arrayBuffer()).byteLength>10000);
  }
  console.log('PASS container health, homepage, assets, login, guides and source download');
}finally{
  docker('rm','-f',container);
}
