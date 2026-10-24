import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as age from 'age-encryption';
import YAML from 'yaml';
import {fixtureBundle,settings,testSystem} from './helpers.mjs';
import {compileDevices,hashBundle,newBundle,patchRouting,providerNameEntries,providerProxies,providerLinks,subscriptionNameKey,deviceProviderNameEntries,deviceProviderProxies,deviceProviderLinks} from '../shared/config.mjs';
import {migrateSubscriptionNames} from '../server/subscription-names.mjs';
import {Store} from '../server/store.mjs';

async function fixture(){
 const s=await testSystem();await s.login();
 const c=(await s.call('/nodes','POST',{name:'原有线路',ipv4:'203.0.113.1',ipv6:'2001:db8::1'})).body;
 let bundle=fixtureBundle();const headers={'Content-Type':'application/json','X-Node-ID':c.node.id,Authorization:'Bearer '+c.agentToken};
 const poll=async()=>{const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers,body:JSON.stringify({bundle,report:{}})});assert.equal(r.status,200);return r.json();};
 await poll();const devices=[];
 for(let i=0;i<2;i++){const identity=await age.generateIdentity();devices.push({...((await s.call('/devices','POST',{name:'设备 '+i,publicKey:await age.identityToRecipient(identity),grants:[{nodeId:c.node.id,routes:['direct'],modes:['split','single4','vision4']}]})).body),identity});}
 const {job}=await poll();assert.ok(job);bundle=job.payload.bundle;
 const done=await fetch(s.urls[2]+`/v1/agent/jobs/${job.id}/result`,{method:'POST',headers,body:JSON.stringify({ok:true,lease:job.lease,bundle})});assert.equal(done.status,200);
 const route=id=>`/devices/${id}/names`;
 const names=async(i=0)=>(await s.call(route(devices[i].device.id))).body;
 const save=async(body,i=0)=>s.call(route(devices[i].device.id),'PUT',body);
 const subscription=async(i=0)=>{const d=devices[i],r=await fetch(d.url,{headers:{Authorization:'Bearer '+d.token}});assert.equal(r.status,200);const dec=new age.Decrypter();dec.addIdentity(d.identity);return YAML.parse(await dec.decrypt(age.armor.decode(await r.text()),'text')).proxies;};
 return {s,nodeId:c.node.id,devices,route,names,save,subscription,nodeNames:async()=>(await s.call(`/nodes/${c.node.id}/subscription-names`)).body,rename:async body=>s.call(`/nodes/${c.node.id}/subscription-names`,'PUT',{subscriptionName:'',...body})};
}

test('node names distinguish files, routes and modes and are shared across identities',()=>{
 const master='a'.repeat(64),node={id:randomUUID(),name:'旧备注',subscriptionName:'统一基础名',ipv4:'203.0.113.1',ipv6:'2001:db8::1'},d={id:randomUUID(),epoch:'one',grants:[{nodeId:node.id,routes:['direct'],modes:['single4','vision4']}]},other={...d,id:randomUUID()};
 const base=fixtureBundle(),second=settings();second.port=8443;base.files['conf/VLESS-8443.json']=newBundle(second).files['conf/VLESS-8443.json'];
 const applied=compileDevices(base,node,[d,other],master),entries=providerNameEntries(node,applied,d,master);assert.equal(entries.length,4);assert.equal(new Set(entries.map(e=>e.name)).size,4);assert.ok(entries.every(e=>e.name.startsWith('统一基础名')));
 const e=entries.find(e=>e.file==='conf/VLESS-8443.json'&&e.mode==='vision4');node.subscriptionNames={[e.key]:'任意完整名称 🐟'};d.subscriptionNames={[e.key]:'旧设备覆盖'};
 for(const device of [d,other]){assert.equal(providerNameEntries(node,applied,device,master).find(x=>x.key===e.key).name,'任意完整名称 🐟');assert.ok(providerLinks(node,applied,device,master).some(l=>decodeURIComponent(new URL(l).hash.slice(1))==='任意完整名称 🐟'));}
 assert.equal(subscriptionNameKey(node.id,e.file,e.route,e.mode),e.key);const reduced=structuredClone(applied);delete reduced.files['conf/VLESS-443.json'];assert.equal(providerNameEntries(node,reduced,d,master).find(x=>x.key===e.key).name,'任意完整名称 🐟');
});

