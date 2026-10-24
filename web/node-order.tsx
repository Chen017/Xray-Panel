import {useEffect,useState} from 'react';
import {ActionIcon,Alert,Button,Card,Group,Loader,Modal,Stack,Text,Tooltip} from '@mantine/core';
import {IconArrowDown,IconArrowUp} from '@tabler/icons-react';
import {api} from './api';
import {notify,type RecordData} from './panel';

export function NodeOrder({opened,onClose,onSaved}:{opened:boolean;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [data,setData]=useState<RecordData|null>(null),[order,setOrder]=useState<string[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    setData(null);setOrder([]);setError('');if(!opened)return;
    let active=true;
    api('/node-order').then(value=>{if(active){setData(value);setOrder(value.order);}}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[opened]);
  const byId=new Map<string,RecordData>((data?.nodes??[]).map((node:RecordData)=>[node.id,node]));
  const changed=!!data&&order.some((id,index)=>id!==data.order[index]);
  function move(index:number,step:number){const next=[...order],target=index+step;if(target<0||target>=next.length)return;[next[index],next[target]]=[next[target],next[index]];setOrder(next);}
  async function save(){
    if(!data)return;setBusy(true);setError('');
    try{await api('/node-order','PUT',{revision:data.revision,order});notify('节点顺序已保存，所有设备刷新订阅后生效');onClose();await onSaved();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal opened={opened} onClose={busy?()=>{}:onClose} title="所有节点排序" size="lg" closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack>
    <Text size="sm">上下移动节点并保存。节点列表、所有设备订阅及 VLESS 导出共用这个顺序；每台设备只包含其已授权、已发布的节点。无需部署 Xray 或更新 Agent。</Text>
    {error&&<Alert color="red">{error} 请关闭窗口后重新打开以载入最新列表。</Alert>}
    {!data&&!error&&<Loader size="sm"/>}
    {data&&!order.length&&<Alert color="cyan">暂无节点，请先添加节点。</Alert>}
    {order.map((id,index)=>{const node=byId.get(id)!;return <Card key={id} padding="sm"><Group justify="space-between" wrap="nowrap"><Text size="sm" fw={600} style={{overflowWrap:'anywhere'}}>{index+1}. {node.name}{!node.enabled&&<Text span size="xs" c="dimmed"> · 未发布</Text>}</Text><Group gap={4} wrap="nowrap"><Tooltip label="上移"><ActionIcon aria-label={`上移：${node.name}`} variant="light" disabled={busy||index===0} onClick={()=>move(index,-1)}><IconArrowUp size={16}/></ActionIcon></Tooltip><Tooltip label="下移"><ActionIcon aria-label={`下移：${node.name}`} variant="light" disabled={busy||index===order.length-1} onClick={()=>move(index,1)}><IconArrowDown size={16}/></ActionIcon></Tooltip></Group></Group></Card>;})}
    {!!order.length&&<Group justify="space-between"><Button variant="subtle" disabled={busy} onClick={()=>setOrder(data!.defaultOrder)}>恢复添加顺序</Button><Button onClick={save} loading={busy} disabled={!changed}>保存顺序</Button></Group>}
  </Stack></Modal>;
}
