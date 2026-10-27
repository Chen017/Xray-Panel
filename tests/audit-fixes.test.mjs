import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {brotliCompressSync,gzipSync} from 'node:zlib';
import {writeFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import * as age from 'age-encryption';
import {testSystem,fixtureBundle,settings} from './helpers.mjs';
import {compileDevices,patchRouting,patchSettings,providerProxies,providerLinks,newBundle,readSettings,hashBundle} from '../shared/config.mjs';

const master='a'.repeat(64),node={id:randomUUID(),name:'audit',ipv4:'203.0.113.1',ipv6:'2001:db8::1'};
const device=()=>({id:randomUUID(),epoch:randomUUID(),grants:[{nodeId:node.id,routes:['1'],modes:['split','single4','vision4']}]});
const relay=()=>({role:'line',landings:[{id:'1',name:'landing',landing_ip:'198.51.100.1',landing_port:24443,transport_uuid:randomUUID(),client_uuid:randomUUID(),encryption:'mlkem768x25519plus.native.0rtt.test'}],failover:{enabled:true,interval:'60s',order:['1']}});

test('private refusal precedes relay, loopback, per-device and custom routes, including imported legacy bundles',()=>{
  const base=fixtureBundle();base.files['config.json'].routing.rules.unshift({type:'field',ip:['127.0.0.1'],outboundTag:'direct'});
  for(const b of [base,patchRouting(base,{relay:relay(),customRules:[{type:'field',ip:['127.0.0.1'],outboundTag:'direct'}]})]){
    const compiled=compileDevices(b,node,[device()],master),rules=compiled.files['config.json'].routing.rules;
    assert.deepEqual(rules[0],{type:'field',ip:['geoip:private'],outboundTag:'block'});
    assert.equal(compiled.files['config.json'].routing.domainStrategy,'IPOnDemand');
    assert.ok(rules.slice(1).some(r=>r.outboundTag==='direct'));
  }
});

test('empty native XHTTP defaults and null XMUX export without touching unrelated inbounds',()=>{
  for(const xhttp of [undefined,null,{}, {path:'/null-xmux',xmux:null}]){
    let b=fixtureBundle(),f=b.files['conf/VLESS-443.json'];
    f.inbounds[2].streamSettings.xhttpSettings=xhttp;
    const extra=[{tag:'http-extra',protocol:'http',listen:'127.0.0.1',port:8080},{tag:'unrelated-vless',protocol:'vless',settings:{clients:[]},streamSettings:{network:'ws'}}];
    f.inbounds.push(...structuredClone(extra));const d=device();d.grants[0].routes=['direct'];
    b=patchRouting(b,{relay:relay()});b=compileDevices(b,node,[d],master);
    assert.deepEqual(b.files['conf/VLESS-443.json'].inbounds.slice(3),extra);
    assert.equal(providerProxies(node,b,d,master).length,3);assert.equal(providerLinks(node,b,d,master).length,3);
    assert.ok(!providerLinks(node,b,d,master).some(link=>link.includes('mode=undefined')));
    assert.equal(readSettings(b).path,xhttp?.path??'/');
    const edited=patchSettings(b,readSettings(b));assert.deepEqual(edited.files['conf/VLESS-443.json'].inbounds.slice(3),extra);
  }
});

test('legacy multi-file XHTTP sockets migrate independently, preserving paths, UUIDs and advanced fields',()=>{
  const base=fixtureBundle(),second=settings();second.port=8443;second.path='/second';
  base.files['conf/VLESS-8443.json']=newBundle(second).files['conf/VLESS-8443.json'];
  const before=structuredClone(base);
  for(const [name,f] of Object.entries(base.files).filter(([n])=>n.startsWith('conf/'))){
    f.inbounds[2].listen='@xhttp_inner';f.inbounds[2].tag='local_xhttp_stream_up';
    for(const i of f.inbounds.slice(0,2))i.settings.fallbacks[0].dest='@xhttp_inner';
  }
  const b=compileDevices(base,node,[],master),files=Object.entries(b.files).filter(([n])=>n.startsWith('conf/'));
  assert.equal(new Set(files.map(([,f])=>f.inbounds[2].tag)).size,2);assert.equal(new Set(files.map(([,f])=>f.inbounds[2].listen)).size,2);
  for(const [name,f] of files){for(const i of f.inbounds.slice(0,2))assert.equal(i.settings.fallbacks[0].dest,f.inbounds[2].listen);assert.deepEqual(f.inbounds[2].settings,before.files[name].inbounds[2].settings);assert.deepEqual(f.inbounds[2].streamSettings,before.files[name].inbounds[2].streamSettings);}
  assert.equal(hashBundle(compileDevices(b,node,[],master)),hashBundle(b));
});

test('failover loopback selection stays ahead of device rules to avoid cycling back to the first landing',()=>{
  const r=relay();r.landings.push({...r.landings[0],id:'2',name:'second'});r.failover.order=['1','2'];
  const b=compileDevices(patchRouting(fixtureBundle(),{relay:r}),node,[device()],master),rules=b.files['config.json'].routing.rules;
  const loop=rules.findIndex(r=>r.inboundTag?.includes('from-loop-relay-2'));
  const scoped=rules.findIndex(r=>r.user?.some(u=>u.startsWith('panel-')));
  assert.ok(loop>0&&loop<scoped);assert.equal(rules[loop].balancerTag,'relay-balancer-2');
});

test('all JSON parsers reject compressed bodies, including authenticated restore',async()=>{
  const s=await testSystem();try{
    for(const [encoding,compress] of [['br',brotliCompressSync],['gzip',gzipSync]])for(const [url,route] of [[s.urls[0],'/api/login'],[s.urls[1],'/unknown'],[s.urls[2],'/v1/agent/poll']]){
      const r=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':encoding,Origin:s.config.adminOrigin},body:compress(Buffer.from('{}'))});assert.equal(r.status,415);
    }
    await s.login();const session=(await s.call('/session')).body;
    const r=await fetch(s.urls[0]+'/api/restore',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'br',Origin:s.config.adminOrigin,Cookie:s.getCookie(),'X-CSRF-Token':session.csrf},body:brotliCompressSync(Buffer.from('{}'))});assert.equal(r.status,415);
  }finally{await s.close();}
});