test('node rename updates two encrypted subscriptions, previews and VLESS while preserving credentials and deployment',async()=>{
 const f=await fixture();try{const catalog=await f.nodeNames(),e=catalog.entries.find(e=>e.mode==='single4'),original=f.s.store.get('node',f.nodeId),devices=f.s.store.list('device'),jobs=f.s.store.list('job').length,before=await f.subscription();
 const sort=await f.names();
 assert.equal((await f.rename({revision:0,subscriptionName:'统一东京',names:{[e.key]:'香港家宽 "🐟"'}})).status,200);
 for(let i=0;i<2;i++){const out=await f.subscription(i);assert.ok(out.some(p=>p.name==='香港家宽 "🐟"'));assert.ok(out.filter(p=>p.name!=='香港家宽 "🐟"').every(p=>p.name.startsWith('统一东京')));const id=f.devices[i].device.id;assert.deepEqual(YAML.parse((await f.s.call(`/devices/${id}/preview`)).body).proxies,out);assert.deepEqual((await f.s.call(`/devices/${id}/links`)).body.split('\n').map(l=>decodeURIComponent(new URL(l).hash.slice(1))),out.map(p=>p.name));}
 assert.deepEqual((await f.names()).entries.map(e=>e.key),sort.entries.map(e=>e.key));assert.deepEqual((await f.subscription()).map(p=>p.uuid).sort(),before.map(p=>p.uuid).sort());
 const n=f.s.store.get('node',f.nodeId);assert.equal(hashBundle(n.applied),hashBundle(original.applied));assert.equal(n.syncRevision,original.syncRevision);assert.equal(f.s.store.list('job').length,jobs);for(const d of devices){const saved=f.s.store.get('device',d.id);assert.equal(saved.tokenHash,d.tokenHash);assert.equal(saved.epoch,d.epoch);}
 const old=await f.save({revision:1,names:{[e.key]:'旧窗口尝试覆盖'}});assert.equal(old.status,409);assert.equal((await f.nodeNames()).entries.find(x=>x.key===e.key).name,'香港家宽 "🐟"');
 }finally{await f.s.close();}
});

test('clearing node aliases restores defaults globally, independent of node remarks',async()=>{
 const f=await fixture();try{const e=(await f.nodeNames()).entries[0];await f.rename({revision:0,subscriptionName:'基础',names:{[e.key]:'完整名称'}});await f.s.call(`/nodes/${f.nodeId}`,'PATCH',{name:'新的备注'});assert.equal((await f.nodeNames()).entries.find(x=>x.key===e.key).name,'完整名称');
 assert.equal((await f.rename({revision:1,subscriptionName:'',names:{[e.key]:''}})).status,200);assert.ok((await f.nodeNames()).entries.every(x=>x.name.startsWith('新的备注')));assert.deepEqual(f.s.store.get('node',f.nodeId).subscriptionNames,{});
 }finally{await f.s.close();}
});

