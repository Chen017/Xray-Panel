import {Badge,Box,Button,Checkbox,Group,Table,Text,ThemeIcon} from '@mantine/core';
import {IconChevronRight,IconServer} from '@tabler/icons-react';
import {date} from './api';
import type {RecordData} from './panel';

function NodeIdentity({node}:{node:RecordData}){
  const role=node.draft?.files?.['relay.json']?.role;
  return <Group gap="sm" wrap="nowrap" className="node-identity">
    <ThemeIcon variant="light" color="gray" radius="md" size={38}><IconServer size={19}/></ThemeIcon>
    <Box miw={0}><Text fw={600} size="sm" className="node-name">{node.name}</Text><Text c="dimmed" size="xs">{role==='line'?'线路机':role==='landing'?'落地机':'独立节点'}</Text></Box>
  </Group>;
}
function NodeAddressSummary({node}:{node:RecordData}){
  return <><Text size="xs" ff="monospace" className="node-address">{node.ipv4||'未设置 IPv4'}</Text><Text c="dimmed" size="xs" ff="monospace" className="node-address">{node.ipv6||'未设置 IPv6'}</Text></>;
}
function NodeConnection({node}:{node:RecordData}){
  return <><Group gap={8} wrap="nowrap"><span className={`status-dot ${node.online?'':'offline'}`}/><Text size="sm">{node.online?'在线':'未连接'}</Text></Group><Text c="dimmed" size="xs" mt={4}>{node.report?.installed?(node.report.active?'Xray 运行中':'Xray 已停止'):'等待导入或安装'}</Text></>;
}
function NodeConfigStatus({node}:{node:RecordData}){
  return <><Badge variant="light" color={node.needsSync||node.hasDraftChanges?'orange':node.appliedAt?'teal':'gray'}>{node.needsSync?'待同步设备授权':node.hasDraftChanges?'草稿待部署':node.appliedAt?'已发布':'尚未发布'}</Badge><Text size="xs" c="dimmed" mt={4}>{node.appliedAt?date(node.appliedAt):'订阅仅使用部署成功的配置'}</Text></>;
}

export function NodeList({nodes,selected,onSelectedChange,onManage}:{nodes:RecordData[];selected:string[];onSelectedChange:(ids:string[])=>void;onManage:(id:string)=>void}){
  const allSelected=nodes.length>0&&nodes.every(node=>selected.includes(node.id));
  const someSelected=nodes.some(node=>selected.includes(node.id));
  const selectAll=(checked:boolean)=>onSelectedChange(checked?nodes.map(node=>node.id):[]);
  const selectNode=(id:string,checked:boolean)=>onSelectedChange(checked?[...selected,id]:selected.filter(value=>value!==id));
  const selection=(node:RecordData)=><Checkbox aria-label={`选择 ${node.name}`} checked={selected.includes(node.id)} onChange={event=>selectNode(node.id,event.currentTarget.checked)}/>;
  const manage=(node:RecordData,mobile=false)=><Button className={mobile?'node-manage':undefined} fullWidth={mobile} size={mobile?'sm':'xs'} variant="light" aria-label={`管理 ${node.name}`} rightSection={<IconChevronRight size={14}/>} onClick={()=>onManage(node.id)}>管理</Button>;
  return <>
    <Box hiddenFrom="sm" className="node-cards">
      <Checkbox className="node-select-all" label="选择所有节点" checked={allSelected} indeterminate={!allSelected&&someSelected} onChange={event=>selectAll(event.currentTarget.checked)}/>
      {nodes.map(node=><Box component="article" className="node-card" key={node.id} aria-label={node.name}>
        <Group wrap="nowrap" align="center" className="node-card-heading">{selection(node)}<NodeIdentity node={node}/></Group>
        <dl className="node-card-details">
          <div><dt>连接地址</dt><dd><NodeAddressSummary node={node}/></dd></div>
          <div><dt>Agent / 服务</dt><dd><NodeConnection node={node}/></dd></div>
          <div><dt>配置状态</dt><dd><NodeConfigStatus node={node}/></dd></div>
        </dl>
        {manage(node,true)}
      </Box>)}
    </Box>
    <Box visibleFrom="sm">
      <Table.ScrollContainer minWidth={780}><Table className="node-table" verticalSpacing="md" horizontalSpacing="lg" highlightOnHover>
        <Table.Thead><Table.Tr><Table.Th><Checkbox aria-label="选择所有节点" checked={allSelected} indeterminate={!allSelected&&someSelected} onChange={event=>selectAll(event.currentTarget.checked)}/></Table.Th><Table.Th>节点</Table.Th><Table.Th>连接地址</Table.Th><Table.Th>Agent / 服务</Table.Th><Table.Th>配置状态</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{nodes.map(node=><Table.Tr key={node.id}><Table.Td>{selection(node)}</Table.Td><Table.Td><NodeIdentity node={node}/></Table.Td><Table.Td><NodeAddressSummary node={node}/></Table.Td><Table.Td className="node-connection"><NodeConnection node={node}/></Table.Td><Table.Td><NodeConfigStatus node={node}/></Table.Td><Table.Td>{manage(node)}</Table.Td></Table.Tr>)}</Table.Tbody>
      </Table></Table.ScrollContainer>
    </Box>
  </>;
}
