import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { sourceFiles } from './package-files.mjs';
mkdirSync('dist',{recursive:true});
const r=spawnSync('tar',['-czf','dist/source.tar.gz','--null','-T','-'],{input:sourceFiles().join('\0')+'\0',stdio:['pipe','inherit','inherit']});
if(r.status!==0)process.exit(r.status??1);
console.log('AGPL 源码归档：dist/source.tar.gz（已排除本地配置与运行数据）');
