import {Alert,Button,Group,Loader,Modal,Stack,Text} from '@mantine/core';
import {CopyBlock,Status,type RecordData} from './panel';
import {date} from './api';

export function JobResult({opened,job,error,onClose,retry}:{opened:boolean;job?:RecordData;error?:string;onClose:()=>void;retry:()=>void}) {
  const pending=!job||['queued','running'].includes(job.status);
  return <Modal opened={opened} onClose={onClose} title={job?`任务结果 · ${job.action}`:'提交任务'} size="xl"><Stack>
    {error?<Alert color="red">{error}</Alert>:!job?<Group><Loader size="sm"/><Text>正在提交任务…</Text></Group>:<>
      <Group justify="space-between"><Status value={job.status}/><Text size="xs" c="dimmed">{date(job.completedAt??job.createdAt)}</Text></Group>
      <Text size="xs" ff="monospace">任务 ID：{job.id}</Text>
      {pending&&<Alert color="cyan">{job.status==='queued'?'等待 Agent 领取':'Agent 正在执行'}。关闭窗口不会取消任务，可从当前节点或任务历史重新打开。</Alert>}
      <CopyBlock value={job.output||'尚无结果输出；任务完成后自动显示。'} label="复制任务完整输出"/>
      {!pending&&<Button variant="light" onClick={retry}>重新执行</Button>}
    </>}
  </Stack></Modal>;
}
