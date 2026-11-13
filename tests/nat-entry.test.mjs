import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixtureBundle,testSystem} from './helpers.mjs';
import {resolveLinkedAddresses} from '../shared/addresses.mjs';
import * as age from 'age-encryption';
import {compileDevices,deviceProviderProxies,providerProxies,patchRouting,readSettings,patchSettings,deviceUuid,relaySchema,natEntryClients,providerNameEntries,subscriptionNameKey} from '../shared/config.mjs';

const master='nat-entry-test-master';
function topology(){
  const relay={role:'landing',transport_uuid:randomUUID(),decryption:'mlkem768x25519plus.native.0rtt.test',encryption:'mlkem768x25519plus.native.0rtt.test',listen_port:24443,external_port:34443,landing_ip:'8.8.8.8',peer_ip:'',entry_listen_port:25555,entry_external_port:35555,entry_uuid:randomUUID(),entry_decryption:'mlkem768x25519plus.random.600s.test',entry_encryption:'mlkem768x25519plus.random.0rtt.test'};
  const target={id:randomUUID(),enabled:true,name:'NAT',ipv4:'8.8.8.8',applied:patchRouting(fixtureBundle(),{relay})};delete target.applied.files['conf/VLESS-443.json'];target.observed=target.applied;
  const landing={id:'1',name:'NAT',nodeId:target.id,landing_ip:'8.8.8.8',landing_port:34443,transport_uuid:relay.transport_uuid,client_uuid:randomUUID(),encryption:relay.encryption,entry_port:35555,entry_uuid:relay.entry_uuid,entry_encryption:relay.entry_encryption};
  const source={id:randomUUID(),enabled:true,name:'Line',ipv4:'9.9.9.9',ipv6:'2001:db8::1',applied:patchRouting(fixtureBundle(),{relay:{role:'line',landings:[landing],failover:{enabled:false,interval:'60s',order:[]}}})};source.observed=source.applied;
  const device={id:randomUUID(),epoch:randomUUID(),grants:[{nodeId:source.id,routes:['1'],modes:['split','single4','vision4']}]};
  source.applied=compileDevices(source.applied,source,[device],master);source.observed=source.applied;
  return {source,target,device,relay,landing,nodes:[source,target]};
}
test('disabled UI entry fields normalize while enabled entries require independent credentials and ports',()=>{
  const {relay}=topology();
  const off=relaySchema.parse({...relay,entry_listen_port:0,entry_external_port:0,entry_uuid:'',entry_decryption:'',entry_encryption:''});
  assert.equal(off.entry_uuid,undefined);assert.equal(off.entry_external_port,undefined);
  assert.equal(relaySchema.parse({...relay,entry_listen_port:0,entry_uuid:'unfinished-invalid-key',entry_encryption:'draft'}).entry_uuid,undefined);
  for(const patch of [{entry_uuid:''},{entry_encryption:''},{entry_listen_port:relay.listen_port},{entry_external_port:relay.external_port}])assert.throws(()=>relaySchema.parse({...relay,...patch}));
});
test('compile migrates every old public-entry flow and preserves the inter-server Vision flow',()=>{
  const {target}=topology(),old=target.applied.files['conf/99_relay_in.json'].inbounds;
  old[1].settings.clients.push({id:randomUUID(),email:'old-extra',flow:'xtls-rprx-vision'});old[1].settings.clients[0].flow='xtls-rprx-vision';
  const migrated=compileDevices(target.applied,target,[],master).files['conf/99_relay_in.json'].inbounds;
  assert.equal(migrated[0].settings.clients[0].flow,'xtls-rprx-vision');assert.ok(migrated[1].settings.clients.every(c=>!c.flow));
});
test('both split directions use NAT only for IPv4, and TFO is disabled on the encrypted entry',()=>{
  const {source,device}=topology();
  for(const reverse of [false,true]){
    const s=readSettings(source.applied),base=patchSettings(source.applied,{...s,v6Uplink:reverse}),compiled=compileDevices(base,source,[device],master);
    const out=providerProxies(source,compiled,device,master),split=out.find(p=>p.name.endsWith('split')),guard=out.find(p=>p.name.endsWith('NAT-v4-Entry'));
    assert.equal(guard.tfo,false);
    if(reverse){assert.equal(split['dialer-proxy'],undefined);assert.equal(split['xhttp-opts']['download-settings']['dialer-proxy'],guard.name);}
    else{assert.equal(split['dialer-proxy'],guard.name);assert.equal(split['xhttp-opts']['download-settings']['dialer-proxy'],'');}
  }
});
test('managed entry identities are device-specific, published after both deployments, and removed on revoke',()=>{
  const f=topology();assert.deepEqual(deviceProviderProxies(f.nodes,f.device,master),[]);
  f.target.applied=compileDevices(f.target.applied,f.target,[f.device],master,f.nodes);f.target.observed=f.target.applied;
  const proxies=deviceProviderProxies(f.nodes,f.device,master),guard=proxies.find(p=>p.name.endsWith('NAT-v4-Entry'));
  assert.equal(guard.uuid,deviceUuid(master,f.device,f.source.id,'1'));assert.notEqual(guard.uuid,f.relay.entry_uuid);
  const second={...f.device,id:randomUUID()};assert.notEqual(natEntryClients(f.target.id,f.nodes,[second],master)[0].id,guard.uuid);
  const revoked={...f.device,revoked:true};f.target.applied=compileDevices(f.target.applied,f.target,[revoked],master,f.nodes);
  assert.ok(f.target.applied.files['conf/99_relay_in.json'].inbounds[1].settings.clients.every(c=>c.id!==guard.uuid));
  assert.deepEqual(deviceProviderProxies(f.nodes,revoked,master),[]);
});

