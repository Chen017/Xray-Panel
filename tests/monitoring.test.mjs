import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {testSystem,fixtureBundle} from './helpers.mjs';
import {createMonitoring,monitoringDefaults,sendTelegram} from '../server/monitoring.mjs';
const botToken='123456789:Test_only_token_abcdefghijklmnopqrstuvwxyz';
const cfg={...monitoringDefaults,enabled:true,botToken,chatId:'-100123456789',interval:60};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
async function fixture(){
 const s=await testSystem();await s.login();let at=Date.now(),sent=[];
 const m=createMonitoring(s.store,{clock:()=>at,fetchImpl:async(url,options)=>{sent.push({url,options});return response({ok:true,result:{message_id:sent.length}});}});
 const target=(await s.call('/nodes','POST',{name:'target',ipv4:'8.8.8.8'})).body.node;
 target.report={monitorProtocol:2};target.observed=fixtureBundle();s.store.put('node',target.id,target);m.save(cfg);
 const tick=()=>at+=61000;
 const accept=(domestic=true,global=true,sni=true)=>{const plan=m.plan(s.store.get('node',target.id));assert.ok(plan,'expected a fresh plan');m.accept(target,{planId:plan.id,results:plan.targets.map(t=>t.kind==='connectivity'?{id:t.id,ok:domestic&&global,domestic,global,code:'ignored-agent-code'}:{id:t.id,ok:sni,code:sni?'ok':'timeout'})});return plan;};
 const networkRound=async(domestic=false,global=true)=>{tick();accept(domestic,global);await m.drain();};
 return {s,m,target,accept,tick,networkRound,sent,advance:ms=>at+=ms};
}

test('self checks need repeated domestic failure with Cloudflare success; recovery deduplicates',async()=>{
 const f=await fixture();try{
 await f.networkRound();await f.networkRound();assert.equal(f.sent.length,0);await f.networkRound();assert.equal(f.sent.length,1);assert.match(JSON.parse(f.sent[0].options.body).text,/疑似国内连通异常/);assert.match(JSON.parse(f.sent[0].options.body).text,/不能据此确认/);
 await f.networkRound();assert.equal(f.sent.length,1);await f.networkRound(true);assert.equal(f.sent.length,1);await f.networkRound(true);assert.equal(f.sent.length,2);assert.match(JSON.parse(f.sent[1].options.body).text,/恢复/);
 }finally{await f.s.close();}
});

test('domestic and global failures are network alerts and changing categories requires new confirmation',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++)await f.networkRound(false,false);assert.equal(f.sent.length,1);assert.match(JSON.parse(f.sent[0].options.body).text,/节点网络异常/);assert.doesNotMatch(JSON.parse(f.sent[0].options.body).text,/疑似国内/);
 await f.networkRound(false,true);await f.networkRound(false,true);assert.equal(f.sent.length,1);await f.networkRound(false,true);assert.equal(f.sent.length,2);assert.match(JSON.parse(f.sent[1].options.body).text,/疑似国内连通异常/);
 for(let i=0;i<3;i++)await f.networkRound(true,false);assert.equal(f.sent.length,3);assert.match(JSON.parse(f.sent[2].options.body).text,/境外对照异常/);
 }finally{await f.s.close();}
});

test('SNI failures are independent; recovery cancels unsent alerts and disabled monitoring produces no plans',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++){f.tick();f.accept(true,true,false);}assert.equal(f.m.status().notifications[0].status,'pending');
 for(let i=0;i<2;i++){f.tick();f.accept();}await f.m.drain();assert.equal(f.sent.length,0);
 for(let i=0;i<3;i++){f.tick();f.accept(true,true,false);}await f.m.drain();assert.equal(f.sent.length,1);assert.match(JSON.parse(f.sent[0].options.body).text,/SNI/);
 f.m.save({...cfg,enabled:false});assert.equal(f.m.plan(f.target),null);
 }finally{await f.s.close();}
});

