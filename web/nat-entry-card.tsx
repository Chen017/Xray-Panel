import {Accordion,Alert,Badge,Button,Card,Group,NumberInput,SimpleGrid,Stack,Switch,Text,Textarea,TextInput} from '@mantine/core';
import type {RecordData} from './panel';

export function NatEntryCard({value,onChange,onGenerate,busy}:{value:RecordData;onChange:(value:RecordData)=>void;onGenerate:()=>void;busy:boolean}){
  const enabled=Number(value.entry_listen_port)>0;
  const field=(key:string,next:unknown)=>onChange({...value,[key]:next});
  const ready=!!(value.entry_uuid&&value.entry_encryption&&value.entry_decryption);
  return <Card withBorder><Stack gap="sm">
    <Group justify="space-between"><Text fw={600} size="sm">公开 IPv4 入口</Text><Badge color={enabled?'cyan':'gray'}>{enabled?'已在草稿中开启':'未开启'}</Badge></Group>
    <Switch label="允许客户端通过 NAT IPv4 接入" description="互联端口继续供线路机使用，公开入口使用另一组映射端口。" checked={enabled} onChange={event=>{
      if(!event.currentTarget.checked){onChange({...value,entry_listen_port:0});return;}
      const port=value.listen_port===25555?25556:25555;
      onChange({...value,entry_listen_port:port,entry_external_port:port,entry_uuid:value.entry_uuid||crypto.randomUUID()});
      if(!ready)onGenerate();
    }}/>
    {enabled&&<>
      <SimpleGrid cols={{base:1,sm:2}}><NumberInput label="公开入口监听端口" min={1} max={65535} value={value.entry_listen_port} onChange={v=>field('entry_listen_port',Number(v))}/><NumberInput label="公开入口映射端口" min={1} max={65535} value={value.entry_external_port||value.entry_listen_port} onChange={v=>field('entry_external_port',Number(v))}/></SimpleGrid>
      <Text size="sm">公网 {value.entry_external_port||value.entry_listen_port} → 本机 {value.entry_listen_port} · 部署后纳入国内连通检测（需启用后台检测）</Text>
      <Group><Badge color={ready?'teal':'orange'}>{ready?'独立加密参数已就绪':'等待生成加密参数'}</Badge><Button size="xs" variant="light" loading={busy} onClick={onGenerate}>{ready?'重新生成加密参数':'生成加密参数'}</Button></Group>
      <Text size="xs" c="dimmed">生成成功后会自动填入当前草稿。保存并部署后，关联线路机自动同步；客户端刷新 Provider 即可获取新配置。</Text>
      <Alert color="cyan">随机加密入口可独立使用。NAT IPv4 与线路机 IPv6 分离需要支持独立下行拨号的个人 Mihomo 构建；普通 VLESS 分享链接无法保存整条串联配置。</Alert>
      <Accordion><Accordion.Item value="keys"><Accordion.Control>独立 UUID 与加密参数</Accordion.Control><Accordion.Panel><Stack gap="sm">
        <TextInput label="公开入口 UUID" value={value.entry_uuid??''} onChange={e=>field('entry_uuid',e.currentTarget.value)}/>
        <Textarea label="入口 decryption（服务端）" value={value.entry_decryption??''} onChange={e=>field('entry_decryption',e.currentTarget.value)} autosize minRows={2}/>
        <Textarea label="入口 encryption（客户端）" value={value.entry_encryption??''} onChange={e=>field('entry_encryption',e.currentTarget.value)} autosize minRows={2}/>
      </Stack></Accordion.Panel></Accordion.Item></Accordion>
    </>}
  </Stack></Card>;
}
