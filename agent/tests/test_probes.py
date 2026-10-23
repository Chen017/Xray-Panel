import concurrent.futures,importlib.util,json,socket,ssl,subprocess,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('network_probes',Path(__file__).resolve().parents[1]/'probes.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ProbeTests(unittest.TestCase):
 def target(self,kind='sni'):return {'kind':kind,'host':'localhost','port':443,'family':4,'id':'fixture'}
 def resolver(self,*args):return [(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',443))]
 def test_private_dns_and_invalid_target_never_connect(self):
  connector=lambda *a,**k:self.fail('private address connected')
  result=m.probe_one(self.target(),resolver=lambda *a:[(2,1,6,'',('127.0.0.1',443))],connector=connector)
  self.assertFalse(result['ok']);self.assertEqual(result['code'],'non_public_or_empty_dns')
  for key,value in [('port',0),('kind','shell'),('family',5),('host','https://wrong/path')]:
   self.assertIsNone(m.probe_one({**self.target(),key:value})['ok'])
 def test_dns_certificate_and_timeout_are_structured(self):
  def dns(*a):raise socket.gaierror('name missing')
  self.assertEqual(m.probe_one(self.target(),resolver=dns)['code'],'dns_failed')
  def timeout(*a,**k):raise TimeoutError()
  self.assertEqual(m.probe_one(self.target(),resolver=self.resolver,connector=timeout)['code'],'timeout')
 def test_tls13_h2_real_handshake_and_certificate_validation(self):
  with tempfile.TemporaryDirectory(prefix='probe-tls-') as tmp:
   key,cert=Path(tmp)/'key.pem',Path(tmp)/'cert.pem'
   subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],check=True,capture_output=True)
   def check(alpn,trust=True):
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();port=listener.getsockname()[1]
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.minimum_version=ssl.TLSVersion.TLSv1_3;ctx.load_cert_chain(cert,key);ctx.set_alpn_protocols(alpn)
    def serve():
     try:
      conn,_=listener.accept()
      with conn:
       try:
        with ctx.wrap_socket(conn,server_side=True):pass
       except ssl.SSLError:pass
     finally:listener.close()
    thread=threading.Thread(target=serve);thread.start()
    def connect(*a,**kw):return socket.create_connection(('127.0.0.1',port),timeout=2)
    factory=(lambda:ssl.create_default_context(cafile=str(cert))) if trust else ssl.create_default_context
    result=m.probe_one(self.target(),resolver=self.resolver,connector=connect,context_factory=factory);thread.join(5);self.assertFalse(thread.is_alive());return result
   self.assertTrue(check(['h2'])['ok']);self.assertEqual(check(['http/1.1'])['code'],'h2_not_negotiated');self.assertEqual(check(['h2'],False)['code'],'certificate_invalid')
 def test_plan_limits_and_deadlines(self):
  self.assertIsNone(m.run_plan({'id':'test','targets':[{}]*9}))
  target=self.target('tcp')
  with patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('fixture',5)):
   result=m.run_plan({'id':'test','targets':[target]});self.assertFalse(result['results'][0]['ok']);self.assertEqual(result['results'][0]['code'],'probe_timeout')
if __name__=='__main__':unittest.main()
