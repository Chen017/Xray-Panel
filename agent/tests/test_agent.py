import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('agent', Path(__file__).resolve().parents[1] / 'agent.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AgentSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'xray'
        self.root.mkdir()
        self.bundle = {'files': {'config.json': {'log': {'loglevel': 'warning'}}, 'conf/node.json': {'inbounds': []}}}

    def tearDown(self):
        self.tmp.cleanup()

    def test_roundtrip_and_flag(self):
        b = json.loads(json.dumps(self.bundle))
        b['files']['conf/is_v6_uplink'] = True
        module.write_bundle(self.root, b)
        self.assertEqual(module.read_bundle(self.root), b)
        module.write_bundle(self.root, self.bundle)
        self.assertFalse((self.root / 'conf/is_v6_uplink').exists())

    def test_path_traversal_rejected(self):
        for name in ['../x.json', 'conf/../../x.json', '/etc/passwd', 'conf/a/b.json', 'conf/../x.json']:
            b = {'files': {'config.json': {}, name: {}}}
            with self.assertRaises(ValueError):
                module.write_bundle(self.root, b)

    def test_bad_json_shape_rejected(self):
        for b in [{}, {'files': []}, {'files': {'config.json': None}}, {'files': {'config.json': {}, 'conf/is_v6_uplink': False}}]:
            with self.assertRaises(ValueError):
                module.validate_bundle(b)

    def test_https_required(self):
        config = {'url': 'http://example.com', 'token': 'a' * 43, 'nodeId': 'test', 'stateDir': str(self.root / 'state'), 'xrayRoot': str(self.root)}
        with self.assertRaises(ValueError):
            module.Agent(config)
        config['allowLoopbackHttp'] = True
        with self.assertRaises(ValueError):
            module.Agent(config)
        config['url'] = 'http://127.0.0.1:3002'
        module.Agent(config)

    def test_redirect_and_embedded_credentials_rejected(self):
        config = {'url': 'https://name:password@example.com', 'token': 'a' * 43, 'nodeId': 'test', 'stateDir': str(self.root / 'state'), 'xrayRoot': str(self.root)}
        with self.assertRaises(ValueError):
            module.Agent(config)
        with self.assertRaises(ValueError):
            module.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.example')

    def test_hash_is_order_invariant(self):
        self.assertEqual(module.bundle_hash({'a': 1, 'b': 2}), module.bundle_hash({'b': 2, 'a': 1}))

    def test_unrecognized_job_rejected(self):
        a = module.Agent({'url': 'https://agent.example.com', 'token': 'a' * 43, 'nodeId': 'test', 'stateDir': str(self.root / 'state'), 'xrayRoot': str(self.root)})
        with self.assertRaises(ValueError):
            a.execute({'id': '../../outside', 'action': 'deploy'})
        with self.assertRaises(ValueError):
            a.execute({'id': 'a' * 36, 'action': 'shell'})

    def make_agent(self):
        a = module.Agent({'url': 'https://agent.example.com', 'token': 'a' * 43, 'nodeId': 'test', 'stateDir': str(self.root / 'state'), 'xrayRoot': str(self.root)})
        a.report = lambda: {'installed': True}
        return a

    def test_malformed_json_still_sends_heartbeat(self):
        (self.root / 'config.json').write_text('{broken')
        a = self.make_agent()
        with patch.object(a, 'request', return_value={'job': None}) as request:
            a.once()
        payload = request.call_args.args[1]
        self.assertNotIn('bundle', payload)
        self.assertIn('JSONDecodeError', payload['report']['configError'])

    def test_logs_can_complete_with_malformed_json(self):
        (self.root / 'config.json').write_text('{broken')
        a = self.make_agent()
        job = {'id': str(uuid.uuid4()), 'action': 'logs', 'payload': {}, 'lease': 'test-lease'}
        with patch.object(a, 'request', side_effect=[{'job': job}, {'ok': True}]) as request, patch.object(module, 'command', return_value=(True, 'diagnostic log')):
            a.once()
        result = request.call_args_list[1].args[1]
        self.assertTrue(result['ok'])
        self.assertEqual(result['output'], 'diagnostic log')
        self.assertIn('configError', result['report'])
        self.assertNotIn('bundle', result)

    def test_cached_readonly_result_refreshes_the_snapshot(self):
        module.write_bundle(self.root, self.bundle)
        a = self.make_agent()
        job = {'id': str(uuid.uuid4()), 'action': 'inspect', 'payload': {}}
        a.execute(job)
        changed = json.loads(json.dumps(self.bundle))
        changed['files']['config.json']['log']['loglevel'] = 'error'
        module.write_bundle(self.root, changed)
        self.assertEqual(a.execute(job)['bundle'], changed)

    def test_cached_deploy_never_republishes_a_stale_or_unreadable_snapshot(self):
        module.write_bundle(self.root, self.bundle)
        a = self.make_agent()
        target = json.loads(json.dumps(self.bundle))
        target['files']['config.json']['log']['loglevel'] = 'debug'
        job = {'id': str(uuid.uuid4()), 'action': 'deploy', 'payload': {'bundle': target, 'expectedHash': module.bundle_hash(self.bundle), 'targetHash': module.bundle_hash(target)}}
        def deploy(*args, **kwargs):
            module.write_bundle(self.root, target)
            return True, 'deployed'
        with patch.object(module, 'command', side_effect=deploy) as command:
            self.assertTrue(a.execute(job)['ok'])
            self.assertTrue(a.execute(job)['ok'])
            module.write_bundle(self.root, self.bundle)
            replay = a.execute(job)
            self.assertFalse(replay['ok'])
            self.assertEqual(replay['bundle'], self.bundle)
            (self.root / 'config.json').write_text('{broken')
            replay = a.execute(job)
            self.assertFalse(replay['ok'])
            self.assertNotIn('bundle', replay)
            self.assertTrue(replay['report']['configError'])
            self.assertEqual(command.call_count, 1)

    @unittest.skipIf(__import__('os').name == 'nt', 'Symlink creation requires Linux permissions')
    def test_symlink_rejected(self):
        target = self.root / 'outside.json'
        target.write_text('{}')
        (self.root / 'config.json').symlink_to(target)
        with self.assertRaises(ValueError):
            module.read_bundle(self.root)


if __name__ == '__main__':
    unittest.main()
