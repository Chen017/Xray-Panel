import {compileDevices,providerNameEntries,nodeFiles,subscriptionNameKey} from '../shared/config.mjs';

// The synthetic identity enumerates names only. It is never deployed or persisted.
export function nodeNameEntries(node,master) {
  const base=node.applied??node.draft;if(!base)return [];
  const device={id:'00000000-0000-4000-8000-000000000000',epoch:'catalog',grants:[{nodeId:node.id,routes:['direct',...(base.files['relay.json']?.landings??[]).map(l=>l.id)],modes:['split','single4','single6','vision4','vision6']}]};
  const catalogNode={...node,ipv4:node.ipv4||'192.0.2.1',ipv6:node.ipv6||'2001:db8::1'};
  return providerNameEntries(catalogNode,compileDevices(base,node,[device],master),device,master);
}
export function assertUniqueNames(nodes,devices,master) {
  const check=names=>{const seen=new Set();for(const name of names){if(seen.has(name)){const e=Error('订阅名称重复：'+name+'；请为每条节点使用不同名称');e.status=400;throw e;}seen.add(name);}};
  const catalogs=new Map(nodes.map(n=>[n.id,nodeNameEntries(n,master)]));
  for(const entries of catalogs.values())check(entries.map(e=>e.name));
  // Validate future grants too: a new device's UUID has not been deployed yet.
  for(const device of devices.filter(d=>!d.revoked))check(nodes.filter(n=>n.enabled).flatMap(n=>{const g=device.grants.find(g=>g.nodeId===n.id);return g?catalogs.get(n.id).filter(e=>g.routes.includes(e.route)&&g.modes.includes(e.mode)).map(e=>e.name):[];}));
}
export function migrateSubscriptionNames(store,master) {
  let migrated=false;
  const devices=store.list('device').sort((a,b)=>(a.createdAt??'').localeCompare(b.createdAt??'')||a.id.localeCompare(b.id));
  for(const node of store.list('node')){
    if(node.subscriptionNamingVersion===1)continue;
    migrated=true;
    const names={...node.subscriptionNames},conflicts=[];
    // Include keys from temporarily hidden entries without needing a deployed bundle.
    const legacy=new Map();for(const device of devices.filter(d=>d.grants.some(g=>g.nodeId===node.id)))for(const[key,value]of Object.entries(device.subscriptionNames??{})){if(!value)continue;const values=legacy.get(key)??[];values.push({device:device.name,name:value});legacy.set(key,values);}
    // Keys are node-specific hashes; use the node catalog plus granted key provenance.
    // A device may grant several nodes, so only migrate keys attributable to this node.
    const candidates=new Set();for(const device of devices)for(const base of [node.applied,node.draft,node.observed].filter(Boolean))for(const [file] of nodeFiles(base))for(const grant of device.grants.filter(g=>g.nodeId===node.id))for(const route of grant.routes)for(const mode of grant.modes)candidates.add(subscriptionNameKey(node.id,file,route,mode));
    for(const[key,values]of legacy){if(!candidates.has(key))continue;if(!names[key])names[key]=values[0].name;if(new Set(values.map(v=>v.name)).size>1)conflicts.push({key,chosen:names[key],previous:values});}
    node.subscriptionNames=names;node.subscriptionNameConflicts=conflicts;node.subscriptionNamingVersion=1;node.subscriptionNameRevision??=0;
    store.put('node',node.id,node);
  }
  // Independent old device aliases can collide when combined. Preserve all old
  // values for review, and disambiguate only the conflicting migrated aliases.
  if(!migrated)return;
  const used=new Set();for(const node of store.list('node').sort((a,b)=>a.id.localeCompare(b.id))){let changed=false;for(const e of nodeNameEntries(node,master)){
    let name=e.name;if(used.has(name)||name==='Subscription Download'){
      const original=name;let counter=1;do{name=`${original.slice(0,95)} · ${node.name.slice(0,12)} · ${counter++}`;}while(used.has(name));
      node.subscriptionNames??={};node.subscriptionNames[e.key]=name;node.subscriptionNameConflicts??=[];node.subscriptionNameConflicts.push({key:e.key,chosen:name,previous:[{device:'旧名称冲突',name:original}]});changed=true;
    }used.add(name);
  }if(changed)store.put('node',node.id,node);}
}
