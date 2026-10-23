import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testSystem,fixtureBundle} from './helpers.mjs';
import {addressPolicy,effectiveAddress,observeAddresses,publicAddress,resolveLinkedAddresses} from '../shared/addresses.mjs';
import {hashBundle,patchRouting} from '../shared/config.mjs';
const sample=(address='8.8.8.8',seconds=0,status='ok')=>({checkedAt:new Date(Date.UTC(2026,9,23,0,0,seconds)).toISOString(),ipv4:{status,address,source:'https://probe.example'},ipv6:{status:'failed'}});
test('public addresses require stable samples, preserve manual migration and survive failed probes',()=>{
 const legacy={ipv4:'nat.example.com',ipv6:'2606:4700::1111'};assert.equal(addressPolicy(legacy).ipv4.mode,'manual');
 observeAddresses(legacy,sample());observeAddresses(legacy,sample('8.8.8.8',20));assert.equal(legacy.ipv4,'nat.example.com');
 const auto={ipv4:'',ipv6:'',addressPolicy:{ipv4:{mode:'auto',value:''},ipv6:{mode:'manual',value:'ddns.example.com'}}};
 observeAddresses(auto,sample());assert.equal(auto.ipv4,'');observeAddresses(auto,sample('8.8.8.8',5));assert.equal(auto.ipv4,'');observeAddresses(auto,sample('8.8.8.8',15));assert.equal(auto.ipv4,'8.8.8.8');
 observeAddresses(auto,sample(null,20,'failed'));assert.equal(auto.ipv4,'8.8.8.8');assert.equal(effectiveAddress(auto,'ipv6'),'ddns.example.com');
 observeAddresses(auto,sample('1.1.1.1',25));assert.equal(auto.ipv4,'8.8.8.8');observeAddresses(auto,sample('1.1.1.1',40));assert.equal(auto.ipv4,'1.1.1.1');
 observeAddresses(auto,sample('9.9.9.9',30));assert.equal(auto.ipv4,'1.1.1.1');
 for(const ip of ['127.0.0.1','10.0.0.1','100.64.1.1','192.168.1.1','203.0.113.1','198.18.0.1','224.0.0.1'])assert.equal(publicAddress(ip,4),false,ip);
 assert.equal(publicAddress('192.0.3.1',4),true);assert.equal(publicAddress('2606:4700::1111',6),true);assert.equal(publicAddress('2001:db8::1',6),false);
});
test('linked landing follows effective address and NAT external port while preserving manual targets and config',()=>{
 const id=randomUUID(),landing={id:'1',name:'linked',nodeId:id,addressFamily:'ipv6',landing_ip:'8.8.8.8',landing_port:24443,transport_uuid:randomUUID(),client_uuid:randomUUID(),encryption:'mlkem768x25519plus.fixture'};
 const b=patchRouting(fixtureBundle(),{relay:{role:'line',landings:[landing,{...landing,id:'2',name:'external',nodeId:undefined,addressFamily:undefined,landing_ip:'external.example.com'}],failover:{enabled:false,interval:'60s',order:[]}}});
 const nodes=[{id,ipv4:'8.8.8.8',ipv6:'2606:4700::1111',applied:{files:{'relay.json':{role:'landing',listen_port:24443,external_port:34443}}}}];
 const r=resolveLinkedAddresses(b,nodes);assert.equal(r.files['relay.json'].landings[0].landing_ip,'2606:4700::1111');assert.equal(r.files['relay.json'].landings[0].landing_port,34443);
 assert.equal(r.files['relay.json'].landings[1].landing_ip,'external.example.com');assert.deepEqual(r.files['custom_rules.json'],b.files['custom_rules.json']);
 assert.equal(r.files['config.json'].outbounds.find(o=>o.tag==='relay-out').settings.port,34443);assert.equal(b.files['relay.json'].landings[0].landing_port,24443);
 assert.throws(()=>resolveLinkedAddresses(b,[]));
});
test('address-only changes do not deploy Xray; linked changes use validated jobs and stale results stay pending',async()=>{
 const s=await testSystem();try{await s.login();
 const create=async name=>(await s.call('/nodes','POST',{name,ipv4:'8.8.8.8'})).body;
 const land=await create('landing'),line=await create('line');
 const headers=n=>({'Content-Type':'application/json','X-Node-ID':n.node.id,Authorization:'Bearer '+n.agentToken});
 let lb=fixtureBundle();lb.files['relay.json']={role:'landing',transport_uuid:randomUUID(),decryption:'mlkem768x25519plus.fixture',encryption:'mlkem768x25519plus.fixture',landing_ip:'8.8.8.8',listen_port:24443,external_port:34443,peer_ip:''};
 const edge={id:'1',name:'linked',nodeId:land.node.id,addressFamily:'ipv4',landing_ip:'8.8.8.8',landing_port:34443,transport_uuid:lb.files['relay.json'].transport_uuid,client_uuid:randomUUID(),encryption:lb.files['relay.json'].encryption};
 let b=patchRouting(fixtureBundle(),{relay:{role:'line',landings:[edge],failover:{enabled:false,interval:'60s',order:[]}}});
 const poll=async(n,bundle)=>{const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers:headers(n),body:JSON.stringify({bundle,report:{network:sample()}})});assert.equal(r.status,200);return r.json();};
 const done=async(n,j,bundle)=>{const r=await fetch(s.urls[2]+`/v1/agent/jobs/${j.id}/result`,{method:'POST',headers:headers(n),body:JSON.stringify({ok:true,lease:j.lease,bundle})});assert.equal(r.status,200);};
 await poll(land,lb);await poll(line,b);
 await s.call(`/nodes/${land.node.id}`,'PATCH',{ipv4:'1.1.1.1'});
 assert.equal((await poll(land,lb)).job,null,'client address change must not restart landing');
 const j=(await poll(line,b)).job;assert.equal(j.source,'address-sync');assert.equal(j.payload.expectedHash,hashBundle(b));assert.equal(j.payload.bundle.files['relay.json'].landings[0].landing_ip,'1.1.1.1');
 // Return destination to the original value while old deployment is in flight.
 await s.call(`/nodes/${land.node.id}`,'PATCH',{ipv4:'8.8.8.8'});b=j.payload.bundle;await done(line,j,b);
 assert.equal(s.store.get('node',line.node.id).needsRelaySync,true);
 const repair=(await poll(line,b)).job;assert.equal(repair.payload.bundle.files['relay.json'].landings[0].landing_ip,'8.8.8.8');b=repair.payload.bundle;await done(line,repair,b);
 assert.equal(s.store.get('node',line.node.id).needsRelaySync,false);
 assert.equal((await poll(line,b)).job,null);
 }finally{await s.close();}
});

test('removing the last linked landing clears stale errors and unblocks device synchronization',async()=>{
 const s=await testSystem();try{await s.login();
 const created=(await s.call('/nodes','POST',{name:'unlinked line',ipv4:'8.8.8.8'})).body;
 const n=s.store.get('node',created.node.id),bundle=fixtureBundle();
 Object.assign(n,{observed:bundle,observedHash:hashBundle(bundle),needsSync:true,needsRelaySync:true,relaySyncError:'关联落地已不存在',relayTargetHash:'old-linked-target',relayRevision:4});s.store.put('node',n.id,n);
 const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers:{'Content-Type':'application/json','X-Node-ID':n.id,Authorization:'Bearer '+created.agentToken},body:JSON.stringify({report:{},bundle})});
 assert.equal(r.status,200);const result=await r.json();assert.equal(result.job?.source,'device-sync');
 const current=s.store.get('node',n.id);assert.equal(current.needsRelaySync,false);assert.equal(current.relaySyncError,undefined);assert.equal(current.relayTargetHash,undefined);
 }finally{await s.close();}
});
