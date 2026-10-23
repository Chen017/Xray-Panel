"""Bounded, read-only reachability checks. No proxy, shell or arbitrary URLs."""
import concurrent.futures,json,ipaddress,socket,ssl,subprocess,sys,time
from pathlib import Path

def public(value):
    try:
        ip=ipaddress.ip_address(value)
        return ip.is_global and not ip.is_multicast and not ip.is_reserved
    except ValueError:return False

def probe_one(target,resolver=socket.getaddrinfo,connector=socket.create_connection,context_factory=ssl.create_default_context):
    start=time.monotonic()
    try:
        host=target['host'];family=socket.AF_INET6 if target['family']==6 else socket.AF_INET
        if target['family'] not in (4,6) or target['kind'] not in ('tcp','sni') or not isinstance(target['port'],int) or not 1<=target['port']<=65535 or not isinstance(host,str) or len(host)>253 or any(c in host for c in '/\\@?#\r\n '):raise ValueError('target')
        candidates=resolver(host,target['port'],family,socket.SOCK_STREAM)
        addresses=list(dict.fromkeys(item[4][0] for item in candidates))
        if not addresses or any(not public(ip) for ip in addresses):return {'ok':False if target['kind']=='sni' else None,'code':'non_public_or_empty_dns'}
        last=None
        for address in addresses[:2]:
            try:
                with connector((address,target['port']),timeout=2) as sock:
                    if target['kind']=='sni':
                        ctx=context_factory();ctx.minimum_version=ssl.TLSVersion.TLSv1_3;ctx.set_alpn_protocols(['h2'])
                        with ctx.wrap_socket(sock,server_hostname=host) as tls:
                            if tls.selected_alpn_protocol()!='h2':return {'ok':False,'code':'h2_not_negotiated'}
                return {'ok':True,'code':'ok','latencyMs':round((time.monotonic()-start)*1000)}
            except ssl.SSLCertVerificationError:last='certificate_invalid'
            except ssl.SSLError:last='tls_failed'
            except (TimeoutError,socket.timeout):last='timeout'
            except OSError:last='connect_failed'
        return {'ok':False,'code':last or 'connect_failed'}
    except socket.gaierror:return {'ok':False,'code':'dns_failed'}
    except (KeyError,TypeError,ValueError):return {'ok':None,'code':'invalid_target'}
    except OSError:return {'ok':False,'code':'network_failed'}

def run_plan(plan):
    if not isinstance(plan,dict) or not isinstance(plan.get('id'),str) or len(plan['id'])>80 or not isinstance(plan.get('targets'),list) or len(plan['targets'])>8:return None
    def check(target):
        identity=target.get('id') if isinstance(target,dict) else None
        if not isinstance(identity,str) or len(identity)>80:return None
        try:
            result=subprocess.run([sys.executable,str(Path(__file__).resolve())],input=json.dumps(target),text=True,capture_output=True,timeout=5)
            data=json.loads(result.stdout[:4096]) if result.returncode==0 else {'ok':None,'code':'probe_failed'}
        except subprocess.TimeoutExpired:data={'ok':False,'code':'probe_timeout'}
        except (OSError,ValueError):data={'ok':None,'code':'probe_failed'}
        return {'id':identity,**data}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        return {'planId':plan['id'],'results':[result for result in pool.map(check,plan['targets']) if result]}

if __name__=='__main__':
    print(json.dumps(probe_one(json.loads(sys.stdin.read(4096)))))
