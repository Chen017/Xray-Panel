import importlib.util,json,subprocess,tempfile,unittest,sqlite3
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('lifecycle',Path(__file__).resolve().parents[1]/'lifecycle.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        for name,value in {'HOME':self.root/'manager','AGENT':self.root/'agent','PANEL':self.root/'panel','CONFIG':self.root/'etc/config.json','UNIT':self.root/'etc/agent.service'}.items():
            p=patch.object(m,name,value);p.start();self.addCleanup(p.stop)
        m.HOME.mkdir();self.addCleanup(self.tmp.cleanup)
        self.config={'nodeId':'3c244755-e889-4e17-a659-d9a179036bad','token':'a'*43,'url':'https://agent.example.com','CF-Access-Client-Id':'client','CF-Access-Client-Secret':'secret'}
    def test_agent_install_repeat_preserves_identity_and_paths(self):
        with patch.object(m,'run',return_value=b''),patch.object(m,'service_state',return_value=(True,True)),patch.object(m.time,'sleep'),patch.object(m.shutil,'which',return_value='/bin/tool'):
            m.agent_install(self.config,False)
            current=json.loads(m.CONFIG.read_text());current.update({'xrayRoot':'/custom/xray','stateDir':'/custom/state'});m.write(m.CONFIG,json.dumps(current))
            m.agent_install({k:v for k,v in self.config.items() if not k.startswith('CF-')},False)
            after=json.loads(m.CONFIG.read_text());self.assertEqual(after['CF-Access-Client-Secret'],'secret');self.assertEqual(after['xrayRoot'],'/custom/xray')
            self.assertTrue((m.AGENT/'agent/system_report.py').exists());self.assertEqual(m.CONFIG.stat().st_mode&0o777,0o600)
            with self.assertRaises(ValueError):m.agent_install({**self.config,'nodeId':'adc10a22-557b-4466-a182-137fbf12b1bd'},False)
    def test_failed_legacy_migration_restores_old_service_and_files(self):
        m.CONFIG.parent.mkdir();m.write(m.CONFIG,json.dumps(self.config));m.write(m.UNIT,'old unit /opt/xray-panel/agent/agent.py')
        m.AGENT.mkdir();(m.AGENT/'old').write_text('old');m.PANEL.mkdir();(m.PANEL/'shared').write_text('panel source')
        calls=[];failed=False
        def run(args,**kw):
            nonlocal failed
            calls.append(args)
            if args[:3]==['systemctl','restart',m.SERVICE] and not failed:failed=True;raise RuntimeError('restart failed')
            return b''
        with patch.object(m,'run',side_effect=run),patch.object(m,'service_state',return_value=(True,True)),patch.object(m.subprocess,'run'),patch.object(m.shutil,'which',return_value='/bin/tool'):
            with self.assertRaises(RuntimeError):m.agent_install(self.config,False)
        self.assertEqual((m.AGENT/'old').read_text(),'old');self.assertIn('old unit',m.UNIT.read_text());self.assertEqual((m.PANEL/'shared').read_text(),'panel source')
        self.assertEqual(json.loads(m.CONFIG.read_text()),self.config);self.assertEqual(calls[-1],['systemctl','restart',m.SERVICE])
    def test_uninstall_preserves_xray_shared_source_and_default_credentials(self):
        m.write(m.CONFIG,json.dumps(self.config));m.write(m.UNIT,'/opt/xray-panel/agent/agent.py');m.AGENT.mkdir();m.PANEL.mkdir();(m.PANEL/'keep').touch()
        with patch.object(m,'run',return_value=b''),patch.object(m.subprocess,'run'):
            m.uninstall('agent');self.assertTrue(m.CONFIG.exists());self.assertTrue((m.PANEL/'keep').exists());self.assertFalse(m.AGENT.exists())
            with self.assertRaises(ValueError):m.uninstall('agent',True,'YES')
    def test_migrate_existing_1panel_project_volume_key_and_rollback(self):
        old={'container':'old','project':'1panel','volume':'xray-panel_panel-data','image':'sha256:old','env':{'PANEL_MASTER_KEY':'original-key','PANEL_ADMIN_PASSWORD':'original-password','PANEL_ADMIN_ORIGIN':'https://panel.example.com'}}
        m.PANEL.mkdir();m.write(m.PANEL/'.env','PANEL_MASTER_KEY=stale-key\n');calls=[];healthy=True
        def run(args,**kw):
            calls.append(args)
            if any('VACUUM INTO' in x for x in args):return b'{"uid":1000,"gid":1000}\nconsistent database snapshot'
            if 'ps' in args and '-q' in args:return b'new-container'
            return b''
        def inspect(args):return [{'State':{'Health':{'Status':'healthy' if healthy else 'unhealthy'}}}]
        with patch.object(m,'discover_panel',return_value=old),patch.object(m,'run',side_effect=run),patch.object(m,'docker_json',side_effect=inspect),patch.object(m.shutil,'which',return_value='/bin/docker'),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
            m.panel_install(m.VERSION)
            state=json.loads((m.HOME/'panel.json').read_text());self.assertEqual(state['project'],'1panel');self.assertEqual(state['volume'],old['volume'])
            self.assertIn('original-key',Path(state['envFile']).read_text());self.assertNotIn('stale-key',Path(state['envFile']).read_text())
            self.assertIn('external: true',(m.HOME/'panel.compose.yaml').read_text());self.assertFalse(any('build' in c for c in calls))
            healthy=False
            with self.assertRaises(RuntimeError):m.panel_install(m.VERSION)
            self.assertIn('sha256:old',(m.HOME/'panel.compose.yaml').read_text())
            restore=next(c for c in calls if any('chownSync' in x for x in c));self.assertTrue(any('chownSync' in x and '1000,1000' in x for x in restore))
            backups=list((m.HOME/'backups').glob('*/panel.sqlite'));self.assertEqual(backups[0].read_bytes(),b'consistent database snapshot')
    def test_stopped_panel_is_backed_up_without_exec_and_remains_stopped_on_failure(self):
        old={'container':'stopped','running':False,'project':'1panel','volume':'original-volume','image':'sha256:old','env':{'PANEL_MASTER_KEY':'original-key'}}
        calls=[]
        def run(args,**kw):
            calls.append(args)
            if args[:2]==['docker','exec']:self.fail('cannot exec a stopped container')
            if any('VACUUM INTO' in x for x in args):return b'{"uid":1000,"gid":1000}\nstopped snapshot'
            if 'ps' in args:return b'new-container'
            return b''
        with patch.object(m,'discover_panel',return_value=old),patch.object(m,'run',side_effect=run),patch.object(m,'docker_json',return_value=[{'State':{'Health':{'Status':'unhealthy'}}}]),patch.object(m.shutil,'which',return_value='/bin/docker'),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
            with self.assertRaises(RuntimeError):m.panel_install(m.VERSION)
        self.assertTrue(any('chownSync' in x for c in calls for x in c))
        self.assertEqual(sum('up' in c for c in calls),1,'rollback must not start a previously stopped panel')
        self.assertTrue(any('create' in c and 'panel' in c for c in calls))
    def test_retained_panel_volume_gets_a_snapshot_and_rollback_after_reinstall_failure(self):
        env=m.HOME/'panel.env';m.write(env,'PANEL_MASTER_KEY=original-key\n')
        m.write(m.HOME/'panel.json',json.dumps({'project':'kept','volume':'kept-volume','envFile':str(env),'version':'1.1.0'}))
        calls=[]
        def run(args,**kw):
            calls.append(args)
            if any('VACUUM INTO' in x for x in args):return b'{"uid":1000,"gid":1000}\nretained snapshot'
            if 'ps' in args:return b'new-container'
            return b''
        with patch.object(m,'discover_panel',return_value=None),patch.object(m,'run',side_effect=run),patch.object(m,'docker_json',return_value=[{'State':{'Health':{'Status':'unhealthy'}}}]),patch.object(m.shutil,'which',return_value='/bin/docker'),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
            with self.assertRaises(RuntimeError):m.panel_install(m.VERSION)
        self.assertTrue(any('chownSync' in x for c in calls for x in c),'retained database must be rolled back too')
        self.assertEqual(next((m.HOME/'backups').glob('*/panel.sqlite')).read_bytes(),b'retained snapshot')
        self.assertEqual(json.loads((m.HOME/'panel.json').read_text())['version'],'1.1.0')
    def test_failed_pull_never_changes_existing_panel(self):
        with patch.object(m.shutil,'which',return_value='/bin/docker'),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)),patch.object(m,'run',side_effect=[b'',RuntimeError('pull failed')]):
            with self.assertRaises(RuntimeError):m.panel_install(m.VERSION)
        self.assertFalse((m.HOME/'panel.compose.yaml').exists())
    def test_upgrade_snapshot_follows_last_confirmed_write_and_failure_preserves_it(self):
        old={'container':'old','running':True,'project':'fixture','volume':'fixture-volume','image':'sha256:old','env':{'PANEL_MASTER_KEY':'original-key'}}
        database=self.root/'actual.sqlite';db=sqlite3.connect(database)
        self.addCleanup(db.close);db.execute('CREATE TABLE devices(revoked INTEGER)');db.execute('INSERT INTO devices VALUES(0)');db.commit()
        calls=[];stopped=False
        def run(args,**kw):
            nonlocal stopped
            calls.append(args)
            if args[:2]==['docker','stop']:
                # Represents the last successful HTTP revocation before shutdown.
                db.execute('UPDATE devices SET revoked=1');db.commit();stopped=True
            if any('VACUUM INTO' in x for x in args):
                self.assertTrue(stopped,'must stop the old writer before snapshot')
                return b'{"uid":1000,"gid":1000}\n'+database.read_bytes()
            if any('chownSync' in x for x in args):
                self.assertTrue(any('stop' in c and 'panel' in c for c in calls))
                snapshot=next((m.HOME/'backups').glob('*/panel.sqlite'))
                restored=sqlite3.connect(snapshot)
                try:self.assertEqual(restored.execute('SELECT revoked FROM devices').fetchone()[0],1)
                finally:restored.close()
            if 'ps' in args:return b'new-container'
            return b''
        with patch.object(m,'discover_panel',return_value=old),patch.object(m,'run',side_effect=run),patch.object(m,'docker_json',return_value=[{'State':{'Health':{'Status':'unhealthy'}}}]),patch.object(m.shutil,'which',return_value='/bin/docker'),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
            with self.assertRaises(RuntimeError):m.panel_install(m.VERSION)
        self.assertTrue(any('chownSync' in x for c in calls for x in c))
        self.assertTrue(any("writeFileSync(p," in x for c in calls for x in c),'candidate must start in maintenance mode')
    def test_snapshot_failure_restarts_old_writer_without_starting_candidate(self):
        old={'container':'old','running':True,'project':'fixture','volume':'fixture-volume','image':'sha256:old','env':{'PANEL_MASTER_KEY':'original-key'}}
        calls=[]
        def run(args,**kw):
            calls.append(args)
            if any('VACUUM INTO' in x for x in args):raise RuntimeError('snapshot failed')
            return b''
        with patch.object(m,'discover_panel',return_value=old),patch.object(m,'run',side_effect=run),patch.object(m.shutil,'which',return_value='/bin/docker'),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0)):
            with self.assertRaises(RuntimeError):m.panel_install(m.VERSION)
        self.assertIn(['docker','start','old'],calls);self.assertFalse(any('up' in c for c in calls))
    def test_first_panel_install_generates_env_and_retains_data_after_uninstall(self):
        with patch.object(m,'discover_panel',return_value=None),patch.object(m.shutil,'which',return_value='/bin/docker'),patch.object(m.subprocess,'run',side_effect=lambda args,**kw:subprocess.CompletedProcess([],1 if 'inspect' in args else 0)),patch.object(m,'run',side_effect=lambda args,**kw:b'container' if 'ps' in args else b''),patch.object(m,'docker_json',return_value=[{'State':{'Health':{'Status':'healthy'}}}]):
            m.panel_install(m.VERSION,['a.example.com','b.example.com','c.example.com'])
            env=(m.PANEL/'.env').read_text();self.assertIn('PANEL_MASTER_KEY=',env);self.assertIn('PANEL_AGENT_ORIGIN=https://c.example.com',env)
            m.uninstall('panel');self.assertEqual((m.PANEL/'.env').read_text(),env)
            with self.assertRaises(ValueError):m.uninstall('panel',True)
            m.uninstall('panel',True,'DELETE-PANEL-DATA');self.assertFalse((m.PANEL/'.env').exists());self.assertFalse((m.HOME/'panel.json').exists())
    def test_cli_menu_and_validation(self):
        with patch('builtins.input',side_effect=['0']),patch('builtins.print') as output:m.menu('agent')
        self.assertTrue(any('安装接入 Agent' in str(c) for c in output.call_args_list));self.assertFalse(any('安装 Panel' in str(c) for c in output.call_args_list))
        for url in ['http://a.com','https://a.com/path','https://a.com?','https://a.com\\x','https://a\nb.com']:
            with self.assertRaises(ValueError):m.safe_url(url)
        with self.assertRaises(ValueError):m.enrollment(json.dumps({**self.config,'testDriver':'anything','token':'x'}))
        self.assertNotIn('testDriver',m.enrollment(json.dumps({**self.config,'testDriver':'anything'})))
        for value in ['latest','1.0','1;id']:
            with self.assertRaises(ValueError):m.version_tag(value)
    def test_interrupted_manager_copy_never_becomes_a_complete_cached_release(self):
        source=self.root/'source';(source/'deploy').mkdir(parents=True)
        (source/'package.json').write_text(json.dumps({'version':m.VERSION}));(source/'deploy/lifecycle.py').write_text('complete manager')
        destination=m.HOME/'versions'/m.VERSION
        def interrupted(src,dst,*a,**kw):
            Path(dst).mkdir(parents=True);(Path(dst)/'partial').touch();raise OSError('interrupted copy')
        with patch.object(m.shutil,'copytree',side_effect=interrupted):
            with self.assertRaises(OSError):m.stage_release(source,destination,'a'*64)
        self.assertFalse(destination.exists());self.assertFalse(m.release_ready(destination,m.VERSION))
        destination.mkdir();(destination/'partial').touch()
        m.stage_release(source,destination,'a'*64)
        self.assertTrue(m.release_ready(destination,m.VERSION));self.assertFalse((destination/'partial').exists())
        self.assertEqual(list(destination.parent.glob('.install-*')),[])
    def test_manager_publish_failure_restores_the_previous_cache(self):
        source=self.root/'source';source.mkdir();(source/'new').touch()
        destination=m.HOME/'versions'/m.VERSION;destination.mkdir(parents=True);(destination/'old').touch()
        real_replace=m.os.replace
        def fail_publish(src,dst):
            if Path(src).name=='release':raise OSError('rename failed')
            return real_replace(src,dst)
        with patch.object(m.os,'replace',side_effect=fail_publish):
            with self.assertRaises(OSError):m.stage_release(source,destination,'a'*64)
        self.assertTrue((destination/'old').exists());self.assertFalse((destination/'new').exists())

if __name__=='__main__':unittest.main()
