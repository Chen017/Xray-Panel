let csrf = '';
export function setCsrf(value:string){csrf=value;}
export async function api(route:string,method='GET',body?:unknown):Promise<any>{
  const res=await fetch(`/api${route}`,{method,credentials:'same-origin',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(method==='GET'?{}:{'X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
  if(!res.ok){const value=await res.json().catch(()=>({error:`HTTP ${res.status}`}));throw Object.assign(Error(value.error),{status:res.status});}
  return res.headers.get('Content-Type')?.includes('application/json')?res.json():res.text();
}
export const json=(v:unknown)=>JSON.stringify(v,null,2);
export const date=(v?:string)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';
export function download(name:string,content:string){const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
