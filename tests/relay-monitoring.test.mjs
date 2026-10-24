import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testSystem,fixtureBundle} from './helpers.mjs';
import {createMonitoring,monitoringDefaults} from '../server/monitoring.mjs';
import {patchRouting} from '../shared/config.mjs';
import {relayTargets} from '../server/relay-monitoring.mjs';

async function fixture(){
  const system=await testSystem();await system.login();let at=Date.now();const sent=[];
  const monitoring=createMonitoring(system.store,{clock:()=>at,fetchImpl:async(_,options)=>{sent.push(JSON.parse(options.body).text);return new Response(JSON.stringify({ok:true,result:{message_id:sent.length}}));}});
  const create=async(name,ipv4)=>(await system.call('/nodes','POST',{name,ipv4})).body.node;
  const line=await create('东京中转','8.8.8.8'),landing=await create('香港落地','9.9.9.9');
  const link={id:'1',name:'NAT 落地',nodeId:landing.id,landing_ip:landing.ipv4,landing_port:34443,transport_uuid:randomUUID(),client_uuid:randomUUID(),encryption:'mlkem768x25519plus.fixture-secret'};
  line.observed=patchRouting(fixtureBundle(),{relay:{role:'line',landings:[link],failover:{enabled:false,interval:'60s',order:[]}}});
  landing.observed={files:{'config.json':{},'relay.json':{role:'landing',listen_port:24443,external_port:34443}}};
  for(const node of [line,landing]){node.report={monitorProtocol:3};system.store.put('node',node.id,node);}
  monitoring.save({...monitoringDefaults,enabled:true,interval:60,botToken:'123456789:Local_fixture_token_abcdefghijklmnopqrstuvwxyz',chatId:'-100123456789'});
  const samples=(plan,states={},code='timeout')=>plan.targets.map(target=>{
    if(target.kind==='connectivity')return {id:target.id,ok:true,domestic:true,global:true,code:'ok'};
    const key=target.kind==='overseas'?'overseas':target.direction==='line-to-landing'?'forward':target.direction==='landing-to-line'?'reverse':'sni';
    const ok=states[key]!==false;return {id:target.id,ok,code:ok?'ok':code,...(target.kind==='overseas'?{global:ok}:{})};
  });
  async function round(states={},code='timeout',drain=true){
    at+=61000;
    for(const node of [line,landing]){const current=system.store.get('node',node.id);const plan=monitoring.plan(current);if(plan)monitoring.accept(current,{planId:plan.id,results:samples(plan,states,code)});}
    if(drain)for(let i=0;i<4;i++)await monitoring.drain();
  }
  return {system,monitoring,line,landing,link,round,sent,samples,tick:()=>at+=61000};
}

test('running topology produces both TCP directions, NAT ports and overseas-only landing plans without credentials',async()=>{
  const f=await fixture();try{
    const forward=f.monitoring.plan(f.line),reverse=f.monitoring.plan(f.landing);
    const a=forward.targets.find(t=>t.kind==='tcp'),b=reverse.targets.find(t=>t.kind==='tcp');
    assert.equal(a.direction,'line-to-landing');assert.equal(a.host,f.landing.ipv4);assert.equal(a.port,34443);
    assert.equal(b.direction,'landing-to-line');assert.equal(b.host,f.line.ipv4);assert.equal(b.port,443);
    assert.ok(reverse.targets.some(t=>t.kind==='overseas'));assert.ok(reverse.targets.every(t=>t.kind!=='connectivity'));
    for(const secret of [f.link.transport_uuid,f.link.client_uuid,f.link.encryption])assert.ok(!JSON.stringify([forward,reverse]).includes(secret));
    const saved=f.system.store.get('node',f.line.id);saved.draft=patchRouting(fixtureBundle(),{relay:{role:'none'}});f.system.store.put('node',saved.id,saved);
    assert.deepEqual(f.monitoring.plan(saved).targets,forward.targets,'a draft edit does not change running checks');
  }finally{await f.system.close();}
});

