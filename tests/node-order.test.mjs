import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as age from 'age-encryption';
import YAML from 'yaml';
import {fixtureBundle,testSystem} from './helpers.mjs';
import {compileDevices,deviceProviderNameEntries,hashBundle} from '../shared/config.mjs';
import {Store} from '../server/store.mjs';

async function fixture(){
  const s=await testSystem();await s.login();const nodes=[],devices=[];
  for(let i=0;i<3;i++)nodes.push((await s.call('/nodes','POST',{name:'节点 '+i,ipv4:`203.0.113.${i+1}`})).body.node);
  for(let i=0;i<2;i++){
    const identity=await age.generateIdentity(),granted=i?nodes.slice(0,2):nodes;
    const result=(await s.call('/devices','POST',{name:'设备 '+i,publicKey:await age.identityToRecipient(identity),grants:[...granted].reverse().map(n=>({nodeId:n.id,routes:['direct'],modes:['single4','vision4']}))})).body;
    devices.push({...result,identity});
  }
  for(const node of nodes){const n=s.store.get('node',node.id);n.applied=compileDevices(fixtureBundle(),n,s.store.list('device'),s.config.masterKey);n.draft=n.applied;n.needsSync=false;s.store.put('node',n.id,n);}
  const snapshot=async()=>(await s.call('/node-order')).body;
  const save=async(order,revision)=>s.call('/node-order','PUT',{revision:revision??(await snapshot()).revision,order});
  const subscription=async(i)=>{const d=devices[i],r=await fetch(d.url,{headers:{Authorization:'Bearer '+d.token}});assert.equal(r.status,200);const dec=new age.Decrypter();dec.addIdentity(d.identity);return YAML.parse(await dec.decrypt(age.armor.decode(await r.text()),'text')).proxies;};
  return {s,nodes,devices,snapshot,save,subscription};
}

test('one node order governs the node table, two encrypted subscriptions, previews and VLESS links',async()=>{
  const f=await fixture();try{
    const beforeNodes=f.s.store.list('node'),beforeDevices=f.s.store.list('device'),beforeJobs=f.s.store.list('job');
    // Old per-device ordering is retained as historical data but never applied.
    for(const d of beforeDevices){d.subscriptionOrder=deviceProviderNameEntries(beforeNodes,d,f.s.config.masterKey).map(e=>e.key).reverse();f.s.store.put('device',d.id,d);}
    const order=(await f.snapshot()).order.reverse();assert.equal((await f.save(order)).status,200);
    assert.deepEqual((await f.s.call('/nodes')).body.map(n=>n.id),order);
    for(let i=0;i<2;i++){
      const d=f.devices[i],allowed=new Set(d.device.grants.map(g=>g.nodeId)),expected=order.filter(id=>allowed.has(id)).flatMap(id=>['single4','vision4'].map(mode=>`${f.nodes.find(n=>n.id===id).name} · 直出 · ${mode}`));
      const proxies=await f.subscription(i);assert.deepEqual(proxies.map(p=>p.name),expected);
      assert.deepEqual(YAML.parse((await f.s.call(`/devices/${d.device.id}/preview`)).body).proxies,proxies);
      assert.deepEqual((await f.s.call(`/devices/${d.device.id}/links`)).body.split('\n').map(l=>decodeURIComponent(new URL(l).hash.slice(1))),expected);
      assert.equal((await f.s.call(`/devices/${d.device.id}/names`,'PUT',{revision:0,order:[]})).status,409);
    }
    assert.deepEqual(f.s.store.list('job'),beforeJobs);
    for(const n of beforeNodes){const current=f.s.store.get('node',n.id);assert.equal(hashBundle(current.applied),hashBundle(n.applied));assert.deepEqual(current,n);}
    for(const d of beforeDevices){const {lastAccess,...current}=f.s.store.get('device',d.id);assert.ok(lastAccess);assert.deepEqual(current,d);}
  }finally{await f.s.close();}
});

