import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixtureBundle,testSystem} from './helpers.mjs';
import * as age from 'age-encryption';
import {compileDevices,deviceProviderProxies,providerProxies,patchRouting,readSettings,patchSettings,deviceUuid,relaySchema,natEntryClients,vlessLink} from '../shared/config.mjs';

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
    assert.throws(()=>vlessLink(split,s),/单条 VLESS/);
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

test('Agent lifecycle synchronizes linked NAT grants, gates subscription and removes revoked clients',async()=>{
  const s=await testSystem();try{
    await s.login();
    const create=async name=>(await s.call('/nodes','POST',{name,ipv4:'8.8.8.8',ipv6:'2606:4700::1111'})).body;
    const target=await create('NAT'),source=await create('Line'),f=topology();
    f.source.applied.files['relay.json'].landings[0].nodeId=target.node.id;
    const bundles=new Map([[target.node.id,f.target.applied],[source.node.id,f.source.applied]]);
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
    const identity=await age.generateIdentity(),d=(await s.call('/devices','POST',{name:'Laptop',publicKey:await age.identityToRecipient(identity),grants:[{nodeId:source.node.id,routes:['1'],modes:['split']}]})).body;
    const sub=()=>fetch(d.url,{headers:{Authorization:'Bearer '+d.token}});
    const sourceJob=await poll(source);assert.ok(sourceJob);await finish(source,sourceJob);
    assert.equal((await sub()).status,503,'line-only deployment cannot publish an unusable NAT chain');
    const targetJob=await poll(target);assert.ok(targetJob);await finish(target,targetJob);
    assert.equal((await sub()).status,200);
    const clients=()=>bundles.get(target.node.id).files['conf/99_relay_in.json'].inbounds.find(i=>i.tag==='relay-entry-v4').settings.clients;
    assert.equal(clients().filter(c=>c.email?.startsWith('panel-relay-')).length,1);
    await s.call(`/devices/${d.device.id}/revoke`,'POST',{});
    const revoke=await poll(target);assert.ok(revoke);await finish(target,revoke);
    assert.ok(!clients().some(c=>c.email?.startsWith('panel-relay-')));
    assert.equal((await sub()).status,401);
    assert.equal(await poll(target),null,'unchanged heartbeat must not queue another deployment');
  }finally{await s.close();}
});
