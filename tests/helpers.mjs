import { randomBytes,randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { createSystem } from '../server/app.mjs';
import { keypair,defaultXhttp,newBundle } from '../shared/config.mjs';
export const testPassword='Local-test-only-password-2026!';
export function settings(){return {port:443,uuid:randomUUID(),...keypair(),sni4:'example.com',sni6:'www.example.com',shortIds4:['01234567','0123456789abcdef'],shortIds6:['89abcdef','fedcba9876543210'],path:'/api/v3/updates',v6Uplink:false,logLevel:'warning',outbound:'UseIPv4v6',xhttp:defaultXhttp()};}
export function fixtureBundle(){const b=newBundle(settings(),'127.0.0.1');b.files['config.json'].log={loglevel:'none'};return b;}
export async function testSystem(overrides={}){
  mkdirSync('.local',{recursive:true});const dir=mkdtempSync(path.resolve('.local','test-'));
  const config={dbPath:path.join(dir,'panel.sqlite'),masterKey:randomBytes(32).toString('hex'),password:testPassword,secure:false,adminOrigin:'http://127.0.0.1',subscriptionOrigin:'http://127.0.0.1',agentOrigin:'http://127.0.0.1',...overrides};
  const sys=createSystem(config);const servers=await Promise.all(['admin','subscription','agent'].map(role=>new Promise(resolve=>{const server=sys[role].listen(0,'127.0.0.1',()=>resolve(server));})));
  const urls=servers.map(s=>`http://127.0.0.1:${s.address().port}`);[config.adminOrigin,config.subscriptionOrigin,config.agentOrigin]=urls;
  let cookie='',csrf='';
  async function call(route,method='GET',body,options={}){const r=await fetch(urls[0]+'/api'+route,{method,headers:{Origin:config.adminOrigin,...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{'X-CSRF-Token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...options.headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(value.csrf)csrf=value.csrf;return{status:r.status,body:value,headers:r.headers};}
  async function login(){const r=await call('/login','POST',{password:testPassword});if(r.status!==200)throw Error(JSON.stringify(r));return r;}
  async function close(){await Promise.all(servers.map(s=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();})));sys.store.close();}
  return {...sys,dir,urls,call,login,close,getCookie:()=>cookie};
}