test('maintenance blocks all external writes and task dispatch while health remains available',async()=>{
  const s=await testSystem();try{
    await s.login();const marker=path.join(s.dir,'.panel-maintenance');writeFileSync(marker,'upgrade');
    assert.equal((await s.call('/nodes','POST',{name:'must not exist'})).status,503);
    assert.equal((await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503);
    assert.equal((await fetch(s.urls[0]+'/api/health')).status,200);
    assert.equal((await fetch(s.urls[1]+'/health')).status,200);assert.equal(s.store.list('node').length,0);
    unlinkSync(marker);assert.equal((await s.call('/nodes','POST',{name:'after maintenance'})).status,201);
  }finally{await s.close();}
});

test('abandon expired leases without losing revocations; reject late acknowledgements and permit recovery/deletion',async()=>{
  const s=await testSystem();try{
    await s.login();const c=(await s.call('/nodes','POST',{name:'offline',ipv4:'203.0.113.1'})).body,id=c.node.id,bundle=fixtureBundle();
    const headers={'Content-Type':'application/json','X-Node-ID':id,Authorization:`Bearer ${c.agentToken}`};
    const poll=async()=>{const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers,body:JSON.stringify({report:{},bundle})});return r.json();};
    await poll();const publicKey=await age.identityToRecipient(await age.generateIdentity());
    const d=(await s.call('/devices','POST',{name:'to revoke',publicKey,grants:[{nodeId:id,routes:['direct'],modes:['vision4']}]})).body;
    const {job}=await poll();assert.ok(job);assert.equal((await s.call(`/jobs/${job.id}/abandon`,'POST',{})).status,409);
    await s.call(`/devices/${d.device.id}/revoke`,'POST',{});
    const stored=s.store.get('job',job.id);stored.leaseUntil=Date.now()-1;s.store.put('job',job.id,stored);
    assert.equal((await s.call('/jobs')).body.find(j=>j.id===job.id).canAbandon,true);
    assert.equal((await s.call(`/jobs/${job.id}/abandon`,'POST',{})).status,200);
    assert.equal(s.store.get('node',id).needsSync,true);assert.equal(s.store.get('job',job.id).leaseHash,undefined);
    const late=await fetch(s.urls[2]+`/v1/agent/jobs/${job.id}/result`,{method:'POST',headers,body:JSON.stringify({lease:job.lease,ok:true,bundle:job.payload.bundle})});assert.equal(late.status,409);assert.equal(s.store.get('node',id).applied,undefined);
    assert.equal((await s.call(`/nodes/${id}/actions`,'POST',{action:'inspect'})).status,202);
    const queued=(await s.call('/jobs')).body.find(j=>j.status==='queued');await s.call(`/jobs/${queued.id}/cancel`,'POST',{});
    assert.equal((await s.call(`/nodes/${id}`,'DELETE')).status,200);
    assert.ok(s.store.audits().some(a=>a.action==='job.abandoned'));
  }finally{await s.close();}
});

test('SNI monitoring switches to observed runtime after external edits and rejects old plans',async()=>{
  const s=await testSystem();try{
    await s.login();const c=(await s.call('/nodes','POST',{name:'sni',ipv4:'203.0.113.1'})).body;
    const b=fixtureBundle(),n=s.store.get('node',c.node.id);n.applied=b;n.observed=structuredClone(b);n.report={monitorProtocol:3};s.store.put('node',n.id,n);
    s.monitoring.save({enabled:true,botToken:'123456789:Test_only_token_abcdefghijklmnopqrstuvwxyz',chatId:'-100123',threadId:null,interval:60,failures:2,recoveries:2});
    const old=s.monitoring.plan(n);assert.ok(old.targets.some(t=>t.host==='example.com'));
    n.observed=patchSettings(b,{...readSettings(b),sni4:'changed.example.net'});n.monitorPlan=old;s.store.put('node',n.id,n);
    s.monitoring.accept(n,{planId:old.id,results:old.targets.map(t=>({id:t.id,ok:false,code:'timeout',domestic:false,global:true}))});
    assert.ok(!s.store.list('monitor').some(m=>m.host==='example.com'));
    // Recreate the outstanding old plan so plan() must invalidate it immediately.
    const current=s.store.get('node',n.id);current.monitorPlan=old;s.store.put('node',n.id,current);
    const fresh=s.monitoring.plan(current);assert.ok(fresh.targets.some(t=>t.host==='changed.example.net'));assert.notEqual(fresh.id,old.id);
    assert.equal(readSettings(s.store.get('node',n.id).applied).sni4,'example.com');
    const oldTarget=old.targets.find(t=>t.kind==='sni');
    s.store.put('monitor',oldTarget.id,{...oldTarget,id:oldTarget.id,active:true,alertDelivered:true,samples:{[n.id]:{ok:false,count:3,at:Date.now(),region:'self'}}});
    // A second target change retires evidence even if that hostname is later reused.
    const next=s.store.get('node',n.id);next.observed=patchSettings(b,{...readSettings(b),sni4:'third.example.net'});s.store.put('node',n.id,next);s.monitoring.plan(next);
    assert.deepEqual(s.store.get('monitor',oldTarget.id).samples,{});
  }finally{await s.close();}
});