test('address edits invalidate in-flight network checks and queued alert destinations',async()=>{
 const f=await fixture();try{
 f.tick();const p=f.m.plan(f.target);const n=f.s.store.get('node',f.target.id);n.ipv4='1.1.1.1';n.addressPolicy={ipv4:{mode:'manual',value:n.ipv4},ipv6:{mode:'manual',value:''}};f.s.store.put('node',n.id,n);
 const old=p.targets.find(t=>t.kind==='connectivity');f.m.accept(f.target,{planId:p.id,results:[{id:old.id,ok:false,domestic:false,global:true}]});assert.equal(f.m.status().incidents.length,0);
 for(let i=0;i<3;i++){f.tick();f.accept(false,true);}
 const changed=f.s.store.get('node',n.id);changed.ipv4='9.9.9.9';changed.addressPolicy.ipv4.value=changed.ipv4;f.s.store.put('node',n.id,changed);await f.m.drain();assert.equal(f.sent.length,0);assert.equal(f.m.status().notifications[0].status,'superseded');
 }finally{await f.s.close();}
});

test('settings API requires admin and CSRF, preserves encrypted token and does not return credentials',async()=>{
 const s=await testSystem({monitorFetch:async()=>response({ok:true,result:{message_id:1}})});try{
 assert.equal((await s.call('/monitoring')).status,401);await s.login();
 assert.equal((await s.call('/monitoring','PUT',cfg,{headers:{'X-CSRF-Token':'wrong'}})).status,403);
 const saved=await s.call('/monitoring','PUT',cfg);assert.equal(saved.status,200);assert.equal(saved.body.hasToken,true);assert.ok(!JSON.stringify(saved.body).includes(botToken));
 const info=await s.call('/monitoring');assert.ok(!JSON.stringify(info.body).includes(botToken));assert.ok(!readFileSync(s.config.dbPath).includes(Buffer.from(botToken)));
 const keep={...cfg};delete keep.botToken;assert.equal((await s.call('/monitoring','PUT',keep)).status,200);assert.equal(s.monitoring.settings().botToken,botToken);
 const tested=await s.call('/monitoring/test','POST',{});assert.equal(tested.body.ok,true);
 assert.equal((await s.call('/monitoring','PUT',{...keep,enabled:false,clearToken:true})).status,200);assert.equal(s.monitoring.settings().botToken,undefined);
 }finally{await s.close();}
});
test('Telegram sender checks HTTP and JSON success, handles 429 and redacts arbitrary errors',async()=>{
 let r=await sendTelegram(cfg,'test',async()=>response({ok:false,error_code:429,parameters:{retry_after:77},description:botToken},429));assert.equal(r.retryAfter,77);assert.ok(!JSON.stringify(r).includes(botToken));
 r=await sendTelegram(cfg,'test',async()=>response({ok:false,description:botToken},401));assert.equal(r.permanent,true);assert.equal(r.code,'telegram_401');
 r=await sendTelegram(cfg,'test',async()=>{throw Error('request failed '+botToken);});assert.equal(r.code,'network_or_invalid_response');assert.ok(!JSON.stringify(r).includes(botToken));
 r=await sendTelegram(cfg,'test',async()=>new Response('invalid'));assert.equal(r.ok,false);
 r=await sendTelegram(cfg,'test',async()=>response({ok:true}));assert.equal(r.ok,false);
 r=await sendTelegram(cfg,'test',async()=>new Response('x'.repeat(40000)));assert.equal(r.code,'invalid_response');
});
test('persistent outbox retries after restart, honors Telegram retry-after and masks failures',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++){f.tick();f.accept(false,true);}
 let calls=0;
 // Use a clock within the original incident TTL, then recreate worker over same DB.
 const queued=f.m.status().notifications[0];let at=queued.createdAt;
 const transport=async()=>{calls++;return calls===1?response({ok:false,error_code:429,parameters:{retry_after:120}},429):response({ok:true,result:{message_id:42}});};
 const first=createMonitoring(f.s.store,{clock:()=>at,fetchImpl:transport});await first.drain();assert.equal(calls,1);assert.equal(first.status().notifications[0].status,'pending');
 const restarted=createMonitoring(f.s.store,{clock:()=>at,fetchImpl:transport});await restarted.drain();assert.equal(calls,1);at+=120000;await restarted.drain();assert.equal(calls,2);assert.equal(restarted.status().notifications[0].messageId,42);
 }finally{await f.s.close();}
});
test('Agent HTTP heartbeats transport monitor plans and accept each result only once',async()=>{
 const s=await testSystem();try{await s.login();
 const created=(await s.call('/nodes','POST',{name:'observer target',ipv4:'8.8.8.8'})).body;
 await s.call('/monitoring','PUT',{...cfg,cnProbeIds:[],globalProbeIds:[]});
 const headers={'Content-Type':'application/json','X-Node-ID':created.node.id,Authorization:'Bearer '+created.agentToken};
 const poll=async(report)=>{const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers,body:JSON.stringify({report,bundle:fixtureBundle()})});assert.equal(r.status,200);return r.json();};
 assert.equal((await poll({})).monitorPlan,null,'legacy Agent receives no probes');
 const first=await poll({monitorProtocol:1});assert.ok(first.monitorPlan);assert.equal(first.job,null);assert.ok(!JSON.stringify(first.monitorPlan).includes(botToken));
 const monitor={planId:first.monitorPlan.id,results:first.monitorPlan.targets.map(t=>({id:t.id,ok:false,code:'certificate_invalid'}))};
 await poll({monitorProtocol:1,monitor});const one=s.monitoring.status().incidents;assert.equal(one.length,1);assert.equal(Object.values(one[0].samples)[0].count,1);
 await poll({monitorProtocol:1,monitor});assert.equal(Object.values(s.monitoring.status().incidents[0].samples)[0].count,1);
 const backup=(await s.call('/backup')).body;assert.ok(backup.records.some(r=>r.kind==='monitor'));assert.equal((await s.call('/restore','POST',backup)).status,200);
 }finally{await s.close();}
});
test('recovery during an in-flight Telegram request follows the acknowledged alert',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++){f.tick();f.accept(false,true);}
 let release;let at=f.m.status().notifications[0].createdAt;let sent=0;
 const worker=createMonitoring(f.s.store,{clock:()=>at,fetchImpl:async()=>{sent++;if(sent===1)await new Promise(r=>release=r);return response({ok:true,result:{message_id:sent}});}});
 const pending=worker.drain();assert.equal(worker.status().notifications[0].status,'sending');
 for(let i=0;i<2;i++){f.tick();f.accept(true,true);}
 release();await pending;at=Date.now()+360000;await worker.drain();assert.equal(sent,2);assert.ok(worker.status().notifications.every(n=>n.status==='sent'));
 }finally{await f.s.close();}
});
test('delayed notifications wait for fresh corroboration rather than sending expired block evidence',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++){f.tick();f.accept(false,true);}
 f.advance(181000);await f.m.drain();assert.equal(f.sent.length,0);assert.equal(f.m.status().notifications[0].code,'waiting_for_fresh_evidence');
 // Long probe gaps reset consecutive failure counts.
 for(let i=0;i<3;i++)await f.networkRound();assert.equal(f.sent.length,1);
 }finally{await f.s.close();}
});
test('legacy settings drop observer fields while preserving Bot credentials, and each node only checks itself',async()=>{
 const f=await fixture();try{
 f.s.store.put('system','monitoring',{...f.m.settings(),cnProbeIds:[f.target.id],globalProbeIds:[f.target.id],cnQuorum:2});
 assert.equal(f.m.publicSettings().cnProbeIds,undefined);assert.equal(f.m.settings().botToken,botToken);
 const p=f.m.plan(f.target);assert.ok(p.targets.some(t=>t.kind==='connectivity'));assert.ok(p.targets.every(t=>t.nodeId===f.target.id));
 const old={...f.target,report:{monitorProtocol:1}};f.m.save(cfg);f.s.store.put('node',old.id,old);assert.ok(f.m.plan(old).targets.every(t=>t.kind==='sni'));assert.equal(f.m.status().upgradeRequired.length,1);
 f.m.save(cfg);assert.equal(f.s.store.get('system','monitoring').cnProbeIds,undefined);
 assert.equal((await f.s.call(`/nodes/${f.target.id}`,'DELETE')).status,200);assert.ok(f.m.status().incidents.every(r=>!r.current));
 }finally{await f.s.close();}
});

