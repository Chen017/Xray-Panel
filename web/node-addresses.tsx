import {useState} from 'react';
import {Badge,Button,Card,Group,Select,SimpleGrid,Stack,Switch,Text,TextInput} from '@mantine/core';
import {api,date} from './api';
import {perform,notify,type RecordData} from './panel';

export function NodeAddresses({node,reload,detect}:{node:RecordData;reload:()=>Promise<void>;detect:()=>void}) {
  const [name,setName]=useState(node.name),[enabled,setEnabled]=useState(node.enabled);
  const [policy,setPolicy]=useState<RecordData>(node.addressPolicy??{ipv4:{mode:'manual',value:node.ipv4??''},ipv6:{mode:'manual',value:node.ipv6??''}});
  return <Card><Stack gap="sm"><Group justify="space-between"><Text fw={600}>{node.name} · 客户端连接地址</Text><Badge color={node.online?'teal':'gray'}>{node.online?'Agent 在线':'Agent 离线'}</Badge></Group>
    <TextInput label="节点备注" value={name} onChange={e=>setName(e.currentTarget.value)}/>
    <SimpleGrid cols={{base:1,sm:2}}>{['ipv4','ipv6'].map(key=><Stack key={key} gap="xs"><Group><Text fw={600}>{key.toUpperCase()}</Text><Text ff="monospace" size="sm">{node[key]||'暂无可用地址'}</Text></Group>
      <Select label={`${key.toUpperCase()} 来源`} data={[{value:'auto',label:'自动检测公网 IP'},{value:'manual',label:'手动 IP / 域名（NAT / DDNS）'}]} value={policy[key].mode} onChange={mode=>setPolicy({...policy,[key]:{...policy[key],mode}})}/>
      {policy[key].mode==='manual'&&<TextInput label={`${key.toUpperCase()} 手动覆盖`} value={policy[key].value??''} onChange={e=>setPolicy({...policy,[key]:{...policy[key],value:e.currentTarget.value}})}/>}
      <Text size="xs" c="dimmed">最近有效检测：{node.detectedAddresses?.[key]?.address??'暂无'} · {date(node.detectedAddresses?.[key]?.checkedAt)}</Text><Text size="xs" c="dimmed">来源：{node.detectedAddresses?.[key]?.source??'未确认'}；本次状态：{node.addressCandidates?.[key]?.status??'等待采集'}</Text>
    </Stack>)}</SimpleGrid>
    <Text size="xs" c="dimmed">自动检测需两次一致结果（间隔至少 10 秒），默认每 5 分钟采集；失败保留最后有效地址。NAT 与 DDNS 请使用手动覆盖。地址本身更新订阅，不重启 Xray；关联落地通过正常任务校验部署。</Text>
    <Group justify="space-between"><Switch label="在订阅中发布此节点" checked={enabled} onChange={e=>setEnabled(e.currentTarget.checked)}/><Group><Button size="xs" variant="light" disabled={!node.report?.network} onClick={detect}>立即检测公网地址</Button><Button size="xs" onClick={()=>perform(async()=>{await api(`/nodes/${node.id}`,'PATCH',{name,enabled,addressPolicy:policy});await reload();notify('节点信息已保存');})}>保存节点信息</Button></Group></Group>
  </Stack></Card>;
}
