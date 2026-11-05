// Real Xray 26.3.27 + patched Mihomo, entirely on loopback. No VPS or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import YAML from 'yaml';
import {keypair,migrateNodeEntrypoints} from '../shared/config.mjs';

const windows=process.platform==='win32';
const xray=path.resolve(process.env.XRAY_NATIVE_BIN??`../Xray-Script/Xray/.test-tools/v26.3.27/xray${windows?'.exe':''}`);
const mihomo=process.env.MIHOMO_NAT_BIN;
assert.ok(mihomo,'Set MIHOMO_NAT_BIN to a build supporting independent XHTTP download dialers');
const scratchRoot=path.resolve('.local');fs.mkdirSync(scratchRoot,{recursive:true});
const dir=fs.mkdtempSync(path.join(scratchRoot,'nat-e2e-'));
const children=[];let origin,tlsTarget;
const run=(bin,args)=>new Promise((resolve,reject)=>{
  const p=spawn(bin,args,{windowsHide:true});let out='',error='';
  p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>error+=d);p.on('error',reject);p.on('exit',code=>resolve({code,out,error}));
});
const start=(bin,args)=>{
  const p=spawn(bin,args,{windowsHide:true});let log='';
  p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);
  const worker={p,log:()=>log};children.push(worker);return worker;
};
const stop=async worker=>{if(worker.p.exitCode!==null||worker.p.signalCode!==null)return;const exited=new Promise(r=>worker.p.once('exit',r));worker.p.kill();await exited;};
const listen=(server,host='127.0.0.1')=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,()=>resolve(server.address().port));});
const free=async(host='127.0.0.1')=>{const s=net.createServer(),port=await listen(s,host);await new Promise(r=>s.close(r));return port;};
const ready=async(port,worker)=>{
  for(let i=0;i<100;i++){
    assert.equal(worker.p.exitCode,null,worker.log());
    if(await new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.destroy();r(true);});s.on('error',()=>r(false));}))return;
    await new Promise(r=>setTimeout(r,50));
  }
  throw Error('Test listener did not start: '+worker.log());
};
try{
  const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
  const openssl=process.env.OPENSSL_BIN??(windows?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
  const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{encoding:'utf8',windowsHide:true});
  assert.equal(generated.status,0,generated.stderr);
  const payload='NAT-SPLIT-COMPLETE\n'.repeat(32768);
  origin=http.createServer((_,r)=>r.end(payload));
  tlsTarget=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert),minVersion:'TLSv1.3',ALPNProtocols:['h2','http/1.1']},(_,r)=>r.end(payload));
  const httpPort=await listen(origin),tlsPort=await listen(tlsTarget),linePort=await free('::'),inner=await free(),entry=await free(),mixed=await free(),controller=await free();
  const pair=keypair(),id=randomUUID(),entryId=randomUUID();
  const generatedKeys=spawnSync(xray,['vlessenc'],{encoding:'utf8',windowsHide:true});assert.equal(generatedKeys.status,0,generatedKeys.stderr);
  const auth=generatedKeys.stdout.slice(generatedKeys.stdout.indexOf('Authentication: X25519'));
  const value=name=>auth.match(new RegExp('"'+name+'"\\s*:\\s*"([^"]+)"'))[1];
  const algorithm=value('encryption').split('.')[0],padding='100-111-1111.75-0-111.50-0-3333';
  const enc=`${algorithm}.random.0rtt.${padding}.${value('encryption').split('.').at(-1)}`;
  const dec=`${algorithm}.random.600s.${padding}.${value('decryption').split('.').at(-1)}`;
  const server={log:{loglevel:'warning'},inbounds:[
    {tag:'line',listen:'::',port:linePort,protocol:'vless',settings:{clients:[{id,flow:'xtls-rprx-vision'}],decryption:'none',fallbacks:[{dest:inner}]},streamSettings:{network:'raw',security:'reality',realitySettings:{dest:`127.0.0.1:${tlsPort}`,serverNames:['localhost'],privateKey:pair.privateKey,shortIds:['12345678']},sockopt:{v6only:false}}},
    {listen:'127.0.0.1',port:inner,protocol:'vless',settings:{clients:[{id}],decryption:'none'},streamSettings:{network:'xhttp',security:'none',xhttpSettings:{path:'/test',mode:'stream-up'}}},
    {tag:'relay-entry-v4',listen:'127.0.0.1',port:entry,protocol:'vless',settings:{clients:[{id:entryId,email:'test-nat',flow:'xtls-rprx-vision'}],decryption:dec},streamSettings:{network:'raw',security:'none'}}
  ],outbounds:[{protocol:'freedom'}]};
  const transport={port:linePort,tls:true,servername:'localhost','client-fingerprint':'chrome',alpn:['h2'],'reality-opts':{'public-key':pair.publicKey,'short-id':'12345678'}};
  const proxies=[
    {name:'guard',type:'vless',server:'127.0.0.1',port:entry,uuid:entryId,network:'tcp',tls:false,encryption:enc,tfo:false},
    ...[false,true].map(reverse=>({name:reverse?'reverse':'split',type:'vless',server:reverse?'::1':'127.0.0.1',...transport,uuid:id,network:'xhttp',...(reverse?{}:{'dialer-proxy':'guard'}),'xhttp-opts':{mode:'stream-up',path:'/test',host:'localhost','download-settings':{...transport,server:reverse?'127.0.0.1':'::1',path:'/test',host:'localhost','dialer-proxy':reverse?'guard':''}}}))
  ];
  const client={'mixed-port':mixed,'external-controller':`127.0.0.1:${controller}`,'bind-address':'127.0.0.1','allow-lan':false,ipv6:true,'log-level':'warning','proxy-providers':{test:{type:'inline',payload:proxies}},'proxy-groups':[{name:'TEST',type:'select',use:['test']}],rules:['MATCH,TEST']};
  const serverFile=path.join(dir,'server.json'),clientFile=path.join(dir,'client.yaml');fs.writeFileSync(clientFile,YAML.stringify(client));
  const clientWorker=start(mihomo,['-d',dir,'-f',clientFile]);await ready(controller,clientWorker);
  const request=async(name,secure=false)=>{
    const selected=await fetch(`http://127.0.0.1:${controller}/proxies/TEST`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});assert.equal(selected.status,204);
    return run(windows?'curl.exe':'curl',['--silent','--show-error','--http1.1','--insecure','--noproxy','','--max-time','5','--proxy',`http://127.0.0.1:${mixed}`,`${secure?'https':'http'}://127.0.0.1:${secure?tlsPort:httpPort}/`]);
  };
  fs.writeFileSync(serverFile,JSON.stringify(server));let serverWorker=start(xray,['run','-c',serverFile]);await ready(entry,serverWorker);
  const rejected=await request('split');assert.notEqual(rejected.out,payload,'Legacy Vision entry unexpectedly carried the split TLS upload');
  console.log('PASS old public-entry Vision reproduces the split failure');await stop(serverWorker);
  migrateNodeEntrypoints({files:{'conf/99_relay_in.json':{inbounds:server.inbounds}}});
  fs.writeFileSync(serverFile,JSON.stringify(server));serverWorker=start(xray,['run','-c',serverFile]);await ready(entry,serverWorker);
  // The persistent client may still hold a ticket from the old Xray process.
  // A rejected early request is not replayed; the next connection must recover.
  await request('guard');
  server.inbounds.find(i=>i.tag==='relay-entry-v4').sniffing={enabled:true,destOverride:['tls','http'],routeOnly:true};
  server.outbounds=[{tag:'direct',protocol:'freedom'},{tag:'block',protocol:'blackhole'}];
  server.routing={rules:[{type:'field',domain:['full:localhost'],outboundTag:'block'}]};
  await stop(serverWorker);fs.writeFileSync(serverFile,JSON.stringify(server));serverWorker=start(xray,['run','-c',serverFile]);await ready(entry,serverWorker);
  await request('guard');const blocked=await request('split');assert.notEqual(blocked.out,payload,'SNI block did not reproduce NAT transport failure');
  server.routing.rules.unshift({type:'field',inboundTag:['relay-entry-v4'],user:['test-nat'],ip:['127.0.0.1'],port:String(linePort),network:'tcp',outboundTag:'direct'});
  await stop(serverWorker);fs.writeFileSync(serverFile,JSON.stringify(server));serverWorker=start(xray,['run','-c',serverFile]);await ready(entry,serverWorker);await request('guard');
  console.log('PASS sniffed SNI block reproduced and scoped line transport rule restores connection');
  for(const name of ['guard','split','reverse'])for(const secure of [false,true]){
    const result=await request(name,secure);assert.equal(result.code,0,result.error);assert.ok(result.out===payload,`${name} returned ${result.out.length}/${payload.length} bytes of ${secure?'HTTPS':'HTTP'} content`);
  }
  await stop(serverWorker);serverWorker=start(xray,['run','-c',serverFile]);await ready(entry,serverWorker);
  await request('guard');
  for(let i=0;i<3;i++){
    const result=await request('guard',true);assert.equal(result.code,0,result.error);assert.equal(result.out,payload,'0-RTT entry did not recover after server restart');
  }
  console.log('PASS persistent 0-RTT client recovers after Xray restart and keeps returning complete content');
  console.log('PASS migrated random-encryption entry, IPv4 upload/IPv6 download and reverse direction return complete HTTP/HTTPS content');
}catch(error){for(const worker of children)console.error(worker.log().slice(-4000));throw error;}
finally{
  for(const worker of children)await stop(worker);
  for(const server of [origin,tlsTarget])if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  const relative=path.relative(scratchRoot,dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(dir,{recursive:true,force:true});
}
