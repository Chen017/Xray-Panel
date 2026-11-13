import {Badge,Button,Card,Group,NumberInput,SimpleGrid,Stack,Switch,Text,Textarea,TextInput} from '@mantine/core';
import type {RecordData} from './panel';

export function NatEntryCard({value,onChange,onGenerate,busy,advanced=false}:{value:RecordData;onChange:(value:RecordData)=>void;onGenerate:()=>void;busy:boolean;advanced?:boolean}){
  const enabled=Number(value.entry_listen_port)>0;
  const field=(key:string,next:unknown)=>onChange({...value,[key]:next});
  const ready=!!(value.entry_uuid&&value.entry_encryption&&value.entry_decryption);
  if(advanced)return enabled?<Stack gap="sm">
      <SimpleGrid cols={{base:1,sm:2}}><NumberInput label="公开入口监听端口" min={1} max={65535} value={value.entry_listen_port} onChange={v=>field('entry_listen_port',Number(v))}/><NumberInput label="公开入口映射端口" min={1} max={65535} value={value.entry_external_port||value.entry_listen_port} onChange={v=>field('entry_external_port',Number(v))}/></SimpleGrid>
      <TextInput label="公开入口 UUID" value={value.entry_uuid??''} onChange={e=>field('entry_uuid',e.currentTarget.value)}/>
      <Textarea label="入口 decryption（服务端）" value={value.entry_decryption??''} onChange={e=>field('entry_decryption',e.currentTarget.value)} autosize minRows={2}/>
      <Textarea label="入口 encryption（客户端）" value={value.entry_encryption??''} onChange={e=>field('entry_encryption',e.currentTarget.value)} autosize minRows={2}/>
      <Group><Button size="xs" variant="light" loading={busy} onClick={onGenerate}>重新生成公开入口加密参数</Button></Group>
    </Stack>:null;
  return <Card withBorder><Stack gap="sm">
    <Group justify="space-between"><Text fw={600} size="sm">公开 IPv4 入口</Text><Badge color={enabled?'cyan':'gray'}>{enabled?'已在草稿中开启':'未开启'}</Badge></Group>
    <Switch label="允许客户端通过 NAT IPv4 接入" description="公开入口可单独运行。启用互联时使用不同的映射端口。" checked={enabled} onChange={event=>{
      if(!event.currentTarget.checked){onChange({...value,entry_listen_port:0});return;}
      const port=[25555,25556,25557].find(p=>value.relay_enabled===false||(p!==value.listen_port&&p!==value.external_port));
      onChange({...value,entry_listen_port:port,entry_external_port:port,entry_uuid:value.entry_uuid||crypto.randomUUID()});
      if(!ready)onGenerate();
    }}/>
    {enabled&&<>
      <Text size="sm">公网 {value.entry_external_port||value.entry_listen_port} → 本机 {value.entry_listen_port}</Text>
      <Group><Badge color={ready?'teal':'orange'}>{ready?'独立加密参数已就绪':'等待生成加密参数'}</Badge>{!ready&&<Button size="xs" variant="light" loading={busy} onClick={onGenerate}>生成加密参数</Button>}</Group>
    </>}
  </Stack></Card>;
}
