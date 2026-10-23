import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { compileDevices,providerProxies,providerLinks,readSettings,patchSettings,patchRouting,hashBundle,validateBundle,vlessLink,newBundle } from '../shared/config.mjs';
import { settings,fixtureBundle } from './helpers.mjs';
const master='a'.repeat(64),node={id:randomUUID(),name:'东京 "线路"',ipv4:'203.0.113.1',ipv6:'2001:db8::1'};
function device(){return{id:randomUUID(),epoch:randomUUID(),revoked:false,grants:[{nodeId:node.id,routes:['direct'],modes:['split','single4','single6','vision4','vision6']}]};}
test('standard settings preserve independent stack SNI and Short IDs',()=>{const b=fixtureBundle(),s=readSettings(b);assert.equal(s.sni4,'example.com');assert.equal(s.shortIds6[1],'fedcba9876543210');assert.equal(s.path,'/api/v3/updates');});
test('parameter edits preserve original non-panel clients and advanced XHTTP fields',()=>{let b=fixtureBundle(),s=readSettings(b);s.port=8443;s.v6Uplink=true;s.path='/new/path';s.xhttp.serverMaxHeaderBytes=10000;b=patchSettings(b,s);assert.equal(readSettings(b).port,8443);assert.equal(b.files['conf/is_v6_uplink'],true);assert.equal(readSettings(b).xhttp.serverMaxHeaderBytes,10000);assert.equal(b.files['conf/VLESS-443.json'].inbounds[0].settings.clients[0].id,s.uuid);});
test('reject unsafe filenames and malformed port, domains, UUIDs',()=>{for(const name of ['../config.json','conf/../../escape.json','conf/a/b.json','/etc/passwd','conf/../x.json']){const b=fixtureBundle();b.files[name]={};assert.throws(()=>validateBundle(b));}const b=fixtureBundle(),s=readSettings(b);assert.throws(()=>patchSettings(b,{...s,port:8080}));assert.throws(()=>patchSettings(b,{...s,sni4:'$(id).com'}));assert.throws(()=>patchSettings(b,{...s,uuid:'invalid'}));});
test('reject mismatched REALITY key pair before saving',()=>{const b=fixtureBundle(),s=readSettings(b),other=settings();assert.throws(()=>patchSettings(b,{...s,publicKey:other.publicKey}),/公钥与私钥不匹配/);});
test('each device gets distinct stable UUIDs and revoked clients are removed',()=>{const b=fixtureBundle(),d=device(),e=device();const out=compileDevices(b,node,[d,e],master),p=providerProxies(node,out,d,master),q=providerProxies(node,out,e,master);assert.equal(p.length,5);assert.notEqual(p[0].uuid,q[0].uuid);assert.equal(p[0].uuid,providerProxies(node,compileDevices(b,node,[d],master),d,master)[0].uuid);assert.equal(providerProxies(node,compileDevices(out,node,[{...d,revoked:true},e],master),d,master).length,0);});
test('no publication before the device UUID exists in every applicable inbound',()=>{const d=device();assert.deepEqual(providerProxies(node,fixtureBundle(),d,master),[]);});
test('UUID rotation requires newly deployed identity',()=>{const d=device(),b=compileDevices(fixtureBundle(),node,[d],master),rotated={...d,epoch:randomUUID()};assert.equal(providerProxies(node,b,rotated,master).length,0);assert.notEqual(providerProxies(node,b,d,master)[0].uuid,providerProxies(node,compileDevices(b,node,[rotated],master),rotated,master)[0].uuid);});
test('split direction and IPv6 download stay consistent with deployed config',()=>{const d=device(),b=fixtureBundle();b.files['conf/is_v6_uplink']=true;const p=providerProxies(node,compileDevices(b,node,[d],master),d,master)[0];assert.equal(p.server,node.ipv6);assert.equal(p.servername,'www.example.com');assert.equal(p['xhttp-opts']['download-settings'].server,node.ipv4);assert.equal(p['reality-opts']['short-id'],'fedcba9876543210');assert.equal(p['xhttp-opts']['uplink-http-method'],'PUT');assert.equal(p['xhttp-opts']['reuse-settings']['max-concurrency'],'16-32');assert.ok(!('sc-stream-up-server-secs' in p['xhttp-opts']));});
test('single stack suppresses unusable modes and server secrets never enter subscriptions',()=>{const d=device(),b=compileDevices(fixtureBundle(),node,[d],master),p=providerProxies({...node,ipv6:''},b,d,master);assert.equal(p.length,2);const text=JSON.stringify(p);assert.ok(!text.includes(readSettings(b).privateKey));assert.ok(!text.includes('decryption'));});
test('custom rules are placed before base blocking rules',()=>{const rule={type:'field',domain:['domain:kimi.ai'],outboundTag:'direct'};const b=patchRouting(fixtureBundle(),{customRules:[rule]});assert.deepEqual(b.files['config.json'].routing.rules[0],rule);assert.equal(b.files['config.json'].routing.rules[1].domain[0],'geosite:cn');});
test('multi-landing relay and failover order produce distinct per-device route UUIDs',()=>{const d=device();const landings=['1','2'].map(id=>({id,name:`落地 ${id}`,landing_ip:'198.51.100.'+id,landing_port:24443,transport_uuid:randomUUID(),encryption:'mlkem768x25519plus.native.0rtt.test',client_uuid:randomUUID()}));d.grants[0].routes=['direct','1','2'];const base=patchRouting(fixtureBundle(),{relay:{role:'line',landings,failover:{enabled:true,interval:'30s',order:['2','1']}}}),b=compileDevices(base,node,[d],master),m=b.files['config.json'];assert.equal(m.routing.balancers[0].tag,'relay-balancer-2');assert.equal(m.routing.balancers[0].fallbackTag,'loop-relay-1');assert.equal(m.routing.balancers[1].fallbackTag,'direct');assert.equal(new Set(providerProxies(node,b,d,master).map(p=>p.uuid)).size,3);assert.ok(m.routing.rules.some(r=>r.user?.some(u=>u.startsWith('panel-'))&&r.balancerTag==='relay-balancer-2'));});
test('relay removal removes all relay clients and generated outbounds',()=>{let b=fixtureBundle();const l={id:'1',name:'A',landing_ip:'198.51.100.1',landing_port:24443,transport_uuid:randomUUID(),encryption:'mlkem768x25519plus.native.0rtt.test',client_uuid:randomUUID()};b=patchRouting(b,{relay:{role:'line',landings:[l],failover:{enabled:false,interval:'60s',order:[]}}});b=patchRouting(b,{relay:{role:'none'}});assert.ok(!b.files['relay.json']);assert.ok(!b.files['config.json'].outbounds.some(o=>o.tag.startsWith('relay-')));assert.ok(!JSON.stringify(b).includes(l.client_uuid));});
test('reject unknown and duplicated failover IDs',()=>{const l={id:'1',name:'A',landing_ip:'198.51.100.1',landing_port:24443,transport_uuid:randomUUID(),encryption:'mlkem768x25519plus.native.0rtt.test',client_uuid:randomUUID()};assert.throws(()=>patchRouting(fixtureBundle(),{relay:{role:'line',landings:[l],failover:{enabled:true,interval:'60s',order:['2']}}}));});
test('hash is key-order invariant and VLESS split exports retain downloadSettings',()=>{assert.equal(hashBundle({b:2,a:1}),hashBundle({a:1,b:2}));const d=device(),b=compileDevices(fixtureBundle(),node,[d],master),p=providerProxies(node,b,d,master)[0];const url=new URL(vlessLink(p,readSettings(b)));assert.equal(url.protocol,'vless:');assert.equal(JSON.parse(url.searchParams.get('extra')).downloadSettings.address,node.ipv6);});
test('Node and Python hash integers, float exponents, negative zero and Unicode identically',()=>{const value={numbers:[0,-0,1,1.0,1.25,0.000001,1e-7,1e21,9007199254740992,-1.5],text:'测试线路 🗾',nested:{yes:true,no:false,nil:null}};const result=spawnSync(process.platform==='win32'?'python':'python3',['-c',"import sys,json;sys.path.insert(0,'agent');import agent;print(agent.bundle_hash(json.load(sys.stdin)))"],{input:JSON.stringify(value),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),hashBundle(value));});

