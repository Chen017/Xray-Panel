// Xray node and relay layout adapted from Chen017/Xray src/node.jq and core.sh.
import { createHash, createHmac, generateKeyPairSync,createPrivateKey,createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

// Numeric hashes use normalized IEEE-754 bytes, avoiding JS/Python JSON float formatting differences.
export const stable = (v) => {if(typeof v==='number'){if(!Number.isFinite(v))throw Error('配置包含非有限数字');const b=Buffer.alloc(8);b.writeDoubleBE(v===0?0:v);return `n${b.toString('hex')}`;}return v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;};
export const hashBundle = b => createHash('sha256').update(stable(b)).digest('hex');
export const clone = v => structuredClone(v);
export const portSchema = z.number().int().min(1).max(65535);
export const hostSchema = z.string().min(1).max(253).refine(v=>isIP(v) || /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(v), '无效的主机名或 IP');
const sniSchema = hostSchema.refine(v=>!isIP(v) && v.includes('.'),'SNI 必须是域名');
const sidSchema = z.array(z.string().regex(/^(?:[0-9a-f]{2}){0,8}$/i)).min(1).max(32);
export const settingsSchema = z.object({port:z.union([z.literal(443),z.literal(8443)]),uuid:z.string().uuid(),privateKey:z.string().regex(/^[A-Za-z0-9_-]{43}$/),publicKey:z.string().regex(/^[A-Za-z0-9_-]{43}$/),sni4:sniSchema,sni6:sniSchema,shortIds4:sidSchema,shortIds6:sidSchema,path:z.string().regex(/^\/[^\s\x00-\x1f]*$/).max(512),v6Uplink:z.boolean(),logLevel:z.enum(['debug','info','warning','error','none']),outbound:z.enum(['UseIPv4','UseIPv6','UseIPv4v6','UseIPv6v4','HappyEyeballs4','HappyEyeballs6']),xhttp:z.record(z.unknown())});
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
export const baseBlocks = () => [{type:'field',domain:['geosite:cn'],outboundTag:'block'},{type:'field',ip:['geoip:cn','geoip:private'],outboundTag:'block'},{type:'field',protocol:['bittorrent'],outboundTag:'block'}];
export function newBundle(settings,listen4='127.0.0.1') {
  const s=settingsSchema.parse(settings);verifyKeypair(s);
  const entry = (family,sni,sids) => ({tag:`public_${s.port}_${family}`,listen:family==='v4'?listen4:'::',port:s.port,protocol:'vless',settings:{clients:[{id:s.uuid,email:`vision-${family}`,flow:'xtls-rprx-vision'}],decryption:'none',fallbacks:[{dest:'@xhttp_inner'}]},streamSettings:{network:'raw',security:'reality',realitySettings:{show:false,dest:`${sni}:443`,serverNames:[sni],privateKey:s.privateKey,publicKey:s.publicKey,shortIds:sids,maxTimeDiff:60000},sockopt:{tcpFastOpen:true,...(family==='v6'?{v6only:true}:{})}},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}});
  const b={files:{'config.json':{log:{access:'/var/log/xray/access.log',error:'/var/log/xray/error.log',loglevel:s.logLevel},dns:{servers:['localhost','1.1.1.1','8.8.8.8']},outbounds:[{protocol:'freedom',tag:'direct',settings:{domainStrategy:'UseIPv4v6'}},{protocol:'freedom',tag:'direct-v4',settings:{domainStrategy:'UseIPv4'}},{protocol:'freedom',tag:'direct-v6',settings:{domainStrategy:'UseIPv6'}},{protocol:'blackhole',tag:'block'}],routing:{domainStrategy:'IPIfNonMatch',rules:baseBlocks()}},[`conf/VLESS-${s.port}.json`]:{inbounds:[entry('v4',s.sni4,s.shortIds4),entry('v6',s.sni6,s.shortIds6),{tag:'local_xhttp_stream_up',listen:'@xhttp_inner',protocol:'vless',settings:{clients:[{id:s.uuid,email:'xhttp-stream-up'}],decryption:'none'},streamSettings:{network:'xhttp',security:'none',xhttpSettings:s.xhttp},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}}]},'custom_rules.json':[],'firewall_ports.json':{open:[],closed:[]}}};
  return patchSettings(b,s);
}
export function readSettings(bundle) {
  const entries=nodeFiles(bundle); if(!entries.length) return null;
  const inbounds=entries[0][1].inbounds, v4=inbounds.find(i=>i.tag?.endsWith('_v4')),v6=inbounds.find(i=>i.tag?.endsWith('_v6')),x=inbounds.find(i=>i.streamSettings?.network==='xhttp');
  if(!v4 || !v6 || !x) return null;
  const main=bundle.files['config.json'],direct=main.outbounds?.find(o=>o.tag==='direct');
  return {port:v4.port,uuid:v4.settings.clients.find(c=>!c.email?.startsWith('panel-')&&!c.email?.startsWith('relay-'))?.id ?? v4.settings.clients[0]?.id,...{privateKey:v4.streamSettings.realitySettings.privateKey,publicKey:v4.streamSettings.realitySettings.publicKey},sni4:v4.streamSettings.realitySettings.serverNames[0],sni6:v6.streamSettings.realitySettings.serverNames[0],shortIds4:v4.streamSettings.realitySettings.shortIds,shortIds6:v6.streamSettings.realitySettings.shortIds,path:x.streamSettings.xhttpSettings.path,v6Uplink:!!bundle.files['conf/is_v6_uplink'],logLevel:main.log?.loglevel??'warning',outbound:direct?.streamSettings?.sockopt?.happyEyeballs?(direct.streamSettings.sockopt.happyEyeballs.prioritizeIPv6?'HappyEyeballs6':'HappyEyeballs4'):(direct?.settings?.domainStrategy??'UseIPv4v6'),xhttp:x.streamSettings.xhttpSettings};
}
export function patchSettings(bundle,input) {
  const s=settingsSchema.parse(input),b=clone(bundle),files=nodeFiles(b);verifyKeypair(s);
  if(!files.length) throw Error('纯落地机无普通入站；请使用互联配置或先创建标准节点');
  for(const i of files[0][1].inbounds) {
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
  return validateBundle(b);
}
export const ruleSchema=z.object({type:z.literal('field'),domain:z.array(z.string().min(1)).optional(),ip:z.array(z.string().min(1)).optional(),outboundTag:z.enum(['direct','direct-v4','direct-v6','block'])}).refine(r=>!!r.domain?.length!==!!r.ip?.length,'每条规则仅填写 domain 或 ip');
export const landingSchema=z.object({id:z.string().regex(/^\d{1,6}$/),name:z.string().min(1).max(80),landing_ip:hostSchema,landing_port:portSchema,transport_uuid:z.string().uuid(),encryption:z.string().min(10).max(2000).refine(s=>s.startsWith('mlkem768x25519plus.')||s.startsWith('mlkem768x25519.')) ,client_uuid:z.string().uuid(),nodeId:z.string().uuid().optional(),addressFamily:z.enum(['ipv4','ipv6']).optional()});
export const relaySchema=z.discriminatedUnion('role',[
  z.object({role:z.literal('none')}),
  z.object({role:z.literal('line'),landings:z.array(landingSchema).min(1).max(32),failover:z.object({enabled:z.boolean(),interval:z.string().regex(/^[1-9]\d{0,4}s$/),order:z.array(z.string())})}),
  z.object({role:z.literal('landing'),transport_uuid:z.string().uuid(),decryption:z.string().min(10).max(2000),encryption:z.string().min(10).max(2000),listen_port:portSchema,external_port:portSchema,landing_ip:hostSchema,peer_ip:z.string().refine(s=>s===''||isIP(s)===4,'来源白名单必须是 IPv4')})
]);
export function patchRouting(bundle,{customRules,relay}={}) {
  const b=clone(bundle),f=b.files,m=f['config.json'];
  if(customRules!==undefined)f['custom_rules.json']=z.array(ruleSchema).max(500).parse(customRules);
  if(relay!==undefined) {relay=relaySchema.parse(relay);if(relay.role==='none')delete f['relay.json'];else f['relay.json']={version:relay.role==='line'?2:1,...relay};}
  const r=f['relay.json'],landings=r?.role==='line'?(r.landings??[]):[],fo=r?.failover??{enabled:false,interval:'60s',order:[]};
  if(new Set(landings.map(l=>l.id)).size!==landings.length)throw Error('落地 ID 重复');
  if(fo.order.some(id=>!landings.some(l=>l.id===id))||new Set(fo.order).size!==fo.order.length)throw Error('故障转移顺序包含重复或未知 ID');
  const order=[...(fo.order??[]),...landings.map(l=>l.id).filter(id=>!fo.order?.includes(id))];
  m.outbounds=m.outbounds.filter(o=>!/^relay-out(?:-|$)|^loop-relay-/.test(o.tag));
  m.routing??={domainStrategy:'IPIfNonMatch',rules:[]};
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
  for(const [,file] of nodeFiles(b))for(const i of file.inbounds) {
    i.settings.clients=i.settings.clients.filter(c=>!c.email?.startsWith('relay-'));
    const vision=i.streamSettings?.security==='reality';
    for(const [index,l] of landings.entries())i.settings.clients.push({id:l.client_uuid,email:index===0?(vision?`relay-vision-${i.tag.endsWith('_v6')?'v6':'v4'}`:'relay-xhttp'):`relay-${l.id}-${vision?`vision-${i.tag.endsWith('_v6')?'v6':'v4'}`:'xhttp'}`,...(vision?{flow:'xtls-rprx-vision'}:{})});
  }
  if(r?.role==='landing')f['conf/99_relay_in.json']={inbounds:[{tag:'relay-in',listen:'0.0.0.0',port:r.listen_port,protocol:'vless',settings:{clients:[{id:r.transport_uuid,flow:'xtls-rprx-vision',email:'relay-transport'}],decryption:r.decryption},streamSettings:{network:'raw',security:'none'},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}}]};
  else delete f['conf/99_relay_in.json'];
  m.routing.rules=[...rules,...(f['custom_rules.json']??[]),...baseBlocks()];
  return validateBundle(b);
}
export function deviceUuid(master,device,nodeId,route) {
  const a=createHmac('sha256',master).update(`${device.id}:${device.epoch}:${nodeId}:${route}`).digest().subarray(0,16);a[6]=(a[6]&15)|0x40;a[8]=(a[8]&63)|0x80;const h=a.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function compileDevices(base,node,devices,master) {
  const b=validateBundle(base),m=b.files['config.json'];
  m.routing??={rules:[]};m.routing.rules=(m.routing.rules??[]).filter(r=>!r.user?.some(u=>u.startsWith('panel-')));
  for(const [,f] of nodeFiles(b))for(const i of f.inbounds)i.settings.clients=(i.settings.clients??[]).filter(c=>!c.email?.startsWith('panel-'));
  for(const d of devices.filter(d=>!d.revoked))for(const grant of d.grants.filter(g=>g.nodeId===node.id))for(const route of grant.routes) {
    const l=route==='direct'?null:b.files['relay.json']?.landings?.find(l=>l.id===route);
    if(route!=='direct'&&!l)continue;
    const email=`panel-${d.id}-${route}`,id=deviceUuid(master,d,node.id,route);
    for(const [,f]of nodeFiles(b))for(const i of f.inbounds) i.settings.clients.push({id,email,...(i.streamSettings?.security==='reality'?{flow:'xtls-rprx-vision'}:{})});
    if(l)m.routing.rules.unshift({type:'field',user:[email],...(b.files['relay.json'].failover?.enabled?{balancerTag:`relay-balancer-${route}`}:{outboundTag:`relay-out-${route}`})});
  }
  return b;
}
const rename={uplinkHTTPMethod:'uplink-http-method',noGRPCHeader:'no-grpc-header',noSSEHeader:'no-sse-header',xPaddingBytes:'x-padding-bytes',xPaddingObfsMode:'x-padding-obfs-mode',xPaddingPlacement:'x-padding-placement',xPaddingMethod:'x-padding-method',xPaddingKey:'x-padding-key',xPaddingHeader:'x-padding-header',sessionPlacement:'session-placement',sessionKey:'session-key',sessionIDLength:'session-length',seqPlacement:'seq-placement',seqKey:'seq-key',uplinkDataPlacement:'uplink-data-placement',uplinkDataKey:'uplink-data-key',uplinkChunkSize:'uplink-chunk-size',scMaxEachPostBytes:'sc-max-each-post-bytes',scMinPostsIntervalMs:'sc-min-posts-interval-ms',xmux:'reuse-settings',maxConcurrency:'max-concurrency',maxConnections:'max-connections',cMaxReuseTimes:'c-max-reuse-times',hMaxRequestTimes:'h-max-request-times',hMaxReusableSecs:'h-max-reusable-secs',hKeepAlivePeriod:'h-keep-alive-period'};
export const mihomoXhttp = x => Object.fromEntries(Object.entries(x).filter(([k])=>['mode','host','path','headers',...Object.keys(rename)].includes(k)).map(([k,v])=>[rename[k]??k,k==='xmux'?mihomoXhttp(v):v]));
export const subscriptionNameKey=(nodeId,file,route,mode)=>createHash('sha256').update(JSON.stringify([nodeId,file,route,mode])).digest('hex').slice(0,40);
function providerEntries(node,applied,device,master,sourceFile) {
  const regular=nodeFiles(applied);
  if(regular.length>1){const regularNames=new Set(regular.map(([name])=>name));return regular.flatMap(([name,file])=>providerEntries({...node,name:`${node.name} · ${name.slice(5,-5)}`},{files:{...Object.fromEntries(Object.entries(applied.files).filter(([n])=>!regularNames.has(n))),[name]:file}},device,master,name));}
  const s=readSettings(applied);if(!s)return [];
  const result=[],grant=device.grants.find(g=>g.nodeId===node.id);if(!grant)return [];
  for(const route of grant.routes)for(const mode of grant.modes) {
    const uuid=deviceUuid(master,device,node.id,route),email=`panel-${device.id}-${route}`;
    const files=nodeFiles(applied);if(!files.some(([,f])=>f.inbounds.every(i=>i.settings?.clients?.some(c=>c.id===uuid&&c.email===email))))continue;
    const split=mode==='split',family=mode.endsWith('6')||split&&s.v6Uplink?'6':'4',down=family==='4'?'6':'4';
    const addr=f=>f==='4'?node.ipv4:node.ipv6;if(!addr(family)||split&&!addr(down))continue;
    const sni=f=>f==='4'?s.sni4:s.sni6,sid=f=>f==='4'?s.shortIds4[0]:(s.shortIds6[1]??s.shortIds6[0]);
    const transport=f=>({server:addr(f),port:s.port,tls:true,servername:sni(f),'client-fingerprint':f===family?'chrome':'firefox',alpn:['h2'],'reality-opts':{'public-key':s.publicKey,'short-id':sid(f)}});
    const landing=applied.files['relay.json']?.landings?.find(l=>l.id===route);
    const file=sourceFile??regular[0][0],key=subscriptionNameKey(node.id,file,route,mode),defaultName=`${node.name} · ${route==='direct'?'直出':landing?.name??route} · ${mode}`,customName=device.subscriptionNames?.[key]??'';
    const p={name:customName||defaultName,type:'vless',...transport(family),uuid,udp:true,tfo:true,mptcp:true,'packet-encoding':'xudp',encryption:'none'};
    if(mode.startsWith('vision')){p.network='tcp';p.flow='xtls-rprx-vision';}
    else {p.network='xhttp';p['xhttp-opts']={...mihomoXhttp(s.xhttp),host:s.xhttp.host||sni(family),path:s.path};if(split)p['xhttp-opts']['download-settings']={...transport(down),host:s.xhttp.host||sni(down),path:s.path,'reuse-settings':{'max-concurrency':'8-16','c-max-reuse-times':0,'h-max-request-times':'300-600','h-max-reusable-secs':'2400-3600','h-keep-alive-period':0}};}
    result.push({proxy:p,settings:s,key,nodeId:node.id,file,route,mode,defaultName,customName});
  }
  return result;
}
export function providerProxies(node,applied,device,master) {
  return providerEntries(node,applied,device,master).map(({proxy})=>proxy);
}
export function providerNameEntries(node,applied,device,master) {
  return providerEntries(node,applied,device,master).map(({proxy,settings,...entry})=>({...entry,name:proxy.name}));
}
export function providerLinks(node,applied,device,master) {
  return providerEntries(node,applied,device,master).map(({proxy,settings})=>vlessLink(proxy,settings));
}
export function vlessLink(proxy,settings) {
  const p=proxy,q=new URLSearchParams({encryption:'none',security:'reality',sni:p.servername,fp:p['client-fingerprint'],pbk:p['reality-opts']['public-key'],sid:p['reality-opts']['short-id'],alpn:(p.alpn??['h2']).join(','),type:p.network==='xhttp'?'xhttp':'tcp'});
  if(p.network==='tcp')q.set('flow','xtls-rprx-vision');
  else {q.set('mode',p['xhttp-opts'].mode);q.set('path',p['xhttp-opts'].path);q.set('host',p['xhttp-opts'].host);const extra={...settings.xhttp,host:p['xhttp-opts'].host,path:p['xhttp-opts'].path};const d=p['xhttp-opts']['download-settings'];if(d)extra.downloadSettings={address:d.server,port:d.port,network:'xhttp',security:'reality',realitySettings:{fingerprint:d['client-fingerprint'],serverName:d.servername,publicKey:d['reality-opts']['public-key'],shortId:d['reality-opts']['short-id']},xhttpSettings:{...settings.xhttp,host:d.host,path:d.path}};q.set('extra',JSON.stringify(extra));}
  return `vless://${p.uuid}@${p.server.includes(':')?`[${p.server}]`:p.server}:${p.port}?${q}#${encodeURIComponent(p.name)}`;
}
