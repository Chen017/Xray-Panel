// Xray node and relay layout adapted from Chen017/Xray src/node.jq and core.sh.
import { createHash, createHmac, generateKeyPairSync,createPrivateKey,createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import {H2_WINDOW_MAX} from './h2-window.mjs';

// Numeric hashes use normalized IEEE-754 bytes, avoiding JS/Python JSON float formatting differences.
export const stable = (v) => {if(typeof v==='number'){if(!Number.isFinite(v))throw Error('配置包含非有限数字');const b=Buffer.alloc(8);b.writeDoubleBE(v===0?0:v);return `n${b.toString('hex')}`;}return v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;};
export const hashBundle = b => createHash('sha256').update(stable(b)).digest('hex');
export const clone = v => structuredClone(v);
export const portSchema = z.number().int().min(1).max(65535);
export const hostSchema = z.string().min(1).max(253).refine(v=>isIP(v) || /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(v), '无效的主机名或 IP');
const sniSchema = hostSchema.refine(v=>!isIP(v) && v.includes('.'),'SNI 必须是域名');
const sidSchema = z.array(z.string().regex(/^(?:[0-9a-f]{2}){0,8}$/i)).min(1).max(32);
export const settingsSchema = z.object({port:z.union([z.literal(443),z.literal(8443)]),uuid:z.guid(),privateKey:z.string().regex(/^[A-Za-z0-9_-]{43}$/),publicKey:z.string().regex(/^[A-Za-z0-9_-]{43}$/),sni4:sniSchema,sni6:sniSchema,shortIds4:sidSchema,shortIds6:sidSchema,path:z.string().regex(/^\/[^\s\x00-\x1f]*$/).max(512),v6Uplink:z.boolean(),logLevel:z.enum(['debug','info','warning','error','none']),outbound:z.enum(['UseIPv4','UseIPv6','UseIPv4v6','UseIPv6v4','HappyEyeballs4','HappyEyeballs6']),xhttp:z.record(z.string(),z.unknown())});
export const allowedFile = name => ['config.json','relay.json','custom_rules.json','firewall_ports.json','conf/is_v6_uplink'].includes(name) || /^conf\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.json$/.test(name);
export function validateBundle(b) {
  if (!b || typeof b !== 'object' || !b.files || typeof b.files !== 'object' || Array.isArray(b.files)) throw Error('配置必须包含 files 对象');
  if (!b.files['config.json'] || Array.isArray(b.files['config.json'])) throw Error('缺少 config.json');
  if (Object.keys(b.files).length > 100) throw Error('配置文件过多');
  for (const [name,value] of Object.entries(b.files)) {
    if (!allowedFile(name)) throw Error(`不允许的配置路径: ${name}`);
    if (name==='conf/is_v6_uplink' ? value!==true : value===null || typeof value!=='object') throw Error(`无效配置: ${name}`);
  }
  return clone({files:b.files});
}
export const nodeFiles = bundle => Object.entries(bundle.files).filter(([n,v])=>n.startsWith('conf/') && n.endsWith('.json') && n!=='conf/99_relay_in.json' && v.inbounds?.some(i=>i.streamSettings?.security==='reality'));
export function keypair() {
  const {privateKey,publicKey}=generateKeyPairSync('x25519');
  return {privateKey:privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('base64url'),publicKey:publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64url')};
}
function verifyKeypair(s){const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),Buffer.from(s.privateKey,'base64url')]),format:'der',type:'pkcs8'});if(createPublicKey(privateKey).export({type:'spki',format:'der'}).subarray(-32).toString('base64url')!==s.publicKey)throw Error('REALITY 公钥与私钥不匹配');}
export const defaultXhttp = () => ({mode:'stream-up',host:'',path:'/api/v3/updates',uplinkHTTPMethod:'PUT',noGRPCHeader:true,noSSEHeader:true,xPaddingBytes:'100-1000',xPaddingObfsMode:true,xPaddingPlacement:'queryInHeader',xPaddingMethod:'tokenish',xPaddingKey:'x_padding',xPaddingHeader:'Referer',sessionPlacement:'path',seqPlacement:'path',scStreamUpServerSecs:'20-80',xmux:{maxConcurrency:'16-32',cMaxReuseTimes:0,hMaxRequestTimes:'600-900',hMaxReusableSecs:'1800-3000',hKeepAlivePeriod:0}});
export const privateBlock = () => ({type:'field',ip:['geoip:private'],outboundTag:'block'});
export const baseBlocks = () => [{type:'field',domain:['geosite:cn'],outboundTag:'block'},{type:'field',ip:['geoip:cn'],outboundTag:'block'},{type:'field',protocol:['bittorrent'],outboundTag:'block'}];
export const managedInbounds = file => (file.inbounds??[]).filter(i=>i.protocol==='vless'&&(i.streamSettings?.security==='reality'||i.streamSettings?.network==='xhttp'));
// Match Xray's empty SplitHTTP defaults without inventing tuned XMUX values.
const xhttpSettings = value => value && typeof value==='object' && !Array.isArray(value) ? value : {};
export function migrateNodeEntrypoints(bundle) {
  for(const i of bundle.files['conf/99_relay_in.json']?.inbounds??[])if(i.tag==='relay-entry-v4')for(const c of i.settings?.clients??[])delete c.flow;
  for(const [name,file] of nodeFiles(bundle)) {
    const suffix=createHash('sha256').update(name).digest('hex').slice(0,16);
    const socket=`@xhttp_${suffix}`,tag=`local_xhttp_${suffix}`;
    const inner=managedInbounds(file).filter(i=>i.streamSettings?.network==='xhttp'&&(i.tag==='local_xhttp_stream_up'||/^local_xhttp_(?:port_[0-9]+|[0-9a-f]{16})$/.test(i.tag??'')));
    if(inner.length>1)throw Error(`配置 ${name} 包含多个受管 XHTTP 入口`);
    if(!inner.length)continue;
    const x=inner[0],old=x.listen;
    x.tag=tag;x.listen=socket;
    for(const i of managedInbounds(file))for(const fallback of i.settings?.fallbacks??[])if(fallback.dest===old||fallback.dest==='@xhttp_inner')fallback.dest=socket;
  }
  return bundle;
}
export function newBundle(settings,listen4='127.0.0.1') {
  const s=settingsSchema.parse(settings);verifyKeypair(s);
  const entry = (family,sni,sids) => ({tag:`public_${s.port}_${family}`,listen:family==='v4'?listen4:'::',port:s.port,protocol:'vless',settings:{clients:[{id:s.uuid,email:`vision-${family}`,flow:'xtls-rprx-vision'}],decryption:'none',fallbacks:[{dest:'@xhttp_inner'}]},streamSettings:{network:'raw',security:'reality',realitySettings:{show:false,dest:`${sni}:443`,serverNames:[sni],privateKey:s.privateKey,publicKey:s.publicKey,shortIds:sids,maxTimeDiff:60000},sockopt:{tcpFastOpen:true,...(family==='v6'?{v6only:true}:{})}},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}});
  const b={files:{'config.json':{log:{access:'/var/log/xray/access.log',error:'/var/log/xray/error.log',loglevel:s.logLevel},dns:{servers:['localhost','1.1.1.1','8.8.8.8']},outbounds:[{protocol:'freedom',tag:'direct',settings:{domainStrategy:'UseIPv4v6'}},{protocol:'freedom',tag:'direct-v4',settings:{domainStrategy:'UseIPv4'}},{protocol:'freedom',tag:'direct-v6',settings:{domainStrategy:'UseIPv6'}},{protocol:'blackhole',tag:'block'}],routing:{domainStrategy:'IPOnDemand',rules:baseBlocks()}},[`conf/VLESS-${s.port}.json`]:{inbounds:[entry('v4',s.sni4,s.shortIds4),entry('v6',s.sni6,s.shortIds6),{tag:'local_xhttp_stream_up',listen:'@xhttp_inner',protocol:'vless',settings:{clients:[{id:s.uuid,email:'xhttp-stream-up'}],decryption:'none'},streamSettings:{network:'xhttp',security:'none',xhttpSettings:s.xhttp},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}}]},'custom_rules.json':[],'firewall_ports.json':{open:[],closed:[]}}};
  b.files['config.json'].routing.rules.unshift(privateBlock());
  return patchSettings(b,s);
}
export function readSettings(bundle) {
  const entries=nodeFiles(bundle); if(!entries.length) return null;
  const inbounds=entries[0][1].inbounds, v4=inbounds.find(i=>i.tag?.endsWith('_v4')),v6=inbounds.find(i=>i.tag?.endsWith('_v6')),x=inbounds.find(i=>i.streamSettings?.network==='xhttp');
  if(!v4 || !v6 || !x) return null;
  const main=bundle.files['config.json'],direct=main.outbounds?.find(o=>o.tag==='direct');
  const xhttp=xhttpSettings(x.streamSettings.xhttpSettings);
  return {port:v4.port,uuid:v4.settings.clients.find(c=>!c.email?.startsWith('panel-')&&!c.email?.startsWith('relay-'))?.id ?? v4.settings.clients[0]?.id,...{privateKey:v4.streamSettings.realitySettings.privateKey,publicKey:v4.streamSettings.realitySettings.publicKey},sni4:v4.streamSettings.realitySettings.serverNames[0],sni6:v6.streamSettings.realitySettings.serverNames[0],shortIds4:v4.streamSettings.realitySettings.shortIds,shortIds6:v6.streamSettings.realitySettings.shortIds,path:xhttp.path||'/',v6Uplink:!!bundle.files['conf/is_v6_uplink'],logLevel:main.log?.loglevel??'warning',outbound:direct?.streamSettings?.sockopt?.happyEyeballs?(direct.streamSettings.sockopt.happyEyeballs.prioritizeIPv6?'HappyEyeballs6':'HappyEyeballs4'):(direct?.settings?.domainStrategy??'UseIPv4v6'),xhttp};
}
export function patchSettings(bundle,input) {
  const s=settingsSchema.parse(input),b=clone(bundle),files=nodeFiles(b);verifyKeypair(s);
  if(!files.length) throw Error('纯落地机无普通入站；请使用互联配置或先创建标准节点');
  for(const i of managedInbounds(files[0][1])) {
    for(const c of i.settings?.clients??[]) if(!c.email?.startsWith('relay-')&&!c.email?.startsWith('panel-')) c.id=s.uuid;
    if(i.streamSettings?.security==='reality') {
      i.port=s.port; const v6=i.tag.endsWith('_v6'); i.tag=`public_${s.port}_${v6?'v6':'v4'}`;
      Object.assign(i.streamSettings.realitySettings,{dest:`${v6?s.sni6:s.sni4}:443`,serverNames:[v6?s.sni6:s.sni4],shortIds:v6?s.shortIds6:s.shortIds4,privateKey:s.privateKey,publicKey:s.publicKey});
    }
    if(i.streamSettings?.network==='xhttp') i.streamSettings.xhttpSettings={...s.xhttp,path:s.path};
  }
  if(s.v6Uplink)b.files['conf/is_v6_uplink']=true;else delete b.files['conf/is_v6_uplink'];
  b.files['config.json'].log={...b.files['config.json'].log,loglevel:s.logLevel};
  const direct=b.files['config.json'].outbounds.find(o=>o.tag==='direct'); if(!direct)throw Error('缺少 direct 出站');
  direct.settings??={}; if(s.outbound.startsWith('Happy')) {
    direct.settings.domainStrategy='AsIs';direct.settings.targetStrategy='AsIs';direct.streamSettings??={};direct.streamSettings.sockopt={...direct.streamSettings.sockopt,domainStrategy:'UseIP',happyEyeballs:{tryDelayMs:250,prioritizeIPv6:s.outbound==='HappyEyeballs6',interleave:1,maxConcurrentTry:4}};
  } else {direct.settings.domainStrategy=s.outbound;delete direct.settings.targetStrategy;if(direct.streamSettings?.sockopt){delete direct.streamSettings.sockopt.happyEyeballs;delete direct.streamSettings.sockopt.domainStrategy;}}
  return validateBundle(migrateNodeEntrypoints(b));
}
export const ruleSchema=z.object({type:z.literal('field'),domain:z.array(z.string().min(1)).optional(),ip:z.array(z.string().min(1)).optional(),outboundTag:z.enum(['direct','direct-v4','direct-v6','block'])}).refine(r=>!!r.domain?.length!==!!r.ip?.length,'每条规则仅填写 domain 或 ip');
const optionalEntryPort=z.preprocess(v=>v===0||v===''?undefined:v,portSchema.optional());
const optionalEntryUuid=z.preprocess(v=>v===''?undefined:v,z.guid().optional());
const optionalEntryKey=z.preprocess(v=>v===''?undefined:v,z.string().min(10).max(2000).optional());
function normalizeLanding(r) {
  if(r?.role!=='landing')return r;
  const landing={...r};
  if(!landing.entry_listen_port)for(const key of ['entry_external_port','entry_uuid','entry_decryption','entry_encryption'])delete landing[key];
  if(landing.relay_enabled===false)for(const key of ['transport_uuid','decryption','encryption','listen_port','external_port','peer_ip'])delete landing[key];
  return landing;
}
export const landingSchema=z.object({id:z.string().regex(/^\d{1,6}$/),name:z.string().min(1).max(80),landing_ip:hostSchema,landing_port:portSchema,transport_uuid:z.guid(),encryption:z.string().min(10).max(2000).refine(s=>s.startsWith('mlkem768x25519plus.')||s.startsWith('mlkem768x25519.')||s.startsWith('chacha20poly1305.')),client_uuid:z.guid(),nodeId:z.guid().optional(),addressFamily:z.enum(['ipv4','ipv6']).optional(),entry_enabled:z.boolean().optional(),entry_address:hostSchema.optional(),entry_port:optionalEntryPort,entry_uuid:optionalEntryUuid,entry_encryption:optionalEntryKey}).superRefine((l,ctx)=>{if(l.entry_port&&(!l.entry_uuid||!l.entry_encryption))ctx.addIssue({code:'custom',path:['entry_port'],message:'公开入口需要独立 UUID 和加密参数，请在高级页补齐'});});
const natEntriesSchema=z.record(z.string().regex(/^(direct|\d{1,6})$/),z.object({
  nodeId:z.guid(),address:hostSchema.optional(),port:portSchema.optional(),uuid:z.guid().optional(),encryption:optionalEntryKey
}).nullable());
export const relaySchema=z.preprocess(normalizeLanding,z.discriminatedUnion('role',[
  z.object({role:z.literal('none'),nat_entries:natEntriesSchema.optional()}),
  z.object({role:z.literal('line'),nat_entries:natEntriesSchema.optional(),landings:z.array(landingSchema).min(1).max(32),failover:z.object({enabled:z.boolean(),interval:z.string().regex(/^[1-9]\d{0,4}s$/),order:z.array(z.string())})}),
  z.object({role:z.literal('landing'),relay_enabled:z.boolean().optional(),transport_uuid:z.guid().optional(),decryption:z.string().min(10).max(2000).optional(),encryption:z.string().min(10).max(2000).optional(),listen_port:portSchema.optional(),external_port:portSchema.optional(),landing_ip:hostSchema,peer_ip:z.string().refine(s=>s===''||isIP(s)===4,'来源白名单必须是 IPv4').optional(),entry_listen_port:z.number().int().min(0).max(65535).optional(),entry_external_port:optionalEntryPort,entry_uuid:optionalEntryUuid,entry_decryption:optionalEntryKey,entry_encryption:optionalEntryKey})
]).superRefine((r,ctx)=>{
  const issue=(key,message)=>ctx.addIssue({code:'custom',path:[key],message});
  if(r.role==='landing'){
    if(r.relay_enabled!==false) {
      for(const key of ['transport_uuid','decryption','encryption','listen_port','external_port'])if(!r[key])issue(key,'启用互联前请填写端口和互联加密参数');
    }else if(!r.entry_listen_port)issue('entry_listen_port','请启用公开 IPv4 入口或将节点设为独立节点');
    if(r.entry_listen_port>0){
      if(!r.entry_uuid||!r.entry_decryption||!r.entry_encryption)issue('entry_listen_port','启用公开入口前请生成独立 UUID 与匹配的加密参数');
      if(r.relay_enabled!==false&&r.entry_listen_port===r.listen_port)issue('entry_listen_port','公开入口与互联监听端口不能相同');
      if(r.relay_enabled!==false&&(r.entry_external_port??r.entry_listen_port)===r.external_port)issue('entry_external_port','公开入口与互联公网端口不能相同');
    }
  }else for(const route of Object.keys(r.nat_entries??{}))if(route!=='direct'&&!r.landings?.some(l=>l.id===route))issue('nat_entries','IPv4 接入配置引用了未知出口');
}));
export function natRouteEntry(relay,route) {
  if(Object.hasOwn(relay?.nat_entries??{},route))return relay.nat_entries[route];
  const landing=relay?.landings?.find(l=>l.id===route);
  if(landing?.entry_enabled===false||!landing?.entry_port||!landing.entry_encryption)return null;
  return {legacy:true,nodeId:landing.nodeId,address:landing.entry_address??landing.landing_ip,port:landing.entry_port,uuid:landing.entry_uuid,encryption:landing.entry_encryption};
}
const natModes=['split','single4','vision4'];
export function patchRouting(bundle,{customRules,relay}={}) {
  const b=clone(bundle),f=b.files,m=f['config.json'];
  if(customRules!==undefined)f['custom_rules.json']=z.array(ruleSchema).max(500).parse(customRules);
  if(relay!==undefined) {relay=relaySchema.parse(relay);if(relay.role==='none'&&!Object.keys(relay.nat_entries??{}).length)delete f['relay.json'];else f['relay.json']={version:relay.role==='line'?2:1,...relay};}
  m.routing??={rules:[]};m.routing.domainStrategy='IPOnDemand';
  const r=f['relay.json'],landings=r?.role==='line'?(r.landings??[]):[],fo=r?.failover??{enabled:false,interval:'60s',order:[]};
  if(new Set(landings.map(l=>l.id)).size!==landings.length)throw Error('落地 ID 重复');
  if(fo.order.some(id=>!landings.some(l=>l.id===id))||new Set(fo.order).size!==fo.order.length)throw Error('故障转移顺序包含重复或未知 ID');
  const order=[...(fo.order??[]),...landings.map(l=>l.id).filter(id=>!fo.order?.includes(id))];
  m.outbounds=m.outbounds.filter(o=>!/^relay-out(?:-|$)|^loop-relay-/.test(o.tag));
  m.routing??={domainStrategy:'IPOnDemand',rules:[]};
  delete m.observatory;delete m.routing.balancers;
  const rules=[];
  for(const [index,l] of landings.entries()) {
    const outbound=tag=>({tag,protocol:'vless',settings:{address:l.landing_ip,port:l.landing_port,id:l.transport_uuid,encryption:l.encryption,flow:'xtls-rprx-vision'},streamSettings:{network:'raw',security:'none'},mux:{enabled:false},targetStrategy:'AsIs'});
    if(index===0)m.outbounds.push(outbound('relay-out'));m.outbounds.push(outbound(`relay-out-${l.id}`));
    const users=[`relay-${l.id}-vision-v4`,`relay-${l.id}-vision-v6`,`relay-${l.id}-xhttp`,...(index===0?['relay-vision-v4','relay-vision-v6','relay-xhttp']:[])];
    rules.push({type:'field',user:users,...(fo.enabled?{balancerTag:`relay-balancer-${l.id}`}:{outboundTag:index===0?'relay-out':`relay-out-${l.id}`})});
  }
  if(landings.length&&fo.enabled) {
    m.observatory={subjectSelector:['relay-out',...landings.map(l=>`relay-out-${l.id}`)],probeUrl:'http://cp.cloudflare.com/generate_204',probeInterval:fo.interval,enableConcurrency:true};
    m.routing.balancers=order.map((id,k)=>({tag:`relay-balancer-${id}`,selector:[`relay-out-${id}`],strategy:{type:'leastPing'},fallbackTag:k===order.length-1?'direct':`loop-relay-${order[k+1]}`}));
    for(const id of order.slice(1)){m.outbounds.push({tag:`loop-relay-${id}`,protocol:'loopback',settings:{inboundTag:`from-loop-relay-${id}`}});rules.unshift({type:'field',inboundTag:[`from-loop-relay-${id}`],balancerTag:`relay-balancer-${id}`});}
  }
  for(const [,file] of nodeFiles(b))for(const i of managedInbounds(file)) {
    i.settings??={};i.settings.clients=(i.settings.clients??[]).filter(c=>!c.email?.startsWith('relay-'));
    const vision=i.streamSettings?.security==='reality';
    for(const [index,l] of landings.entries())i.settings.clients.push({id:l.client_uuid,email:index===0?(vision?`relay-vision-${i.tag.endsWith('_v6')?'v6':'v4'}`:'relay-xhttp'):`relay-${l.id}-${vision?`vision-${i.tag.endsWith('_v6')?'v6':'v4'}`:'xhttp'}`,...(vision?{flow:'xtls-rprx-vision'}:{})});
  }
  if(r?.role==='landing') {
    const inbounds=r.relay_enabled===false?[]:[{tag:'relay-in',listen:'0.0.0.0',port:r.listen_port,protocol:'vless',settings:{clients:[{id:r.transport_uuid,flow:'xtls-rprx-vision',email:'relay-transport'}],decryption:r.decryption},streamSettings:{network:'raw',security:'none'},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}}];
    if(r.entry_listen_port&&r.entry_listen_port>0&&r.entry_uuid&&r.entry_decryption) {
      inbounds.push({tag:'relay-entry-v4',listen:'0.0.0.0',port:r.entry_listen_port,protocol:'vless',settings:{clients:[{id:r.entry_uuid,email:'relay-entry-v4'}],decryption:r.entry_decryption},streamSettings:{network:'raw',security:'none'},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}});
    }
    f['conf/99_relay_in.json']={inbounds};
  }
  else delete f['conf/99_relay_in.json'];
  m.routing.rules=[privateBlock(),...rules,...(f['custom_rules.json']??[]),...baseBlocks()];
  return validateBundle(migrateNodeEntrypoints(b));
}
export function deviceUuid(master,device,nodeId,route) {
  const a=createHmac('sha256',master).update(`${device.id}:${device.epoch}:${nodeId}:${route}`).digest().subarray(0,16);a[6]=(a[6]&15)|0x40;a[8]=(a[8]&63)|0x80;const h=a.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function natEntryClients(nodeId,nodes,devices,master){
  const clients=[];
  for(const source of nodes.filter(n=>n.enabled&&n.id!==nodeId)){
    const relay=(source.observed??source.applied)?.files?.['relay.json'];
    for(const d of devices.filter(d=>!d.revoked)){
      const grant=d.grants.find(g=>g.nodeId===source.id);
      if(!grant?.modes.some(mode=>natModes.includes(mode)))continue;
      for(const route of grant.routes){
        if(route!=='direct'&&!relay?.landings?.some(l=>l.id===route))continue;
        const entry=natRouteEntry(relay,route);
        if(entry?.nodeId===nodeId&&entry.port)clients.push({id:deviceUuid(master,d,source.id,route),email:`panel-relay-${source.id}-${d.id}-${route}`});
      }
    }
  }
  return clients.sort((a,b)=>a.email.localeCompare(b.email));
}
// Allow authenticated transport to associated line endpoints before country/SNI
// blocks. Private refusal still runs first; unrelated destinations stay blocked.
export function natEntryTransportRules(nodeId,nodes,devices,master){
 const clients=natEntryClients(nodeId,nodes,devices,master),rules=[];
 for(const source of nodes.filter(n=>n.enabled)){
  const users=clients.filter(c=>c.email.startsWith(`panel-relay-${source.id}-`)).map(c=>c.email);
  const ip=[source.ipv4,source.ipv6].filter(v=>v&&isIP(v));
  const ports=[...new Set(nodeFiles((source.observed??source.applied)??{files:{}}).flatMap(([,f])=>managedInbounds(f).filter(i=>i.streamSettings?.security==='reality').map(i=>i.port)).filter(p=>Number.isInteger(p)&&p>0&&p<=65535))].sort((a,b)=>a-b);
  const domain=[...new Set(nodeFiles((source.observed??source.applied)??{files:{}}).flatMap(([,f])=>managedInbounds(f).filter(i=>i.streamSettings?.security==='reality').flatMap(i=>i.streamSettings.realitySettings?.serverNames??[])))].map(s=>'full:'+s);
  if(users.length&&ports.length)for(const target of [...(domain.length?[{domain}]:[]),...(ip.length?[{ip}]:[])])rules.push({type:'field',inboundTag:['relay-entry-v4'],user:users,...target,port:ports.join(','),network:'tcp',outboundTag:'direct'});
 }
 return rules;
}
export function compileDevices(base,node,devices,master,nodes=[]) {
  const b=migrateNodeEntrypoints(validateBundle(base)),m=b.files['config.json'];
  const deviceRules=[];
  m.routing??={rules:[]};m.routing.domainStrategy='IPOnDemand';m.routing.rules=(m.routing.rules??[]).filter(r=>r.ruleTag!=='panel-nat-transport-temporary'&&!r.user?.some(u=>u.startsWith('panel-')));
  for(const [,f] of nodeFiles(b))for(const i of managedInbounds(f)){i.settings??={};i.settings.clients=(i.settings.clients??[]).filter(c=>!c.email?.startsWith('panel-'));}
  const landingEntryInbound=b.files['conf/99_relay_in.json']?.inbounds?.find(i=>i.tag==='relay-entry-v4');
  if(landingEntryInbound){landingEntryInbound.settings??={};landingEntryInbound.settings.clients=(landingEntryInbound.settings.clients??[]).filter(c=>!c.email?.startsWith('panel-'));}
  for(const d of devices.filter(d=>!d.revoked))for(const grant of d.grants.filter(g=>g.nodeId===node.id))for(const route of grant.routes) {
    const l=route==='direct'?null:b.files['relay.json']?.landings?.find(l=>l.id===route);
    if(route!=='direct'&&!l)continue;
    const email=`panel-${d.id}-${route}`,id=deviceUuid(master,d,node.id,route);
    for(const [,f]of nodeFiles(b))for(const i of managedInbounds(f)) i.settings.clients.push({id,email,...(i.streamSettings?.security==='reality'?{flow:'xtls-rprx-vision'}:{})});
    if(route==='direct'&&landingEntryInbound)landingEntryInbound.settings.clients.push({id,email});
    if(l)deviceRules.push({type:'field',user:[email],...(b.files['relay.json'].failover?.enabled?{balancerTag:`relay-balancer-${route}`}:{outboundTag:`relay-out-${route}`})});
  }
  if(landingEntryInbound){landingEntryInbound.settings.clients.push(...natEntryClients(node.id,nodes,devices,master));deviceRules.push(...natEntryTransportRules(node.id,nodes,devices,master));}
  // This applies to imported legacy routing too, before any per-user or loopback rule.
  const rules=m.routing.rules.filter(r=>!(r.outboundTag==='block'&&r.ip?.length===1&&r.ip[0]==='geoip:private'));
  const loopRule=r=>r.balancerTag?.startsWith('relay-balancer-')&&r.inboundTag?.some(t=>t.startsWith('from-loop-relay-'));
  m.routing.rules=[privateBlock(),...rules.filter(loopRule),...deviceRules,...rules.filter(r=>!loopRule(r))];
  return b;
}
const rename={uplinkHTTPMethod:'uplink-http-method',noGRPCHeader:'no-grpc-header',noSSEHeader:'no-sse-header',xPaddingBytes:'x-padding-bytes',xPaddingObfsMode:'x-padding-obfs-mode',xPaddingPlacement:'x-padding-placement',xPaddingMethod:'x-padding-method',xPaddingKey:'x-padding-key',xPaddingHeader:'x-padding-header',sessionPlacement:'session-placement',sessionKey:'session-key',sessionIDLength:'session-length',seqPlacement:'seq-placement',seqKey:'seq-key',uplinkDataPlacement:'uplink-data-placement',uplinkDataKey:'uplink-data-key',uplinkChunkSize:'uplink-chunk-size',scMaxEachPostBytes:'sc-max-each-post-bytes',scMinPostsIntervalMs:'sc-min-posts-interval-ms',xmux:'reuse-settings',maxConcurrency:'max-concurrency',maxConnections:'max-connections',cMaxReuseTimes:'c-max-reuse-times',hMaxRequestTimes:'h-max-request-times',hMaxReusableSecs:'h-max-reusable-secs',hKeepAlivePeriod:'h-keep-alive-period'};
export const mihomoXhttp = x => Object.fromEntries(Object.entries(xhttpSettings(x)).filter(([k,v])=>v!==null&&['mode','host','path','headers',...Object.keys(rename)].includes(k)).map(([k,v])=>[rename[k]??k,k==='xmux'?mihomoXhttp(v):v]));
export const subscriptionNameKey=(nodeId,file,route,mode)=>createHash('sha256').update(JSON.stringify([nodeId,file,route,mode])).digest('hex').slice(0,40);
function natEndpoint(entry) {
  return entry?.nodeId&&JSON.stringify([entry.nodeId,entry.address,entry.port,entry.uuid,entry.encryption]);
}

function sharedNatNames(node,bundle) {
  const relay=bundle.files['relay.json'],landings=relay?.landings??[];
  const groups=new Map(),endpointsByNode=new Map();
  for(const route of ['direct',...landings.map(l=>l.id)]){
    const entry=natRouteEntry(relay,route),endpoint=natEndpoint(entry);
    if(!endpoint||!entry.address||!entry.port||!entry.uuid||!entry.encryption)continue;
    if(!groups.has(endpoint)){
      groups.set(endpoint,{entry,routes:[]});
      endpointsByNode.set(entry.nodeId,(endpointsByNode.get(entry.nodeId)??0)+1);
    }
    groups.get(endpoint).routes.push(route);
  }
  const shared=new Map(),files=nodeFiles(bundle).map(([file])=>file).sort();
  const repeated=[...groups].filter(([,group])=>group.routes.length>1&&endpointsByNode.get(group.entry.nodeId)===1);
  for(const [endpoint,{entry,routes}] of repeated){
    const key=subscriptionNameKey(node.id,'conf/99_relay_in.json',entry.nodeId,'nat4-entry');
    const previousKeys=routes.flatMap(route=>files.map(file=>subscriptionNameKey(node.id,file,route,'nat4-entry')));
    const customName=node.subscriptionNames?.[key]??previousKeys.map(old=>node.subscriptionNames?.[old]).find(Boolean)??'';
    const routeLabel=routes[0]==='direct'?'直出':landings.find(l=>l.id===routes[0])?.name??routes[0];
    const defaultName=`${node.subscriptionName||node.name}${repeated.length>1?` · ${routeLabel}`:''} · NAT-v4-Entry`;
    shared.set(endpoint,{key,customName,defaultName,sharedRoutes:routes});
  }
  return shared;
}

// The outer NAT hop only dials the line. The inner proxy still authenticates
// with the UUID of its own exit. Pick an already authorized outer credential.
function mergeNatEntries(node,applied,entries) {
  const names=sharedNatNames(node,applied),groups=new Map();
  for(const entry of entries){
    if(entry.mode!=='nat4-entry')continue;
    const endpoint=natEndpoint(entry.entryTarget?.entry),name=names.get(endpoint);
    if(!name)continue;
    const group=groups.get(endpoint)??[];
    group.push(entry);
    groups.set(endpoint,group);
  }
  const replacements=new Map(),merged=new Map();
  for(const [endpoint,group] of groups){
    const name=names.get(endpoint);
    const chosen=group.find(entry=>entry.route==='direct')??group[0];
    const proxy={...chosen.proxy,name:name.customName||name.defaultName};
    for(const entry of group)replacements.set(entry.key,proxy.name);
    merged.set(group[0].key,{...chosen,...name,proxy,sharedNat:true});
  }
  return entries.flatMap(entry=>{
    if(entry.mode==='nat4-entry'&&replacements.has(entry.key)){
      return merged.has(entry.key)?[merged.get(entry.key)]:[];
    }
    const replacement=replacements.get(entry.natGuardKey);
    if(replacement){
      const download=entry.proxy['xhttp-opts']?.['download-settings'];
      if(download?.['dialer-proxy'])download['dialer-proxy']=replacement;
      else entry.proxy['dialer-proxy']=replacement;
    }
    return [entry];
  });
}
function providerEntries(node,applied,device,master,sourceFile) {
  const regular=nodeFiles(applied);
  if(regular.length>1){const regularNames=new Set(regular.map(([name])=>name));return regular.flatMap(([name,file])=>providerEntries({...node,name:`${node.name} · ${name.slice(5,-5)}`,subscriptionName:node.subscriptionName?`${node.subscriptionName} · ${name.slice(5,-5)}`:''},{files:{...Object.fromEntries(Object.entries(applied.files).filter(([n])=>!regularNames.has(n))),[name]:file}},device,master,name));}
  const s=readSettings(applied);
  const r=applied.files?.['relay.json'];
  if(!s){
    if(r?.role==='landing'&&r.entry_listen_port>0&&r.entry_encryption){
      const grant=device.grants.find(g=>g.nodeId===node.id);if(!grant||!grant.routes.includes('direct'))return [];
      const entryInbound=applied.files?.['conf/99_relay_in.json']?.inbounds?.find(i=>i.tag==='relay-entry-v4');
      const uuid=deviceUuid(master,device,node.id,'direct');
      if(!entryInbound?.settings?.clients?.some(c=>c.id===uuid&&c.email===`panel-${device.id}-direct`))return [];
      const server=node.ipv4||r.landing_ip;if(!server)return [];
      const port=r.entry_external_port||r.entry_listen_port;
      const key=subscriptionNameKey(node.id,'conf/99_relay_in.json','direct','vlessenc');
      const defaultName=`${node.subscriptionName||node.name} · NAT-v4-VLESS-Enc`,customName=node.subscriptionNames?.[key]??'';
      const p={name:customName||defaultName,type:'vless',server,port,uuid,network:'tcp',tls:false,udp:true,tfo:false,mptcp:true,'packet-encoding':'xudp',encryption:(r.entry_encryption||'').replace(/=+$/,'')};
      return [{proxy:p,key,nodeId:node.id,file:'conf/99_relay_in.json',route:'direct',mode:'vlessenc',defaultName,customName}];
    }
    return [];
  }
  const result=[],grant=device.grants.find(g=>g.nodeId===node.id);if(!grant)return [];
  const emittedGuards=new Set();
  for(const route of grant.routes)for(const mode of grant.modes) {
    const uuid=deviceUuid(master,device,node.id,route),email=`panel-${device.id}-${route}`;
    const files=nodeFiles(applied);if(!files.some(([,f])=>managedInbounds(f).every(i=>i.settings?.clients?.some(c=>c.id===uuid&&c.email===email))))continue;
    const split=mode==='split',family=mode.endsWith('6')||split&&s.v6Uplink?'6':'4',down=family==='4'?'6':'4';
    const addr=f=>f==='4'?node.ipv4:node.ipv6;if(!addr(family)||split&&!addr(down))continue;
    const sni=f=>f==='4'?s.sni4:s.sni6,sid=f=>f==='4'?s.shortIds4[0]:(s.shortIds6[1]??s.shortIds6[0]);
    const transport=f=>({server:addr(f),port:s.port,tls:true,servername:sni(f),'client-fingerprint':f===family?'chrome':'firefox',alpn:['h2'],'reality-opts':{'public-key':s.publicKey,'short-id':sid(f)}});
    const landing=applied.files['relay.json']?.landings?.find(l=>l.id===route);
    const entry=natRouteEntry(applied.files['relay.json'],route),usesNat=!!entry&&natModes.includes(mode);
    if(usesNat&&(!entry.port||!entry.address||!entry.uuid||!entry.encryption))continue;
    const entryTarget=usesNat&&entry.nodeId?{nodeId:entry.nodeId,uuid,entry}:null;
    const file=sourceFile??regular[0][0],guardKey=subscriptionNameKey(node.id,file,route,'nat4-entry'),guardDefaultName=`${node.subscriptionName||node.name} · ${landing?.name??(route==='direct'?'直出':route)} · NAT-v4-Entry`,guardCustomName=node.subscriptionNames?.[guardKey]??'',guardName=guardCustomName||guardDefaultName;
    const guardProxy=usesNat?{name:guardName,type:'vless',server:entry.address,port:entry.port,uuid:entry.nodeId?uuid:entry.uuid,network:'tcp',tls:false,udp:true,tfo:false,mptcp:true,'packet-encoding':'xudp',encryption:entry.encryption.replace(/=+$/,'')}:null;
    const key=subscriptionNameKey(node.id,file,route,mode),defaultName=`${node.subscriptionName||node.name} · ${route==='direct'?'直出':landing?.name??route} · ${mode}`,customName=node.subscriptionNames?.[key]??'';

    if(usesNat&&entry.legacy&&mode==='vision4'){
      const p={...guardProxy,name:customName||defaultName};
      result.push({proxy:p,key,nodeId:node.id,file,route,mode,defaultName,customName,entryTarget});
      continue;
    }
    const p={name:customName||defaultName,type:'vless',...transport(family),uuid,udp:true,tfo:true,mptcp:true,'packet-encoding':'xudp',encryption:'none'};
    if(mode.startsWith('vision')){p.network='tcp';p.flow='xtls-rprx-vision';}
    else {p.network='xhttp';p['xhttp-opts']={...mihomoXhttp(s.xhttp),host:s.xhttp.host||sni(family),path:s.path};if(split)p['xhttp-opts']['download-settings']={...transport(down),host:s.xhttp.host||sni(down),path:s.path,'reuse-settings':{'max-concurrency':'8-16','c-max-reuse-times':0,'h-max-request-times':'300-600','h-max-reusable-secs':'2400-3600','h-keep-alive-period':0}};}
    let natGuardKey;
    if(usesNat){
      natGuardKey=guardKey;
      if(split){
        if(s.v6Uplink)p['xhttp-opts']['download-settings']['dialer-proxy']=guardName;
        else{p['dialer-proxy']=guardName;p['xhttp-opts']['download-settings']['dialer-proxy']='';}
      }
      else p['dialer-proxy']=guardName;
      if((p['dialer-proxy']||p['xhttp-opts']?.['download-settings']?.['dialer-proxy'])&&!emittedGuards.has(guardKey)){
        emittedGuards.add(guardKey);
        result.push({proxy:guardProxy,key:guardKey,nodeId:node.id,file,route,mode:'nat4-entry',defaultName:guardDefaultName,customName:guardCustomName,entryTarget});
      }
    }
    const window=device.downloadWindows?.[key];
    if(split&&Number.isInteger(window)&&window>0&&window<=H2_WINDOW_MAX)p['xhttp-opts']['download-settings']['h2-max-receive-buffer-per-stream']=window;
    result.push({proxy:p,key,nodeId:node.id,file,route,mode,defaultName,customName,entryTarget,natGuardKey});
  }
  return result;
}
export function providerProxies(node,applied,device,master) {
  return mergeNatEntries(node,applied,providerEntries(node,applied,device,master)).map(({proxy})=>proxy);
}
export function providerNameEntries(node,applied,device,master) {
  return mergeNatEntries(node,applied,providerEntries(node,applied,device,master)).map(({proxy,entryTarget,natGuardKey,...entry})=>({...entry,name:proxy.name}));
}
function deviceProviderEntries(nodes,device,master) {
  if(device.revoked)return [];
  const targets=new Map(nodes.filter(n=>n.enabled&&n.applied).map(n=>[n.id,n.applied]));
  const ready=({entryTarget})=>{
    if(!entryTarget)return true;
    const {nodeId,uuid,entry}=entryTarget,applied=targets.get(nodeId);
    const inbound=applied?.files['conf/99_relay_in.json']?.inbounds?.find(i=>i.tag==='relay-entry-v4');
    if(!inbound?.settings?.clients?.some(c=>c.id===uuid))return false;
    if(entry.legacy)return true;
    const config=applied.files['relay.json'];
    return config?.entry_listen_port===inbound.port&&(config.entry_external_port??config.entry_listen_port)===entry.port&&config.entry_uuid===entry.uuid&&config.entry_encryption===entry.encryption;
  };
  return nodes.filter(n=>n.enabled&&n.applied).flatMap(n=>mergeNatEntries(n,n.applied,providerEntries(n,n.applied,device,master).filter(ready))).map((entry,defaultIndex)=>({...entry,defaultIndex}));
}
export function deviceProviderProxies(nodes,device,master){return deviceProviderEntries(nodes,device,master).map(({proxy})=>proxy);}
export function deviceProviderNameEntries(nodes,device,master){return deviceProviderEntries(nodes,device,master).map(({proxy,entryTarget,natGuardKey,...entry})=>({...entry,name:proxy.name}));}
