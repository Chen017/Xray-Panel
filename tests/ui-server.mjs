// Disposable UI fixture. Credentials and nodes here belong only to this local test.
import path from 'node:path';
import * as age from 'age-encryption';
import {testSystem,testPassword,fixtureBundle} from './helpers.mjs';
import {driver,linuxPath} from './linux.mjs';
const s=await testSystem(process.env.MOCK_TELEGRAM==='1'?{monitorFetch:async()=>new Response(JSON.stringify({ok:true,result:{message_id:1}}))}:{}),d=driver(),root=linuxPath(path.join(s.dir,'ui-vps'));
await s.login();const r=(await s.call('/nodes','POST',{name:'UI 测试线路 · Tokyo',ipv4:'127.0.0.1',ipv6:'::1'})).body;
const config={nodeId:r.node.id,token:r.agentToken,url:s.urls[2],allowLoopbackHttp:true};
await d.call({action:'init',root,bundle:fixtureBundle(),core:linuxPath(process.env.XRAY_LINUX_BIN??'../Xray-Script/Xray/.test-tools/v26.3.27/xray')});
const once=()=>d.call({action:'once',root,config});await once();
const identity=await age.generateIdentity();await s.call('/devices','POST',{name:'UI 测试笔记本',publicKey:await age.identityToRecipient(identity),grants:[{nodeId:r.node.id,routes:['direct'],modes:['split','vision4']}]});await once();
if(process.env.MOCK_TELEGRAM==='1')await s.call('/monitoring','PUT',{enabled:false,botToken:'123456789:Local_fixture_token_abcdefghijklmnopqrstuvwxyz',chatId:'-100123456789',threadId:null,cnProbeIds:[],globalProbeIds:[],cnQuorum:2,interval:300,failures:3,recoveries:2});
console.log(`UI_URL=${s.urls[0]}\nUI_PASSWORD=${testPassword}\nTest data only. Active Agent uses isolated files and simulated service/firewall.`);
let running=false;const timer=setInterval(async()=>{if(running)return;running=true;try{await once();}catch(e){console.error(e.message);}finally{running=false;}},2000);
async function stop(){clearInterval(timer);await d.close();await s.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
