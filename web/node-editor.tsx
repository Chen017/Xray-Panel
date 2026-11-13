import { useEffect,useRef,useState } from 'react';
import { Accordion,ActionIcon,Alert,Badge,Box,Button,Card,Checkbox,Combobox,Divider,Group,InputBase,Modal,NumberInput,Select,SimpleGrid,Stack,Switch,Tabs,Text,Textarea,TextInput,Title,Tooltip,useCombobox } from '@mantine/core';
import { IconArrowDown,IconArrowUp,IconCheck,IconCode,IconCopy,IconKey,IconPlus,IconRefresh,IconRocket,IconTrash } from '@tabler/icons-react';
import { api,json,date } from './api';
import { CopyBlock,notify,perform,Status,type RecordData } from './panel';
import {LandingCard} from './landing-card';
import {NatEntryCard} from './nat-entry-card';
import {NodeSubscriptionNames} from './node-subscription-names';
import {NodeAddresses} from './node-addresses';
import {FirewallView} from './firewall-view';
import {JobResult} from './job-result';
import { draftPatch,editorChanged,formChanged,type EditorBaseline } from './editor-state';

const xhttpDefault={mode:'stream-up',host:'',path:'/api/v3/updates',uplinkHTTPMethod:'PUT',noGRPCHeader:true,noSSEHeader:true,xPaddingBytes:'100-1000',xPaddingObfsMode:true,xPaddingPlacement:'queryInHeader',xPaddingMethod:'tokenish',xPaddingKey:'x_padding',xPaddingHeader:'Referer',sessionPlacement:'path',seqPlacement:'path',scStreamUpServerSecs:'20-80',xmux:{maxConcurrency:'16-32',cMaxReuseTimes:0,hMaxRequestTimes:'600-900',hMaxReusableSecs:'1800-3000',hKeepAlivePeriod:0}};
const defaultSettings=()=>({port:443,uuid:crypto.randomUUID(),privateKey:'',publicKey:'',sni4:'hahuma.com',sni6:'dodoshort.com',shortIds4:[''],shortIds6:[''],path:'/api/v3/updates',v6Uplink:false,logLevel:'warning',outbound:'UseIPv4v6',xhttp:xhttpDefault});
const labelActions:Record<string,string>={'detect-addresses':'检测公网地址','firewall-status':'读取系统防火墙',inspect:'同步当前配置',validate:'校验当前配置',dump:'查看合并配置',logs:'读取日志',start:'启动服务',stop:'停止服务',restart:'重启服务',enable:'开机自启',disable:'关闭自启','update-core':'更新固定版核心','update-script':'更新管理脚本','update-geodata':'更新 geodata',maintenance:'重装维护任务',bbr:'启用 BBR',diagnostics:'网络与 SNI 自检','relay-test':'测试全部落地链路','relay-keygen':'生成互联加密参数','relay-entry-keygen':'生成方案一过墙加密参数','install-standard':'安装标准节点','install-landing':'安装纯落地环境',uninstall:'卸载 Xray'};
const typeData=['DOMAIN','DOMAIN-SUFFIX','DOMAIN-KEYWORD','IP-CIDR','GEOSITE','GEOIP'];
const ruleTypes=typeData.map(type=>({value:type,label:type}));
const ruleActions=[{value:'direct',label:'放行 direct'},{value:'direct-v4',label:'IPv4 解析'},{value:'direct-v6',label:'IPv6 解析'},{value:'block',label:'阻止 block'}];

function RuleSelect({label,options,value,onChange}:{label:string;options:{value:string;label:string}[];value:string;onChange:(value:string)=>void}){
  const combobox=useCombobox({onDropdownClose:()=>combobox.resetSelectedOption()});
  const current=options.find(option=>option.value===value);
  return <Combobox store={combobox} floatingStrategy="fixed" onOptionSubmit={next=>{
    onChange(next);
    combobox.closeDropdown();
  }}>
    <Combobox.Target targetType="button">
      <InputBase component="button" type="button" pointer label={label} aria-label={label}
        rightSection={<Combobox.Chevron/>} rightSectionPointerEvents="none" onClick={()=>combobox.toggleDropdown()}>
        {current?.label}
      </InputBase>
    </Combobox.Target>
    <Combobox.Dropdown>
      <Combobox.Options aria-label={label}>
        {options.map(option=><Combobox.Option key={option.value} value={option.value} active={option.value===value}>
          {option.label}
        </Combobox.Option>)}
      </Combobox.Options>
    </Combobox.Dropdown>
  </Combobox>;
}
function decodeRule(r:any){const v=r.domain?.[0]??r.ip?.[0]??'';let type=r.ip?'IP-CIDR':'DOMAIN';let value=v;for(const [prefix,t]of [['full:','DOMAIN'],['domain:','DOMAIN-SUFFIX'],['keyword:','DOMAIN-KEYWORD'],['geosite:','GEOSITE'],['geoip:','GEOIP']])if(v.startsWith(prefix)){type=t;value=v.slice(prefix.length);}return{type,value,tag:r.outboundTag??'direct'};}
function encodeRule(type:string,value:string,tag:string){const prefixes:Record<string,string>={DOMAIN:'full:','DOMAIN-SUFFIX':'domain:','DOMAIN-KEYWORD':'keyword:',GEOSITE:'geosite:',GEOIP:'geoip:','IP-CIDR':''};return{type:'field',[['GEOIP','IP-CIDR'].includes(type)?'ip':'domain']:[prefixes[type]+value],outboundTag:tag};}