test('shared order persists encrypted, reopens and survives backup/restore',async()=>{
  const f=await fixture();try{
    const order=(await f.snapshot()).order.reverse();await f.save(order);
    const reopened=new Store(f.s.config.dbPath,f.s.config.masterKey);try{assert.deepEqual(reopened.get('system','node-order').order,order);}finally{reopened.close();}
    assert.ok(!readFileSync(f.s.config.dbPath).includes(Buffer.from(order[0])));
    const backup=(await f.s.call('/backup')).body;await f.save([]);assert.equal((await f.s.call('/restore','POST',backup)).status,200);await f.s.login();assert.deepEqual((await f.snapshot()).order,order);
    assert.deepEqual((await f.s.call('/nodes')).body.map(n=>n.id),order);
  }finally{await f.s.close();}
});

test('hidden and unpublished nodes retain their shared positions; new nodes append and deletion removes them',async()=>{
  const f=await fixture();try{
    const order=(await f.snapshot()).order.reverse();await f.save(order);const first=order[0],n=f.s.store.get('node',first);
    await f.s.call(`/nodes/${first}`,'PATCH',{enabled:false});assert.deepEqual((await f.snapshot()).order,order);
    assert.ok((await f.subscription(0)).every(p=>!p.name.startsWith(n.name)));
    await f.s.call(`/nodes/${first}`,'PATCH',{enabled:true});assert.ok((await f.subscription(0))[0].name.startsWith(n.name));
    const {applied,...unpublished}=f.s.store.get('node',first);f.s.store.put('node',first,unpublished);assert.ok((await f.subscription(0)).every(p=>!p.name.startsWith(n.name)));f.s.store.put('node',first,{...unpublished,applied});assert.ok((await f.subscription(0))[0].name.startsWith(n.name));
    const extra=(await f.s.call('/nodes','POST',{name:'新节点'})).body.node;assert.deepEqual((await f.snapshot()).order,[...order,extra.id]);
    await f.s.call(`/nodes/${extra.id}`,'DELETE');assert.deepEqual((await f.snapshot()).order,order);
    const identity=await age.generateIdentity(),created=(await f.s.call('/devices','POST',{name:'新设备',publicKey:await age.identityToRecipient(identity),grants:f.nodes.map(n=>({nodeId:n.id,routes:['direct'],modes:['vision4']}))})).body;
    for(const node of f.nodes){const current=f.s.store.get('node',node.id);current.applied=compileDevices(current.draft,current,f.s.store.list('device'),f.s.config.masterKey);f.s.store.put('node',node.id,current);}
    const preview=YAML.parse((await f.s.call(`/devices/${created.device.id}/preview`)).body).proxies;
    assert.deepEqual(preview.map(p=>p.name),order.map(id=>`${f.nodes.find(n=>n.id===id).name} · 直出 · vision4`));
  }finally{await f.s.close();}
});

test('invalid, duplicate, foreign, incomplete and stale edits cannot change the saved order',async()=>{
  const f=await fixture();try{
    const {order}=await f.snapshot();for(const invalid of [['invalid'],[order[0],order[0]],Array(10001).fill(order[0])])assert.equal((await f.save(invalid,0)).status,400);
    for(const invalid of [[randomUUID(),...order.slice(1)],order.slice(1)])assert.equal((await f.save(invalid,0)).status,409);
    assert.equal((await f.snapshot()).revision,0);
    assert.equal((await f.s.call('/node-order','PUT',{revision:0,order},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
    assert.equal((await f.save([...order].reverse(),0)).status,200);assert.equal((await f.save(order,0)).status,409);
    const extra=(await f.s.call('/nodes','POST',{name:'另一个页面添加'})).body.node;assert.equal((await f.save(order,1)).status,409);
    await f.s.call(`/nodes/${extra.id}`,'DELETE');await f.s.call(`/nodes/${order[0]}`,'DELETE');assert.equal((await f.save(order,1)).status,409);
    await f.s.call('/logout','POST',{});assert.equal((await f.s.call('/node-order')).status,401);assert.equal((await f.save([],1)).status,401);
  }finally{await f.s.close();}
});
