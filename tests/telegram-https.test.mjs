// A real HTTPS server speaks the Telegram wire format. No Telegram traffic is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {linuxPath} from './linux.mjs';
import {sendTelegram} from '../server/monitoring.mjs';
test('Telegram JSON POST completes through verified local HTTPS with the official endpoint shape',async()=>{
 mkdirSync('.local',{recursive:true});const dir=mkdtempSync(path.resolve('.local','telegram-https-')),key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
 const args=['req','-x509','-newkey','rsa:2048','-nodes','-keyout',linuxPath(key),'-out',linuxPath(cert),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'];
 const created=process.platform==='win32'?spawnSync('wsl',['-d',process.env.XRAY_TEST_WSL??'Debian','--','openssl',...args],{encoding:'utf8',timeout:30000}):spawnSync('openssl',args,{encoding:'utf8',timeout:30000});assert.equal(created.status,0,created.stderr);
 const settings={botToken:'123456789:Local_fixture_token_abcdefghijklmnopqrstuvwxyz',chatId:'-100123456789',threadId:17};let received;
 const server=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received={method:req.method,path:req.url,headers:req.headers,body:JSON.parse(body)};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:{message_id:73}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const transport=(url,options)=>new Promise((resolve,reject)=>{
  assert.equal(url,`https://api.telegram.org/bot${settings.botToken}/sendMessage`);assert.equal(options.redirect,'error');
  const req=https.request(`https://127.0.0.1:${server.address().port}/bot${settings.botToken}/sendMessage`,{method:options.method,headers:options.headers,signal:options.signal,ca:readFileSync(cert)},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve(new Response(body,{status:r.statusCode,headers:r.headers})));});req.on('error',reject);req.end(options.body);
 });
 try{const result=await sendTelegram(settings,'测试通知 / TLS 完整流程',transport);assert.equal(result.ok,true);assert.equal(result.messageId,73);assert.equal(received.method,'POST');assert.equal(received.body.chat_id,settings.chatId);assert.equal(received.body.message_thread_id,17);assert.equal(received.body.text,'测试通知 / TLS 完整流程');assert.equal(received.body.parse_mode,undefined);assert.deepEqual(received.body.link_preview_options,{is_disabled:true});}
 finally{await new Promise(r=>server.close(r));}
});
