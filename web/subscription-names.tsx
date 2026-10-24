import {useEffect,useState} from 'react';
import {ActionIcon,Alert,Button,Card,Group,Loader,Modal,Stack,Text,TextInput,Tooltip} from '@mantine/core';
import {IconArrowDown,IconArrowUp} from '@tabler/icons-react';
import {api} from './api';
import {notify,type RecordData} from './panel';

const sameOrder=(a:string[],b:string[])=>a.length===b.length&&a.every((key,index)=>key===b[index]);
export function SubscriptionNames({device,onClose,onSaved}:{device:RecordData|null;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [data,setData]=useState<RecordData|null>(null),[names,setNames]=useState<Record<string,string>>({}),[order,setOrder]=useState<string[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    setData(null);setNames({});setOrder(null);setError('');if(!device)return;
    let active=true;
    api(`/devices/${device.id}/names`).then(value=>{if(active){setData(value);setNames(Object.fromEntries(value.entries.map((e:RecordData)=>[e.key,e.customName])));}}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[device?.id]);
  const entries:RecordData[]=data?.entries??[],initial=entries.map(e=>e.key),defaults=[...entries].sort((a,b)=>a.defaultIndex-b.defaultIndex).map(e=>e.key);
  const visible=order===null?initial:order.length?order:defaults,byKey=new Map(entries.map(e=>[e.key,e])),ordered=visible.map(key=>byKey.get(key)!);
  const used=new Set<string>();let duplicate='';
  for(const entry of entries){const value=names[entry.key]?.trim()||entry.defaultName;if(used.has(value))duplicate=value;used.add(value);}
  const changed=entries.some(e=>(names[e.key]??'').trim()!==e.customName)||(order!==null&&(order.length?!sameOrder(visible,initial):!!data?.order?.length));
  function move(index:number,step:number){const next=[...visible],target=index+step;if(target<0||target>=next.length)return;[next[index],next[target]]=[next[target],next[index]];setOrder(next);}
  async function save(){
    if(!device||!data)return;setBusy(true);setError('');
    try{await api(`/devices/${device.id}/names`,'PUT',{revision:data.revision,names,...(order!==null?{order}:{})});notify('订阅名称和顺序已保存，刷新客户端订阅即可生效');onClose();await onSaved();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal opened={!!device} onClose={busy?()=>{}:onClose} title={`订阅节点命名与排序 · ${device?.name??''}`} size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack>
    <Text size="sm">上下移动可调整订阅顺序，名称留空沿用默认。仅影响当前设备的订阅和 VLESS 导出；保存后刷新客户端订阅即可，无需部署 Xray 或更新 Agent。</Text>
    {error&&<Alert color="red">{error}</Alert>}
    {!data&&!error&&<Loader size="sm"/>}
    {data&&!entries.length&&<Alert color="cyan">暂无已发布节点，请先确认设备授权、Agent 部署任务和节点地址。</Alert>}
    {ordered.map((entry,index)=><Card key={entry.key} padding="sm"><Group justify="space-between" wrap="nowrap" mb="xs"><Text size="sm" fw={600} style={{overflowWrap:'anywhere'}}>{index+1}. {names[entry.key]?.trim()||entry.defaultName}</Text><Group gap={4} wrap="nowrap"><Tooltip label="上移"><ActionIcon aria-label={`上移：${entry.defaultName}`} variant="light" disabled={busy||index===0} onClick={()=>move(index,-1)}><IconArrowUp size={16}/></ActionIcon></Tooltip><Tooltip label="下移"><ActionIcon aria-label={`下移：${entry.defaultName}`} variant="light" disabled={busy||index===ordered.length-1} onClick={()=>move(index,1)}><IconArrowDown size={16}/></ActionIcon></Tooltip></Group></Group><Text size="xs" c="dimmed" mb="xs">{entry.file} · 出口 {entry.route} · {entry.mode}</Text><TextInput label={`订阅名称：${entry.defaultName}`} placeholder={entry.defaultName} value={names[entry.key]??''} maxLength={120} onChange={e=>setNames({...names,[entry.key]:e.currentTarget.value})} disabled={busy}/></Card>)}
    {duplicate&&<Alert color="orange">名称重复：{duplicate}。请为每条节点使用不同名称。</Alert>}
    {!!entries.length&&<Group justify="space-between"><Group gap="xs"><Button variant="subtle" disabled={busy} onClick={()=>setNames(Object.fromEntries(entries.map(e=>[e.key,''])))}>恢复默认名称</Button><Button variant="subtle" disabled={busy} onClick={()=>setOrder([])}>恢复默认顺序</Button></Group><Button onClick={save} loading={busy} disabled={!changed||!!duplicate}>保存名称与顺序</Button></Group>}
  </Stack></Modal>;
}
