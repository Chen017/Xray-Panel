import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as age from 'age-encryption';
import YAML from 'yaml';
import {fixtureBundle,settings,testSystem} from './helpers.mjs';
import {compileDevices,hashBundle,newBundle,patchRouting,providerNameEntries,providerProxies,providerLinks,subscriptionNameKey,deviceProviderNameEntries,deviceProviderProxies,deviceProviderLinks} from '../shared/config.mjs';
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
 return {s,nodeId:c.node.id,devices,route,names,save,subscription};
}

test('legacy defaults and stable naming identities distinguish files, routes, modes and devices',()=>{
 const node={id:randomUUID(),name:'线路',ipv4:'203.0.113.1',ipv6:'2001:db8::1'},master='a'.repeat(64);
 const d={id:randomUUID(),epoch:randomUUID(),grants:[{nodeId:node.id,routes:['direct','1'],modes:['single4','vision4']}]},other={...d,id:randomUUID()};
 let base=patchRouting(fixtureBundle(),{relay:{role:'line',landings:[{id:'1',name:'落地',landing_ip:'198.51.100.1',landing_port:24443,transport_uuid:randomUUID(),client_uuid:randomUUID(),encryption:'mlkem768x25519plus.fixture'}],failover:{enabled:false,interval:'60s',order:[]}}});
 const second=settings();second.port=8443;base.files['conf/VLESS-8443.json']=newBundle(second).files['conf/VLESS-8443.json'];
 const applied=compileDevices(base,node,[d,other],master),entries=providerNameEntries(node,applied,d,master);assert.equal(entries.length,8);assert.equal(new Set(entries.map(e=>e.key)).size,8);
 const selected=entries.find(e=>e.file==='conf/VLESS-8443.json'&&e.route==='1'&&e.mode==='vision4');d.subscriptionNames={[selected.key]:'香港家宽 "专用" 🐟'};
 const proxies=providerProxies(node,applied,d,master);assert.equal(proxies.filter(p=>p.name==='香港家宽 "专用" 🐟').length,1);assert.ok(providerProxies(node,applied,other,master).every(p=>p.name!=='香港家宽 "专用" 🐟'));
 assert.equal(decodeURIComponent(new URL(providerLinks(node,applied,d,master).find(url=>decodeURIComponent(new URL(url).hash).includes('香港家宽'))).hash.slice(1)),'香港家宽 "专用" 🐟');
 assert.equal(providerNameEntries({...node,name:'服务器新备注'},applied,d,master).find(e=>e.key===selected.key).name,'香港家宽 "专用" 🐟');
 assert.equal(subscriptionNameKey(node.id,selected.file,selected.route,selected.mode),selected.key);
 const single={files:{...applied.files}};delete single.files['conf/VLESS-443.json'];assert.equal(providerNameEntries(node,single,d,master).find(e=>e.key===selected.key).name,'香港家宽 "专用" 🐟');
});

test('rename updates encrypted provider, preview and VLESS without UUID rotation or deployment',async()=>{
 const f=await fixture();try{
 const before=await f.subscription(),names=await f.names(),entry=names.entries.find(e=>e.mode==='single4');
 const original=f.s.store.get('node',f.nodeId),device=f.s.store.get('device',f.devices[0].device.id),jobs=f.s.store.list('job').length;
 const saved=await f.save({revision:names.revision,names:{[entry.key]:'  香港家宽 "🐟"  '}});assert.equal(saved.status,200);
 const after=await f.subscription();assert.equal(after.find(p=>p.name==='香港家宽 "🐟"').uuid,before.find(p=>p.network==='xhttp'&&!p['xhttp-opts']['download-settings']).uuid);
 assert.deepEqual(after.map(({name,...p})=>p),before.map(({name,...p})=>p));
 const preview=YAML.parse((await f.s.call(`/devices/${device.id}/preview`)).body);assert.ok(preview.proxies.some(p=>p.name==='香港家宽 "🐟"'));
 const links=(await f.s.call(`/devices/${device.id}/links`)).body;assert.ok(links.split('\n').some(value=>decodeURIComponent(new URL(value).hash.slice(1))==='香港家宽 "🐟"'));
 const current=f.s.store.get('node',f.nodeId),updated=f.s.store.get('device',device.id);assert.equal(hashBundle(current.applied),hashBundle(original.applied));assert.equal(current.needsSync,false);assert.equal(current.syncRevision,original.syncRevision);assert.equal(f.s.store.list('job').length,jobs);assert.equal(updated.epoch,device.epoch);assert.equal(updated.tokenHash,device.tokenHash);
 assert.ok((await f.subscription(1)).every(p=>p.name!=='香港家宽 "🐟"'));
 }finally{await f.s.close();}
});

