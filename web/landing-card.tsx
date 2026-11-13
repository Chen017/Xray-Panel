import {NumberInput,Select,SimpleGrid,Stack,TextInput} from '@mantine/core';
import type {RecordData} from './panel';

export function LandingCard({value,nodes,onChange}:{value:RecordData;nodes:RecordData[];onChange:(v:RecordData)=>void}) {
  const linked=nodes.find(n=>n.id===value.nodeId);
  const targets=nodes.filter(n=>(n.applied??n.observed)?.files['relay.json']?.role==='landing'&&(n.applied??n.observed)?.files['relay.json']?.relay_enabled!==false);
  function bind(id:string|null) {
    const target=nodes.find(n=>n.id===id),r=(target?.applied??target?.observed)?.files['relay.json'];
    const eport=r?.entry_external_port??r?.entry_listen_port??0;
    onChange({...value,nodeId:id||undefined,addressFamily:id?'ipv4':undefined,...(r?{landing_ip:target?.ipv4||r.landing_ip,landing_port:r.external_port??r.listen_port,transport_uuid:r.transport_uuid,encryption:r.encryption,...(eport>0?{entry_port:eport,...(r.entry_uuid?{entry_uuid:r.entry_uuid}:{}),...(r.entry_encryption?{entry_encryption:r.entry_encryption}:{})}:{entry_port:0,entry_uuid:undefined,entry_encryption:undefined})}:{})});
  }
  const linkedRelay=(linked?.applied??linked?.observed)?.files['relay.json'];
  const effectiveEntryPort=linked?linkedRelay?.entry_external_port??linkedRelay?.entry_listen_port??0:value.entry_port??0;
  return <Stack gap="sm"><TextInput label="备注" value={value.name} onChange={e=>onChange({...value,name:e.currentTarget.value})}/>
    <Select label="落地地址来源" value={value.nodeId??''} data={[{value:'',label:'外部落地：手动地址'},...targets.map(n=>({value:n.id,label:`关联 ${n.name}`}))]} onChange={bind}/>
    {linked&&<Select label="关联地址族" data={[{value:'ipv4',label:'IPv4 / 手动域名'},{value:'ipv6',label:'IPv6 / 手动域名'}]} value={value.addressFamily??'ipv4'} onChange={family=>onChange({...value,addressFamily:family})}/>}
    <SimpleGrid cols={{base:1,sm:2}}><TextInput label="公网 IP / 域名" readOnly={!!linked} value={linked?.[value.addressFamily??'ipv4']||value.landing_ip} onChange={e=>onChange({...value,landing_ip:e.currentTarget.value})}/><NumberInput label="公网端口" readOnly={!!linked} min={1} max={65535} value={linkedRelay?.external_port??value.landing_port} onChange={v=>onChange({...value,landing_port:Number(v)})}/></SimpleGrid>
    {[['transport_uuid','互联 UUID'],['client_uuid','脚本客户端 UUID'],['encryption','VLESS encryption']].map(([key,label])=><TextInput key={key} label={label} value={value[key]} onChange={e=>onChange({...value,[key]:e.currentTarget.value})}/>)}
    <NumberInput label="NAT v4 方案一过墙公网端口（0 为不开启）" min={0} max={65535} readOnly={!!linked} value={effectiveEntryPort} onChange={v=>onChange({...value,entry_port:Number(v)})}/>
    {Number(effectiveEntryPort)>0&&<><TextInput label="方案一过墙 UUID" readOnly={!!linked} value={(linked?linkedRelay?.entry_uuid:value.entry_uuid)??''} onChange={e=>onChange({...value,entry_uuid:e.currentTarget.value})}/><TextInput label="方案一过墙 VLESS encryption" readOnly={!!linked} value={(linked?linkedRelay?.entry_encryption:value.entry_encryption)??''} onChange={e=>onChange({...value,entry_encryption:e.currentTarget.value})}/></>}
      </Stack>;
}
