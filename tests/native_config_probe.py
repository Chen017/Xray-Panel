"""Real Xray parser, multi-file merge, and authenticated private-destination test.
Only temporary files, loopback connections and child core processes are used.
"""
import copy
import http.server
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

data=json.load(sys.stdin);core=Path(sys.argv[1]);bundle=data['bundle']
env={**os.environ,'XRAY_LOCATION_ASSET':str(core.parent)}
pair=subprocess.check_output([str(core),'vlessenc'],text=True)
encryption=re.search(r'"encryption"\s*:\s*"([^"]+)"',pair)[1]
for outbound in bundle['files']['config.json']['outbounds']:
    if outbound['protocol']=='vless':outbound['settings']['encryption']=encryption

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

def write_bundle(root,b):
    for name,value in b['files'].items():
        if name=='conf/is_v6_uplink':continue
        file=root/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(value))

with tempfile.TemporaryDirectory(prefix='xray-native-audit-') as directory:
    root=Path(directory);write_bundle(root,bundle)
    command=[str(core),'run','-config',str(root/'config.json'),'-confdir',str(root/'conf')]
    result=subprocess.run([*command,'-dump'],env=env,capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    merged=json.loads(result.stdout)
    inner=[i for i in merged['inbounds'] if i.get('streamSettings',{}).get('network')=='xhttp']
    assert len(inner)==2,inner
    assert len({i['listen'] for i in inner})==2
    assert len({i['settings']['clients'][0]['id'] for i in inner})==2
    assert {i['streamSettings']['xhttpSettings']['path'] for i in inner}=={'/api/v3/updates','/independent-second'}
    print('PASS real Xray merge retains two independent migrated XHTTP paths and identities')
    for xhttp in [None,{},'absent',{'xmux':None}]:
        candidate=copy.deepcopy(bundle)
        for name,file in candidate['files'].items():
            if not name.startswith('conf/'):continue
            for inbound in file['inbounds']:
                if inbound.get('streamSettings',{}).get('network')=='xhttp':
                    if xhttp=='absent':inbound['streamSettings'].pop('xhttpSettings',None)
                    else:inbound['streamSettings']['xhttpSettings']=xhttp
            file['inbounds'].append({'tag':'http-'+name,'protocol':'http','listen':'127.0.0.1','port':free_port()})
        write_bundle(root,candidate)
        result=subprocess.run([*command,'-test'],env=env,capture_output=True,text=True)
        assert result.returncode==0,result.stderr+result.stdout
    print('PASS real Xray accepts empty/missing XHTTP, null XMUX and extra HTTP inbounds')

    class Resource(http.server.BaseHTTPRequestHandler):
        hits=0
        def do_GET(self):
            Resource.hits+=1;self.send_response(200);self.send_header('Content-Length','22');self.end_headers();self.wfile.write(b'PANEL_PRIVATE_RESOURCE')
        def log_message(self,*args):pass
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Resource)
    threading.Thread(target=server.serve_forever,daemon=True).start()

    def receive(s,n):
        value=b''
        while len(value)<n:
            chunk=s.recv(n-len(value))
            if not chunk:raise ConnectionError('closed')
            value+=chunk
        return value

    def attempt(socks_port,domain=False):
        try:
            with socket.create_connection(('127.0.0.1',socks_port),timeout=3) as s:
                s.settimeout(3);s.sendall(b'\x05\x01\x00');assert receive(s,2)==b'\x05\x00'
                address=b'\x03\x12audit-private.test' if domain else b'\x01\x7f\x00\x00\x01'
                s.sendall(b'\x05\x01\x00'+address+struct.pack('!H',server.server_port))
                reply=receive(s,4)
                if reply[1]!=0:return b''
                size={1:4,4:16}.get(reply[3])
                if size is None:size=receive(s,1)[0]
                receive(s,size+2);s.sendall(b'GET / HTTP/1.0\r\nHost: localhost\r\n\r\n')
                out=b''
                while True:
                    chunk=s.recv(8192)
                    if not chunk:return out
                    out+=chunk
                    if b'PANEL_PRIVATE_RESOURCE' in out:return out
        except (OSError,ConnectionError):return b''

    def proxy_round(protected,domain=False,strategy=None):
        # Keep the generated relay/loopback/user rules; use local authenticated
        # VLESS transport so the test never depends on an external TLS service.
        main=copy.deepcopy(bundle['files']['config.json']);port=free_port();socks=free_port()
        main['log']={'loglevel':'debug'}
        main['observatory']['probeUrl']=f'http://127.0.0.1:{server.server_port}/'
        main['observatory']['probeInterval']='1s'
        main['dns']={'hosts':{'audit-private.test':'127.0.0.1'},'servers':['localhost']}
        if strategy:main['routing']['domainStrategy']=strategy
        main['inbounds']=[{'tag':'audit-auth','listen':'127.0.0.1','port':port,'protocol':'vless','settings':{'decryption':'none','clients':[{'id':data['uuid'],'email':data['email']}]},'streamSettings':{'network':'raw','security':'none'}}]
        if not protected:main['routing']['rules']=[r for r in main['routing']['rules'] if r.get('ip')!=['geoip:private']]
        client={'log':{'loglevel':'none'},'inbounds':[{'listen':'127.0.0.1','port':socks,'protocol':'socks','settings':{'auth':'noauth'}}],'outbounds':[{'protocol':'vless','settings':{'address':'127.0.0.1','port':port,'id':data['uuid'],'encryption':'none'},'streamSettings':{'network':'raw','security':'none'}}]}
        workers=[]
        try:
            for name,config in [('server',main),('client',client)]:
                file=root/(name+'.json');file.write_text(json.dumps(config))
                log=(root/(name+'.log')).open('w')
                process=subprocess.Popen([str(core),'run','-c',str(file)],env=env,stdout=log,stderr=subprocess.STDOUT);workers.append((process,log))
            for _ in range(60):
                assert all(p.poll() is None for p,_ in workers),[(root/(name+'.log')).read_text() for name in ['server','client']]
                try:
                    with socket.create_connection(('127.0.0.1',socks),timeout=.1):break
                except OSError:time.sleep(.05)
            time.sleep(.5)
            response=attempt(socks,domain)
            if not protected and b'PANEL_PRIVATE_RESOURCE' not in response:
                print((root/'server.log').read_text()[-8000:],file=sys.stderr)
            return response
        finally:
            for process,log in workers:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()
                log.close()
    try:
        assert b'PANEL_PRIVATE_RESOURCE' in proxy_round(False),'control must reach private resource through failover'
        assert b'PANEL_PRIVATE_RESOURCE' in proxy_round(True,domain=True,strategy='IPIfNonMatch'),'priority alone must not hide the DNS bypass control'
        before=Resource.hits
        assert b'PANEL_PRIVATE_RESOURCE' not in proxy_round(True),'private refusal was bypassed'
        assert b'PANEL_PRIVATE_RESOURCE' not in proxy_round(True,domain=True),'private DNS target bypassed refusal'
        assert Resource.hits==before,'protected request reached private resource'
        print('PASS real authenticated relay-only UUID reaches private control but is blocked with fixed routing')
    finally:server.shutdown();server.server_close()