test('clearing names restores defaults and metadata rename leaves explicit names stable',async()=>{
 const f=await fixture();try{
 let names=await f.names();const e=names.entries[0];assert.equal((await f.save({revision:0,names:{[e.key]:'独立名称'}})).status,200);
 await f.s.call(`/nodes/${f.nodeId}`,'PATCH',{name:'新的服务器备注'});names=await f.names();assert.equal(names.entries.find(x=>x.key===e.key).name,'独立名称');
 const restored=await f.save({revision:names.revision,names:{[e.key]:''}});assert.equal(restored.status,200);assert.match(restored.body.entries.find(x=>x.key===e.key).name,/新的服务器备注/);
 assert.deepEqual(f.s.store.get('device',f.devices[0].device.id).subscriptionNames,{});
 }finally{await f.s.close();}
});

test('names reject duplicates, reserved identifiers, controls and oversized values atomically',async()=>{
 const f=await fixture();try{
 const names=await f.names(),[a,b]=names.entries;
 for(const value of ['DIRECT','GLOBAL','bad\nname','bad\u0000name','a'.repeat(121)])assert.equal((await f.save({revision:0,names:{[a.key]:value}})).status,400,value);
 assert.equal((await f.save({revision:0,names:{[a.key]:'重复',[b.key]:'重复'}})).status,400);
 assert.equal((await f.save({revision:0,names:{[a.key]:b.defaultName}})).status,400);
 assert.equal((await f.names()).revision,0);assert.ok((await f.subscription()).every(p=>p.name!== '重复'));
 }finally{await f.s.close();}
});