test('node names reject invalid, duplicate, foreign and stale edits atomically with admin and CSRF checks',async()=>{
 const f=await fixture();try{const [a,b]=(await f.nodeNames()).entries;
 for(const value of ['DIRECT','Subscription Download','bad\nname','bad\u0000name','a'.repeat(121)])assert.equal((await f.rename({revision:0,names:{[a.key]:value}})).status,400,value);
 assert.equal((await f.rename({revision:0,names:{[a.key]:'重复',[b.key]:'重复'}})).status,400);assert.equal((await f.rename({revision:0,names:{[a.key]:b.defaultName}})).status,400);assert.equal((await f.rename({revision:0,names:{['f'.repeat(40)]:'外来'}})).status,409);
 const route=`/nodes/${f.nodeId}/subscription-names`;assert.equal((await f.s.call(route,'PUT',{revision:0,subscriptionName:'',names:{}},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
 assert.equal((await f.rename({revision:0,names:{[a.key]:'有效'}})).status,200);assert.equal((await f.rename({revision:0,names:{[a.key]:'过期'}})).status,409);assert.equal((await f.nodeNames()).entries.find(e=>e.key===a.key).name,'有效');
 await f.s.call('/logout','POST',{});assert.equal((await f.s.call(route)).status,401);assert.equal((await f.s.call(route,'PUT',{revision:1,subscriptionName:'',names:{}})).status,401);
 }finally{await f.s.close();}
});

test('node names persist encrypted and in backups; revoked devices stay unauthorized',async()=>{
 const f=await fixture();try{const e=(await f.nodeNames()).entries[0],custom='全局加密名称';await f.rename({revision:0,names:{[e.key]:custom}});assert.ok(!readFileSync(f.s.config.dbPath).includes(Buffer.from(custom)));
 const reopened=new Store(f.s.config.dbPath,f.s.config.masterKey);try{assert.equal(reopened.get('node',f.nodeId).subscriptionNames[e.key],custom);}finally{reopened.close();}
 const backup=(await f.s.call('/backup')).body;await f.s.call('/restore','POST',backup);await f.s.login();assert.equal((await f.nodeNames()).entries[0].name,custom);
 await f.s.call(`/devices/${f.devices[0].device.id}/revoke`,'POST',{});assert.equal((await f.names()).entries.length,0);assert.equal((await fetch(f.devices[0].url,{headers:{Authorization:'Bearer '+f.devices[0].token}})).status,401);assert.ok((await f.subscription(1)).length);
 }finally{await f.s.close();}
});

test('legacy per-device names migrate once, conflicts are recorded, old overrides cannot hide later node edits',async()=>{
 const f=await fixture();try{const e=(await f.nodeNames()).entries.find(e=>e.mode==='single4');for(let i=0;i<2;i++){const d=f.s.store.get('device',f.devices[i].device.id);d.createdAt=`2026-01-0${i+1}`;d.subscriptionNames={[e.key]:i?'旧手机名':'旧笔记本名'};f.s.store.put('device',d.id,d);}
 const legacyNode=f.s.store.get('node',f.nodeId);delete legacyNode.subscriptionNamingVersion;f.s.store.put('node',f.nodeId,legacyNode);const backup=(await f.s.call('/backup')).body;assert.equal((await f.s.call('/restore','POST',backup)).status,200);await f.s.login();const names=await f.nodeNames();assert.equal(names.entries.find(x=>x.key===e.key).name,'旧笔记本名');assert.equal(names.conflicts.length,1);
 for(let i=0;i<2;i++)assert.ok((await f.subscription(i)).some(p=>p.name==='旧笔记本名'));
 await f.rename({revision:0,names:{[e.key]:'统一新名'}});f.s.store.tx(()=>migrateSubscriptionNames(f.s.store,f.s.config.masterKey));assert.equal((await f.nodeNames()).entries.find(x=>x.key===e.key).name,'统一新名');assert.equal(f.s.store.get('device',f.devices[1].device.id).subscriptionNames[e.key],'旧手机名');await f.rename({revision:1,subscriptionName:'新基础名',names:{[e.key]:'统一新名'}});for(let i=0;i<2;i++)assert.ok((await f.subscription(i)).every(p=>p.name.startsWith('新基础名')));
 }finally{await f.s.close();}
});

test('shared names cannot collide with another node visible to a device',async()=>{
 const f=await fixture();try{const second=(await f.s.call('/nodes','POST',{name:'第二节点',ipv4:'203.0.113.2'})).body.node,devices=f.s.store.list('device');for(const d of devices){d.grants.push({nodeId:second.id,routes:['direct'],modes:['vision4']});f.s.store.put('device',d.id,d);}second.applied=compileDevices(fixtureBundle(),second,devices,f.s.config.masterKey);f.s.store.put('node',second.id,second);
 const target=(await f.nodeNames()).entries.find(e=>e.mode==='vision4'),other=(await f.s.call(`/nodes/${second.id}/subscription-names`)).body.entries.find(e=>e.mode==='vision4');assert.equal((await f.rename({revision:0,names:{[target.key]:other.name}})).status,400);assert.equal((await f.nodeNames()).revision,0);
 second.subscriptionNames={[other.key]:target.name};f.s.store.put('node',second.id,second);const identity=await age.generateIdentity(),input={name:'新设备',publicKey:await age.identityToRecipient(identity),grants:[f.nodeId,second.id].map(nodeId=>({nodeId,routes:['direct'],modes:['vision4']}))};assert.equal((await f.s.call('/devices','POST',input)).status,400,'new grant validates names before its UUID exists on VPS');
 }finally{await f.s.close();}
});

test('combining distinct old device aliases disambiguates collisions and preserves hidden mode aliases',async()=>{
 const f=await fixture();try{const entries=(await f.nodeNames()).entries,a=entries.find(e=>e.mode==='single4'),b=entries.find(e=>e.mode==='vision4');for(let i=0;i<2;i++){const d=f.s.store.get('device',f.devices[i].device.id);d.subscriptionNames={[i?b.key:a.key]:'旧名相同'};f.s.store.put('device',d.id,d);}
 const node=f.s.store.get('node',f.nodeId);delete node.subscriptionNamingVersion;node.ipv4='';f.s.store.put('node',node.id,node);f.s.store.tx(()=>migrateSubscriptionNames(f.s.store,f.s.config.masterKey));const current=await f.nodeNames();assert.equal(new Set(current.entries.map(e=>e.name)).size,current.entries.length);assert.ok(current.conflicts.length);assert.equal(f.s.store.get('node',node.id).subscriptionNames[a.key],'旧名相同');
 const saved=f.s.store.get('node',node.id);f.s.store.tx(()=>migrateSubscriptionNames(f.s.store,f.s.config.masterKey));assert.deepEqual(f.s.store.get('node',node.id),saved);await f.s.call(`/nodes/${node.id}`,'PATCH',{ipv4:'203.0.113.1'});const out=await f.subscription();assert.equal(new Set(out.map(p=>p.name)).size,out.length);
 }finally{await f.s.close();}
});
