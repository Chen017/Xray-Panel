import {Accordion,Alert,NumberInput,Select,SimpleGrid,Stack,TextInput} from '@mantine/core';
import type {RecordData} from './panel';

export function LandingCard({value,nodes,onChange}:{value:RecordData;nodes:RecordData[];onChange:(v:RecordData)=>void}) {
  const linked=nodes.find(n=>n.id===value.nodeId);
  const targets=nodes.filter(n=>(n.applied??n.observed)?.files['relay.json']?.role==='landing');
  function bind(id:string|null) {
    const target=nodes.find(n=>n.id===id),r=(target?.applied??target?.observed)?.files['relay.json'];
    onChange({...value,nodeId:id||undefined,addressFamily:id?'ipv4':undefined,...(r?{landing_ip:target?.ipv4||r.landing_ip,landing_port:r.external_port??r.listen_port,transport_uuid:r.transport_uuid,encryption:r.encryption}:{})});
  }
  return <Stack gap="sm"><TextInput label="备注" value={value.name} onChange={e=>onChange({...value,name:e.currentTarget.value})}/>
    <Select label="落地地址来源" value={value.nodeId??''} data={[{value:'',label:'外部落地：手动地址'},...targets.map(n=>({value:n.id,label:`关联 ${n.name}`}))]} onChange={bind}/>
    {linked&&<><Select label="关联地址族" data={[{value:'ipv4',label:'IPv4 / 手动域名'},{value:'ipv6',label:'IPv6 / 手动域名'}]} value={value.addressFamily??'ipv4'} onChange={family=>onChange({...value,addressFamily:family})}/><Alert color="cyan">关联节点公网地址变化会排入正常配置校验和部署任务，不只修改订阅。公网端口取落地机映射端口。</Alert></>}
    <SimpleGrid cols={{base:1,sm:2}}><TextInput label="公网 IP / 域名" readOnly={!!linked} value={linked?.[value.addressFamily??'ipv4']||value.landing_ip} onChange={e=>onChange({...value,landing_ip:e.currentTarget.value})}/><NumberInput label="公网端口" readOnly={!!linked} min={1} max={65535} value={(linked?.applied??linked?.observed)?.files['relay.json']?.external_port??value.landing_port} onChange={v=>onChange({...value,landing_port:Number(v)})}/></SimpleGrid>
    <Accordion><Accordion.Item value="transport"><Accordion.Control>高级互联参数</Accordion.Control><Accordion.Panel><Stack>{[['transport_uuid','互联 UUID'],['client_uuid','脚本客户端 UUID'],['encryption','VLESS encryption']].map(([key,label])=><TextInput key={key} label={label} value={value[key]} onChange={e=>onChange({...value,[key]:e.currentTarget.value})}/>)}</Stack></Accordion.Panel></Accordion.Item></Accordion>
  </Stack>;
}