test('direct NAT subscriptions never publish the shared script credential before device deployment',()=>{
  const {target,device}=topology();device.grants=[{nodeId:target.id,routes:['direct'],modes:['vision4']}];
  assert.deepEqual(deviceProviderProxies([target],device,master),[]);
  target.applied=compileDevices(target.applied,target,[device],master);
  assert.equal(deviceProviderProxies([target],device,master)[0].uuid,deviceUuid(master,device,target.id,'direct'));
  assert.deepEqual(deviceProviderProxies([target],{...device,epoch:randomUUID()},master),[]);
});

test('Agent lifecycle gates independent NAT grants and deletes revoked clients after a late deployment',async()=>{
  const s=await testSystem();try{
    await s.login();
    const create=async name=>(await s.call('/nodes','POST',{name,ipv4:'8.8.8.8',ipv6:'2606:4700::1111'})).body;
    const target=await create('NAT'),source=await create('Line'),f=topology();
    const natOnly=patchRouting(f.target.applied,{relay:{...f.relay,relay_enabled:false}});
    const line=patchRouting(f.source.applied,{relay:{role:'none',nat_entries:{direct:{nodeId:target.node.id}}}});
    const bundles=new Map([[target.node.id,natOnly],[source.node.id,line]]);
    const headers=n=>({'Content-Type':'application/json','X-Node-ID':n.node.id,Authorization:'Bearer '+n.agentToken});
    const poll=async n=>{
      const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers:headers(n),body:JSON.stringify({bundle:bundles.get(n.node.id),report:{}})});
      assert.equal(r.status,200);return (await r.json()).job;
    };
    const finish=async(n,j)=>{
      assert.equal(j.action,'deploy');bundles.set(n.node.id,j.payload.bundle);
      const r=await fetch(s.urls[2]+`/v1/agent/jobs/${j.id}/result`,{method:'POST',headers:headers(n),body:JSON.stringify({ok:true,lease:j.lease,bundle:j.payload.bundle})});assert.equal(r.status,200);
    };
    for(const n of [target,source]){const j=await poll(n);if(j)await finish(n,j);}
    const identity=await age.generateIdentity(),d=(await s.call('/devices','POST',{name:'Laptop',publicKey:await age.identityToRecipient(identity),grants:[{nodeId:source.node.id,routes:['direct'],modes:['split']}]})).body;
    const sub=()=>fetch(d.url,{headers:{Authorization:'Bearer '+d.token}});
    const sourceJob=await poll(source);assert.ok(sourceJob);await finish(source,sourceJob);
    assert.equal((await sub()).status,503,'line-only deployment cannot publish an unusable NAT chain');
    const targetJob=await poll(target);assert.ok(targetJob);await finish(target,targetJob);
    assert.equal((await sub()).status,200);
    const clients=()=>bundles.get(target.node.id).files['conf/99_relay_in.json'].inbounds.find(i=>i.tag==='relay-entry-v4').settings.clients;
    assert.equal(clients().filter(c=>c.email?.startsWith('panel-relay-')).length,1);
    assert.equal((await s.call(`/devices/${d.device.id}`,'DELETE')).status,409);
    const rotate=await s.call(`/devices/${d.device.id}/rotate`,'POST',{rotateUuid:true});
    assert.equal(rotate.status,200);
    const lateSource=await poll(source),lateTarget=await poll(target);
    assert.ok(lateSource);assert.ok(lateTarget);
    await s.call(`/devices/${d.device.id}/revoke`,'POST',{});
    assert.equal((await s.call(`/devices/${d.device.id}`,'DELETE')).status,200);
    assert.equal((await s.call('/devices')).body.length,0);
    await finish(source,lateSource);await finish(target,lateTarget);
    const cleanSource=await poll(source),cleanTarget=await poll(target);
    assert.ok(cleanSource);assert.ok(cleanTarget);
    await finish(source,cleanSource);await finish(target,cleanTarget);
    assert.ok(!JSON.stringify(bundles.get(source.node.id)).includes(d.device.id));
    assert.ok(!clients().some(c=>c.email?.startsWith('panel-relay-')));
    assert.equal((await sub()).status,401);
    assert.equal(await poll(target),null,'unchanged heartbeat must not queue another deployment');
  }finally{await s.close();}
});

