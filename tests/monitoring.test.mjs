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
 const add=async(name,ip='')=>{const n=(await s.call('/nodes','POST',{name,ipv4:ip})).body.node;n.report={monitorProtocol:1};s.store.put('node',n.id,n);return n;};
 const target=await add('target','8.8.8.8'),cn1=await add('cn1'),cn2=await add('cn2'),global=await add('global');target.observed=fixtureBundle();s.store.put('node',target.id,target);
 m.save({...cfg,cnProbeIds:[cn1.id,cn2.id],globalProbeIds:[global.id]});
 const tick=()=>at+=61000;
 const accept=(node,ok)=>{const plan=m.plan(s.store.get('node',node.id));assert.ok(plan,'expected a fresh plan');m.accept(node,{planId:plan.id,results:plan.targets.map(t=>({id:t.id,ok,code:ok?'ok':'timeout'}))});return plan;};
 const tcpRound=async(cnOk=false,globalOk=true)=>{tick();accept(global,globalOk);accept(cn1,cnOk);accept(cn2,cnOk);await m.drain();};
 return {s,m,target,cn1,cn2,global,accept,tick,tcpRound,sent,advance:ms=>at+=ms};
}
test('domestic comparison needs a fresh global success and two independently failing CN probes; recovery deduplicates',async()=>{
 const f=await fixture();try{
 await f.tcpRound();await f.tcpRound();assert.equal(f.sent.length,0);await f.tcpRound();assert.equal(f.sent.length,1);assert.match(JSON.parse(f.sent[0].options.body).text,/疑似国内网络阻断/);assert.match(JSON.parse(f.sent[0].options.body).text,/不等同于已证明/);
 await f.tcpRound();assert.equal(f.sent.length,1,'no repeat spam');await f.tcpRound(true);assert.equal(f.sent.length,1);await f.tcpRound(true);assert.equal(f.sent.length,2);assert.match(JSON.parse(f.sent[1].options.body).text,/恢复/);
 }finally{await f.s.close();}
});
test('missing CN quorum, global failure, expired evidence and replayed plans cannot report blocked IPs',async()=>{
 const f=await fixture();try{
 for(let i=0;i<4;i++)await f.tcpRound(false,false);assert.equal(f.sent.length,0);
 f.advance(181000);for(let i=0;i<3;i++){f.tick();const p=f.accept(f.cn1,false);f.m.accept(f.cn1,{planId:p.id,results:p.targets.map(t=>({id:t.id,ok:false,code:'timeout'}))});}await f.m.drain();assert.equal(f.sent.length,0);
 assert.ok(f.m.status().incidents.every(r=>!r.active));
 }finally{await f.s.close();}
});
test('SNI failure and recovery work independently of domestic probes and pending obsolete alerts are cancelled',async()=>{
 const f=await fixture();try{
 f.m.save({...cfg,cnProbeIds:[],globalProbeIds:[]});
 for(let i=0;i<3;i++){f.tick();f.accept(f.target,false);}assert.equal(f.m.status().notifications[0].status,'pending');
 // Recover before any Telegram acknowledgement: no stale alert or recovery spam.
 for(let i=0;i<2;i++){f.tick();f.accept(f.target,true);}await f.m.drain();assert.equal(f.sent.length,0);
 for(let i=0;i<3;i++){f.tick();f.accept(f.target,false);}await f.m.drain();assert.equal(f.sent.length,1);assert.match(JSON.parse(f.sent[0].options.body).text,/SNI/);
 f.m.save({...cfg,enabled:false,cnProbeIds:[],globalProbeIds:[]});assert.equal(f.m.plan(f.target),null);
 }finally{await f.s.close();}
});
test('address edits invalidate in-flight evidence and queued alert destinations',async()=>{
 const f=await fixture();try{
 f.tick();const p=f.m.plan(f.cn1);const n=f.s.store.get('node',f.target.id);n.ipv4='1.1.1.1';n.addressPolicy={ipv4:{mode:'manual',value:n.ipv4},ipv6:{mode:'manual',value:''}};f.s.store.put('node',n.id,n);
 f.m.accept(f.cn1,{planId:p.id,results:p.targets.map(t=>({id:t.id,ok:false,code:'timeout'}))});assert.equal(f.m.status().incidents.length,0);
 for(let i=0;i<3;i++){f.tick();f.accept(f.global,true);f.accept(f.cn1,false);f.accept(f.cn2,false);}
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
 for(let i=0;i<3;i++){f.tick();f.accept(f.global,true);f.accept(f.cn1,false);f.accept(f.cn2,false);}
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
 for(let i=0;i<3;i++){f.tick();f.accept(f.global,true);f.accept(f.cn1,false);f.accept(f.cn2,false);}
 let release;let at=f.m.status().notifications[0].createdAt;let sent=0;
 const worker=createMonitoring(f.s.store,{clock:()=>at,fetchImpl:async()=>{sent++;if(sent===1)await new Promise(r=>release=r);return response({ok:true,result:{message_id:sent}});}});
 const pending=worker.drain();assert.equal(worker.status().notifications[0].status,'sending');
 for(let i=0;i<2;i++){f.tick();f.accept(f.global,true);f.accept(f.cn1,true);f.accept(f.cn2,true);}
 release();await pending;at=Date.now()+360000;await worker.drain();assert.equal(sent,2);assert.ok(worker.status().notifications.every(n=>n.status==='sent'));
 }finally{await f.s.close();}
});
test('delayed notifications wait for fresh corroboration rather than sending expired block evidence',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++){f.tick();f.accept(f.global,true);f.accept(f.cn1,false);f.accept(f.cn2,false);}
 f.advance(181000);await f.m.drain();assert.equal(f.sent.length,0);assert.equal(f.m.status().notifications[0].code,'waiting_for_fresh_evidence');
 // Long probe gaps reset consecutive failure counts.
 for(let i=0;i<3;i++)await f.tcpRound();assert.equal(f.sent.length,1);
 }finally{await f.s.close();}
});
test('deleting an observer prunes its configuration and restarts evidence collection',async()=>{
 const f=await fixture();try{
 assert.equal((await f.s.call(`/nodes/${f.cn1.id}`,'DELETE')).status,200);assert.ok(!f.m.settings().cnProbeIds.includes(f.cn1.id));assert.match(f.m.status().notice,/不足/);
 }finally{await f.s.close();}
});

