import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {readSettings} from '../shared/config.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=z.string().uuid();
export const monitoringSchema=z.object({enabled:z.boolean(),botToken:z.string().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/).optional(),clearToken:z.boolean().optional(),chatId:z.string().regex(/^-?\d{1,20}$/).or(z.literal('')),threadId:z.number().int().min(1).optional().nullable(),cnProbeIds:z.array(uuid).max(20),globalProbeIds:z.array(uuid).max(20),cnQuorum:z.number().int().min(1).max(10),interval:z.number().int().min(60).max(3600),failures:z.number().int().min(2).max(10),recoveries:z.number().int().min(2).max(10)});
export const monitoringDefaults={enabled:false,chatId:'',threadId:null,cnProbeIds:[],globalProbeIds:[],cnQuorum:2,interval:300,failures:3,recoveries:2};

// Token is necessarily part of Telegram's official URL format. Never log the URL,
// response description, thrown fetch error or arbitrary response body.
export async function sendTelegram(settings,text,fetchImpl=fetch){
  let response,data;
  try{
    response=await fetchImpl(`https://api.telegram.org/bot${settings.botToken}/sendMessage`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:settings.chatId,text:text.slice(0,4000),...(settings.threadId?{message_thread_id:settings.threadId}:{}),link_preview_options:{is_disabled:true}})});
    if(Number(response.headers.get('content-length')??0)>32768)return {ok:false,code:'invalid_response'};
    // Bound the response even when a peer omits Content-Length.
    const reader=response.body.getReader();let bytes=0,chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>32768){await reader.cancel();return {ok:false,code:'invalid_response'};}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
    data=JSON.parse(Buffer.concat(chunks).toString());
  }catch{return {ok:false,code:'network_or_invalid_response'};}
  if(!data||typeof data!=='object'||Array.isArray(data))return {ok:false,code:'invalid_response'};
  if(response.ok&&data.ok===true&&Number.isSafeInteger(data.result?.message_id))return {ok:true,messageId:data.result.message_id};
  const status=response.status===200?Number(data.error_code):response.status;
  return {ok:false,code:`telegram_${Number.isInteger(status)?status:'invalid'}`,permanent:[400,401,403,404].includes(status),retryAfter:status===429?Math.max(1,Math.min(86400,Number(data.parameters?.retry_after)||60)):undefined};
}

