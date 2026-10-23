import { spawn } from 'node:child_process';
import path from 'node:path';
export const linuxPath=p=>process.platform==='win32'?path.resolve(p).replace(/^([A-Za-z]):/,(_,drive)=>`/mnt/${drive.toLowerCase()}`).replaceAll('\\','/'):path.resolve(p);
export function driver(){
  const file=linuxPath('tests/agent_driver.py');
  const proc=process.platform==='win32'?spawn('wsl',['-d',process.env.XRAY_TEST_WSL??'Debian','--','python3','-u',file],{stdio:['pipe','pipe','pipe']}):spawn('python3',['-u',file],{stdio:['pipe','pipe','pipe']});
  let buffer='',pending=[],errors='';proc.stderr.on('data',d=>{errors+=d.toString();});proc.stdout.on('data',d=>{buffer+=d.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const request=pending.shift();try{const result=JSON.parse(line);result.ok?request.resolve(result.result):request.reject(Error(result.error+'\n'+errors));}catch(e){request?.reject(e);}}});
  proc.on('exit',code=>{for(const p of pending)p.reject(Error(`Linux driver exited ${code}: ${errors}`));pending=[];});
  return{async call(message){return new Promise((resolve,reject)=>{pending.push({resolve,reject});proc.stdin.write(JSON.stringify(message)+'\n');});},async close(){await this.call({action:'shutdown'});proc.stdin.end();},errors:()=>errors};
}