test('NAT alias updates both split directions and can be cleared',()=>{
 const {source,device}=topology();const entry=providerNameEntries(source,source.applied,device,master).find(e=>e.mode==='nat4-entry');source.subscriptionNames={[entry.key]:'🇭🇰 HKT'};
 for(const reverse of [false,true]){const b=patchSettings(source.applied,{...readSettings(source.applied),v6Uplink:reverse}),proxies=providerProxies(source,b,device,master),split=proxies.find(p=>p.network==='xhttp'&&p['xhttp-opts']['download-settings']);assert.ok(proxies.some(p=>p.name==='🇭🇰 HKT'));assert.equal(reverse?split['xhttp-opts']['download-settings']['dialer-proxy']:split['dialer-proxy'],'🇭🇰 HKT');}
 source.subscriptionNames={};assert.ok(providerProxies(source,source.applied,device,master).some(p=>p.name===entry.defaultName));
});
test('NAT routing switch preserves inter-server relay and can be re-enabled',()=>{
 const {source,device,target,nodes}=topology();const original=structuredClone(source.applied),off=structuredClone(original);off.files['relay.json'].landings[0].entry_enabled=false;source.observed=off;source.applied=off;
 const proxies=providerProxies(source,off,device,master),split=proxies.find(p=>p.name.endsWith('split'));assert.equal(split['dialer-proxy'],undefined);assert.ok(!proxies.some(p=>p.name.endsWith('NAT-v4-Entry')));assert.deepEqual(off.files['config.json'].outbounds,original.files['config.json'].outbounds);assert.deepEqual(natEntryClients(target.id,nodes,[device],master),[]);
 off.files['relay.json'].landings[0].entry_enabled=true;assert.ok(providerProxies(source,off,device,master).some(p=>p.name.endsWith('NAT-v4-Entry')));assert.equal(natEntryClients(target.id,nodes,[device],master).length,1);
});

test('admin can save a NAT guard alias and all provider references follow it',async()=>{
 const s=await testSystem();try{await s.login();const f=topology();s.store.put('node',f.source.id,f.source);s.store.put('node',f.target.id,f.target);
 const url=`/nodes/${f.source.id}/subscription-names`,catalog=(await s.call(url)).body,guard=catalog.entries.find(e=>e.mode==='nat4-entry');assert.ok(guard);
 const saved=await s.call(url,'PUT',{revision:catalog.revision,subscriptionName:'',names:{[guard.key]:'🇭🇰 HKT'}});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.entries.find(e=>e.key===guard.key).name,'🇭🇰 HKT');
 }finally{await s.close();}
});

test('NAT transport exception is limited to granted users, line IPs, inbound and ports after private refusal',()=>{
 const f=topology(),bundle=compileDevices(f.target.applied,f.target,[f.device],master,f.nodes),rules=bundle.files['config.json'].routing.rules;
 assert.deepEqual(rules[0].ip,['geoip:private']);const rule=rules.find(r=>r.inboundTag?.includes('relay-entry-v4')&&r.ip);assert.ok(rule);assert.deepEqual(rule.ip,[f.source.ipv4,f.source.ipv6]);const sniRule=rules.find(r=>r.inboundTag?.includes('relay-entry-v4')&&r.domain);assert.deepEqual(sniRule.domain,[...new Set([readSettings(f.source.applied).sni4,readSettings(f.source.applied).sni6])].map(s=>'full:'+s));assert.deepEqual(sniRule.user,rule.user);assert.equal(rule.port,'443');assert.equal(rule.network,'tcp');assert.deepEqual(rule.user,natEntryClients(f.target.id,f.nodes,[f.device],master).map(c=>c.email));
 const revoked=compileDevices(bundle,f.target,[{...f.device,revoked:true}],master,f.nodes);assert.ok(!revoked.files['config.json'].routing.rules.some(r=>r.inboundTag?.includes('relay-entry-v4')));
});

