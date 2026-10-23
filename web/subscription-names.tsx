import {useEffect,useState} from 'react';
import {Alert,Button,Card,Group,Loader,Modal,Stack,Text,TextInput} from '@mantine/core';
import {api} from './api';
import {notify,type RecordData} from './panel';

export function SubscriptionNames({device,onClose,onSaved}:{device:RecordData|null;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [data,setData]=useState<RecordData|null>(null),[names,setNames]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    setData(null);setNames({});setError('');if(!device)return;
    let active=true;
    api(`/devices/${device.id}/names`).then(value=>{if(active){setData(value);setNames(Object.fromEntries(value.entries.map((e:RecordData)=>[e.key,e.customName])));}}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[device?.id]);
  const entries:RecordData[]=data?.entries??[],used=new Set<string>();let duplicate='';
  for(const entry of entries){const value=names[entry.key]?.trim()||entry.defaultName;if(used.has(value))duplicate=value;used.add(value);}
  const changed=entries.some(e=>(names[e.key]??'').trim()!==e.customName);
  async function save(){
    if(!device||!data)return;setBusy(true);setError('');
    try{await api(`/devices/${device.id}/names`,'PUT',{revision:data.revision,names});notify('订阅名称已保存，刷新客户端订阅即可生效');onClose();await onSaved();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal opened={!!device} onClose={busy?()=>{}:onClose} title={`订阅节点命名 · ${device?.name??''}`} size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack>
    <Text size="sm">只修改当前设备的订阅和 VLESS 分享名称。留空恢复默认；保存后刷新订阅即可，无需部署 Xray 或更新 Agent。</Text>
    {error&&<Alert color="red">{error}</Alert>}
    {!data&&!error&&<Loader size="sm"/>}
    {data&&!entries.length&&<Alert color="cyan">暂无已发布节点，请先确认设备授权、Agent 部署任务和节点地址。</Alert>}
    {entries.map(entry=><Card key={entry.key} padding="sm"><Text size="sm" fw={600}>{entry.defaultName}</Text><Text size="xs" c="dimmed" mb="xs">{entry.file} · 出口 {entry.route} · {entry.mode}</Text><TextInput label={`订阅名称：${entry.defaultName}`} placeholder={entry.defaultName} value={names[entry.key]??''} maxLength={120} onChange={e=>setNames({...names,[entry.key]:e.currentTarget.value})} disabled={busy}/></Card>)}
    {duplicate&&<Alert color="orange">名称重复：{duplicate}。请为每条节点使用不同名称。</Alert>}
    {!!entries.length&&<Group justify="space-between"><Button variant="subtle" disabled={busy} onClick={()=>setNames(Object.fromEntries(entries.map(e=>[e.key,''])))}>全部恢复默认</Button><Button onClick={save} loading={busy} disabled={!changed||!!duplicate}>保存名称</Button></Group>}
  </Stack></Modal>;
}
