import test from 'node:test';
import assert from 'node:assert/strict';
import * as age from 'age-encryption';
import {testSystem,fixtureBundle,settings} from './helpers.mjs';
import {patchSettings,readSettings,deviceUuid,newBundle} from '../shared/config.mjs';
import {draftPatch,editorChanged} from '../web/editor-state.ts';

async function fixture(){
  const s=await testSystem();await s.login();
  const c=(await s.call('/nodes','POST',{name:'Regression fixture',ipv4:'203.0.113.1',ipv6:'2001:db8::1'})).body;
  let current=fixtureBundle();
  const headers={'Content-Type':'application/json','X-Node-ID':c.node.id,Authorization:`Bearer ${c.agentToken}`};
  const poll=async(report={installed:true},includeBundle=true)=>{
    const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers,body:JSON.stringify({report,...(includeBundle?{bundle:current}:{})})});
    assert.equal(r.status,200,await r.clone().text());return r.json();
  };
  const submit=async(job,ok,bundle=current)=>{
    const r=await fetch(`${s.urls[2]}/v1/agent/jobs/${job.id}/result`,{method:'POST',headers,body:JSON.stringify({lease:job.lease,ok,bundle,output:ok?'completed':'temporary failure'})});
    assert.equal(r.status,200,await r.text());
  };
  const success=async job=>{current=job.payload.bundle;await submit(job,true);};
  const node=()=>s.store.get('node',c.node.id);
  const due=()=>{const n=node();n.syncRetryAt=Date.now()-1;s.store.put('node',n.id,n);};
  const device=async()=>{const publicKey=await age.identityToRecipient(await age.generateIdentity());return(await s.call('/devices','POST',{name:'Device',publicKey,grants:[{nodeId:c.node.id,routes:['direct'],modes:['split','vision4']}]})).body;};
  await poll();
  return{s,id:c.node.id,poll,submit,success,node,due,device,setCurrent:b=>{current=b;},getCurrent:()=>current};
}

test('failed revocation retains pending state, backs off, then removes the old UUID',async()=>{
  const f=await fixture();try{
    const d=await f.device();await f.success((await f.poll()).job);
    const uuid=deviceUuid(f.s.config.masterKey,d.device,f.id,'direct');assert.ok(JSON.stringify(f.getCurrent()).includes(uuid));
    await f.s.call(`/devices/${d.device.id}/revoke`,'POST',{});
    const failed=(await f.poll()).job;await f.submit(failed,false);
    assert.equal(f.node().needsSync,true);assert.ok(f.node().syncRetryAt>Date.now());assert.equal((await f.poll()).job,null);
    f.due();const retry=(await f.poll()).job;assert.notEqual(retry.id,failed.id);assert.ok(!JSON.stringify(retry.payload.bundle).includes(uuid));
    await f.success(retry);assert.equal(f.node().needsSync,false);assert.ok(!JSON.stringify(f.getCurrent()).includes(uuid));
  }finally{await f.s.close();}
});

test('cancelling a queued deployment does not discard pending authorization changes',async()=>{
  const f=await fixture();try{
    await f.device();const j=(await f.s.call(`/nodes/${f.id}/deploy`,'POST',{revision:f.node().revision})).body;
    assert.equal((await f.s.call(`/jobs/${j.id}/cancel`,'POST',{})).status,200);
    assert.equal(f.node().needsSync,true);assert.equal((await f.poll()).job,null);
    f.due();const retry=(await f.poll()).job;assert.equal(retry.source,'device-sync');await f.success(retry);assert.equal(f.node().needsSync,false);
  }finally{await f.s.close();}
});

test('an older successful deployment cannot acknowledge a newer revocation',async()=>{
  const f=await fixture();try{
    const d=await f.device(),old=(await f.poll()).job;
    await f.s.call(`/devices/${d.device.id}/revoke`,'POST',{});await f.success(old);
    assert.equal(f.node().needsSync,true);const next=(await f.poll()).job;
    assert.ok(next.payload.syncRevision>old.payload.syncRevision);assert.ok(!JSON.stringify(next.payload.bundle).includes(`panel-${d.device.id}`));
    await f.success(next);assert.equal(f.node().needsSync,false);
  }finally{await f.s.close();}
});

test('a cached deployment result cannot overwrite a newer snapshot received at re-lease',async()=>{
  const f=await fixture();try{
    await f.s.call(`/nodes/${f.id}/deploy`,'POST',{revision:1});const first=(await f.poll()).job;
    const intended=first.payload.bundle,actual=patchSettings(intended,{...readSettings(intended),port:8443});
    f.setCurrent(actual);const stored=f.s.store.get('job',first.id);stored.leaseUntil=Date.now()-1;f.s.store.put('job',stored.id,stored);
    const retry=(await f.poll()).job;await f.submit(retry,true,intended);
    assert.equal(f.s.store.get('job',first.id).status,'failed');assert.equal(readSettings(f.node().observed).port,8443);assert.ok(!f.node().applied);
  }finally{await f.s.close();}
});

