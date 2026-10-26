import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID,randomBytes } from 'node:crypto';
import path from 'node:path';
import { existsSync,readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as age from 'age-encryption';
import YAML from 'yaml';
import {orderNodes} from '../shared/node-order.mjs';
import {H2_WINDOW_MAX} from '../shared/h2-window.mjs';
import {nodeNameEntries,assertUniqueNames,migrateSubscriptionNames} from './subscription-names.mjs';
import {createMonitoring} from './monitoring.mjs';
import { Store,token,digest,passwordHash,passwordVerify } from './store.mjs';
import {addressPolicy,effectiveAddress,observeAddresses,resolveLinkedAddresses,linkedTargetHash} from '../shared/addresses.mjs';
import { validateBundle,hashBundle,compileDevices,deviceProviderProxies,deviceProviderLinks,deviceProviderNameEntries,readSettings,patchSettings,patchRouting,keypair,hostSchema,newBundle,settingsSchema,clone } from '../shared/config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
const now=()=>new Date().toISOString();
const error=(message,status=400)=>Object.assign(Error(message),{status});
const idSchema=z.string().uuid();
const addressSchema=z.object({mode:z.enum(['auto','manual']),value:z.union([hostSchema,z.literal('')]).default('')});
const nodeSchema=z.object({name:z.string().trim().min(1).max(80),ipv4:z.union([hostSchema,z.literal('')]).default(''),ipv6:z.union([hostSchema,z.literal('')]).default(''),enabled:z.boolean().default(true),addressPolicy:z.object({ipv4:addressSchema,ipv6:addressSchema}).optional()});
const grantSchema=z.object({nodeId:idSchema,routes:z.array(z.string().regex(/^(direct|\d{1,6})$/)).min(1).max(33),modes:z.array(z.enum(['split','single4','single6','vision4','vision6'])).min(1).max(5)});
const deviceSchema=z.object({name:z.string().trim().min(1).max(80),publicKey:z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),grants:z.array(grantSchema).max(100)});
const downloadWindowsSchema=z.object({revision:z.number().int().nonnegative(),windows:z.record(z.string().regex(/^[0-9a-f]{40}$/),z.number().int().min(1).max(H2_WINDOW_MAX)).refine(v=>Object.keys(v).length<=5000,'一次最多设置 5000 条窗口')});
const subscriptionName=z.string().trim().max(120).refine(s=>!/[\x00-\x1f\x7f]/.test(s),'名称不能包含控制字符').refine(s=>!['DIRECT','REJECT','REJECT-DROP','PASS','COMPATIBLE','GLOBAL','Subscription Download'].includes(s),'名称不能使用 Mihomo 或下载策略组保留名称');
const namesRecord=z.record(z.string().regex(/^[0-9a-f]{40}$/),subscriptionName).refine(v=>Object.keys(v).length<=5000,'一次最多修改 5000 条名称');
const nodeOrderSchema=z.object({revision:z.number().int().nonnegative(),order:z.array(idSchema).max(10000).refine(ids=>new Set(ids).size===ids.length,'排序包含重复节点')});
const nodeNamesSchema=z.object({revision:z.number().int().nonnegative(),subscriptionName:subscriptionName,names:namesRecord});
const actionSchema=z.enum(['inspect','detect-addresses','firewall-status','validate','dump','logs','start','stop','restart','enable','disable','update-core','update-script','update-geodata','maintenance','bbr','diagnostics','relay-test','relay-keygen','uninstall','install-standard','install-landing']);
export const MAX_BACKUP_BYTES=64*1024*1024;
const MAX_BACKUP_RECORDS=100000;

