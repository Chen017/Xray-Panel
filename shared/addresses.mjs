import {isIP} from 'node:net';
import {clone,hashBundle} from './config.mjs';

// Existing manually entered addresses remain manual, including NAT/DDNS overrides.
export function addressPolicy(node) {
  return node.addressPolicy??Object.fromEntries(['ipv4','ipv6'].map(key=>[key,{mode:'manual',value:node[key]??''}]));
}
export function effectiveAddress(node,key) {
  const policy=addressPolicy(node)[key];
  return policy.mode==='auto'?(node.detectedAddresses?.[key]?.address??policy.value??''):policy.value;
}
export function publicAddress(value,family) {
  if(isIP(value)!==family)return false;
  if(family===4) {
    const [a,b,c]=value.split('.').map(Number);
    return a>0&&a<224&&a!==10&&a!==127&&!(a===192&&(b===168||b===0&&(c===0||c===2)))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113)&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31);
  }
  return /^[23][0-9a-f]{3}:/i.test(value)&&!/^2001:(?:db8|0*0|0*2|0*10|0*20):/i.test(value);
}
export function observeAddresses(node,network) {
  if(!network||!Number.isFinite(Date.parse(network.checkedAt)))return false;
  node.addressPolicy=addressPolicy(node);
  node.addressCandidates??={};node.detectedAddresses??={};
  let changed=false;
  for(const [key,family] of [['ipv4',4],['ipv6',6]]) {
    const sample=network[key], previous=node.addressCandidates[key];
    const timestamp=Date.parse(network.checkedAt);
    if(previous&&timestamp<=Date.parse(previous.checkedAt))continue;
    if(sample?.status!=='ok'||!publicAddress(sample.address,family)) {
      node.addressCandidates[key]={checkedAt:network.checkedAt,status:'failed'};
      continue; // Keep last valid address after a failed probe.
    }
    const stable=previous?.address===sample.address&&timestamp-Date.parse(previous.firstSeen)>=10000;
    node.addressCandidates[key]={address:sample.address,checkedAt:network.checkedAt,firstSeen:previous?.address===sample.address?previous.firstSeen:network.checkedAt,status:stable?'stable':'confirming'};
    if(stable)node.detectedAddresses[key]={address:sample.address,checkedAt:network.checkedAt,source:sample.source};
    const value=effectiveAddress(node,key);
    if(node[key]!==value){node[key]=value;changed=true;}
  }
  return changed;
}
export function resolveLinkedAddresses(bundle,nodes) {
  const b=clone(bundle),landings=b.files['relay.json']?.landings??[];
  for(const landing of landings) {
    if(!landing.nodeId)continue;
    const target=nodes.find(n=>n.id===landing.nodeId);
    if(!target)throw Error('关联落地已不存在，请重新选择或改用手动地址');
    const current=target.applied?.files['relay.json']??target.observed?.files['relay.json'];
    if(current?.role!=='landing')throw Error('关联节点不是已配置的落地机');
    const address=effectiveAddress(target,landing.addressFamily??'ipv4');
    if(!address)throw Error('关联落地没有可用的公网地址，请设置手动覆盖或等待探测');
    landing.landing_ip=address;landing.landing_port=current.external_port??current.listen_port;
    // Change only the linked transport destination; preserve unrelated routing and clients.
    for(const outbound of b.files['config.json'].outbounds??[]) {
      if(outbound.tag===`relay-out-${landing.id}`||outbound.tag==='relay-out'&&landing===landings[0]) {
        if(outbound.settings?.vnext)for(const server of outbound.settings.vnext){server.address=address;server.port=landing.landing_port;}
        else if(outbound.settings){outbound.settings.address=address;outbound.settings.port=landing.landing_port;}
      }
    }
  }
  return b;
}
export function linkedTargetHash(node,nodes) {
  const base=node.observed??node.applied;
  return base?hashBundle(resolveLinkedAddresses(base,nodes)):null;
}
