import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { createSystem } from './app.mjs';
try{loadEnvFile();}catch(e){if(e.code!=='ENOENT')throw e;}
const secure=process.env.PANEL_SECURE_COOKIE!=='false';
const config={dbPath:path.resolve(process.env.PANEL_DB??'data/panel.sqlite'),masterKey:process.env.PANEL_MASTER_KEY,password:process.env.PANEL_ADMIN_PASSWORD,secure,adminOrigin:process.env.PANEL_ADMIN_ORIGIN??'http://127.0.0.1:3000',subscriptionOrigin:process.env.PANEL_SUBSCRIPTION_ORIGIN??'http://127.0.0.1:3001',agentOrigin:process.env.PANEL_AGENT_ORIGIN??'http://127.0.0.1:3002'};
const system=createSystem(config),host=process.env.PANEL_HOST??'127.0.0.1',ports=[Number(process.env.PANEL_ADMIN_PORT??3000),Number(process.env.PANEL_SUBSCRIPTION_PORT??3001),Number(process.env.PANEL_AGENT_PORT??3002)];
const servers=['admin','subscription','agent'].map((role,index)=>system[role].listen(ports[index],host,()=>console.log(`${role}: http://${host}:${ports[index]}`)));
const notifications=setInterval(()=>system.monitoring.drain().catch(()=>console.error('Notification worker failed')),5000);notifications.unref();
process.on('SIGTERM',()=>{clearInterval(notifications);for(const s of servers)s.close();system.store.close();});
