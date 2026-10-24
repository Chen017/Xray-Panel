import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {providerConfig,providerInstructions,downloadGroups,DOWNLOAD_GROUP} from '../web/provider-config.mjs';
test('generated provider uses a named fallback group and preserves device and CF credentials',()=>{
 const yaml=providerInstructions({url:'https://sub.example.test/v1/subscriptions/id'},'device-token','AGE-SECRET-KEY-1example','cf-id','cf-secret'),parsed=YAML.parse(yaml),p=parsed['proxy-providers'].xray,g=parsed['proxy-groups'][0];
 assert.equal(p.proxy,DOWNLOAD_GROUP);assert.equal(p.header.Authorization[0],'Bearer device-token');assert.equal(p['age-secret-key'],'AGE-SECRET-KEY-1example');assert.equal(p.header['CF-Access-Client-Secret'][0],'cf-secret');assert.deepEqual(g.proxies,['Existing Proxy','DIRECT']);assert.equal(g.type,'fallback');assert.equal(g.lazy,false);assert.equal(g['expected-status'],204);assert.ok(!g.url.includes('gstatic'));
 assert.equal(g.hidden,true);assert.equal((yaml.match(/^proxy-providers:/gm)??[]).length,1);assert.equal((yaml.match(/^proxy-groups:/gm)??[]).length,1);assert.match(yaml,/并非每次订阅请求失败/);assert.match(yaml,/首次没有缓存/);assert.match(yaml,/不得反向引用/);
});
test('standalone provider and group snippets merge into existing configuration without duplicate root fields',()=>{
 const provider=YAML.parse(providerConfig({url:'https://sub.example.test/'},'token','')),groups=downloadGroups();const local={'proxy-providers':{other:{type:'file',path:'other.yaml'}},'proxy-groups':[{name:'My Existing Proxy',type:'select',proxies:['DIRECT']}]};
 groups['proxy-groups'][0].proxies[0]='My Existing Proxy';Object.assign(local['proxy-providers'],provider['proxy-providers']);local['proxy-groups'].push(...groups['proxy-groups']);assert.doesNotThrow(()=>YAML.parse(YAML.stringify(local)));assert.equal(local['proxy-groups'].length,2);assert.ok(!provider['proxy-providers'].xray.header['CF-Access-Client-Id']);
});
