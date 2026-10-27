// Real core regressions, invoked separately from fast HTTP/unit tests.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fixtureBundle,settings} from './helpers.mjs';
import {compileDevices,patchRouting,newBundle} from '../shared/config.mjs';
import {linuxPath} from './linux.mjs';

const node={id:randomUUID()},device={id:randomUUID(),epoch:randomUUID(),grants:[{nodeId:node.id,routes:['1'],modes:['single4']}]};
const second=settings();second.port=8443;second.path='/independent-second';
const base=fixtureBundle();base.files['conf/VLESS-8443.json']=newBundle(second).files['conf/VLESS-8443.json'];
for(const file of Object.entries(base.files).filter(([name])=>name.startsWith('conf/')).map(([,file])=>file)){
  file.inbounds[2].tag='local_xhttp_stream_up';file.inbounds[2].listen='@xhttp_inner';
  for(const inbound of file.inbounds.slice(0,2))inbound.settings.fallbacks[0].dest='@xhttp_inner';
}
const relay={role:'line',landings:['1','2'].map(id=>({id,name:id,landing_ip:'127.0.0.1',landing_port:1,transport_uuid:randomUUID(),client_uuid:randomUUID(),encryption:'mlkem768x25519plus.native.0rtt.test'})),failover:{enabled:true,interval:'60s',order:['1','2']}};
const bundle=compileDevices(patchRouting(base,{relay}),node,[device],'a'.repeat(64));
const uuid=bundle.files['conf/VLESS-443.json'].inbounds[2].settings.clients.find(c=>c.email===`panel-${device.id}-1`).id;
const core=linuxPath(process.env.XRAY_LINUX_BIN??(existsSync('.local/tools/v26.3.27/xray')?'.local/tools/v26.3.27/xray':'../Xray-Script/Xray/.test-tools/v26.3.27/xray'));
const args=[linuxPath('tests/native_config_probe.py'),core];
const options={input:JSON.stringify({bundle,uuid,email:`panel-${device.id}-1`}),encoding:'utf8',timeout:60000};
const run=process.platform==='win32'?spawnSync('wsl',['-d',process.env.XRAY_TEST_WSL??'Debian','--','python3',...args],options):spawnSync('python3',args,options);
assert.equal(run.status,0,run.stderr+'\n'+run.stdout);console.log(run.stdout.trim());