test('reused landing IDs retain their intended outbound for every original client',()=>{
  for(const ids of [['1','2'],['2','1'],['3','1','2']])for(const enabled of [false,true]){
    const landings=ids.map(id=>({id,name:`Landing ${id}`,landing_ip:`198.51.100.${id}`,landing_port:24443,transport_uuid:randomUUID(),client_uuid:randomUUID(),encryption:'mlkem768x25519plus.native.0rtt.test'}));
    const b=patchRouting(fixtureBundle(),{relay:{role:'line',landings,failover:{enabled,interval:'60s',order:[...ids].reverse()}}}),main=b.files['config.json'];
    for(const inbound of b.files['conf/VLESS-443.json'].inbounds)for(const landing of landings){
      const client=inbound.settings.clients.find(c=>c.id===landing.client_uuid),rule=main.routing.rules.find(r=>r.user?.includes(client.email));
      const tag=enabled?main.routing.balancers.find(v=>v.tag===rule.balancerTag).selector[0]:rule.outboundTag;
      assert.equal(main.outbounds.find(o=>o.tag===tag).settings.address,landing.landing_ip,`${ids}: ${client.email}`);
    }
  }
});

test('custom XHTTP Host survives provider generation and VLESS upload/download export',()=>{
  const d=device(),base=fixtureBundle();base.files['conf/VLESS-443.json'].inbounds[2].streamSettings.xhttpSettings.host='transport.example.com';
  const b=compileDevices(base,node,[d],master),p=providerProxies(node,b,d,master)[0],url=new URL(vlessLink(p,readSettings(b))),extra=JSON.parse(url.searchParams.get('extra'));
  assert.equal(p.servername,'example.com');assert.equal(p['xhttp-opts'].host,'transport.example.com');
  assert.equal(p['xhttp-opts']['download-settings'].host,'transport.example.com');
  assert.equal(url.searchParams.get('host'),'transport.example.com');assert.equal(extra.host,'transport.example.com');
  assert.equal(extra.downloadSettings.xhttpSettings.host,'transport.example.com');
});