test('entry-only NAT supports both exits and Vision without publishing before the target deploys',()=>{
  const {source,target,relay,landing,device,nodes}=topology();
  const targetBundle=patchRouting(target.applied,{relay:{...relay,relay_enabled:false}});
  target.applied=target.observed=targetBundle;
  assert.deepEqual(targetBundle.files['conf/99_relay_in.json'].inbounds.map(i=>i.tag),['relay-entry-v4']);
  device.grants[0].routes=['direct','1'];
  const config={role:'line',landings:[{...landing,nodeId:undefined,entry_enabled:false}],failover:{enabled:false,interval:'60s',order:[]},nat_entries:{}};
  for(const selected of [false,true])for(const reverse of [false,true]){
    config.nat_entries={direct:selected?{nodeId:target.id}:null,'1':selected?{nodeId:target.id}:null};
    let sourceBundle=patchRouting(source.applied,{relay:config});
    sourceBundle=patchSettings(sourceBundle,{...readSettings(sourceBundle),v6Uplink:reverse});
    source.applied=source.observed=compileDevices(resolveLinkedAddresses(sourceBundle,nodes),source,[device],master);
    target.applied=target.observed=targetBundle;
    assert.equal(deviceProviderProxies(nodes,device,master).length,selected?0:6);
    target.applied=target.observed=compileDevices(targetBundle,target,[device],master,nodes);
    const proxies=deviceProviderProxies(nodes,device,master);
    const guards=proxies.filter(p=>p.name.endsWith('NAT-v4-Entry'));
    assert.equal(guards.length,selected?1:0);
    if(selected){
      assert.equal(guards[0].uuid,deviceUuid(master,device,source.id,'direct'));
      const splitOnly={...device,grants:[{...device.grants[0],modes:['split']}]};
      assert.equal(deviceProviderProxies(nodes,splitOnly,master).length,3);
      const landingOnly={...splitOnly,grants:[{...splitOnly.grants[0],routes:['1']}]};
      const limited=deviceProviderProxies(nodes,landingOnly,master);
      assert.equal(limited.find(p=>p.name===guards[0].name).uuid,deviceUuid(master,device,source.id,'1'));
    }
    for(const exit of ['direct','1']){
      const id=deviceUuid(master,device,source.id,exit);
      const vision=proxies.find(p=>p.uuid===id&&p.flow==='xtls-rprx-vision');
      assert.equal(vision.server,source.ipv4);
      const split=proxies.find(p=>p.uuid===id&&p['xhttp-opts']?.['download-settings']);
      const dialer=reverse?split['xhttp-opts']['download-settings']['dialer-proxy']:split['dialer-proxy'];
      assert.equal(Boolean(dialer),selected);
      assert.equal(vision['dialer-proxy'],dialer);
      if(selected)assert.equal(dialer,guards[0].name);
      const rule=source.applied.files['config.json'].routing.rules.find(r=>r.user?.includes(`panel-${device.id}-${exit}`));
      assert.equal(rule?.outboundTag,exit==='direct'?undefined:'relay-out-1');
    }
  }
  target.applied=target.observed=patchRouting(targetBundle,{relay:{role:'none'}});
  const unresolved=resolveLinkedAddresses(source.applied,nodes);
  assert.deepEqual(unresolved.files['relay.json'].nat_entries.direct,{nodeId:target.id});
  assert.deepEqual(deviceProviderProxies(nodes,device,master),[]);
  assert.throws(()=>resolveLinkedAddresses(source.applied,nodes,{strictNat:true}),/尚未就绪/);
});

test('the shared entry preserves the previous direct alias and can be renamed or reset',async()=>{
  const sys=await testSystem();try{
    await sys.login();
    const {source,target,device,nodes}=topology();
    const relay=source.applied.files['relay.json'];
    relay.nat_entries={direct:{nodeId:target.id},'1':{nodeId:target.id}};
    device.grants[0].routes=['direct','1'];
    source.applied=source.observed=compileDevices(resolveLinkedAddresses(source.applied,nodes),source,[device],master);
    const previous=subscriptionNameKey(source.id,'conf/VLESS-443.json','direct','nat4-entry');
    source.subscriptionNames={[previous]:'旧入口名称'};
    sys.store.put('node',source.id,source);
    const url=`/nodes/${source.id}/subscription-names`;
    const catalog=(await sys.call(url)).body;
    const [guard]=catalog.entries.filter(e=>e.mode==='nat4-entry');
    assert.equal(catalog.entries.filter(e=>e.mode==='nat4-entry').length,1);
    assert.equal(guard.name,'旧入口名称');
    const save=(revision,name)=>sys.call(url,'PUT',{revision,subscriptionName:'',names:{[guard.key]:name}});
    const renamed=await save(catalog.revision,'共用入口');
    assert.equal(renamed.status,200);
    const reset=await save(renamed.body.revision,'');
    assert.equal(reset.status,200);
    assert.equal(reset.body.entries.find(e=>e.key===guard.key).name,guard.defaultName);
  }finally{await sys.close();}
});
