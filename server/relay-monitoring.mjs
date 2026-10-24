import {isIP} from 'node:net';
import {hostSchema,portSchema,readSettings} from '../shared/config.mjs';

// Observe the running topology, never an uncommitted draft or a newly resolved
// destination which has not yet been applied on the source VPS.
export const liveBundle=node=>node.observed??node.applied;
export const isLanding=node=>liveBundle(node)?.files?.['relay.json']?.role==='landing';
const sameHost=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

export function relayTargets(probe,nodes){
  const targets=[];
  if(!probe.enabled||probe.report?.monitorProtocol!==3)return targets;
  for(const line of nodes.filter(n=>n.enabled&&liveBundle(n)?.files?.['relay.json']?.role==='line')){
    const bundle=liveBundle(line),relay=bundle.files['relay.json'];
    if(!Array.isArray(relay.landings))continue;
    for(const link of relay.landings.slice(0,32)){
      if(!link||typeof link.id!=='string'||!/^\d{1,6}$/.test(link.id)||!hostSchema.safeParse(link.landing_ip).success||!portSchema.safeParse(link.landing_port).success)continue;
      const landing=link.nodeId?nodes.find(n=>n.id===link.nodeId):nodes.find(n=>isLanding(n)&&[n.ipv4,n.ipv6].some(address=>sameHost(address,link.landing_ip))&&[liveBundle(n).files['relay.json'].external_port,liveBundle(n).files['relay.json'].listen_port].includes(link.landing_port));
      // A removed or disabled managed endpoint must not keep creating alerts.
      if(link.nodeId&&(!landing?.enabled||!isLanding(landing)))continue;
      const family=isIP(link.landing_ip)||(link.addressFamily==='ipv6'?6:4);
      const common={kind:'tcp',region:'self',routeId:link.id,scope:[line.id,link.id,link.landing_ip,link.landing_port,landing?.id??null]};
      if(line.id===probe.id)targets.push({...common,nodeId:probe.id,direction:'line-to-landing',peerNodeId:landing?.id??null,peerName:landing?.name??String(link.name??link.landing_ip).slice(0,80),host:link.landing_ip,port:link.landing_port,family});
      if(landing?.id!==probe.id)continue;
      let settings;try{settings=readSettings(bundle);}catch{}
      if(!portSchema.safeParse(settings?.port).success)continue;
      const key=family===6?'ipv6':'ipv4',other=family===6?'ipv4':'ipv6';
      const host=line[key]||line[other];
      if(!hostSchema.safeParse(host).success)continue;
      const reverseFamily=isIP(host)||(line[key]?family:family===6?4:6);
      targets.push({...common,nodeId:probe.id,direction:'landing-to-line',peerNodeId:line.id,peerName:line.name,host,port:settings.port,family:reverseFamily});
    }
  }
  return targets;
}
