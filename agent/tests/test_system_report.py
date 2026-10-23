import importlib.util,io,json,unittest,urllib.error
from pathlib import Path
spec=importlib.util.spec_from_file_location('system_report',Path(__file__).resolve().parents[1]/'system_report.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
agent_spec=importlib.util.spec_from_file_location('agent_report',Path(__file__).resolve().parents[1]/'agent.py');a=importlib.util.module_from_spec(agent_spec);agent_spec.loader.exec_module(a)
class ReportTests(unittest.TestCase):
 def test_dual_stack_probes_and_failure(self):
  def run(args):return (0,'ip=8.8.8.8\n' if '-4' in args else '2606:4700::1111','')
  r=m.addresses(run);self.assertEqual(r['ipv4']['address'],'8.8.8.8');self.assertEqual(r['ipv6']['address'],'2606:4700::1111')
  self.assertEqual(m.addresses(lambda _: (0,'ip=10.0.0.1',''))['ipv4']['status'],'failed')
  self.assertEqual(m.addresses(lambda _: (1,'','timeout'))['ipv6']['status'],'failed')
 def test_firewall_inventory_preserves_family_sources_actions_and_separates_policy(self):
  def run(args):return (0,'-P INPUT DROP\n-A INPUT -p tcp -s 1.1.1.1/32 --dport 22 -j ACCEPT\n','') if args[0]=='iptables' else (1,'','Permission denied')
  bundle={'files':{'conf/a.json':{'inbounds':[{'port':443,'listen':'2606:4700::1','streamSettings':{'security':'reality'}}]},'firewall_ports.json':{'open':[8080],'closed':[9999]}}}
  r=m.firewall(bundle,run,lambda name:name if name!='nft' else None)
  rule=r['sources'][0]['rules'][1];self.assertEqual(rule['family'],'IPv4');self.assertEqual(rule['source'],'1.1.1.1/32');self.assertEqual(rule['ports'],'22');self.assertEqual(rule['action'],'ACCEPT')
  self.assertEqual(r['sources'][1]['status'],'permission-denied');self.assertEqual(r['manual']['closed'],[9999]);self.assertEqual(r['automatic'][0]['family'],'IPv6')
  self.assertEqual(m.firewall(available=lambda _:None)['status'],'unsupported')
 def test_safe_cloudflare_error_excludes_response_secrets(self):
  exc=urllib.error.HTTPError('https://agent.example.com',403,'Forbidden',{},io.BytesIO(b'error code: 1010 secret=abc-token'))
  text=a.connection_error(exc);self.assertIn('HTTP 403 / CF 1010',text);self.assertIn('BIC',text);self.assertNotIn('abc-token',text)
if __name__=='__main__':unittest.main()
