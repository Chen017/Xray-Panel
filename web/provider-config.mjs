import YAML from 'yaml';
export const DOWNLOAD_GROUP='Subscription Download';
export const DOWNLOAD_PROBE='https://cp.cloudflare.com/generate_204';
export const downloadGroups=()=>({'proxy-groups':[{name:DOWNLOAD_GROUP,type:'fallback',proxies:['Existing Proxy','DIRECT'],url:DOWNLOAD_PROBE,interval:60,timeout:5000,lazy:false,'expected-status':204}]});
export const downloadGuidance='将 Existing Proxy 替换为已有且独立可用的代理组名称，把该组追加到原 proxy-groups 列表；已有 proxy-providers 时只合并 xray 子项，不要重复顶层字段。已有代理组不得反向引用 Subscription Download，也不能只依赖本次下载的 xray provider。健康检测失败后按顺序回退 DIRECT，并非每次订阅请求失败就立即直连重试。首次没有缓存时，需要已有代理或直连至少一种能访问订阅域名；两者都不通时无法下载。检测地址也须在当前网络支持代理和直连，可按需替换。';
export function providerConfig(result,token,privateKey,cfId='',cfSecret=''){
  return YAML.stringify({'proxy-providers':{xray:{type:'http',url:result.url,path:'./proxy_providers/xray.yaml',interval:3600,proxy:DOWNLOAD_GROUP,'age-secret-key':privateKey||'在此填写本设备 AGE-SECRET-KEY-1…',header:{Authorization:[`Bearer ${token}`],...(cfId&&cfSecret?{'CF-Access-Client-Id':[cfId],'CF-Access-Client-Secret':[cfSecret]}:{})},'health-check':{enable:true,url:DOWNLOAD_PROBE,interval:300}}}});
}
export function providerInstructions(result,token,privateKey,cfId='',cfSecret=''){
  return '# '+downloadGuidance+'\n'+providerConfig(result,token,privateKey,cfId,cfSecret)+'\n'+YAML.stringify(downloadGroups());
}