test('a malformed configuration report keeps the node online and allows diagnostics without auto-deploy',async()=>{
  const f=await fixture();try{
    await f.device();assert.equal((await f.poll({installed:true,configError:'JSONDecodeError'},false)).job,null);
    assert.equal((await f.s.call('/nodes')).body[0].online,true);assert.equal(f.node().needsSync,true);
    assert.equal((await f.s.call(`/nodes/${f.id}/deploy`,'POST',{revision:1})).status,409);
    assert.equal((await f.s.call(`/nodes/${f.id}/actions`,'POST',{action:'logs'})).status,202);
    const j=(await f.poll({installed:true,configError:'JSONDecodeError'},false)).job;assert.equal(j.action,'logs');await f.submit(j,true,null);
    assert.equal((await f.poll()).job.action,'deploy');
  }finally{await f.s.close();}
});

test('a backup over 2 MiB restores its records and revokes existing sessions',async()=>{
  const f=await fixture();try{
    for(let i=0;i<10;i++){const j=f.s.queue(f.node(),'logs');j.status='succeeded';j.output='log line\n'.repeat(19000);f.s.store.put('job',j.id,j);}
    const exported=await f.s.call('/backup'),backup=exported.body;assert.equal(exported.status,200);assert.ok(Buffer.byteLength(JSON.stringify(backup))>2*1024*1024);
    await f.s.call(`/nodes/${f.id}`,'PATCH',{name:'Changed after backup'});
    assert.equal((await f.s.call('/restore','POST',backup)).status,200);assert.equal((await f.s.call('/nodes')).status,401);
    await f.s.login();assert.equal((await f.s.call('/nodes')).body[0].name,'Regression fixture');assert.equal(f.s.store.list('job').length,10);
    assert.equal((await f.s.call(`/nodes/${f.id}/draft`,'PUT',{padding:'x'.repeat(2*1024*1024)})).status,413);
  }finally{await f.s.close();}
});

test('restoring a backup requires authentication and CSRF before parsing a larger body',async()=>{
  const s=await testSystem();try{
    assert.equal((await s.call('/restore','POST',{invalid:true})).status,401);await s.login();
    assert.equal((await s.call('/restore','POST',{invalid:true},{headers:{'X-CSRF-Token':'bad'}})).status,403);
  }finally{await s.close();}
});

test('the links API uses the XHTTP settings belonging to each published file',async()=>{
  const f=await fixture();try{
    const b=f.getCurrent(),second=settings();second.port=8443;second.path='/second-node';second.xhttp={...second.xhttp,path:second.path,uplinkHTTPMethod:'POST'};
    b.files['conf/VLESS-8443.json']=newBundle(second).files['conf/VLESS-8443.json'];f.setCurrent(b);await f.poll();
    const d=await f.device();await f.success((await f.poll()).job);
    const links=(await f.s.call(`/devices/${d.device.id}/links`)).body.split('\n').map(v=>new URL(v)),secondLink=links.find(v=>v.port==='8443'&&v.searchParams.get('type')==='xhttp');
    const extra=JSON.parse(secondLink.searchParams.get('extra'));assert.equal(extra.path,'/second-node');assert.equal(extra.uplinkHTTPMethod,'POST');
  }finally{await f.s.close();}
});

function baseline(){const s=settings();return{nodeId:'test',revision:4,hasSettings:true,settings:s,xhttp:JSON.stringify(s.xhttp),raw:'{"files":{}}',rules:[],relay:{role:'none'},firewall:'{"open":[],"closed":[]}'};}
test('saving a draft combines modified fields across tabs in one revision',()=>{
  const b=baseline(),current=structuredClone(b);current.settings.sni4='changed.example.com';current.rules=[{type:'field',domain:['domain:test.example'],outboundTag:'direct'}];current.firewall='{"open":[443],"closed":[]}';
  const patch=draftPatch(current,b);assert.equal(patch.revision,4);assert.equal(patch.settings.sni4,'changed.example.com');assert.deepEqual(patch.customRules,current.rules);assert.deepEqual(patch.firewall.open,[443]);
  assert.equal(draftPatch(b,b),null);assert.equal(editorChanged(current,b),true);
});
test('conflicting raw and form edits are retained instead of silently overwriting either',()=>{
  const b=baseline(),current=structuredClone(b);current.raw='{"files":{"config.json":{}}}';current.settings.sni4='changed.example.com';
  assert.throws(()=>draftPatch(current,b),/完整配置与表单/);assert.equal(current.settings.sni4,'changed.example.com');
  current.settings=b.settings;assert.equal(draftPatch(current,b).bundle.files['config.json']!==undefined,true);
});
