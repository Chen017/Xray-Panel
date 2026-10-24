import concurrent.futures,importlib.util,json,os,socket,ssl,subprocess,tempfile,threading,unittest
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
 def test_shared_script_results_and_failures_are_bounded(self):
  for domestic,global_ok,code in [(True,True,'ok'),(False,True,'domestic_unreachable'),(True,False,'global_unreachable'),(False,False,'network_unreachable')]:
   completed=subprocess.CompletedProcess([],0,json.dumps({'domestic':domestic,'global':global_ok,'code':'untrusted'}),'')
   with patch.object(m.subprocess,'run',return_value=completed) as run:
    result=m.probe_one({'kind':'connectivity'});self.assertEqual(result['code'],code);self.assertEqual(result['ok'],domestic and global_ok)
    self.assertEqual(run.call_args.args[0],['bash',str(m.NETWORK_SCRIPT),'--json']);self.assertEqual(run.call_args.kwargs['timeout'],15)
  for value in ['bad',json.dumps({'domestic':'false','global':True}),json.dumps([])]:
   with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,value,'')):
    self.assertIsNone(m.probe_network()['ok'])
  with patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('fixture',15)):
   self.assertIsNone(m.probe_network()['ok'])
 def test_actual_bash_module_round_trip_uses_only_fixed_destinations(self):
  with tempfile.TemporaryDirectory() as tmp:
   fake=Path(tmp)/'timeout';fake.write_text('''#!/bin/bash
for last; do :; done
case "$last" in
 sh-*.ip.zstaticcdn.com) [[ $TEST_DOMESTIC == true ]] ;;
 1.1.1.1|1.0.0.1) [[ $TEST_GLOBAL == true ]] ;;
 *) exit 77 ;;
esac
''');fake.chmod(0o755)
   for domestic in (True,False):
    for global_ok in (True,False):
     with patch.dict(os.environ,{'PATH':tmp+os.pathsep+os.environ['PATH'],'TEST_DOMESTIC':str(domestic).lower(),'TEST_GLOBAL':str(global_ok).lower()}):
      result=m.probe_network();self.assertIs(result['domestic'],domestic);self.assertIs(result['global'],global_ok)
if __name__=='__main__':unittest.main()