test('each inbound file keeps its native XHTTP fields in exported links',()=>{
  const d=device(),b=fixtureBundle(),second=settings();second.port=8443;second.path='/second';second.xhttp={...second.xhttp,path:second.path,uplinkHTTPMethod:'POST',sessionKey:'other-session'};
  b.files['conf/VLESS-8443.json']=newBundle(second).files['conf/VLESS-8443.json'];
  const compiled=compileDevices(b,node,[d],master),links=providerLinks(node,compiled,d,master).map(value=>new URL(value));
  const other=links.find(url=>url.port==='8443'&&url.searchParams.get('type')==='xhttp'),extra=JSON.parse(other.searchParams.get('extra'));
  assert.equal(other.searchParams.get('path'),'/second');assert.equal(extra.path,'/second');assert.equal(extra.uplinkHTTPMethod,'POST');assert.equal(extra.sessionKey,'other-session');
  assert.equal(extra.downloadSettings.xhttpSettings.path,'/second');
  const first=links.find(url=>url.port==='443'&&url.searchParams.get('type')==='xhttp');assert.equal(JSON.parse(first.searchParams.get('extra')).uplinkHTTPMethod,'PUT');
  assert.ok(!JSON.stringify(providerProxies(node,compiled,d,master)).includes(second.privateKey));
});
