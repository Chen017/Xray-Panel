import {useEffect,useState} from 'react';
import {Alert,Button,Card,Group,Loader,Modal,Stack,Text,TextInput} from '@mantine/core';
import {api} from './api';
import {notify,type RecordData} from './panel';

export function NodeSubscriptionNames({node,onClose,onSaved}:{node:RecordData|null;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [data,setData]=useState<RecordData|null>(null),[base,setBase]=useState(''),[names,setNames]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{setData(null);setError('');if(!node)return;let active=true;api(`/nodes/${node.id}/subscription-names`).then(value=>{if(active){setData(value);setBase(value.subscriptionName);setNames(Object.fromEntries(value.entries.map((e:RecordData)=>[e.key,e.customName])));}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[node?.id]);
  async function save(){if(!node||!data)return;setBusy(true);setError('');try{await api(`/nodes/${node.id}/subscription-names`,'PUT',{revision:data.revision,subscriptionName:base,names});notify('订阅名称已统一保存，所有授权设备刷新订阅后生效');onClose();await onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const changed=!!data&&(base.trim()!==data.subscriptionName||data.entries.some((e:RecordData)=>(names[e.key]??'').trim()!==e.customName));
  return <Modal opened={!!node} title={`统一订阅名称 · ${node?.name??''}`} onClose={busy?()=>{}:onClose} size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack>
    <Text size="sm">一次设置，所有授权设备共用。名称不修改 Xray 配置或 UUID；保存后刷新客户端 provider。设备的独立排序保持不变。</Text>
    {error&&<Alert color="red">{error}</Alert>}{!data&&!error&&<Loader size="sm"/>}
    {data&&<><TextInput label="订阅基础名称" description="留空沿用节点备注；修改基础名称会恢复逐条默认名称，可再填写完整名称。默认附加文件、出口与模式。" value={base} onChange={e=>{setBase(e.currentTarget.value);setNames(Object.fromEntries(data.entries.map((v:RecordData)=>[v.key,''])));}} maxLength={120} disabled={busy}/>
    {!!data.conflicts.length&&<Alert color="orange" title="旧设备名称迁移记录">冲突时采用最早授权设备的名称；为避免重名，必要时已自动区分。请在下面核对，旧值保留供参考。{data.conflicts.map((c:RecordData,i:number)=><Text key={i} size="xs" mt="xs">已采用：{c.chosen}；旧值：{c.previous.map((v:RecordData)=>`${v.device}：${v.name}`).join('；')}</Text>)}</Alert>}
    {!data.entries.length&&<Alert>暂无可导出的入站条目。仍可先保存基础名称；导入入站配置后可逐条命名。</Alert>}
    {data.entries.map((e:RecordData)=><Card key={e.key} padding="sm"><Text size="xs" c="dimmed" mb="xs">{e.file} · 出口 {e.route} · {e.mode}</Text><TextInput label={`完整名称：${e.defaultName}`} description="可填写任意完整名称，不受默认命名规则限制；留空使用基础名称和区分后缀。" placeholder={e.defaultName} value={names[e.key]??''} maxLength={120} disabled={busy} onChange={v=>setNames({...names,[e.key]:v.currentTarget.value})}/></Card>)}
    <Group justify="space-between"><Button variant="subtle" disabled={busy} onClick={()=>{setBase('');setNames(Object.fromEntries(data.entries.map((e:RecordData)=>[e.key,''])));}}>恢复默认名称</Button><Button loading={busy} disabled={!changed} onClick={save}>保存所有设备的名称</Button></Group></>}
  </Stack></Modal>;
}
