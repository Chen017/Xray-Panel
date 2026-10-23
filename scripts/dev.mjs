import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
try{loadEnvFile();}catch{console.error('请先运行 npm run setup');process.exit(1);}
const env={...process.env,PANEL_ADMIN_ORIGIN:'http://127.0.0.1:5173',PANEL_SECURE_COOKIE:'false'};
const server=spawn(process.execPath,['server/index.mjs'],{env,stdio:'inherit'});
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit'});
function stop(){server.kill();vite.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
server.on('exit',()=>{vite.kill();});vite.on('exit',()=>{server.kill();});
