import { spawn } from 'node:child_process';
import path from 'node:path';
export const linuxPath=p=>process.platform==='win32'?path.resolve(p).replace(/^([A-Za-z]):/,(_,drive)=>`/mnt/${drive.toLowerCase()}`).replaceAll('\\','/'):path.resolve(p);
export function driver(){
  const file=linuxPath('tests/agent_driver.py');
  const proc=process.platform==='win32'?spawn('wsl',['-d',process.env.XRAY_TEST_WSL??'Debian','--','python3','-u',file],{stdio:['pipe','pipe','pipe']}):spawn('python3',['-u',file],{stdio:['pipe','pipe','pipe']});
  let buffer='',errors='',failure;
  const pending=[];
  function fail(error){
    if(failure)return;
    failure=error;
    for(const request of pending.splice(0))request.reject(error);
  }
  proc.stderr.on('data',d=>{errors+=d.toString();});
  proc.stdout.on('data',d=>{
    buffer+=d.toString();
    let end;
    while((end=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,end);
      buffer=buffer.slice(end+1);
      if(!line.trim())continue;
      const request=pending.shift();
      if(!request)continue;
      try{
        const result=JSON.parse(line);
        if(result.ok)request.resolve(result.result);
        else request.reject(Error(result.error+'\n'+errors));
      }catch(cause){
        const error=Error('Linux driver returned an invalid response',{cause});
        request.reject(error);
        fail(error);
        proc.stdin.end();
      }
    }
  });
  proc.on('error',fail);
  proc.stdin.on('error',fail);
  proc.on('close',(code,signal)=>fail(Error(`Linux driver exited ${signal??code}: ${errors}`)));
  return{
    async call(message){
      if(failure)throw failure;
      return new Promise((resolve,reject)=>{
        pending.push({resolve,reject});
        proc.stdin.write(JSON.stringify(message)+'\n');
      });
    },
    async close(){
      try{
        if(!failure&&proc.exitCode===null&&proc.signalCode===null)await this.call({action:'shutdown'});
      }finally{proc.stdin.end();}
    },
    errors:()=>errors,
  };
}