test('malformed result entries cannot abort a heartbeat or discard valid observations',async()=>{
 const f=await fixture();try{
 f.tick();const p=f.m.plan(f.cn1);
 assert.doesNotThrow(()=>f.m.accept(f.cn1,{planId:p.id,results:[null,17,{id:p.targets[0].id,ok:false,code:'timeout'}]}));
 assert.equal(f.m.status().incidents.length,1);
 }finally{await f.s.close();}
});

test('status re-evaluates quorum freshness even without another target heartbeat',async()=>{
 const f=await fixture();try{
 for(let i=0;i<3;i++)await f.tcpRound();
 // A slower global round must not keep expired mainland failures marked confirmed.
 const r=f.m.status().incidents.find(r=>r.kind==='tcp');r.samples[f.global.id].periodMs=600000;f.s.store.put('monitor',r.id,r);
 f.advance(181000);const current=f.m.status().incidents.find(x=>x.id===r.id);
 assert.equal(current.assessment,'insufficient');assert.equal(current.active,true,'retain incident history until confirmed recovery');
 }finally{await f.s.close();}
});

test('Telegram rejects non-object JSON responses without throwing',async()=>{
 for(const body of [null,17,'ok',[]]){
  const result=await sendTelegram(cfg,'test',async()=>response(body));assert.equal(result.ok,false);
 }
});
