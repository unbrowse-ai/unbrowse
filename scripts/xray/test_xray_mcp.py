"""The x-ray's MCP server, driven over stdio as an agent's client drives it: the handshake, the tools it lists, and
two tools answering from this checkout (a finding's functions resolved to file:line, a learn's pick from a node log)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, 'xray_mcp.py')


class Client:
    def __init__(self, env=None):
        self.p = subprocess.Popen([sys.executable, '-I', SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                  env=dict(os.environ, **(env or {})))
        self.n = 0

    def ask(self, method, params=None):
        self.n += 1
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params or {}}) + '\n')
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def call(self, name, **arguments):
        r = self.ask('tools/call', {'name': name, 'arguments': arguments})['result']
        return r, json.loads(r['content'][0]['text']) if not r.get('isError') else r['content'][0]['text']

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def eye(**e):
    return 'eye ' + json.dumps(e)


class TheServer(unittest.TestCase):
    def setUp(self):
        self.c = Client()
        self.c.ask('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 't', 'version': '0'}})

    def tearDown(self):
        self.c.close()

    def test_it_lists_its_tools(self):
        names = [t['name'] for t in self.c.ask('tools/list')['result']['tools']]
        self.assertEqual(names, ['xray_pick', 'xray_routes', 'xray_why', 'xray_diff', 'xray_live'])

    def test_a_finding_points_at_the_engine_as_this_checkout_has_it(self):
        _, got = self.c.call('xray_why', finding='door-took-the-walk')
        self.assertEqual(got['level'], 'break')
        at = {s['fn']: s['at'] for s in got['seam']}
        self.assertTrue(at['trace.rs::door_why'] and at['trace.rs::door_why'][0].startswith('unbrowse-node/crates/learn/src/trace.rs:'), at)
        self.assertTrue(at['learn.rs::door_taken'][0].startswith('unbrowse-node/app/src/learn.rs:'), at)
        _, unknown = self.c.call('xray_why', finding='no-such-finding')
        self.assertIn('door-took-the-walk', unknown['findings'])

    def test_a_learn_that_kept_nothing_shows_what_the_door_took(self):
        d = tempfile.mkdtemp(prefix='uxm')
        try:
            os.makedirs(os.path.join(d, 'home', 'node', 'routes'))
            with open(os.path.join(d, 'node.log'), 'w') as f:
                f.write('\n'.join([
                    eye(kind='started', walk='w9', url='https://www.shop.example/find?q=lamps', goal='search products', agent='t'),
                    eye(kind='door', walk='w9', took=2, assets=0, calls=[
                        {'index': 0, 'method': 'GET', 'host': 'www.shop.example', 'path': '/find', 'why': 'went_past', 'by': 0},
                        {'index': 1, 'method': 'POST', 'host': 'api.search.example', 'path': '/1/query', 'why': 'went_past', 'by': 0}]),
                    eye(kind='scored', walk='w9', exchanges=2, candidates=[]),
                    eye(kind='failed', walk='w9', error='loading the page sends no call that answers the goal: it needs clicks or typing'),
                ]) + '\n')
            _, got = self.c.call('xray_pick', ub_dir=d)
            l, = got['shown']
            self.assertFalse(l['kept'])
            self.assertEqual([f['id'] for f in l['findings']], ['door-took-the-walk'])
            self.assertIn('2 a page of script the walk went past', l['door']['said'])
            self.assertEqual([c['call'] for c in l['door']['calls']], ['GET www.shop.example/find', 'POST api.search.example/1/query'])
            self.assertNotIn('lamps', json.dumps(got), 'the word the page was asked is never shown')
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_a_log_alone_is_read_as_a_ci_run_left_it(self):
        d = tempfile.mkdtemp(prefix='uxm')
        try:
            log = os.path.join(d, 'node.log')
            with open(log, 'w') as f:
                f.write('\n'.join([
                    eye(kind='started', walk='w7', url='https://www.shop.example/find?q=lamps', goal='search products', agent='t'),
                    eye(kind='scored', walk='w7', exchanges=2, candidates=[]),
                    eye(kind='failed', walk='w7', error='loading the page sends no call that answers the goal: it needs clicks or typing'),
                ]) + '\n')
            _, got = self.c.call('xray_pick', log=log)
            l, = got['shown']
            self.assertEqual((l['walk'], l['kept']), ('w7', False))
            r, said = self.c.call('xray_pick', log=os.path.join(d, 'missing.log'))
            self.assertTrue(r.get('isError'))
            self.assertIn('is not a file', said)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_the_install_check_says_ok(self):
        p = subprocess.run([sys.executable, '-I', SERVER, '--check'], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertTrue(p.stdout.startswith('XRAY_MCP_OK 5 tools'), p.stdout)

    def test_a_missing_node_is_said_not_raised(self):
        r, said = self.c.call('xray_pick', ub_dir='/nonexistent/node')
        self.assertTrue(r.get('isError'))
        self.assertIn('is not a folder', said)


class TheGuideAndTheConfig(unittest.TestCase):
    """The agent guide names every tool the server lists, and the repository's .mcp.json starts this server: a tool
    added or renamed without the guide, or a config pointing elsewhere, fails here."""

    def test_the_guide_names_each_tool_and_the_config_starts_this_server(self):
        root = os.path.dirname(os.path.dirname(HERE))
        c = Client()
        try:
            c.ask('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 't', 'version': '0'}})
            names = [t['name'] for t in c.ask('tools/list')['result']['tools']]
        finally:
            c.close()
        guide = open(os.path.join(root, 'AGENTS.md')).read()
        for n in names:
            self.assertIn('`%s`' % n, guide, 'AGENTS.md does not name %s' % n)
        self.assertIn('## Finding a bug: the x-ray first', guide)
        self.assertIn('scripts/xray/xray_mcp.py --check', guide, 'the guide says how an agent proves the install')
        server = json.load(open(os.path.join(root, '.mcp.json')))['mcpServers']['xray']
        self.assertIn('scripts/xray/xray_mcp.py', ' '.join([server['command'], *server['args']]))


if __name__ == '__main__':
    unittest.main()
