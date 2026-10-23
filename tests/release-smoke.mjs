import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes,createHash } from 'node:crypto';

const version=JSON.parse(readFileSync('package.json','utf8')).version;
const archive=`release/xray-panel-${version}.tar.gz`;
const digest=createHash('sha256').update(readFileSync(archive)).digest('hex');
assert.ok(readFileSync(archive+'.sha256','utf8').startsWith(digest),'Release checksum');
const listed=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});assert.equal(listed.status,0,listed.stderr);
const names=listed.stdout.trim().split(/\r?\n/).map(n=>n.replace(/^\.\//,''));
assert.ok(names.includes('.env.example')&&names.includes('dist/index.html'));
assert.ok(!names.some(n=>n.startsWith('/')||n.split('/').includes('..')||n==='.env'||/^(\.local|data|node_modules)\//.test(n)||n.includes('.sqlite')),'Release must exclude unsafe paths and runtime secrets');
mkdirSync('.local',{recursive:true});const directory=mkdtempSync(path.resolve('.local','release-smoke-'));
const extracted=spawnSync('tar',['-xzf',archive,'-C',directory],{encoding:'utf8'});assert.equal(extracted.status,0,extracted.stderr);
const {createSystem}=await import(pathToFileURL(path.join(directory,'server/app.mjs')));
const config={dbPath:path.join(directory,'smoke-data/panel.sqlite'),masterKey:randomBytes(32).toString('hex'),password:'Disposable-release-smoke-password!',secure:false,adminOrigin:'http://127.0.0.1',subscriptionOrigin:'http://127.0.0.1',agentOrigin:'http://127.0.0.1'};
const system=createSystem(config),servers=await Promise.all(['admin','subscription','agent'].map(role=>new Promise(resolve=>{const s=system[role].listen(0,'127.0.0.1',()=>resolve(s));})));
const origins=servers.map(s=>'http://127.0.0.1:'+s.address().port);config.adminOrigin=origins[0];
try{
 const response=await fetch(origins[0]+'/');assert.ok(response.ok,'Packaged homepage');const html=await response.text();assert.ok(html.includes('Xray Panel'));
 const resources=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m=>m[1]);assert.ok(resources.length>=2);for(const resource of resources)assert.ok((await fetch(origins[0]+resource)).ok,'Packaged asset '+resource);
 const login=await fetch(origins[0]+'/api/login',{method:'POST',headers:{Origin:origins[0],'Content-Type':'application/json'},body:JSON.stringify({password:config.password})});assert.ok(login.ok,'Packaged login');const cookie=login.headers.get('set-cookie').split(';')[0];
 const docs=await fetch(origins[0]+'/api/docs',{headers:{Cookie:cookie}});const guide=await docs.json();assert.ok(docs.ok&&guide.cloudflare.includes('Service Auth')&&guide.mihomo.includes('age-secret-key')&&guide.telegram.includes('国内'),'Packaged guides');
 for(const origin of origins.slice(0,2)){const source=await fetch(origin+'/source.tar.gz');assert.ok(source.ok,'Source download under a hidden parent directory');assert.ok(source.headers.get('content-disposition').includes('source'));assert.ok((await source.arrayBuffer()).byteLength>10000);}
 console.log('PASS release checksum, safe file list and absence of runtime credentials');
 console.log('PASS extracted runtime: homepage, JS/CSS assets, login, guides and source download on both entries');
 console.log('Fixture: '+directory);
}finally{await Promise.all(servers.map(s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);})));system.store.close();}
