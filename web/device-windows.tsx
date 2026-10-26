import {useEffect,useState} from 'react';
import {Alert,Button,Card,Group,Loader,Modal,Stack,Switch,Text,TextInput} from '@mantine/core';
import {api} from './api';
import {formatH2Window,parseH2Window} from '../shared/h2-window.mjs';

export function DeviceWindows({device,onClose}:{device:{id:string;name:string};onClose:()=>void}){
  const [data,setData]=useState<any>(null),[values,setValues]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;api(`/devices/${device.id}/download-windows`).then(d=>{if(!active)return;setData(d);setValues(Object.fromEntries(Object.entries(d.windows).map(([key,bytes])=>[key,formatH2Window(Number(bytes))])));}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[device.id]);
  async function save(){
    setError('');setBusy(true);
    try{
      const windows=Object.fromEntries(Object.entries(values).map(([key,value])=>[key,parseH2Window(value)]));
      await api(`/devices/${device.id}/download-windows`,'PUT',{revision:data.revision,windows});onClose();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal opened onClose={onClose} title={`${device.name} · 下行 H2 窗口`} size="lg"><Stack>
    <Alert color="cyan">每条 XHTTP 双栈分离节点可独立启用，仅作用于这台设备。需要使用支持该参数的 Mihomo fork；保存后刷新订阅即可生效。</Alert>
    <Text size="sm" c="dimmed">1M = 1048576 字节。仅在 download-settings 内添加 h2-max-receive-buffer-per-stream；关闭则不添加。单栈 XHTTP 和 Vision 不适用此处设置。较大窗口可能增加内存和满载延迟，速度收益取决于链路。</Text>
    {error&&<Alert color="red">{error}</Alert>}
    {!data&&!error&&<Loader/>}
    {data?.entries.length===0&&<Text c="dimmed">暂无已授权的 XHTTP 双栈分离节点，请先在“修改权限”中选择该连接方式，并导入节点配置。</Text>}
    {data?.entries.map((entry:any)=><Card key={entry.key} withBorder padding="md"><Stack gap="sm">
      <Group justify="space-between" wrap="nowrap"><Text size="sm" fw={500}>{entry.name}</Text><Switch aria-label={`启用 ${entry.name} 的下行窗口`} checked={values[entry.key]!==undefined} onChange={e=>{const checked=e.currentTarget.checked;setValues(previous=>{const next={...previous};if(checked)next[entry.key]='8M';else delete next[entry.key];return next;});}}/></Group>
      {values[entry.key]!==undefined&&<TextInput label="接收窗口（M）" placeholder="例如 1M、10M" value={values[entry.key]} onChange={e=>{const value=e.currentTarget.value;setValues(previous=>({...previous,[entry.key]:value}));}}/>}
    </Stack></Card>)}
    <Button disabled={!data} loading={busy} onClick={save}>保存窗口设置</Button>
  </Stack></Modal>;
}
