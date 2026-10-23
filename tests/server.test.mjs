import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as age from 'age-encryption';
import YAML from 'yaml';
import { testSystem,fixtureBundle } from './helpers.mjs';
import { hashBundle } from '../shared/config.mjs';

test('admin authentication, origins, CSRF, credential isolation, draft CAS and encrypted database',async()=>{
  const s=await testSystem();try{
    assert.equal((await s.call('/nodes')).status,401);
    assert.equal((await s.call('/login','POST',{password:'wrong-password'},{headers:{Origin:'https://evil.invalid'}})).status,403);
    await s.login();
    assert.equal((await s.call('/nodes','POST',{name:'A'},{headers:{'X-CSRF-Token':'bad'}})).status,403);
    const created=await s.call('/nodes','POST',{name:'机密线路节点',ipv4:'203.0.113.4',ipv6:'2001:db8::4'});assert.equal(created.status,201);const n=created.body.node,agentToken=created.body.agentToken;
    assert.ok(!('agentHash' in n));
    assert.equal((await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers:{'Content-Type':'application/json','X-Node-ID':n.id,Authorization:'Bearer wrong'},body:JSON.stringify({report:{}})})).status,401);
    const b=fixtureBundle(),headers={'Content-Type':'application/json','X-Node-ID':n.id,Authorization:`Bearer ${agentToken}`};
    let poll=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers,body:JSON.stringify({bundle:b,report:{installed:true,active:true}})});assert.equal(poll.status,200);
    const nodes=(await s.call('/nodes')).body;assert.equal(nodes[0].online,true);assert.equal(nodes[0].revision,1);
    assert.equal((await s.call(`/nodes/${n.id}/draft`,'PUT',{revision:0,bundle:b})).status,409);
    assert.equal((await s.call(`/nodes/${n.id}/draft`,'PUT',{revision:1,bundle:b})).status,200);
    const landingBundle=structuredClone(b);landingBundle.files['relay.json']={role:'landing',listen_port:24443};
    assert.equal((await s.call(`/nodes/${n.id}/draft`,'PUT',{revision:2,bundle:landingBundle})).status,200);
    assert.equal((await s.call(`/nodes/${n.id}/draft`,'PUT',{revision:3,firewall:{open:[],closed:[24443]}})).status,400);
    for(const [url,route]of[[s.urls[1],'/api/nodes'],[s.urls[2],'/api/nodes'],[s.urls[1],'/v1/agent/poll']])assert.equal((await fetch(url+route,{headers})).status,404);
    const db=readFileSync(s.config.dbPath);assert.ok(!db.includes(Buffer.from('机密线路节点')));assert.ok(!db.includes(Buffer.from(agentToken)));
    assert.ok(!(await s.call('/nodes')).body[0].agentHash);
    assert.equal((await s.call(`/nodes/${n.id}/actions`,'POST',{action:'uninstall',confirm:'wrong'})).status,400);
    assert.equal((await s.call(`/nodes/${n.id}/actions`,'POST',{action:'shell',command:'id'})).status,400);
    const backup=await s.call('/backup');assert.equal(backup.status,200);assert.ok(backup.body.records.every(r=>r.kind!=='session'));assert.ok(!JSON.stringify(backup.body).includes('机密线路节点'));
    await s.call('/logout','POST',{});assert.equal((await s.call('/nodes')).status,401);
  }finally{await s.close();}
});