test('names require admin and CSRF; stale editors and obsolete targets cannot overwrite saved names',async()=>{
 const f=await fixture();try{
 const route=f.route(f.devices[0].device.id),names=await f.names(),e=names.entries[0];
 assert.equal((await f.s.call(route,'PUT',{revision:0,names:{[e.key]:'x'}},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
 assert.equal((await f.save({revision:0,names:{['f'.repeat(40)]:'unknown'}})).status,409);
 assert.equal((await f.save({revision:0,names:{[e.key]:'已保存'}})).status,200);
 assert.equal((await f.save({revision:0,names:{[e.key]:'旧窗口覆盖'}})).status,409);
 await f.s.call(`/nodes/${f.nodeId}`,'PATCH',{enabled:false});assert.equal((await f.save({revision:1,names:{[e.key]:'disabled'}})).status,409);
 await f.s.call('/logout','POST',{});assert.equal((await f.s.call(route)).status,401);assert.equal((await f.s.call(route,'PUT',{revision:1,names:{}})).status,401);
 }finally{await f.s.close();}
});

test('names persist in encrypted records and backup restore; revoked devices cannot rename or export',async()=>{
 const f=await fixture();try{
 const names=await f.names(),e=names.entries[0],custom='只应加密保存的独立名称';await f.save({revision:0,names:{[e.key]:custom}});
 assert.ok(!readFileSync(f.s.config.dbPath).includes(Buffer.from(custom)));
 const reopened=new Store(f.s.config.dbPath,f.s.config.masterKey);try{assert.equal(reopened.get('device',f.devices[0].device.id).subscriptionNames[e.key],custom);}finally{reopened.close();}
 const backup=(await f.s.call('/backup')).body;assert.equal((await f.s.call('/restore','POST',backup)).status,200);await f.s.login();assert.equal((await f.names()).entries[0].name,custom);
 await f.s.call(`/devices/${f.devices[0].device.id}/revoke`,'POST',{});assert.equal((await f.names()).entries.length,0);assert.equal((await f.save({revision:1,names:{[e.key]:'revoked'}})).status,409);
 assert.equal((await fetch(f.devices[0].url,{headers:{Authorization:'Bearer '+f.devices[0].token}})).status,401);
 }finally{await f.s.close();}
});

test('device ordering spans nodes, files, routes and modes with one shared export order',()=>{
 const master='b'.repeat(64),first={id:randomUUID(),name:'线路一',enabled:true,ipv4:'203.0.113.1'},second={id:randomUUID(),name:'线路二',enabled:true,ipv4:'203.0.113.2'};
 const device={id:randomUUID(),epoch:randomUUID(),grants:[first,second].map(n=>({nodeId:n.id,routes:['direct'],modes:['single4','vision4']}))};
 const base=fixtureBundle(),extra=settings();extra.port=8443;base.files['conf/VLESS-8443.json']=newBundle(extra).files['conf/VLESS-8443.json'];
 const nodes=[{...first,applied:compileDevices(base,first,[device],master)},{...second,applied:compileDevices(fixtureBundle(),second,[device],master)}];
 const original=deviceProviderNameEntries(nodes,device,master);assert.equal(original.length,6);assert.deepEqual(original.map(e=>e.defaultIndex),[0,1,2,3,4,5]);
 device.subscriptionOrder=[original[5].key,original[2].key,original[4].key,original[0].key,original[3].key,original[1].key];device.subscriptionNames={[original[2].key]:'跨文件自定义'};
 const ordered=deviceProviderNameEntries(nodes,device,master);assert.deepEqual(ordered.map(e=>e.key),device.subscriptionOrder);
 assert.deepEqual(deviceProviderProxies(nodes,device,master).map(p=>p.name),ordered.map(e=>e.name));assert.deepEqual(deviceProviderLinks(nodes,device,master).map(link=>decodeURIComponent(new URL(link).hash.slice(1))),ordered.map(e=>e.name));
 assert.deepEqual(deviceProviderNameEntries([nodes[1],nodes[0]],device,master).map(e=>e.key),device.subscriptionOrder,'custom order survives source node order changes');
 assert.deepEqual(deviceProviderNameEntries([{...nodes[0],enabled:false},nodes[1]],device,master).map(e=>e.key),[original[5].key,original[4].key]);
 assert.deepEqual(deviceProviderProxies(nodes,{...device,revoked:true},master),[]);
});

test('sorting and renaming update provider, preview and links atomically without touching deployment or another device',async()=>{
 const f=await fixture();try{
 const names=await f.names(),before=await f.subscription(),other=await f.subscription(1),order=names.entries.map(e=>e.key).reverse(),key=order[0],original=f.s.store.get('node',f.nodeId),device=f.s.store.get('device',f.devices[0].device.id),jobs=f.s.store.list('job').length;
 const saved=await f.save({revision:0,names:{[key]:'排在最前'},order});assert.equal(saved.status,200);assert.deepEqual(saved.body.entries.map(e=>e.key),order);
 const after=await f.subscription();assert.deepEqual(after,[...before].reverse().map((p,i)=>({...p,name:i===0?'排在最前':p.name})));
 assert.deepEqual(YAML.parse((await f.s.call(`/devices/${device.id}/preview`)).body).proxies,after);assert.deepEqual((await f.s.call(`/devices/${device.id}/links`)).body.split('\n').map(link=>decodeURIComponent(new URL(link).hash.slice(1))),after.map(p=>p.name));
 assert.deepEqual(await f.subscription(1),other);assert.equal(f.s.store.list('job').length,jobs);assert.deepEqual(f.s.store.get('node',f.nodeId),original);assert.equal(f.s.store.get('device',device.id).epoch,device.epoch);assert.equal(f.s.store.get('device',device.id).tokenHash,device.tokenHash);
 assert.equal((await f.save({revision:1,names:{[key]:'只改名称'}})).status,200);assert.deepEqual((await f.names()).order,order,'legacy name-only clients preserve ordering');
 const reset=await f.save({revision:2,names:{},order:[]});assert.equal(reset.status,200);assert.deepEqual(reset.body.order,[]);assert.deepEqual(reset.body.entries.map(e=>e.key),names.entries.map(e=>e.key));assert.equal(reset.body.entries.find(e=>e.key===key).name,'只改名称');
 }finally{await f.s.close();}
});

test('sorting rejects duplicates, invalid, foreign and stale targets without partial name writes',async()=>{
 const f=await fixture();try{
 const names=await f.names(),keys=names.entries.map(e=>e.key),first=keys[0];
 for(const order of [[first,first],['invalid'],Array(5001).fill(first)])assert.equal((await f.save({revision:0,names:{[first]:'不能部分写入'},order})).status,400);
 assert.equal((await f.save({revision:0,names:{[first]:'不能部分写入'},order:['e'.repeat(40)]})).status,409);
 assert.equal((await f.names()).revision,0);assert.deepEqual((await f.names()).order,[]);assert.equal((await f.names()).entries[0].customName,'');
 assert.equal((await f.s.call(f.route(f.devices[0].device.id),'PUT',{revision:0,names:{},order:[...keys].reverse()},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
 assert.equal((await f.save({revision:0,names:{},order:[...keys].reverse()})).status,200);assert.equal((await f.save({revision:0,names:{},order:[]})).status,409);
 await f.s.call(`/nodes/${f.nodeId}`,'PATCH',{enabled:false});assert.equal((await f.save({revision:1,names:{},order:keys})).status,409);
 await f.s.call(`/devices/${f.devices[0].device.id}/revoke`,'POST',{});assert.equal((await f.save({revision:1,names:{},order:[]})).status,409);
 }finally{await f.s.close();}
});

test('ordering preserves hidden slots, appends new entries, survives encrypted persistence and backup restore',async()=>{
 const f=await fixture();try{
 const initial=await f.names(),keys=initial.entries.map(e=>e.key),order=[...keys].reverse(),id=f.devices[0].device.id;
 await f.save({revision:0,names:{},order});const beforeHidden=f.s.store.get('device',id),g=beforeHidden.grants[0],hidden=initial.entries.find(e=>e.mode==='single4').key;
 await f.s.call(`/devices/${id}`,'PUT',{name:beforeHidden.name,publicKey:beforeHidden.publicKey,grants:[{...g,modes:['split','vision4']}]});
 assert.deepEqual((await f.names()).entries.map(e=>e.key),order.filter(key=>key!==hidden));const changed=order.filter(key=>key!==hidden).reverse();assert.equal((await f.save({revision:1,names:{},order:changed})).status,200);
 const expected=[changed[0],hidden,changed[1]],current=f.s.store.get('device',id);assert.deepEqual(current.subscriptionOrder,expected);
 await f.s.call(`/devices/${id}`,'PUT',{name:current.name,publicKey:current.publicKey,grants:[{...g,modes:['single6',...g.modes]}]});
 const visible=await f.names();assert.deepEqual(visible.entries.slice(0,3).map(e=>e.key),expected);assert.equal(visible.entries[3].mode,'single6');
 const reopened=new Store(f.s.config.dbPath,f.s.config.masterKey);try{assert.deepEqual(reopened.get('device',id).subscriptionOrder,expected);}finally{reopened.close();}
 assert.ok(!readFileSync(f.s.config.dbPath).includes(Buffer.from(expected[0])),'ordering stays inside encrypted records');const backup=(await f.s.call('/backup')).body;await f.s.call('/restore','POST',backup);await f.s.login();assert.deepEqual((await f.names()).entries.map(e=>e.key),visible.entries.map(e=>e.key));
 await f.s.call(`/nodes/${f.nodeId}`,'PATCH',{ipv4:'203.0.113.7'});assert.deepEqual((await f.names()).entries.map(e=>e.key),visible.entries.map(e=>e.key));
 }finally{await f.s.close();}
});