export function createSystem(config) {
  const store=new Store(config.dbPath,config.masterKey);
  store.tx(()=>migrateSubscriptionNames(store,config.masterKey));
  const monitoring=createMonitoring(store,{fetchImpl:config.monitorFetch,clock:config.monitorClock});
  if(!store.get('system','admin')){
    if((config.password??'').length<16)throw Error('首次启动需要至少 16 字符的 PANEL_ADMIN_PASSWORD');
    store.put('system','admin',{hash:passwordHash(config.password)});
  }
  const getNode=id=>{const n=store.get('node',id);if(!n)throw error('节点不存在',404);return n;};
  const getDevice=id=>{const d=store.get('device',id);if(!d)throw error('设备不存在',404);return d;};
  const orderedNodes=()=>orderNodes(store.list('node'),store.get('system','node-order')?.order);
  const nodeOrderPresentation=()=>{const nodes=orderedNodes();return {revision:store.get('system','node-order')?.revision??0,order:nodes.map(n=>n.id),defaultOrder:orderNodes(nodes).map(n=>n.id),nodes:nodes.map(({id,name,enabled})=>({id,name,enabled}))};};
  const busy=id=>store.list('job').find(j=>j.nodeId===id&&['queued','running'].includes(j.status));
  const publicNode=n=>{const {agentHash,...safe}=n;let hasDraftChanges=false,settings=null;try{settings=n.draft?readSettings(n.draft):null;hasDraftChanges=!!n.draft&&!!n.applied&&hashBundle(compileDevices(resolveLinkedAddresses(n.draft,store.list('node')),n,store.list('device'),config.masterKey))!==hashBundle(n.applied);}catch{hasDraftChanges=true;}return {...safe,addressPolicy:addressPolicy(n),settings,hasDraftChanges,online:!!n.lastSeen&&Date.now()-Date.parse(n.lastSeen)<45000};};
  const publicDevice=d=>{const {tokenHash,...safe}=d;return safe;};
  function queue(n,action,payload={},source='admin') {
    if(busy(n.id))throw error('该节点有未完成任务，请等待或取消待执行任务',409);
    const j={id:randomUUID(),nodeId:n.id,action,payload,status:'queued',createdAt:now(),source,attempts:0};store.put('job',j.id,j);store.audit(`job.${action}`,n.id,j.id);return j;
  }
  function deploy(n,base,source='admin') {
    if(!n.observedHash)throw error('请先连接 Agent 并同步当前配置',409);
    if(n.report?.configError)throw error('VPS 配置无法读取，请先检查配置错误；仍可读取日志和执行诊断',409);
    if(source==='admin'&&n.draftBaseHash&&n.draftBaseHash!==n.observedHash)throw error('VPS 配置已在面板之外变化，请先导入 VPS 当前配置',409);
    const bundle=compileDevices(resolveLinkedAddresses(base,store.list('node')),n,store.list('device'),config.masterKey);
    return queue(n,'deploy',{bundle,expectedHash:n.observedHash,targetHash:hashBundle(bundle),syncRevision:n.syncRevision??0,relayRevision:n.relayRevision??0},source);
  }
  function markSync(nodeIds){for(const id of new Set(nodeIds)){const n=store.get('node',id);if(n){n.needsSync=true;n.syncRevision=(n.syncRevision??0)+1;delete n.syncRetryAt;delete n.syncFailures;store.put('node',id,n);}}}
  function retrySync(n){if(n.needsSync||n.needsRelaySync){n.syncFailures=(n.syncFailures??0)+1;n.syncRetryAt=Date.now()+Math.min(300000,5000*2**Math.min(n.syncFailures-1,6));}}
  function refreshLinks(){
    const nodes=store.list('node');
    for(const n of nodes){
      if(!n.observed?.files['relay.json']?.landings?.some(l=>l.nodeId)){
        // A successful unlink (or an externally changed configuration) must not
        // leave the old relay failure blocking unrelated device deployments.
        if(n.needsRelaySync||n.relaySyncError||n.relayTargetHash){
          n.needsRelaySync=false;delete n.relaySyncError;delete n.relayTargetHash;
          n.relayRevision=(n.relayRevision??0)+1;store.put('node',n.id,n);
        }
        continue;
      }
      try{
        const target=linkedTargetHash(n,nodes),changed=target!==n.relayTargetHash;
        if(changed){n.relayRevision=(n.relayRevision??0)+1;n.relayTargetHash=target;n.syncRetryAt=0;}
        // Recompute even if the desired destination returned to its previous value
        // while an older job was running. A stale acknowledgement cannot clear it.
        n.needsRelaySync=target!==n.observedHash;
        delete n.relaySyncError;
      }catch(e){n.relaySyncError=e.message;}
      store.put('node',n.id,n);
    }
  }
  const baseApp=(largeRestore=false)=>{const app=express();app.disable('x-powered-by');app.set('trust proxy',false);app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:"],connectSrc:["'self'"],fontSrc:["'self'","data:"],objectSrc:["'none'"],frameAncestors:["'none'"]}},strictTransportSecurity:config.secure?undefined:false}));app.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});const parse=express.json({limit:'2mb',strict:true});app.use((req,res,next)=>largeRestore&&req.method==='POST'&&req.path==='/api/restore'?next():parse(req,res,next));return app;};
  const finish=app=>app.use((err,req,res,next)=>{const status=err instanceof z.ZodError?400:err.status??500;res.status(status).json({error:status===500?'内部错误，请查看服务日志':err instanceof z.ZodError?err.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'):err.message});if(status===500)console.error(err.message);});
  const admin=baseApp(true),subscription=baseApp(),agent=baseApp();
  admin.get('/api/health',(_,res)=>res.json({ok:true,service:'admin',version}));subscription.get('/health',(_,res)=>res.json({ok:true,service:'subscription',version}));agent.get('/health',(_,res)=>res.json({ok:true,service:'agent',version}));
  function session(req){const cookie=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('xray_session='))?.slice(13);if(!cookie)return null;const s=store.get('session',digest(cookie));if(!s||s.expires<Date.now())return null;return {...s,hash:digest(cookie)};}
  const origin=(req,res,next)=>{if(req.get('origin')!==config.adminOrigin)return next(error('请求来源不匹配',403));next();};
  admin.post('/api/login',rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false}),origin,(req,res)=>{
    const p=z.object({password:z.string().max(256)}).parse(req.body).password;
    if(!passwordVerify(p,store.get('system','admin').hash)){store.audit('login.failed','admin');throw error('密码错误',401);}
    const value=token(),csrf=token();store.put('session',digest(value),{csrf,expires:Date.now()+12*3600000});
    res.cookie('xray_session',value,{httpOnly:true,sameSite:'strict',secure:config.secure,maxAge:12*3600000,path:'/'});store.audit('login','admin');res.json({csrf});
  });
  admin.use('/api',(req,res,next)=>{const s=session(req);if(!s)return next(error('请先登录',401));req.session=s;if(!['GET','HEAD','OPTIONS'].includes(req.method)){if(req.get('origin')!==config.adminOrigin||req.get('x-csrf-token')!==s.csrf)return next(error('CSRF 校验失败',403));}next();});
  admin.get('/api/session',(req,res)=>res.json({csrf:req.session.csrf,subscriptionOrigin:config.subscriptionOrigin,agentOrigin:config.agentOrigin}));
  admin.post('/api/logout',(req,res)=>{store.remove('session',req.session.hash);res.clearCookie('xray_session',{path:'/'});res.json({ok:true});});
  admin.post('/api/password',(req,res)=>{const p=z.object({current:z.string().max(256),password:z.string().min(16).max(256)}).parse(req.body);if(!passwordVerify(p.current,store.get('system','admin').hash))throw error('当前密码错误',403);store.tx(()=>{store.put('system','admin',{hash:passwordHash(p.password)});for(const s of store.db.prepare("SELECT id FROM records WHERE kind='session'").all())store.remove('session',s.id);});store.audit('password.changed','admin');res.clearCookie('xray_session',{path:'/'});res.json({ok:true});});
  admin.get('/api/monitoring',(_,res)=>res.json(monitoring.status()));
  admin.put('/api/monitoring',(req,res)=>{try{res.json(monitoring.save(req.body));}catch(e){if(e instanceof z.ZodError)throw e;throw error(e.message);}});
  admin.post('/api/monitoring/test',async(req,res)=>{try{res.json(await monitoring.test());}catch(e){throw error(e.message);}});
  admin.get('/api/nodes',(_,res)=>res.json(orderedNodes().map(publicNode)));
  admin.get('/api/node-order',(_,res)=>res.json(nodeOrderPresentation()));
  admin.put('/api/node-order',(req,res)=>{
    const input=nodeOrderSchema.parse(req.body);
    store.tx(()=>{
      if(input.revision!==(store.get('system','node-order')?.revision??0))throw error('节点顺序已被另一页面修改，请重新载入',409);
      const nodes=store.list('node'),ids=new Set(nodes.map(n=>n.id));
      if(input.order.length&&(input.order.length!==nodes.length||input.order.some(id=>!ids.has(id))))throw error('节点列表已变化，请重新载入排序列表',409);
      store.put('system','node-order',{revision:input.revision+1,order:input.order});
      store.audit('nodes.order.updated','system');
    });
    res.json(nodeOrderPresentation());
  });
  admin.post('/api/nodes',(req,res)=>{const value=nodeSchema.parse(req.body),secret=token(),n={id:randomUUID(),...value,addressPolicy:value.addressPolicy??Object.fromEntries(['ipv4','ipv6'].map(key=>[key,{mode:value[key]?'manual':'auto',value:value[key]}])),agentHash:digest(secret),subscriptionNamingVersion:1,revision:0,createdAt:now(),needsSync:false};store.put('node',n.id,n);store.audit('node.created',n.id);res.status(201).json({node:publicNode(n),agentToken:secret,agentUrl:config.agentOrigin});});
  admin.patch('/api/nodes/:id',(req,res)=>{const n=getNode(req.params.id),patch=nodeSchema.partial().parse(req.body);n.addressPolicy=addressPolicy(n);for(const key of ['ipv4','ipv6'])if(patch[key]!==undefined&&!patch.addressPolicy)n.addressPolicy[key]={mode:'manual',value:patch[key]};Object.assign(n,patch);for(const key of ['ipv4','ipv6'])n[key]=effectiveAddress(n,key);assertUniqueNames(store.list('node').map(x=>x.id===n.id?n:x),store.list('device'),config.masterKey);store.put('node',n.id,n);refreshLinks();store.audit('node.updated',n.id);res.json(publicNode(n));});
  admin.delete('/api/nodes/:id',(req,res)=>{const n=getNode(req.params.id);if(busy(n.id))throw error('请先完成或取消节点任务',409);store.remove('node',n.id);for(const d of store.list('device')){d.grants=d.grants.filter(g=>g.nodeId!==n.id);store.put('device',d.id,d);}store.audit('node.deleted',n.id);res.json({ok:true});});
  admin.post('/api/nodes/:id/agent-token',(req,res)=>{const n=getNode(req.params.id),secret=token();n.agentHash=digest(secret);store.put('node',n.id,n);store.audit('agent.rotated',n.id);res.json({agentToken:secret,nodeId:n.id,agentUrl:config.agentOrigin});});
  admin.post('/api/keys',(_,res)=>res.json({...keypair(),uuid:randomUUID(),shortIds:[randomBytes(4).toString('hex'),randomBytes(8).toString('hex')]}));
  admin.put('/api/nodes/:id/draft',(req,res)=>{const n=getNode(req.params.id),input=z.object({revision:z.number().int(),bundle:z.any().optional(),settings:settingsSchema.optional(),customRules:z.any().optional(),relay:z.any().optional(),firewall:z.object({open:z.array(z.number().int().min(1).max(65535)),closed:z.array(z.number().int().min(1).max(65535))}).optional(),initialize:z.boolean().optional()}).parse(req.body);if(input.revision!==n.revision)throw error('配置已被另一页面修改，请重新载入',409);
    let b=input.bundle?validateBundle(input.bundle):clone(n.draft??n.observed);
    if(input.initialize){if(!input.settings)throw error('创建标准节点需要基础参数');const created=newBundle(input.settings,n.report?.listen4??'127.0.0.1');if(b?.files?.['config.json']){b.files={...b.files,...Object.fromEntries(Object.entries(created.files).filter(([name])=>name.startsWith('conf/')))};b=patchSettings(b,input.settings);if(b.files['relay.json'])b=patchRouting(b,{});}else b=created;}
    else if(input.settings)b=patchSettings(b,input.settings);
    if(!b)throw error('等待 Agent 导入配置');
    if(input.customRules!==undefined||input.relay!==undefined)b=patchRouting(b,input);
    if(input.firewall){const r=b.files['relay.json'];if(r?.role==='landing'&&[...input.firewall.open,...input.firewall.closed].includes(r.listen_port))throw error('落地中继端口由互联配置管理，请在互联页调整或移除');b.files['firewall_ports.json']=input.firewall;}
    n.draft=validateBundle(b);n.revision++;store.put('node',n.id,n);store.audit('config.saved',n.id,`revision ${n.revision}`);res.json(publicNode(n));});
  admin.post('/api/nodes/:id/adopt',(req,res)=>{const n=getNode(req.params.id);if(busy(n.id))throw error('任务执行期间不能导入',409);if(!n.observed)throw error('Agent 尚未导入配置');n.draft=clone(n.observed);n.draftBaseHash=n.observedHash;n.revision++;store.put('node',n.id,n);store.audit('config.imported',n.id);res.json(publicNode(n));});
  admin.get('/api/nodes/:id/preview',(req,res)=>{const n=getNode(req.params.id);if(!n.draft)throw error('请先导入配置');const b=compileDevices(resolveLinkedAddresses(n.draft,store.list('node')),n,store.list('device'),config.masterKey);res.json({bundle:b,hash:hashBundle(b),observedHash:n.observedHash,revision:n.revision});});
  admin.post('/api/nodes/:id/deploy',(req,res)=>{const n=getNode(req.params.id);if(req.body.revision!==n.revision)throw error('配置版本已变化，请重新预览',409);if(!n.draft)throw error('没有配置草稿');res.status(202).json(deploy(n,n.draft));});
  admin.post('/api/nodes/:id/actions',(req,res)=>{const n=getNode(req.params.id),action=actionSchema.parse(req.body.action);if(['uninstall','install-standard','install-landing'].includes(action)&&req.body.confirm!==n.name)throw error('请输入节点名称确认此操作');if(['detect-addresses','firewall-status'].includes(action)&&!n.report?.network)throw error('请先使用 xray-panel agent update 更新该 VPS 的 Agent',409);res.status(202).json(queue(n,action));});
  admin.post('/api/batch',(req,res)=>{const b=z.object({nodeIds:z.array(idSchema).min(1).max(100),action:z.enum(['deploy','inspect','validate','start','stop','restart','update-geodata'])}).parse(req.body);const results=b.nodeIds.map(id=>{try{const n=getNode(id);return{id,job:b.action==='deploy'?deploy(n,n.draft):queue(n,b.action)};}catch(e){return{id,error:e.message};}});res.json(results);});
  admin.get('/api/jobs',(_,res)=>res.json(store.list('job').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,200).map(({payload,leaseHash,...j})=>j)));
  admin.post('/api/jobs/:id/cancel',(req,res)=>{const j=store.get('job',req.params.id);if(!j||j.status!=='queued')throw error('只能取消尚未领取的任务',409);j.status='cancelled';j.completedAt=now();store.tx(()=>{store.put('job',j.id,j);if(j.action==='deploy'){const n=getNode(j.nodeId);retrySync(n);store.put('node',n.id,n);}});store.audit('job.cancelled',j.nodeId,j.id);res.json({ok:true});});
  admin.get('/api/devices',(_,res)=>res.json(store.list('device').map(publicDevice)));
  const windowEntries=d=>orderedNodes().flatMap(n=>{
    const grant=d.grants.find(g=>g.nodeId===n.id);
    return grant?nodeNameEntries(n,config.masterKey).filter(e=>e.mode==='split'&&grant.modes.includes(e.mode)&&grant.routes.includes(e.route)):[];
  });
  admin.get('/api/devices/:id/download-windows',(req,res)=>{
    const d=getDevice(req.params.id);
    res.json({revision:d.downloadWindowsRevision??0,windows:d.downloadWindows??{},entries:windowEntries(d)});
  });
  admin.put('/api/devices/:id/download-windows',(req,res)=>{
    const d=getDevice(req.params.id),input=downloadWindowsSchema.parse(req.body);
    if(d.revoked)throw error('设备已撤销',409);
    if(input.revision!==(d.downloadWindowsRevision??0))throw error('窗口设置已被另一页面修改，请重新载入',409);
    const allowed=new Set(windowEntries(d).map(e=>e.key));
    if(Object.entries(input.windows).some(([key,value])=>!allowed.has(key)&&d.downloadWindows?.[key]!==value))throw error('设备授权或节点配置已变化，请重新载入窗口列表',409);
    d.downloadWindows=input.windows;d.downloadWindowsRevision=(d.downloadWindowsRevision??0)+1;
    store.put('device',d.id,d);store.audit('device.download-windows.updated',d.id);
    res.json({ok:true});
  });
  // Old browser tabs may still call these routes. Reading is harmless; writes
  // must never reinstate per-device overrides of the shared node order.
  admin.get('/api/devices/:id/names',(req,res)=>{res.json({entries:deviceProviderNameEntries(orderedNodes(),getDevice(req.params.id),config.masterKey)});});
  admin.put('/api/devices/:id/names',(req,res)=>{
    getDevice(req.params.id);throw error('名称和顺序已统一管理，请到节点管理修改',409);
  });
  const nodePresentation=n=>({revision:n.subscriptionNameRevision??0,subscriptionName:n.subscriptionName??'',entries:nodeNameEntries(n,config.masterKey),conflicts:n.subscriptionNameConflicts??[]});
  admin.get('/api/nodes/:id/subscription-names',(req,res)=>res.json(nodePresentation(getNode(req.params.id))));
  admin.put('/api/nodes/:id/subscription-names',(req,res)=>{
    const n=getNode(req.params.id),input=nodeNamesSchema.parse(req.body);
    if(input.revision!==(n.subscriptionNameRevision??0))throw error('订阅名称已被另一页面修改，请重新载入',409);
    const allowed=new Set(nodeNameEntries(n,config.masterKey).map(e=>e.key));
    if(Object.keys(input.names).some(key=>!allowed.has(key)))throw error('节点配置已变化，请重新载入名称列表',409);
    const baseChanged=input.subscriptionName!==(n.subscriptionName??''),names=baseChanged?{}:{...n.subscriptionNames};for(const[key,value]of Object.entries(input.names)){if(baseChanged&&value===n.subscriptionNames?.[key])continue;if(value)names[key]=value;else delete names[key];}
    const updated={...n,subscriptionName:input.subscriptionName,subscriptionNames:names,subscriptionNamingVersion:1,subscriptionNameRevision:(n.subscriptionNameRevision??0)+1};
    assertUniqueNames(store.list('node').map(x=>x.id===n.id?updated:x),store.list('device'),config.masterKey);
    store.put('node',n.id,updated);store.audit('node.subscription-names.updated',n.id);res.json(nodePresentation(updated));
  });
  const verifyDevice=input=>{const v=deviceSchema.parse(input),e=new age.Encrypter();e.addRecipient(v.publicKey);if(new Set(v.grants.map(g=>g.nodeId)).size!==v.grants.length)throw error('同一节点只能添加一次授权');for(const g of v.grants){const n=getNode(g.nodeId),routes=n.draft?.files['relay.json']?.landings?.map(l=>l.id)??[];if(g.routes.some(r=>r!=='direct'&&!routes.includes(r)))throw error('授权包含未知落地出口');}assertUniqueNames(store.list('node'),[v],config.masterKey);return v;};
  admin.post('/api/devices',(req,res)=>{const input=verifyDevice(req.body),secret=token(),d={id:randomUUID(),...input,epoch:randomUUID(),tokenHash:digest(secret),revoked:false,createdAt:now()};store.tx(()=>{store.put('device',d.id,d);markSync(d.grants.map(g=>g.nodeId));});store.audit('device.created',d.id);res.status(201).json({device:publicDevice(d),token:secret,url:`${config.subscriptionOrigin}/v1/subscriptions/${d.id}`});});
  admin.put('/api/devices/:id',(req,res)=>{const d=getDevice(req.params.id),v=verifyDevice(req.body),ids=[...d.grants,...v.grants].map(g=>g.nodeId);Object.assign(d,v);store.tx(()=>{store.put('device',d.id,d);markSync(ids);});store.audit('device.updated',d.id);res.json(publicDevice(d));});
  admin.post('/api/devices/:id/rotate',(req,res)=>{const d=getDevice(req.params.id),secret=token();d.tokenHash=digest(secret);if(req.body.rotateUuid===true){d.epoch=randomUUID();markSync(d.grants.map(g=>g.nodeId));}store.put('device',d.id,d);store.audit('device.rotated',d.id,req.body.rotateUuid?'token and uuid':'token');res.json({device:publicDevice(d),token:secret,url:`${config.subscriptionOrigin}/v1/subscriptions/${d.id}`});});
  admin.post('/api/devices/:id/revoke',(req,res)=>{const d=getDevice(req.params.id);d.revoked=true;store.tx(()=>{store.put('device',d.id,d);markSync(d.grants.map(g=>g.nodeId));});store.audit('device.revoked',d.id);res.json({ok:true,pendingNodes:d.grants.map(g=>g.nodeId)});});
  admin.get('/api/devices/:id/preview',(req,res)=>{const d=getDevice(req.params.id);const proxies=deviceProviderProxies(orderedNodes(),d,config.masterKey);res.type('text/yaml').send(YAML.stringify({proxies}));});
  admin.get('/api/devices/:id/links',(req,res)=>{const d=getDevice(req.params.id);const links=deviceProviderLinks(orderedNodes(),d,config.masterKey);res.type('text/plain').send(links.join('\n'));});
  admin.get('/api/audit',(_,res)=>res.json(store.audits()));
  admin.get('/api/backup',(_,res)=>{const backup={version:1,createdAt:now(),records:store.db.prepare('SELECT kind,id,data FROM records WHERE kind != ?').all('session')},serialized=JSON.stringify(backup);if(backup.records.length>MAX_BACKUP_RECORDS||Buffer.byteLength(serialized)>MAX_BACKUP_BYTES)throw error('备份超过 64 MiB 或 100,000 条记录，请先归档历史任务后导出',413);store.audit('backup.exported','system');res.attachment('xray-panel-encrypted-backup.json').type('application/json').send(serialized);});
  admin.post('/api/restore',express.json({limit:MAX_BACKUP_BYTES,strict:true}),(req,res)=>{const backup=z.object({version:z.literal(1),records:z.array(z.object({kind:z.enum(['system','node','device','job','monitor','notification']),id:z.string(),data:z.string()})).max(MAX_BACKUP_RECORDS)}).parse(req.body);if(!backup.records.some(r=>r.kind==='system'&&r.id==='admin'))throw error('备份缺少管理员记录');for(const r of backup.records)store.open(r.data);store.tx(()=>{store.db.exec('DELETE FROM records');const q=store.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)');for(const r of backup.records)q.run(r.kind,r.id,r.data);migrateSubscriptionNames(store,config.masterKey);});store.audit('backup.restored','system');res.json({ok:true});});
  admin.get('/api/docs',(_,res)=>res.json({readme:readFileSync(path.join(root,'README.md'),'utf8'),nodes:readFileSync(path.join(root,'docs/nodes.md'),'utf8'),cloudflare:readFileSync(path.join(root,'docs/cloudflare.md'),'utf8'),mihomo:readFileSync(path.join(root,'docs/mihomo.md'),'utf8'),telegram:readFileSync(path.join(root,'docs/telegram.md'),'utf8')}));
  admin.get('/source.tar.gz',(_,res)=>{const p=path.join(root,'dist/source.tar.gz');if(!existsSync(p))throw error('请运行 npm run build 生成源码归档',404);res.download('source.tar.gz','xray-panel-source.tar.gz',{root:path.join(root,'dist')});});
  if(existsSync(path.join(root,'dist/index.html'))){admin.use(express.static(path.join(root,'dist'),{index:'index.html'}));admin.get('/{*splat}',(_,res)=>res.sendFile(path.join(root,'dist/index.html')));}
  const bearer=req=>{const value=req.get('authorization')??'';return /^Bearer [A-Za-z0-9_-]{43}$/.test(value)?value.slice(7):'';};
  subscription.get('/v1/subscriptions/:id',rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res)=>{
    const d=store.get('device',req.params.id),auth=bearer(req);
    if(!auth||!d||d.revoked||digest(auth)!==d.tokenHash){store.audit('subscription.denied',d?.id??'unknown');throw error('订阅凭据无效',401);}
    const proxies=deviceProviderProxies(orderedNodes(),d,config.masterKey);
    // A temporarily absent deployment must not replace the client's last usable cache.
    if(!proxies.length)throw error('授权节点尚未完成部署，请稍后重试',503);
    const e=new age.Encrypter();e.addRecipient(d.publicKey);const armored=age.armor.encode(await e.encrypt(YAML.stringify({proxies})));
    const latest=store.get('device',d.id);
    if(!latest||latest.revoked||latest.tokenHash!==digest(auth)||latest.publicKey!==d.publicKey)throw error('订阅凭据已更新，请重试',401);
    latest.lastAccess=now();store.put('device',d.id,latest);store.audit('subscription.fetched',d.id,`${proxies.length} proxies`);
    res.set({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="provider.yaml.age"','CDN-Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store'}).send(armored);
  });
  subscription.get('/source.tar.gz',(_,res)=>{const p=path.join(root,'dist/source.tar.gz');if(!existsSync(p))throw error('源码归档尚未生成',404);res.download('source.tar.gz','xray-panel-source.tar.gz',{root:path.join(root,'dist')});});
  agent.use('/v1/agent',(req,res,next)=>{const id=req.get('x-node-id'),auth=bearer(req),n=id?store.get('node',id):null;if(!n||!auth||digest(auth)!==n.agentHash)return next(error('Agent 凭据无效',401));req.node=n;next();},rateLimit({windowMs:60000,limit:300,keyGenerator:req=>req.node.id,standardHeaders:'draft-8',legacyHeaders:false}));
  agent.get('/v1/agent/status',(req,res)=>res.json({ok:true,nodeId:req.node.id,version,agentProtocol:1}));
  agent.post('/v1/agent/poll',(req,res)=>store.tx(()=>{
    let n=getNode(req.node.id);const input=z.object({report:z.record(z.unknown()),bundle:z.any().optional()}).parse(req.body);n.report=input.report;n.lastSeen=now();observeAddresses(n,input.report.network);
    if(input.bundle){n.observed=validateBundle(input.bundle);n.observedHash=hashBundle(n.observed);if(!n.draft){n.draft=clone(n.observed);n.draftBaseHash=n.observedHash;n.revision++;}}
    store.put('node',n.id,n);monitoring.accept(n,input.report.monitor);refreshLinks();n=store.get('node',n.id);
    if((n.needsSync||n.needsRelaySync)&&!busy(n.id)&&n.observed&&input.bundle&&!n.report.configError&&!n.relaySyncError&&(n.syncRetryAt??0)<=Date.now())deploy(n,n.observed,n.needsSync?'device-sync':'address-sync');
    let job=busy(n.id);
    if(job?.status==='running'&&job.leaseUntil>Date.now())job=null;
    if(job?.action==='deploy'&&job.status==='queued'&&n.report.configError)job=null;
    if(job){const lease=token();job.leaseHash=digest(lease);job.leaseObservedHash=n.observedHash??null;job.leaseUntil=Date.now()+15*60000;job.status='running';job.startedAt??=now();job.attempts++;store.put('job',job.id,job);const {leaseHash,...safe}=job;return res.json({job:{...safe,lease},monitorPlan:monitoring.plan(n)});}
    res.json({job:null,monitorPlan:monitoring.plan(n)});
  }));
  agent.post('/v1/agent/jobs/:id/result',(req,res)=>store.tx(()=>{
    const j=store.get('job',req.params.id),input=z.object({lease:z.string(),ok:z.boolean(),output:z.string().max(180000).default(''),bundle:z.any().optional(),report:z.record(z.unknown()).optional()}).parse(req.body);
    if(!j||j.nodeId!==req.node.id||j.status!=='running'||digest(input.lease)!==j.leaseHash)throw error('任务租约无效或结果已提交',409);
    const n=getNode(j.nodeId);
    const staleSuccess=input.ok&&j.action==='deploy'&&(n.report?.configError||input.report?.configError||j.leaseObservedHash!==undefined&&![j.payload.expectedHash,j.payload.targetHash].includes(j.leaseObservedHash));
    let bundle=input.bundle?validateBundle(input.bundle):null;
    const validDeployment=!staleSuccess&&!!bundle&&hashBundle(bundle)===j.payload.targetHash;
    const ok=input.ok&&(j.action!=='deploy'||validDeployment);
    j.status=ok?'succeeded':'failed';j.completedAt=now();j.output=input.output;delete j.leaseHash;
    if(input.ok&&j.action==='deploy'&&!validDeployment)j.output=`部署回执已失效或缺少匹配的当前配置，请重新同步后部署。\n${j.output}`.slice(0,180000);
    if(staleSuccess)bundle=null; // Preserve the newer snapshot received with this lease.
    if(bundle){n.observed=bundle;n.observedHash=hashBundle(bundle);if(ok&&j.action==='deploy'){n.applied=bundle;n.appliedAt=now();n.appliedJob=j.id;if(j.source==='admin'||n.draftBaseHash===j.payload.expectedHash)n.draftBaseHash=n.observedHash;}if(!n.draft){n.draft=bundle;n.draftBaseHash=n.observedHash;n.revision++;}}
    if(j.action==='deploy'){
      if(ok&&(j.payload.syncRevision??0)===(n.syncRevision??0)){n.needsSync=false;delete n.syncRetryAt;delete n.syncFailures;}
      else if(!ok)retrySync(n);
    }
    if(input.ok&&j.action==='uninstall'){delete n.applied;delete n.observed;delete n.observedHash;delete n.draft;n.revision++;}
    if(input.report){n.report=input.report;observeAddresses(n,input.report.network);}
    if(ok&&j.action==='deploy'&&(j.payload.relayRevision??0)===(n.relayRevision??0))n.needsRelaySync=false;store.put('node',n.id,n);refreshLinks();store.put('job',j.id,j);store.audit(`job.${j.status}`,n.id,`${j.action} ${j.id}`);res.json({ok:true});
  }));
  finish(admin);finish(subscription);finish(agent);
  return {admin,subscription,agent,store,config,queue,deploy,monitoring};
}