test('subscription publish gate, native age armor, secret isolation, rotation and revocation',async()=>{
  const s=await testSystem();try{await s.login();const created=(await s.call('/nodes','POST',{name:'测试线路',ipv4:'203.0.113.1',ipv6:'2001:db8::1'})).body,n=created.node,b=fixtureBundle();const ah={'Content-Type':'application/json','X-Node-ID':n.id,Authorization:`Bearer ${created.agentToken}`};
    const poll=async()=>{const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers:ah,body:JSON.stringify({report:{installed:true},bundle:b})});return r.json();};
    await poll();const identity=await age.generateIdentity(),publicKey=await age.identityToRecipient(identity);
    const d=(await s.call('/devices','POST',{name:'Laptop',publicKey,grants:[{nodeId:n.id,routes:['direct'],modes:['split','vision4']}]})).body;
    const fetchSub=auth=>fetch(d.url,{headers:auth?{Authorization:`Bearer ${auth}`}:{}});
    assert.equal((await fetchSub()).status,401);assert.equal((await fetch(d.url+'?token='+d.token)).status,401);assert.equal((await fetchSub(d.token)).status,503);
    const {job}=await poll();assert.equal(job.action,'deploy');assert.ok(!job.leaseHash);
    const submit=(body)=>fetch(s.urls[2]+`/v1/agent/jobs/${job.id}/result`,{method:'POST',headers:ah,body:JSON.stringify(body)});
    assert.equal((await submit({ok:true,lease:'bad',bundle:job.payload.bundle})).status,409);
    assert.equal((await submit({ok:true,lease:job.lease,bundle:job.payload.bundle,output:'valid'})).status,200);
    assert.equal((await submit({ok:true,lease:job.lease,bundle:job.payload.bundle})).status,409);
    const response=await fetchSub(d.token);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const armor=await response.text();assert.ok(armor.startsWith('-----BEGIN AGE ENCRYPTED FILE-----'));assert.ok(!armor.includes('uuid:'));
    const dec=new age.Decrypter();dec.addIdentity(identity);const text=await dec.decrypt(age.armor.decode(armor),'text'),data=YAML.parse(text);assert.equal(data.proxies.length,2);assert.ok(!text.includes('privateKey'));assert.ok(!text.includes('AGE-SECRET-KEY'));assert.notEqual(data.proxies[0].uuid,b.files['conf/VLESS-443.json'].inbounds[0].settings.clients[0].id);
    const wrong=new age.Decrypter();wrong.addIdentity(await age.generateIdentity());await assert.rejects(()=>wrong.decrypt(age.armor.decode(armor),'text'));
    const rotated=(await s.call(`/devices/${d.device.id}/rotate`,'POST',{rotateUuid:false})).body;assert.equal((await fetchSub(d.token)).status,401);assert.equal((await fetchSub(rotated.token)).status,200);
    await s.call(`/devices/${d.device.id}/revoke`,'POST',{});assert.equal((await fetchSub(rotated.token)).status,401);assert.equal((await s.call('/devices')).body[0].revoked,true);
  }finally{await s.close();}
});

test('failed deployment cannot publish and queued jobs can be cancelled',async()=>{
  const s=await testSystem();try{await s.login();const c=(await s.call('/nodes','POST',{name:'A'})).body,n=c.node,b=fixtureBundle(),ah={'Content-Type':'application/json','X-Node-ID':n.id,Authorization:`Bearer ${c.agentToken}`};const poll=async()=>{const r=await fetch(s.urls[2]+'/v1/agent/poll',{method:'POST',headers:ah,body:JSON.stringify({report:{},bundle:b})});return r.json();};await poll();const j=(await s.call(`/nodes/${n.id}/deploy`,'POST',{revision:1})).body;assert.equal((await s.call(`/nodes/${n.id}/actions`,'POST',{action:'restart'})).status,409);await s.call(`/jobs/${j.id}/cancel`,'POST',{});assert.equal((await poll()).job,null);
    await s.call(`/nodes/${n.id}/deploy`,'POST',{revision:1});const {job}=await poll();const r=await fetch(s.urls[2]+`/v1/agent/jobs/${job.id}/result`,{method:'POST',headers:ah,body:JSON.stringify({lease:job.lease,ok:false,output:'validation failed',bundle:b})});assert.equal(r.status,200);assert.ok(!(await s.call('/nodes')).body[0].applied);assert.equal((await s.call('/jobs')).body.find(j=>j.id===job.id).status,'failed');
  }finally{await s.close();}
});