export function createMonitoring(store,{clock=Date.now,fetchImpl=fetch}={}){
  let sending=false;
  const settings=()=>({...monitoringDefaults,...store.get('system','monitoring')});
  const configHash=cfg=>hash([cfg.enabled,cfg.cnProbeIds,cfg.globalProbeIds,cfg.cnQuorum,cfg.failures,cfg.recoveries,cfg.interval,cfg.generation]);
  function publicSettings(){const {botToken,...safe}=settings();return {...safe,hasToken:!!botToken};}
  function save(input){
    const patch=monitoringSchema.parse(input),previous=settings();
    if(patch.cnProbeIds.some(id=>patch.globalProbeIds.includes(id)))throw Error('同一测点不能同时标为中国大陆与境外');
    for(const id of [...patch.cnProbeIds,...patch.globalProbeIds])if(!store.get('node',id))throw Error('测点节点不存在');
    const cfg={...previous,...patch,generation:randomUUID()};if(patch.clearToken)delete cfg.botToken;delete cfg.clearToken;
    if(cfg.enabled&&(!cfg.botToken||!cfg.chatId))throw Error('启用前请填写 Bot Token 和 Chat ID');
    store.put('system','monitoring',cfg);
    // Do not send old alerts into a newly configured chat, or resume stale samples.
    for(const item of store.list('notification'))if(['pending','sending'].includes(item.status))store.put('notification',item.id,{...item,status:'superseded'});
    store.audit('monitoring.updated','system');return publicSettings();
  }
  function targetsFor(probe,cfg,nodes){
    const targets=[];const region=cfg.cnProbeIds.includes(probe.id)?'cn':cfg.globalProbeIds.includes(probe.id)?'global':null;
    for(const n of nodes.filter(n=>n.enabled)){
      const b=n.applied??n.observed;if(!b)continue;
      let s;try{s=readSettings(b);}catch{}
      const relay=b.files['relay.json'];
      const ports=new Set(s?[s.port]:[]);if(relay?.role==='landing')ports.add(relay.external_port??relay.listen_port);
      for(const [key,family] of [['ipv4',4],['ipv6',6]]){
        if(!n[key])continue;
        if(region)for(const port of ports)targets.push({kind:'tcp',nodeId:n.id,host:n[key],port,family,region});
        if(n.id===probe.id&&s)targets.push({kind:'sni',nodeId:n.id,host:s[family===4?'sni4':'sni6'],port:443,family,region:'self'});
      }
    }
    return targets.map(t=>({...t,id:hash([t.kind,t.nodeId,t.host,t.port,t.family]).slice(0,40)}));
  }
  function plan(probe){
    const cfg=settings();if(!cfg.enabled||probe.report?.monitorProtocol!==1)return null;
    const signature=configHash(cfg),current=store.get('node',probe.id)??probe;
    if(current.monitorPlan&&current.monitorPlan.expiresAt>clock()&&current.monitorPlan.signature===signature)return current.monitorPlan;
    if((current.monitorDueAt??0)>clock()&&current.monitorSignature===signature)return null;
    const targets=targetsFor(probe,cfg,store.list('node'));
    if(!targets.length)return null;
    const start=(current.monitorCursor??0)%targets.length,selected=Array.from({length:Math.min(8,targets.length)},(_,i)=>targets[(start+i)%targets.length]);
    const result={id:randomUUID(),signature,periodMs:cfg.interval*1000*Math.ceil(targets.length/8),createdAt:clock(),expiresAt:clock()+Math.max(60000,cfg.interval*1000),targets:selected};
    current.monitorPlan=result;current.monitorDueAt=clock()+cfg.interval*1000;current.monitorSignature=signature;current.monitorCursor=(start+selected.length)%targets.length;store.put('node',current.id,current);return result;
  }
  function queue(incident,active,cfg){
    // Cancel unsent state changes which no longer describe the current condition.
    for(const item of store.list('notification'))if(item.incidentId===incident.id&&item.status==='pending'){item.status='superseded';store.put('notification',item.id,item);}
    const inFlight=store.list('notification').some(x=>x.incidentId===incident.id&&x.active&&x.status==='sending');
    if(!active&&!incident.alertDelivered&&!inFlight)return;
    const target=store.get('node',incident.nodeId);if(!target)return;
    const text=`${active?'⚠️ 告警':'✅ 恢复'} · Xray Panel\n节点：${target.name}\n${incident.kind==='tcp'?'疑似国内网络阻断（IP:端口）':'SNI / TLS 异常'}\n目标：${incident.host}:${incident.port} / IPv${incident.family}\n${active?incident.kind==='tcp'?`${cfg.cnQuorum} 个大陆测点连续失败，境外测点可达；不等同于已证明 GFW 封锁。`:`连续 ${cfg.failures} 轮检查失败；原因：${incident.lastCode}（DNS / 证书 / TLS 1.3 / h2）。`:`连续 ${cfg.recoveries} 轮检查恢复。`}\n时间：${new Date(clock()).toISOString()}`;
    const item={id:randomUUID(),incidentId:incident.id,nodeId:target.id,active,text,createdAt:clock(),dueAt:clock(),attempts:0,status:'pending',destinationHash:hash([cfg.botToken,cfg.chatId,cfg.threadId])};store.put('notification',item.id,item);
  }
  function assessment(record,cfg){
      const samples=Object.entries(record.samples).filter(([id,s])=>clock()-s.at<=(s.periodMs??cfg.interval*1000)*3&&store.get('node',id)&&((s.region==='cn'&&cfg.cnProbeIds.includes(id))||(s.region==='global'&&cfg.globalProbeIds.includes(id))||s.region==='self'&&id===record.nodeId)).map(([,s])=>s);
      let verdict=null;
      if(record.kind==='sni'){
        const s=samples.find(s=>s.region==='self');if(s?.ok===false&&s.count>=cfg.failures)verdict=true;else if(s?.ok&&s.count>=cfg.recoveries)verdict=false;
      }else{
        const cn=samples.filter(s=>s.region==='cn');
        if(cn.filter(s=>!s.ok&&s.count>=cfg.failures).length>=cfg.cnQuorum&&samples.some(s=>s.region==='global'&&s.ok))verdict=true;
        else if(cn.filter(s=>s.ok&&s.count>=cfg.recoveries).length>=cfg.cnQuorum)verdict=false;
      }
      return {verdict,samples};
  }
  function accept(probe,result){
    const cfg=settings(),current=store.get('node',probe.id),p=current?.monitorPlan;
    if(!cfg.enabled||!p||p.signature!==configHash(cfg)||p.id!==result?.planId||p.expiresAt<clock()||!Array.isArray(result.results)||result.results.length>8)return;
    delete current.monitorPlan;store.put('node',current.id,current);
    for(const target of p.targets){
      // Reject old addresses/SNI after configuration edits, node removal or disablement.
      const still=targetsFor(current,cfg,store.list('node')).find(t=>t.id===target.id&&t.region===target.region);if(!still)continue;
      const r=result.results.find(r=>r?.id===target.id&&typeof r.ok==='boolean');if(!r)continue;
      let record=store.get('monitor',target.id)??{id:target.id,...target,active:false,samples:{}};
      if(record.signature!==p.signature){record={...record,signature:p.signature,samples:{},active:false,alertDelivered:false};}
      const previous=record.samples[probe.id];const adjacent=previous&&clock()-previous.at<=(previous.periodMs??cfg.interval*1000)*1.5;
      record.samples[probe.id]={at:clock(),periodMs:p.periodMs,region:target.region,ok:r.ok,count:adjacent&&previous.ok===r.ok?previous.count+1:1};record.updatedAt=clock();record.lastCode=['ok','certificate_invalid','h2_not_negotiated','tls_failed','timeout','connect_failed','dns_failed','network_failed','non_public_or_empty_dns','probe_timeout'].includes(r.code)?r.code:'probe_failed';
      const {verdict,samples}=assessment(record,cfg);
      record.assessment=verdict===null?'insufficient':verdict?'alert':'reachable';
      record.evidence=samples.map(s=>({region:s.region,ok:s.ok,count:s.count,at:s.at}));
      if(verdict!==null&&record.active!==verdict){record.active=verdict;record.changedAt=clock();queue(record,verdict,cfg);}
      store.put('monitor',record.id,record);
    }
  }
  function targetCurrent(record,cfg){
    const probe=record.kind==='sni'?store.get('node',record.nodeId):[...cfg.cnProbeIds,...cfg.globalProbeIds].map(id=>store.get('node',id)).find(Boolean);
    return !!probe&&targetsFor(probe,cfg,store.list('node')).some(t=>t.id===record.id);
  }
  function status(){const cfg=settings();return {settings:publicSettings(),incidents:store.list('monitor').map(r=>{
    const {verdict,samples}=assessment(r,cfg),stale=r.signature!==configHash(cfg)||!samples.length;
    return {...r,current:targetCurrent(r,cfg),stale,assessment:stale||verdict===null?'insufficient':verdict?'alert':'reachable',evidence:samples.map(s=>({region:s.region,ok:s.ok,count:s.count,at:s.at}))};
  }).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)).slice(0,200),notifications:store.list('notification').sort((a,b)=>b.createdAt-a.createdAt).slice(0,50).map(({text,destinationHash,...safe})=>safe),notice:cfg.cnProbeIds.filter(id=>store.get('node',id)).length<cfg.cnQuorum?'国内测点不足，无法形成疑似国内阻断告警；SNI 检查仍可独立工作。':'国内测点位置由管理员声明；对照结果只能提示疑似网络阻断，无法证明封锁原因。'};}
  async function test(){const cfg=settings();if(!cfg.botToken||!cfg.chatId)throw Error('请先保存 Bot Token 和 Chat ID');return sendTelegram(cfg,'Xray Panel 测试通知：Telegram 接口已收到此消息。',fetchImpl);}
  async function drain(){
    if(sending)return;sending=true;
    try{
      const cfg=settings();for(const old of store.list('monitor'))if(clock()-(old.updatedAt??0)>7*86400000)store.remove('monitor',old.id);if(!cfg.enabled)return;
      const item=store.list('notification').filter(x=>(x.status==='pending'&&x.dueAt<=clock()||x.status==='sending'&&(x.leaseUntil??0)<=clock())).sort((a,b)=>a.createdAt-b.createdAt)[0];if(!item)return;
      const incident=store.get('monitor',item.incidentId),node=store.get('node',item.nodeId);
      if(!node?.enabled||!incident||!targetCurrent(incident,cfg)||incident.signature!==configHash(cfg)||incident.active!==item.active||!item.active&&!incident.alertDelivered||item.destinationHash!==hash([cfg.botToken,cfg.chatId,cfg.threadId])||clock()-item.createdAt>86400000){store.put('notification',item.id,{...item,status:'superseded'});return;}
      if(assessment(incident,cfg).verdict!==item.active){item.status='pending';item.dueAt=clock()+cfg.interval*1000;item.code='waiting_for_fresh_evidence';delete item.leaseUntil;store.put('notification',item.id,item);return;}
      item.status='sending';item.leaseUntil=clock()+30000;item.attempts++;item.lastAttemptAt=clock();store.put('notification',item.id,item);
      const result=await sendTelegram(cfg,item.text,fetchImpl);
      // The administrator can disable alerts/change destinations while fetch awaits.
      const latest=store.get('notification',item.id);if(!latest||latest.status!=='sending')return;
      delete item.leaseUntil;item.code=result.ok?'ok':result.code;
      if(result.ok){item.status='sent';item.messageId=result.messageId;const updated=store.get('monitor',item.incidentId);if(updated){updated.alertDelivered=item.active;store.put('monitor',updated.id,updated);}}
      else if(result.permanent)item.status='failed';else {item.status='pending';item.dueAt=clock()+1000*(result.retryAfter??Math.min(3600,30*2**Math.min(item.attempts-1,7)));}
      store.put('notification',item.id,item);store.audit('notification.'+item.status,item.nodeId,item.code);
      const history=store.list('notification').filter(x=>x.status!=='pending').sort((a,b)=>b.createdAt-a.createdAt);for(const old of history.slice(200))store.remove('notification',old.id);
    }finally{sending=false;}
  }
  return {settings,publicSettings,save,plan,accept,status,test,drain};
}