test('each of the three failure modes independently alerts after retries, deduplicates and recovers',async()=>{
  for(const [key,label] of [['forward','中转 → 落地'],['reverse','落地 → 中转'],['overseas','落地机海外连通']]){
    const f=await fixture();try{
      await f.round({[key]:false},'timeout');await f.round({[key]:false},'connect_failed');assert.equal(f.sent.length,0,key);
      await f.round({[key]:false},'dns_failed');assert.equal(f.sent.length,1,key);assert.ok(f.sent[0].includes(label));
      await f.round({[key]:false});assert.equal(f.sent.length,1,'persistent failure does not spam');
      await f.round();assert.equal(f.sent.length,1);await f.round();assert.equal(f.sent.length,2);assert.match(f.sent[1],/✅ 恢复/);
      for(const secret of [f.link.transport_uuid,f.link.client_uuid,f.link.encryption])assert.ok(!f.sent.join().includes(secret));
    }finally{await f.system.close();}
  }
});

test('simultaneous failures are tracked per direction, never require all three failures to agree',async()=>{
  const f=await fixture();try{
    for(let i=0;i<3;i++)await f.round({forward:false,reverse:false,overseas:false});
    assert.equal(f.sent.length,3);assert.equal(f.monitoring.status().incidents.filter(r=>r.active).length,3);
    await f.round({forward:false,reverse:false,overseas:false});assert.equal(f.sent.length,3);
  }finally{await f.system.close();}
});

test('role changes invalidate cached domestic plans, and old landing Agents never receive domestic probes',async()=>{
  const f=await fixture();try{
    assert.ok(f.monitoring.plan(f.line).targets.some(t=>t.kind==='connectivity'));
    const saved=f.system.store.get('node',f.line.id);saved.observed=f.landing.observed;f.system.store.put('node',saved.id,saved);
    assert.ok(f.monitoring.plan(saved).targets.every(t=>t.kind!=='connectivity'));
    for(const protocol of [1,2]){const old={...f.landing,report:{monitorProtocol:protocol}};f.system.store.put('node',old.id,old);assert.equal(f.monitoring.plan(old),null);}
    assert.ok(f.monitoring.status().upgradeRequired.some(n=>n.id===f.landing.id));
  }finally{await f.system.close();}
});

test('removed routes invalidate in-flight results and suppress unsent TCP notifications',async()=>{
  const f=await fixture();try{
    for(let i=0;i<3;i++)await f.round({forward:false,reverse:false},'timeout',false);
    const current=f.system.store.get('node',f.line.id);current.observed=patchRouting(fixtureBundle(),{relay:{role:'none'}});f.system.store.put('node',current.id,current);
    for(let i=0;i<4;i++)await f.monitoring.drain();assert.equal(f.sent.length,0);
    assert.ok(f.monitoring.status().incidents.filter(r=>r.kind==='tcp').every(r=>!r.current));
    assert.ok(f.monitoring.status().notifications.every(n=>n.status==='superseded'));
    const restored={...current,observed:f.line.observed};f.system.store.put('node',restored.id,restored);f.tick();const plan=f.monitoring.plan(restored);
    const changed=f.system.store.get('node',restored.id);changed.observed=structuredClone(changed.observed);changed.observed.files['relay.json'].landings[0].landing_port++;f.system.store.put('node',changed.id,changed);
    f.monitoring.accept(changed,{planId:plan.id,results:f.samples(plan,{forward:false})});
    assert.ok(f.monitoring.status().incidents.filter(r=>r.kind==='tcp').every(r=>!r.current),'old port results are discarded');
  }finally{await f.system.close();}
});

