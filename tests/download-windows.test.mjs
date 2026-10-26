import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as age from 'age-encryption';
import YAML from 'yaml';
import {fixtureBundle,settings,testSystem} from './helpers.mjs';
import {compileDevices,providerProxies,providerNameEntries,newBundle,patchRouting,hashBundle} from '../shared/config.mjs';
import {MIB,parseH2Window,formatH2Window,H2_WINDOW_MAX} from '../shared/h2-window.mjs';

test('M inputs become bounded integer bytes accepted by the fork',()=>{
  for(const [value,bytes] of [['1M',MIB],['10M',10*MIB],['1.5M',1.5*MIB],[' 8m ',8*MIB],['2',2*MIB],['2047M',2047*MIB]])assert.equal(parseH2Window(value),bytes);
  assert.equal(parseH2Window(`${H2_WINDOW_MAX/MIB}M`),H2_WINDOW_MAX);
  for(const bytes of [1,10,1048575,MIB,10*MIB,H2_WINDOW_MAX])assert.equal(parseH2Window(formatH2Window(bytes)),bytes);
  for(const value of ['',0,'0M','-1M','2048M','Infinity','NaN','1MB','1e2M','1M junk','0.000000001M'])assert.throws(()=>parseH2Window(value));
});

test('windows distinguish devices, files and routes while preserving downloads and server config',()=>{
  const master='a'.repeat(64),node={id:randomUUID(),name:'A',ipv4:'203.0.113.1',ipv6:'2001:db8::1'};
  let base=fixtureBundle();const second=settings();second.port=8443;base.files['conf/VLESS-8443.json']=newBundle(second).files['conf/VLESS-8443.json'];
  base=patchRouting(base,{relay:{role:'line',landings:[{id:'1',name:'落地',landing_ip:'198.51.100.1',landing_port:24443,transport_uuid:randomUUID(),client_uuid:randomUUID(),encryption:'mlkem768x25519plus.native.0rtt.test'}],failover:{enabled:false,interval:'60s',order:[]}}});
  const d={id:randomUUID(),epoch:'one',grants:[{nodeId:node.id,routes:['direct','1'],modes:['split','single4','vision4']}]},other={...d,id:randomUUID()};
  const deployed=compileDevices(base,node,[d,other],master),original=providerProxies(node,deployed,d,master),entries=providerNameEntries(node,deployed,d,master);
  const split=entries.filter(e=>e.mode==='split');assert.equal(split.length,4);
  d.downloadWindows=Object.fromEntries(split.slice(0,3).map((e,i)=>[e.key,(i+1)*MIB]));
  // Even malformed internal non-split overrides must not alter those transports.
  d.downloadWindows[entries.find(e=>e.mode==='single4').key]=8*MIB;
  const actual=providerProxies(node,deployed,d,master);
  for(let i=0;i<entries.length;i++){
    const expected=structuredClone(original[i]),bytes=entries[i].mode==='split'?d.downloadWindows[entries[i].key]:undefined;
    if(bytes)expected['xhttp-opts']['download-settings']['h2-max-receive-buffer-per-stream']=bytes;
    assert.deepEqual(actual[i],expected);
  }
  assert.deepEqual(providerProxies(node,deployed,other,master),providerProxies(node,deployed,{...other,downloadWindows:{}},master));
  assert.deepEqual(compileDevices(base,node,[d,other],master),deployed);
  const renamed={...node,subscriptionNames:{[split[0].key]:'新名称'}};
  assert.equal(providerProxies(renamed,deployed,d,master).find(p=>p.name==='新名称')['xhttp-opts']['download-settings']['h2-max-receive-buffer-per-stream'],MIB);
  delete d.downloadWindows;assert.deepEqual(providerProxies(node,deployed,d,master),original);
});

test('API persists per-device windows into preview and encrypted provider without deployment',async()=>{
  const s=await testSystem();try{
    await s.login();const n=(await s.call('/nodes','POST',{name:'窗口线路',ipv4:'203.0.113.1',ipv6:'2001:db8::1'})).body.node;
    const node=s.store.get('node',n.id);node.draft=fixtureBundle();s.store.put('node',n.id,node);
    const identity=await age.generateIdentity(),input={name:'设备 A',publicKey:await age.identityToRecipient(identity),grants:[{nodeId:n.id,routes:['direct'],modes:['split','single4','vision4']}]};
    const created=await s.call('/devices','POST',input);assert.equal(created.status,201);const d=created.body;
    node.applied=compileDevices(node.draft,node,[s.store.get('device',d.device.id)],s.config.masterKey);s.store.put('node',n.id,node);
    const endpoint=`/devices/${d.device.id}/download-windows`,catalog=(await s.call(endpoint)).body;
    assert.equal(catalog.entries.length,1);assert.deepEqual(catalog.windows,{});const key=catalog.entries[0].key;
    const before=hashBundle(s.store.get('node',n.id)),jobs=s.store.list('job').length;
    const save=windows=>s.call(endpoint,'PUT',{revision:catalog.revision,windows});
    for(const bytes of [0,-1,1.5,2147483648,'1048576',null])assert.equal((await save({[key]:bytes})).status,400);
    assert.equal((await save({'bad-key':MIB})).status,400);
    assert.equal((await save({['a'.repeat(40)]:MIB})).status,409);
    assert.equal((await save({[key]:parseH2Window('10M')})).status,200);
    assert.equal((await save({})).status,409,'stale save must not overwrite newer data');
    assert.equal((await s.call(endpoint)).body.windows[key],10*MIB);
    const preview=YAML.parse((await s.call(`/devices/${d.device.id}/preview`)).body).proxies;
    assert.equal(preview[0]['xhttp-opts']['download-settings']['h2-max-receive-buffer-per-stream'],10*MIB);
    const response=await fetch(d.url,{headers:{Authorization:`Bearer ${d.token}`}});assert.equal(response.status,200);
    const dec=new age.Decrypter();dec.addIdentity(identity);assert.deepEqual(YAML.parse(await dec.decrypt(age.armor.decode(await response.text()),'text')).proxies,preview);
    assert.equal(hashBundle(s.store.get('node',n.id)),before,'window writes must not alter node or deployment state');
    assert.equal(s.store.list('job').length,jobs);
    // A normal permission save must preserve windows configured in the separate dialog.
    assert.equal((await s.call(`/devices/${d.device.id}`,'PUT',input)).status,200);
    assert.equal((await s.call(endpoint)).body.windows[key],10*MIB);
    assert.equal(s.store.list('job').length,jobs);
    // Normal permission updates mark sync; isolate the window-only write comparison below.
    const current=s.store.get('node',n.id),savedHash=hashBundle(current);
    assert.equal((await s.call(endpoint,'PUT',{revision:1,windows:{}})).status,200);
    assert.equal(hashBundle(s.store.get('node',n.id)),savedHash);
    assert.equal((await s.call(endpoint)).body.revision,2);
    assert.ok(!((await s.call(`/devices/${d.device.id}/preview`)).body).includes('h2-max-receive-buffer-per-stream'));
    assert.equal((await s.call(endpoint,'PUT',{revision:2,windows:{[key]:H2_WINDOW_MAX}})).status,200);
    await s.call(`/devices/${d.device.id}/revoke`,'POST',{});
    assert.equal((await s.call(endpoint,'PUT',{revision:3,windows:{}})).status,409);
  }finally{await s.close();}
});