test('malformed result entries cannot abort a heartbeat or discard valid observations',async()=>{
 const f=await fixture();try{
 f.tick();const p=f.m.plan(f.target);
 assert.doesNotThrow(()=>f.m.accept(f.target,{planId:p.id,results:[null,17,{id:p.targets[0].id,ok:false,domestic:false,global:true,code:'timeout'}]}));
 assert.equal(f.m.status().incidents.length,1);
 }finally{await f.s.close();}
});

test('status expires stale self-check evidence even without another heartbeat',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++)await f.networkRound();
 const r=f.m.status().incidents.find(r=>r.kind==='connectivity');f.advance(181000);const current=f.m.status().incidents.find(x=>x.id===r.id);
 assert.equal(current.assessment,'insufficient');assert.equal(current.active,true);
 }finally{await f.s.close();}
});

test('Telegram rejects non-object JSON responses without throwing',async()=>{
 for(const body of [null,17,'ok',[]]){
  const result=await sendTelegram(cfg,'test',async()=>response(body));assert.equal(result.ok,false);
 }
});

test('protocol 2 heartbeats carry self connectivity results and reject inconsistent or replayed reports',async()=>{
 const s=await testSystem();try{
 await s.login();const c=(await s.call('/nodes','POST',{name:'self check',ipv4:'8.8.8.8'})).body;await s.call('/monitoring','PUT',cfg);
 const headers={'Content-Type':'application/json','X-Node-ID':c.node.id,Authorization:'Bearer '+c.agentToken};
 const poll=async monitor=>(await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers,body:JSON.stringify({report:{monitorProtocol:2,monitor},bundle:fixtureBundle()})})).json();
 const first=await poll(),p=first.monitorPlan,t=p.targets.find(t=>t.kind==='connectivity');assert.ok(t);assert.ok(p.targets.every(t=>t.nodeId===c.node.id));
 const report={planId:p.id,results:[{id:t.id,ok:false,domestic:false,global:true,code:'forged'}]};await poll(report);
 const row=s.monitoring.status().incidents.find(r=>r.kind==='connectivity');assert.equal(row.lastCode,'domestic_unreachable');assert.equal(row.samples[c.node.id].count,1);await poll(report);assert.equal(s.monitoring.status().incidents[0].samples[c.node.id].count,1);
 s.monitoring.save(cfg);const second=await poll();await poll({planId:second.monitorPlan.id,results:[{id:t.id,ok:true,domestic:false,global:true}]});assert.equal(s.monitoring.status().incidents.find(r=>r.kind==='connectivity').updatedAt,row.updatedAt);
 }finally{await s.close();}
});

test('a failed or absent shared-script report cannot count as network failure',async()=>{
 const f=await fixture();try{
 for(let i=0;i<4;i++){f.tick();const p=f.m.plan(f.target),t=p.targets.find(t=>t.kind==='connectivity');f.m.accept(f.target,{planId:p.id,results:[{id:t.id,ok:null,code:'probe_failed'}]});}
 await f.m.drain();assert.equal(f.sent.length,0);assert.equal(f.m.status().incidents.length,0);
 }finally{await f.s.close();}
});