test('manual endpoint matching, IPv6, disabled peers and incomplete topology are handled without guessing ports',async()=>{
  const f=await fixture();try{
    const line=structuredClone(f.line),landing=structuredClone(f.landing);delete line.observed.files['relay.json'].landings[0].nodeId;
    assert.equal(relayTargets(landing,[line,landing])[0].port,443);
    line.ipv6='2606:4700::1111';landing.ipv6='2620:fe::fe';line.observed.files['relay.json'].landings[0].landing_ip=landing.ipv6;
    assert.equal(relayTargets(landing,[line,landing])[0].family,6);
    assert.equal(relayTargets(landing,[line,landing])[0].host,line.ipv6);
    line.observed.files['relay.json'].landings[0].nodeId=landing.id;landing.enabled=false;
    assert.equal(relayTargets(line,[line,landing]).length,0);
    landing.enabled=true;line.observed={files:{'config.json':{},'relay.json':line.observed.files['relay.json']}};
    assert.equal(relayTargets(landing,[line,landing]).length,0,'unknown source listener is never assumed to be 443');
    line.observed.files['relay.json'].landings[0].landing_ip='http://bad/path';assert.equal(relayTargets(line,[line,landing]).length,0);
  }finally{await f.system.close();}
});

test('large relay plans rotate within eight targets and accumulate evidence at their actual sampling period',async()=>{
  const f=await fixture();try{
    const line=f.system.store.get('node',f.line.id);
    const links=Array.from({length:32},(_,i)=>({...f.link,nodeId:undefined,id:String(i+1),name:'external '+i,landing_ip:'8.8.4.4',landing_port:24443+i}));
    line.observed=patchRouting(fixtureBundle(),{relay:{role:'line',landings:links,failover:{enabled:false,interval:'60s',order:[]}}});f.system.store.put('node',line.id,line);
    const seen=new Set();for(let i=0;i<15;i++){
      f.tick();const current=f.system.store.get('node',line.id),plan=f.monitoring.plan(current);assert.ok(plan.targets.length<=8);assert.equal(plan.periodMs,300000);
      for(const target of plan.targets)if(target.kind==='tcp')seen.add(target.id);
      f.monitoring.accept(current,{planId:plan.id,results:f.samples(plan,{forward:false})});
    }
    assert.equal(seen.size,32);assert.equal(f.monitoring.status().incidents.filter(r=>r.kind==='tcp'&&r.active).length,32);
  }finally{await f.system.close();}
});

test('protocol 3 HTTP heartbeats transport both directions and overseas reports without accepting foreign or replayed plans',async()=>{
  const f=await fixture();try{
    const created=(await f.system.call(`/nodes/${f.line.id}/agent-token`,'POST',{})).body;
    const landingToken=(await f.system.call(`/nodes/${f.landing.id}/agent-token`,'POST',{})).body;
    const poll=async(node,token,monitor)=>{
      const response=await fetch(f.system.urls[2]+'/v1/agent/poll',{method:'POST',headers:{'Content-Type':'application/json','X-Node-ID':node.id,Authorization:'Bearer '+token},body:JSON.stringify({bundle:node.observed,report:{monitorProtocol:3,monitor}})});
      assert.equal(response.status,200);return response.json();
    };
    const linePlan=(await poll(f.line,created.agentToken)).monitorPlan,landingPlan=(await poll(f.landing,landingToken.agentToken)).monitorPlan;
    assert.ok(linePlan.targets.some(t=>t.direction==='line-to-landing'));
    assert.ok(landingPlan.targets.some(t=>t.direction==='landing-to-line'));
    assert.ok(landingPlan.targets.every(t=>t.kind!=='connectivity'));
    const lineReport={planId:linePlan.id,results:f.samples(linePlan,{forward:false})};
    await poll(f.landing,landingToken.agentToken,lineReport);assert.equal(f.system.monitoring.status().incidents.length,0);
    await poll(f.line,created.agentToken,lineReport);await poll(f.line,created.agentToken,lineReport);
    assert.ok(f.system.monitoring.status().incidents.every(r=>r.samples[f.line.id]?.count===1));
    const invalid={planId:landingPlan.id,results:landingPlan.targets.filter(t=>t.kind==='overseas').map(t=>({id:t.id,ok:true,global:false}))};
    await poll(f.landing,landingToken.agentToken,invalid);assert.ok(f.system.monitoring.status().incidents.every(r=>r.kind!=='overseas'));
  }finally{await f.system.close();}
});
