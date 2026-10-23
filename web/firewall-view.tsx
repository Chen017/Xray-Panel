import {Alert,Button,Card,Group,Stack,Table,Text} from '@mantine/core';
import {date,json} from './api';
import {CopyBlock,type RecordData} from './panel';

export function FirewallView({report,refresh}:{report?:RecordData;refresh:()=>void}) {
  return <Stack><Group justify="space-between"><Text fw={600}>系统防火墙规则快照</Text><Button size="xs" variant="light" onClick={refresh}>重新读取系统规则</Button></Group>
    <Alert color="cyan">{report?.notice??'需要新版 Agent 上报实际系统规则。没有显示的端口不能视为关闭；本机规则不代表云防火墙或 NAT 后公网可达。'}</Alert>
    <Text size="xs" c="dimmed">读取状态：{report?.status??'等待上报'} · {date(report?.checkedAt)}</Text>
    {report?.sources?.map((source:RecordData)=><Card key={source.backend}><Text fw={600}>{source.backend} · {source.status}</Text>{source.status==='ok'?<Table.ScrollContainer minWidth={600}><Table><Table.Thead><Table.Tr>{['地址族 / 链','协议','来源','端口','动作'].map(x=><Table.Th key={x}>{x}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{source.rules.map((r:RecordData,i:number)=><Table.Tr key={i}><Table.Td>{r.family} / {r.chain}</Table.Td><Table.Td>{r.protocol}</Table.Td><Table.Td>{r.source}</Table.Td><Table.Td>{r.ports||'见表达式'}</Table.Td><Table.Td>{r.action}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>:<Text size="sm">该后端无法读取，不据此判断端口开放或关闭。</Text>}<CopyBlock value={json(source.rules)} label="复制原始规则清单"/></Card>)}
    <Text fw={600}>Xray / 互联自动管理的端口</Text><CopyBlock value={json(report?.automatic??[])} label="自动策略（不是公网探测结果）"/>
  </Stack>;
}
