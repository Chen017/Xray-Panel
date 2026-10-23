import { randomBytes } from 'node:crypto';
import { existsSync,writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
if(existsSync('.env')){console.log('.env 已存在，保留原配置。');process.exit(0);}
const password=randomBytes(24).toString('base64url'),master=randomBytes(32).toString('hex');
const content=`PANEL_MASTER_KEY=${master}\nPANEL_ADMIN_PASSWORD=${password}\nPANEL_ADMIN_ORIGIN=http://127.0.0.1:3000\nPANEL_SUBSCRIPTION_ORIGIN=http://127.0.0.1:3001\nPANEL_AGENT_ORIGIN=http://127.0.0.1:3002\nPANEL_SECURE_COOKIE=false\nPANEL_HOST=127.0.0.1\nPANEL_DB=data/panel.sqlite\n`;
writeFileSync('.env',content,{mode:0o600,flag:'wx'});
console.log('已生成 .env。管理员初始密码保存在其中，请本地查看并安全保存。');
console.log('生产部署前修改三个 HTTPS 域名，并设置 PANEL_SECURE_COOKIE=true。');
