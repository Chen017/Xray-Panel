import { lstatSync,readdirSync,existsSync } from 'node:fs';
import path from 'node:path';
const roots=['agent','deploy','docs','scripts','server','shared','tests','vendor','web','.dockerignore','.gitignore','.env.example','Dockerfile','compose.yaml','package.json','package-lock.json','tsconfig.json','vite.config.mjs','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
const denied=new Set(['.git','.upstream','.local','node_modules','data','release','test-results','__pycache__']);
function walk(relative,output){const name=path.basename(relative);if(denied.has(name)||name.endsWith('.pyc')||name==='.env'||name.startsWith('.env.')&&name!=='.env.example')return;const stat=lstatSync(relative);if(stat.isSymbolicLink())return;if(stat.isDirectory())for(const entry of readdirSync(relative))walk(path.join(relative,entry),output);else if(stat.isFile())output.push('./'+relative.replaceAll('\\','/'));}
export function sourceFiles(){const files=[];for(const name of roots)if(existsSync(name))walk(name,files);return files.sort();}
export function releaseFiles(){const files=sourceFiles();walk('dist',files);return files.sort();}