export function NodeEditor({node,jobs,allNodes,reload,onSecret,onClose}:{node:RecordData;jobs:RecordData[];allNodes:RecordData[];reload:()=>Promise<void>;onSecret:(r:any)=>void;onClose:()=>void}){
  const [viewJob,setViewJob]=useState<RecordData|null>(null),[viewId,setViewId]=useState(''),[operationError,setOperationError]=useState('');
  const [tab,setTab]=useState<string|null>('basic'),[s,setS]=useState<any>(node.settings??defaultSettings()),[xhttp,setXhttp]=useState(json(node.settings?.xhttp??xhttpDefault)),[raw,setRaw]=useState(json(node.draft??{})),[rules,setRules]=useState<any[]>(node.draft?.files['custom_rules.json']??[]),[relay,setRelay]=useState<any>(node.draft?.files['relay.json']??{role:'none'}),[firewall,setFirewall]=useState(json(node.draft?.files['firewall_ports.json']??{open:[],closed:[]})),[preview,setPreview]=useState(''),[working,setWorking]=useState(false),[actionConfirm,setActionConfirm]=useState(''),[confirmation,setConfirmation]=useState(''),[naming,setNaming]=useState(false),[exitRoute,setExitRoute]=useState('direct'),[ruleType,setRuleType]=useState('DOMAIN-SUFFIX'),[ruleValue,setRuleValue]=useState(''),[ruleTag,setRuleTag]=useState('direct'),[editingRule,setEditingRule]=useState<number|null>(null),[port,setPort]=useState<number|string>(443),[portAction,setPortAction]=useState('open');
  const baseline=useRef<EditorBaseline>({nodeId:node.id,revision:node.revision,hasSettings:!!node.settings,settings:s,xhttp,raw,rules,relay,firewall});
  const current={settings:s,xhttp,raw,rules,relay,firewall};
  const dirty=editorChanged(current,baseline.current),rawConflict=raw!==baseline.current.raw&&formChanged(current,baseline.current);
  function resetDraft(n:RecordData){const settings=n.settings??defaultSettings(),next={nodeId:n.id,revision:n.revision,hasSettings:!!n.settings,settings,xhttp:json(settings.xhttp),raw:json(n.draft??{}),rules:n.draft?.files['custom_rules.json']??[],relay:n.draft?.files['relay.json']??{role:'none'},firewall:json(n.draft?.files['firewall_ports.json']??{open:[],closed:[]})};baseline.current=next;setS(next.settings);setXhttp(next.xhttp);setRaw(next.raw);setRules(next.rules);setRelay(next.relay);setFirewall(next.firewall);}
  useEffect(()=>{if(node.id!==baseline.current.nodeId||node.revision>baseline.current.revision&&!dirty)resetDraft(node);},[node.id,node.revision,dirty]);
  function xhttpText(value:string){setXhttp(value);try{const x=JSON.parse(value);if(typeof x.path==='string')setS((old:any)=>({...old,path:x.path}));}catch{/* Keep invalid text visible until the user fixes it. */}}
  const field=(name:string,value:any)=>{setS({...s,[name]:value});if(name==='path'){try{setXhttp(json({...JSON.parse(xhttp),path:value}));}catch{/* Save will report the invalid JSON. */}}};
  const [keygen,setKeygen]=useState<{id:string;entry:boolean;nodeId:string}|null>(null);
  useEffect(()=>{
    if(!keygen)return;
    const job=jobs.find(j=>j.id===keygen.id);
    if(!job||['queued','running'].includes(job.status))return;
    setKeygen(null);
    if(job.status!=='succeeded'||keygen.nodeId!==node.id)return;
    try{const result=JSON.parse(job.output.slice(job.output.indexOf('{')));if(typeof result.encryption!=='string'||typeof result.decryption!=='string')throw Error('加密参数生成结果不完整');setRelay((old:RecordData)=>old.role!=='landing'?old:{...old,...(keygen.entry?{entry_encryption:result.encryption,entry_decryption:result.decryption}:{encryption:result.encryption,decryption:result.decryption})});setViewId(id=>id===job.id?'':id);notify('加密参数已自动填入当前草稿，请保存并部署');}catch(e){notify((e as Error).message,'red');}
  },[jobs,keygen,node.id]);
  async function generateRelayKeys(entry=false){const job=await action(entry?'relay-entry-keygen':'relay-keygen');setKeygen({id:job.id,entry,nodeId:node.id});}
  const currentJob=jobs.find(j=>['queued','running'].includes(j.status));
  const latestDeploy=jobs.find(j=>j.action==='deploy');
  async function action(a:string,confirm?:string){setViewId('submitting');setViewJob(null);setOperationError('');try{const job=await api(`/nodes/${node.id}/actions`,'POST',{action:a,confirm});setViewJob(job);setViewId(job.id);await reload();return job;}catch(e){setOperationError((e as Error).message);throw e;}}
  async function save(){
    if(node.revision!==baseline.current.revision)throw Error('配置已在另一页面变化。未保存修改已保留，请先核对并重新载入。');
    const body=draftPatch(current,baseline.current);
    if(!body)return node;
    const updated=await api(`/nodes/${node.id}/draft`,'PUT',body);resetDraft(updated);await reload();return updated;
  }
  async function saveAndPreview(){setWorking(true);await perform(async()=>{await save();const p=await api(`/nodes/${node.id}/preview`);setPreview(json(p));notify('草稿已保存，可检查即将部署的完整配置');});setWorking(false);}
  async function deploy(){setWorking(true);await perform(async()=>{const n=await save();const job=await api(`/nodes/${node.id}/deploy`,'POST',{revision:n.revision});setViewJob(job);setViewId(job.id);setOperationError('');notify('部署已排队：先校验，再应用，失败自动回滚');await reload();});setWorking(false);}
  async function gen(which:string){await perform(async()=>{const k=await api('/keys','POST',{});setS((old:any)=>({...old,...(which==='all'||which==='key'?{privateKey:k.privateKey,publicKey:k.publicKey}:{}),...(which==='all'||which==='uuid'?{uuid:k.uuid}:{}),...(which==='all'||which==='sid4'?{shortIds4:k.shortIds}:{}),...(which==='all'||which==='sid6'?{shortIds6:k.shortIds}:{})}));});}
  const peers=allNodes.filter(n=>n.id!==node.id);
  const peerConfig=(n:RecordData|undefined)=>(n?.applied??n?.observed)?.files['relay.json'];
  const landings:RecordData[]=relay.landings??[];
  const route=landings.some(l=>l.id===exitRoute)?exitRoute:'direct';
  const selectedLanding=landings.find(l=>l.id===route);
  const explicitEntry=Object.hasOwn(relay.nat_entries??{},route);
  const legacyEntry=!explicitEntry&&selectedLanding?.entry_enabled!==false&&selectedLanding?.entry_port>0;
  const entryRef=relay.nat_entries?.[route];
  const entryValue=explicitEntry?(entryRef?.nodeId??'direct'):legacyEntry?'legacy':'direct';
  const entryPeers=peers.filter(n=>n.enabled&&n.ipv4&&!n.ipv4.includes(':')&&Number(peerConfig(n)?.entry_listen_port)>0&&peerConfig(n)?.entry_uuid&&peerConfig(n)?.entry_encryption);
  const entryPeer=entryPeers.find(n=>n.id===entryValue);
  const entryOptions=[{value:'direct',label:'直连线路 VPS'},...(legacyEntry?[{value:'legacy',label:`${selectedLanding?.name}（现有 NAT 入口）`}]:[]),...entryPeers.map(n=>({value:n.id,label:n.name})),...(entryRef&&!entryPeer?[{value:entryRef.nodeId,label:'入口已移除或尚未就绪',disabled:true}]:[])];
  const relayPeers=peers.filter(n=>n.enabled&&peerConfig(n)?.role==='landing'&&peerConfig(n)?.relay_enabled!==false&&!landings.some(l=>l.nodeId===n.id));
  function addLanding(id:string|null) {
    const n=relayPeers.find(n=>n.id===id),r=peerConfig(n);
    if(!n||!r)return;
    let next=1;while(landings.some(l=>l.id===String(next)))next++;
    const landing={id:String(next),name:n.name,nodeId:n.id,addressFamily:n.ipv4?'ipv4':'ipv6',landing_ip:n.ipv4||n.ipv6||r.landing_ip,landing_port:r.external_port??r.listen_port,transport_uuid:r.transport_uuid,encryption:r.encryption,client_uuid:crypto.randomUUID(),entry_enabled:false};
    setRelay({...relay,role:'line',landings:[...landings,landing],failover:relay.failover??{enabled:false,interval:'60s',order:[]}});
  }
  function removeLanding(id:string) {
    const remaining=landings.filter(l=>l.id!==id),nat_entries={...relay.nat_entries};
    delete nat_entries[id];
    setRelay(remaining.length?{...relay,landings:remaining,nat_entries,failover:{...relay.failover,order:(relay.failover?.order??[]).filter((x:string)=>x!==id)}}:{role:'none',nat_entries});
  }
  function setRole(role:string){
    setKeygen(null);
    const nat_entries=relay.nat_entries?.direct?{direct:relay.nat_entries.direct}:undefined;
    if(role==='line')setRelay({role,nat_entries,landings:[],failover:{enabled:false,interval:'60s',order:[]}});
    else if(role==='landing')setRelay({role,transport_uuid:crypto.randomUUID(),landing_ip:node.ipv4||node.ipv6||'',listen_port:24443,external_port:24443,peer_ip:'',entry_listen_port:0});
    else setRelay({role:'none',nat_entries});
  }
  function selectEntry(value:string|null){
    if(!value||value==='legacy')return;
    const nat_entries={...relay.nat_entries};
    if(value==='direct'&&route==='direct')delete nat_entries[route];
    else nat_entries[route]=value==='direct'?null:{nodeId:value};
    setRelay({...relay,nat_entries});
  }
  const setR=(key:string,value:any)=>setRelay({...relay,[key]:value});
  return <fieldset disabled={working} style={{border:0,padding:0,margin:0,minWidth:0}}><Stack gap="md"><Group justify="space-between"><Group gap={7}><Badge variant="light" color={node.online?'teal':'gray'}>{node.online?'Agent 在线':'Agent 离线'}</Badge><Text size="xs" c="dimmed">草稿 v{node.revision} · 最近心跳 {date(node.lastSeen)}</Text></Group></Group>
    {node.report?.configError&&<Alert color="red">Agent 无法读取 VPS 配置：{node.report.configError}。请检查配置文件；日志和诊断入口仍可使用。</Alert>}
    {node.revision!==baseline.current.revision&&dirty&&<Alert color="orange">其他页面已更新草稿，你的未保存修改仍保留。<Button size="xs" variant="subtle" onClick={()=>resetDraft(node)}>放弃本地修改并载入最新草稿</Button></Alert>}
    {rawConflict&&<Alert color="orange">完整配置与表单都有修改，保存前请选择保留一种编辑方式。<Group mt="xs"><Button size="xs" variant="light" onClick={()=>setRaw(baseline.current.raw)}>保留表单修改</Button><Button size="xs" variant="light" onClick={()=>{const b=baseline.current;setS(b.settings);setXhttp(b.xhttp);setRules(b.rules);setRelay(b.relay);setFirewall(b.firewall);}}>保留完整配置修改</Button></Group></Alert>}
    {dirty&&!rawConflict&&<Text size="xs" c="cyan">有未保存修改；保存、预览和部署会包含所有页签的修改。</Text>}
    {!currentJob&&latestDeploy?.status==='failed'&&<Alert color="red">最近一次部署失败。<Button size="xs" variant="subtle" onClick={()=>{setViewJob(latestDeploy);setViewId(latestDeploy.id);setOperationError('');}}>查看失败详情</Button></Alert>}
    {currentJob&&<Alert color="cyan"><Group><Status value={currentJob.status}/><Text size="sm">{labelActions[currentJob.action]??currentJob.action}</Text>{currentJob.canAbandon&&<Button size="xs" color="orange" variant="light" onClick={()=>perform(async()=>{if(!window.confirm('放弃过期任务会使旧回执失效，但不能保证远端进程已经停止。确认放弃？'))return;await api(`/jobs/${currentJob.id}/abandon`,'POST',{});await reload();})}>放弃过期任务</Button>}</Group></Alert>}
    {node.draftBaseHash&&node.observedHash!==node.draftBaseHash&&<Alert color="orange">Agent 发现的当前配置与最近发布版本不同。请先同步并检查，再决定是否将现有配置导入草稿。</Alert>}
    <Group className="editor-toolbar" justify="space-between"><Button size="xs" variant="subtle" leftSection={<IconRefresh size={14}/>} onClick={()=>perform(async()=>{const updated=await api(`/nodes/${node.id}/adopt`,'POST',{});resetDraft(updated);await reload();notify('当前 VPS 配置已导入草稿');})} disabled={!node.observed||!!currentJob}>导入 VPS 当前配置</Button><Group gap="xs"><Button size="xs" variant="subtle" aria-label="订阅名称" onClick={()=>setNaming(true)}>{node.subscriptionName?`订阅名称：${node.subscriptionName}`:`订阅名称：${node.name}`}</Button><Button size="xs" variant="default" onClick={()=>perform(async()=>{setWorking(true);try{await save();notify('草稿已保存');}finally{setWorking(false);}})} loading={working} disabled={!node.observed}>保存草稿</Button><Button size="xs" variant="light" leftSection={<IconCode size={14}/>} loading={working} onClick={saveAndPreview} disabled={!node.observed}>预览部署</Button><Button size="xs" leftSection={<IconRocket size={14}/>} loading={working} disabled={!node.observed||!!currentJob} onClick={deploy}>保存并部署</Button></Group></Group>
    <Tabs value={tab} onChange={setTab}><Tabs.List><Tabs.Tab value="basic">基础参数</Tabs.Tab><Tabs.Tab value="rules">分流规则</Tabs.Tab><Tabs.Tab value="relay">线路 / 落地</Tabs.Tab><Tabs.Tab value="operations">运维</Tabs.Tab><Tabs.Tab value="advanced">高级</Tabs.Tab></Tabs.List>
    <Tabs.Panel value="basic" pt="lg"><Stack>
    {!node.observed?<Alert>等待 Agent 连接并导入。未安装 Xray 的 VPS 可在「运维」中选择安装标准节点或纯落地环境。</Alert>:<><Group justify="space-between"><Text size="sm" fw={600}>{node.settings?'普通入站参数':'创建标准节点入站'}</Text></Group><SimpleGrid cols={{base:1,sm:2}}><Select label="监听端口" data={[{value:'443',label:'443'},{value:'8443',label:'8443'}]} value={String(s.port)} onChange={v=>field('port',Number(v))}/><Select label="双栈分离方向" data={[{value:'false',label:'IPv4 上行 / IPv6 下行'},{value:'true',label:'IPv6 上行 / IPv4 下行'}]} value={String(s.v6Uplink)} onChange={v=>field('v6Uplink',v==='true')}/><TextInput label="IPv4 SNI / Dest" value={s.sni4} onChange={e=>field('sni4',e.currentTarget.value)}/><TextInput label="IPv6 SNI / Dest" value={s.sni6} onChange={e=>field('sni6',e.currentTarget.value)}/><Select label="出站 IP 策略" data={[{value:'UseIPv4',label:'仅解析 IPv4'},{value:'UseIPv6',label:'仅解析 IPv6'},{value:'UseIPv4v6',label:'IPv4 解析优先'},{value:'UseIPv6v4',label:'IPv6 解析优先'},{value:'HappyEyeballs4',label:'Happy Eyeballs · IPv4 先尝试'},{value:'HappyEyeballs6',label:'Happy Eyeballs · IPv6 先尝试'}]} value={s.outbound} onChange={v=>field('outbound',v)}/></SimpleGrid><Text className="section-hint">基础表单编辑第一个标准入站文件。多文件、监听地址及额外参数均可在「高级 → 完整服务端 JSON」中编辑。解析优先不代表连接失败时回退。</Text></>}
    </Stack></Tabs.Panel>

    <Tabs.Panel value="rules" pt="lg"><Stack><Text size="sm" c="dimmed">规则按显示顺序执行，并放在脚本内置的回国、Private IP 与 BT 阻断之前。</Text>{rules.map((r,i)=><Card key={i} padding="sm"><Group justify="space-between" wrap="nowrap"><Box><Text size="sm" fw={600}>{decodeRule(r).type} · {decodeRule(r).value}</Text><Text c="dimmed" size="xs">动作：{r.outboundTag}</Text></Box><Group gap={2} wrap="nowrap"><ActionIcon aria-label={`上移规则 ${i+1}`} variant="subtle" disabled={i===0} onClick={()=>{const next=[...rules];[next[i-1],next[i]]=[next[i],next[i-1]];setRules(next);}}><IconArrowUp size={16}/></ActionIcon><ActionIcon aria-label={`下移规则 ${i+1}`} variant="subtle" disabled={i===rules.length-1} onClick={()=>{const next=[...rules];[next[i+1],next[i]]=[next[i],next[i+1]];setRules(next);}}><IconArrowDown size={16}/></ActionIcon><Button size="xs" variant="subtle" onClick={()=>{const v=decodeRule(r);setRuleType(v.type);setRuleValue(v.value);setRuleTag(v.tag);setEditingRule(i);}}>编辑</Button><ActionIcon aria-label={`删除规则 ${i+1}`} variant="subtle" color="red" onClick={()=>setRules(rules.filter((_,idx)=>idx!==i))}><IconTrash size={16}/></ActionIcon></Group></Group></Card>)}{rules.length===0&&<Text c="dimmed" size="sm">尚未添加自定义规则。</Text>}<Divider label={editingRule===null?'添加规则':`编辑第 ${editingRule+1} 条规则`}/><SimpleGrid cols={{base:1,sm:3}}><RuleSelect label="规则类型" options={ruleTypes} value={ruleType} onChange={setRuleType}/><TextInput label="匹配值" placeholder="kimi.ai" value={ruleValue} onChange={e=>setRuleValue(e.currentTarget.value)}/><RuleSelect label="动作" options={ruleActions} value={ruleTag} onChange={setRuleTag}/></SimpleGrid><Group><Button variant="light" size="sm" disabled={!ruleValue.trim()} onClick={()=>{const rule=encodeRule(ruleType,ruleValue.trim(),ruleTag);setRules(editingRule===null?[...rules,rule]:rules.map((r,i)=>i===editingRule?rule:r));setRuleValue('');setEditingRule(null);}}>{editingRule===null?'添加到草稿':'更新此规则'}</Button>{editingRule!==null&&<Button variant="subtle" onClick={()=>setEditingRule(null)}>取消编辑</Button>}</Group></Stack></Tabs.Panel>
    <Tabs.Panel value="relay" pt="lg"><Stack><Select label="互联角色" data={[{value:'none',label:'独立节点'},{value:'line',label:'线路机 → 多落地出口'},{value:'landing',label:'落地机 / NAT / LXC'}]} value={relay.role} onChange={v=>setRole(v!)}/>
    {relay.role!=='landing'&&<>
      <Card withBorder><Stack gap="sm">
        <SimpleGrid cols={{base:1,sm:2}}>
          <Select label="流量出口" allowDeselect={false} value={route} onChange={value=>setExitRoute(value??'direct')} data={[{value:'direct',label:'本机直出'},...landings.map(l=>({value:l.id,label:l.name}))]}/>
          <Select label="IPv4 接入" allowDeselect={false} value={entryValue} onChange={selectEntry} data={entryOptions}/>
        </SimpleGrid>
        {entryRef&&!entryPeer&&<Alert color="orange">选中的 NAT 入口已移除或尚未就绪，请检查部署与公网 IPv4 地址。</Alert>}
        <Text size="sm">IPv4　客户端 → {entryValue==='direct'?'':`${entryPeer?.name??(legacyEntry?selectedLanding?.name:'NAT 入口')} → `}线路机 → {selectedLanding?`${selectedLanding.name} → `:''}Internet</Text>
        {legacyEntry&&<Text size="xs" c="dimmed">现有 Vision IPv4 配置直连原 NAT。重新选择 NAT 入口后，Vision IPv4 也会经过线路机。</Text>}
        <Text size="sm">IPv6　客户端 → 线路机 → {selectedLanding?`${selectedLanding.name} → `:''}Internet</Text>
      </Stack></Card>
      {relay.role==='line'&&<>
        <Select label="添加已接入的落地机" placeholder="选择落地机" data={relayPeers.map(n=>({value:n.id,label:n.name}))} value={null} onChange={addLanding}/>
        {landings.map(l=><Card key={l.id} withBorder><Group justify="space-between"><Text size="sm" fw={600}>{l.name}</Text><Text size="xs" c="dimmed">{l.nodeId?(peers.find(n=>n.id===l.nodeId)?.online?'Agent 在线':'Agent 离线或未接入'):'手动配置'}</Text><Button size="xs" color="red" variant="subtle" onClick={()=>removeLanding(l.id)}>移除</Button></Group></Card>)}
        <Divider label="故障转移"/>
        <Switch label="启用落地故障转移（最后回退到本机直出）" checked={relay.failover?.enabled??false} onChange={e=>setR('failover',{...relay.failover,enabled:e.currentTarget.checked})}/>
        <SimpleGrid cols={{base:1,sm:2}}><TextInput label="探测间隔" placeholder="60s" value={relay.failover?.interval??'60s'} onChange={e=>setR('failover',{...relay.failover,interval:e.currentTarget.value})}/><TextInput label="出口顺序（落地 ID，用逗号分隔）" inputWrapperOrder={['label','input','description','error']} description={landings.map(l=>`${l.id} · ${l.name}`).join('、')} placeholder="留空按列表顺序" value={(relay.failover?.order??[]).join(',')} onChange={e=>setR('failover',{...relay.failover,order:e.currentTarget.value.split(',').map(x=>x.trim()).filter(Boolean)})}/></SimpleGrid>
      </>}
    </>}
    {relay.role==='landing'&&<>
      <Switch label="接收线路机互联流量" checked={relay.relay_enabled!==false} onChange={e=>{const enabled=e.currentTarget.checked;setRelay({...relay,relay_enabled:enabled,...(enabled?{transport_uuid:relay.transport_uuid||crypto.randomUUID(),listen_port:relay.listen_port??24443,external_port:relay.external_port??24443,peer_ip:relay.peer_ip??''}:{})});}}/>
      {relay.relay_enabled!==false&&(!relay.encryption||!relay.decryption)&&<Group><Button size="xs" variant="light" loading={!!keygen&&!keygen.entry} disabled={!!currentJob} onClick={()=>perform(()=>generateRelayKeys())}>生成互联加密参数</Button></Group>}
      <NatEntryCard value={relay} onChange={setRelay} busy={!!currentJob||!!keygen} onGenerate={()=>{void perform(()=>generateRelayKeys(true));}}/>
    </>}
    </Stack></Tabs.Panel>
    <Tabs.Panel value="advanced" pt="lg"><Accordion multiple>
      <Accordion.Item value="node-information"><Accordion.Control>节点信息</Accordion.Control><Accordion.Panel><NodeAddresses key={node.id} node={node} reload={reload} detect={()=>perform(()=>action('detect-addresses'))}/></Accordion.Panel></Accordion.Item>
      {(relay.role==='landing'||landings.length>0)&&<Accordion.Item value="relay"><Accordion.Control>互联与公开 IPv4 参数</Accordion.Control><Accordion.Panel><Stack>
      {relay.role==='line'&&landings.map(l=><Card key={l.id} withBorder><LandingCard value={l} nodes={peers} onChange={value=>setRelay({...relay,landings:landings.map(old=>old.id===l.id?value:old)})}/></Card>)}
      {relay.role==='landing'&&<>
        <TextInput label="公网 IP / 域名" value={relay.landing_ip??''} onChange={e=>setR('landing_ip',e.currentTarget.value)}/>
        {relay.relay_enabled!==false&&<>
          <SimpleGrid cols={{base:1,sm:2}}><NumberInput label="互联监听端口" min={1} max={65535} value={relay.listen_port} onChange={v=>setR('listen_port',Number(v))}/><NumberInput label="互联公网映射端口" min={1} max={65535} value={relay.external_port} onChange={v=>setR('external_port',Number(v))}/></SimpleGrid>
          <TextInput label="仅允许此线路 IPv4（空值允许所有来源）" value={relay.peer_ip??''} onChange={e=>setR('peer_ip',e.currentTarget.value)}/>
          <TextInput label="互联 UUID" value={relay.transport_uuid??''} onChange={e=>setR('transport_uuid',e.currentTarget.value)}/>
          <Textarea label="VLESS decryption（仅保存在落地机）" value={relay.decryption??''} onChange={e=>setR('decryption',e.currentTarget.value)} autosize minRows={2}/>
          <Textarea label="VLESS encryption（线路机使用）" value={relay.encryption??''} onChange={e=>setR('encryption',e.currentTarget.value)} autosize minRows={2}/>
          <Group><Button size="xs" variant="light" loading={!!keygen&&!keygen.entry} disabled={!!currentJob} onClick={()=>perform(()=>generateRelayKeys())}>重新生成互联加密参数</Button></Group>
        </>}
        <NatEntryCard advanced value={relay} onChange={setRelay} busy={!!currentJob||!!keygen} onGenerate={()=>{void perform(()=>generateRelayKeys(true));}}/>
      </>}
    </Stack></Accordion.Panel></Accordion.Item>}<Accordion.Item value="identity"><Accordion.Control>UUID、REALITY 密钥、Short IDs 与日志</Accordion.Control><Accordion.Panel><Stack><Button size="xs" variant="light" leftSection={<IconKey size={14}/>} onClick={()=>gen('all')}>生成 UUID、密钥和 Short IDs</Button><TextInput label="XHTTP 路径" value={s.path} onChange={e=>field('path',e.currentTarget.value)}/><TextInput label="脚本主 UUID" description="设备订阅使用另外分配的独立 UUID。此值用于保留脚本的原有客户端。" value={s.uuid} onChange={e=>field('uuid',e.currentTarget.value)} rightSection={<ActionIcon aria-label="重新生成主 UUID" variant="subtle" onClick={()=>gen('uuid')}><IconRefresh size={15}/></ActionIcon>}/><SimpleGrid cols={{base:1,sm:2}}><TextInput label="REALITY Private Key" value={s.privateKey} onChange={e=>field('privateKey',e.currentTarget.value)}/><TextInput label="REALITY Public Key" value={s.publicKey} onChange={e=>field('publicKey',e.currentTarget.value)}/><TextInput label="IPv4 Short IDs（逗号分隔）" value={s.shortIds4.join(',')} onChange={e=>field('shortIds4',e.currentTarget.value.split(',').map(v=>v.trim()))}/><TextInput label="IPv6 Short IDs（逗号分隔）" value={s.shortIds6.join(',')} onChange={e=>field('shortIds6',e.currentTarget.value.split(',').map(v=>v.trim()))}/></SimpleGrid><Group><Button size="xs" variant="subtle" onClick={()=>gen('key')}>重新生成密钥对</Button><Button size="xs" variant="subtle" onClick={()=>gen('sid4')}>重新生成 IPv4 Short IDs</Button><Button size="xs" variant="subtle" onClick={()=>gen('sid6')}>重新生成 IPv6 Short IDs</Button></Group><Select label="日志等级" data={['debug','info','warning','error','none']} value={s.logLevel} onChange={v=>field('logLevel',v)}/></Stack></Accordion.Panel></Accordion.Item><Accordion.Item value="xhttp"><Accordion.Control>XHTTP 路径与详细参数</Accordion.Control><Accordion.Panel><Stack><Alert color="cyan">编辑 Xray 原生 xhttpSettings。包括 padding、session、seq、上传方式、XMUX、服务器限制等全部字段。订阅自动转换 Mihomo 支持的客户端字段。</Alert><SimpleGrid cols={{base:1,sm:2}}>{[['uplinkHTTPMethod','上传 HTTP 方法'],['xPaddingBytes','Padding 字节范围'],['xPaddingPlacement','Padding 位置'],['xPaddingMethod','Padding 方法'],['sessionPlacement','Session 位置'],['seqPlacement','Seq 位置']].map(([key,label])=><TextInput key={key} label={label} value={(()=>{try{return JSON.parse(xhttp)[key]??'';}catch{return '';}})()} onChange={e=>{try{xhttpText(json({...JSON.parse(xhttp),[key]:e.currentTarget.value}));}catch{notify('请先修正下方 JSON','orange');}}}/>)}</SimpleGrid><Textarea className="editor" label="完整 xhttpSettings JSON" autosize minRows={22} maxRows={36} value={xhttp} onChange={e=>xhttpText(e.currentTarget.value)}/></Stack></Accordion.Panel></Accordion.Item><Accordion.Item value="raw"><Accordion.Control>完整服务端 JSON</Accordion.Control><Accordion.Panel><Stack><Alert color="orange">编辑所有脚本配置文件，可修改任意 Xray 参数。只能写入白名单配置路径；提交后必须通过 VPS 上真实 Xray 核心校验。更改 relay.json 或 custom_rules.json 时，请使用对应页签以同步生成相关规则。</Alert><Textarea className="editor" label="完整配置文件集合（files）" autosize minRows={28} maxRows={42} value={raw} onChange={e=>setRaw(e.currentTarget.value)}/></Stack></Accordion.Panel></Accordion.Item></Accordion></Tabs.Panel>
    <Tabs.Panel value="operations" pt="lg"><Stack><Card><Text fw={600} mb="sm">状态与诊断</Text><Group><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('inspect'))}>{labelActions['inspect']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('validate'))}>{labelActions['validate']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('dump'))}>{labelActions['dump']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('detect-addresses'))}>{labelActions['detect-addresses']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('diagnostics'))}>{labelActions['diagnostics']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('relay-test'))}>{labelActions['relay-test']}</Button></Group></Card><Card><Text fw={600} mb="sm">服务控制</Text><Group><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('start'))}>{labelActions['start']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('stop'))}>{labelActions['stop']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('restart'))}>{labelActions['restart']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('enable'))}>{labelActions['enable']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('disable'))}>{labelActions['disable']}</Button></Group></Card><Card><Text fw={600} mb="sm">日志</Text><Group><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('logs'))}>{labelActions['logs']}</Button></Group></Card><Card><Text fw={600} mb="sm">更新与维护</Text><Group><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('update-core'))}>{labelActions['update-core']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('update-script'))}>{labelActions['update-script']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('update-geodata'))}>{labelActions['update-geodata']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('maintenance'))}>{labelActions['maintenance']}</Button><Button variant="default" size="xs" disabled={!!currentJob} onClick={()=>perform(()=>action('bbr'))}>{labelActions['bbr']}</Button></Group></Card><Text className="section-hint">核心固定为 v26.3.27。更新、维护与诊断任务均由 VPS 上的脚本执行，结果保留在任务记录。</Text><Divider label="防火墙"/><FirewallView report={node.report?.firewall} refresh={()=>perform(()=>action('firewall-status'))}/><Text fw={600}>手动附加策略（不是全部系统规则）</Text><Group align="end"><NumberInput label="端口" min={1} max={65535} value={port} onChange={setPort}/><Select label="操作" data={[{value:'open',label:'放行 TCP / UDP'},{value:'close',label:'关闭 TCP / UDP'}]} value={portAction} onChange={v=>setPortAction(v!)}/><Button variant="light" onClick={()=>{try{const f=JSON.parse(firewall),p=Number(port);if(p<1||p>65535)throw Error('无效端口');f.open=f.open.filter((n:number)=>n!==p);f.closed=f.closed.filter((n:number)=>n!==p);f[portAction==='open'?'open':'closed'].push(p);setFirewall(json(f));}catch(e){notify((e as Error).message,'red');}}}>添加到草稿</Button></Group><Textarea className="editor" label="手动附加放行 / 关闭策略 JSON" autosize minRows={4} value={firewall} onChange={e=>setFirewall(e.currentTarget.value)}/><Card className="danger-zone"><Title order={5} mb="sm">安装与移除</Title><Text size="sm" c="dimmed" mb="md">安装仅用于尚未安装 Xray 的 VPS。纯落地环境安装后，请在「线路 / 落地」设置映射端口并部署。卸载会移除该 VPS 的 Xray、配置与日志。</Text><Group>{['install-standard','install-landing','uninstall'].map(a=><Button key={a} color={a==='uninstall'?'red':'orange'} variant="light" size="xs" disabled={!!currentJob} onClick={()=>{setActionConfirm(a);setConfirmation('');}}>{labelActions[a]}</Button>)}<Button color="red" variant="subtle" size="xs" disabled={!!currentJob} onClick={()=>{setActionConfirm('remove-node');setConfirmation('');}}>仅移除面板记录</Button></Group></Card></Stack></Tabs.Panel>
    </Tabs>
    <Group><Button size="xs" variant="subtle" onClick={()=>perform(async()=>{const r=await api(`/nodes/${node.id}/agent-token`,'POST',{});onSecret(r);})}>轮换 Agent 凭据</Button>{(currentJob||jobs[0])&&<Button variant="subtle" size="xs" onClick={()=>{const job=currentJob??jobs[0];setViewJob(job);setViewId(job.id);setOperationError('');}}>查看最近任务结果</Button>}{node.needsRelaySync&&<Badge color="orange">关联地址待部署</Badge>}</Group>
    {node.relaySyncError&&<Alert color="orange">{node.relaySyncError}</Alert>}
    <NodeSubscriptionNames node={naming?node:null} onClose={()=>setNaming(false)} onSaved={reload}/>
    <JobResult opened={!!viewId} job={jobs.find(j=>j.id===viewId)??viewJob??undefined} error={operationError} onClose={()=>setViewId('')} retry={()=>{const j=jobs.find(j=>j.id===viewId)??viewJob;if(!j)return;if(['install-standard','install-landing','uninstall'].includes(j.action)){setViewId('');setActionConfirm(j.action);setConfirmation('');}else if(j.action==='deploy')perform(deploy);else perform(()=>action(j.action));}}/>
    <Modal opened={!!preview} onClose={()=>setPreview('')} title="即将部署的配置（已注入设备独立 UUID）" size="xl"><CopyBlock value={preview}/><Text c="dimmed" size="xs" mt="sm">配置发布仍需点击「保存并部署」。只有 Agent 成功回执后，订阅才会更新。</Text></Modal>
    <Modal opened={!!actionConfirm} onClose={()=>setActionConfirm('')} title={labelActions[actionConfirm]??'移除面板节点'}><Stack><Text size="sm">输入节点名称 <strong>{node.name}</strong> 确认操作。</Text><TextInput aria-label="确认节点名称" value={confirmation} onChange={e=>setConfirmation(e.currentTarget.value)}/><Button color="red" disabled={confirmation!==node.name} onClick={()=>perform(async()=>{if(actionConfirm==='remove-node'){await api(`/nodes/${node.id}`,'DELETE');onClose();await reload();}else await action(actionConfirm,confirmation);setActionConfirm('');})}>确认执行</Button></Stack></Modal>
  </Stack></fieldset>;
}
