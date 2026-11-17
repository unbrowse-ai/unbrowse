"""The route x-ray's own tests. It reads a route by shape and writes no value of it; it reads the node's log and says
why a learn began; it never writes its pages into a repository; and every function of the engine it names is in the
engine's source as it stands, so it cannot drift from the code it points at.

The route and the log here are made up, on shop.example: a kept route names its site and a walk carries a session,
and neither belongs in the repository. Standard library only; no site is asked.

  python3 -I -m unittest discover -s scripts/xray -p 'test_*.py' -v
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import xray_log as G  # noqa: E402
import xray_why as Y  # noqa: E402

_spec = importlib.util.spec_from_file_location('route_xray', os.path.join(HERE, 'route-xray.py'))
X = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(X)

WALKED = 1794616694  # when the route was learned, in seconds
GOAL = 'search products with names and prices'
# Values of the walk that must never be written out: a time of the walk, the caller's word inside a fixed value, and
# a value seen once that is shaped like a session's id.
CLOCK, BAKED, ONCE = '1794616694321', 'lamps_box', 'Zk3Qm9Lx2Pv7Rt8Ws4Yb6Nc1'


def a_route(rid='r1', word='lamps'):
    return {
        'id': rid, 'site': 'www.shop.example', 'what': GOAL, 'method': 'GET', 'learned_at': WALKED,
        'root': 'https://www.shop.example/find?q=%s' % word,
        'inputs': [{'name': 'q', 'default': word}],
        'heard': {'probed': True},
        'graph': {'steps': [{
            'exchange': 0, 'method': 'GET', 'status': 200, 'needs_browser': False, 'response_shape': {'items': []},
            'url': 'https://www.shop.example/find?q={q}&_=%s&ref=%s&sid=%s' % (CLOCK, BAKED, ONCE),
            'fields': [
                {'loc': {'in': 'query', 'key': 'q'}, 'class': 'input', 'name': 'q', 'default': word, 'secret': False},
                {'loc': {'in': 'query', 'key': '_'}, 'class': 'constant', 'value': CLOCK},
                {'loc': {'in': 'query', 'key': 'ref'}, 'class': 'constant', 'value': BAKED},
                {'loc': {'in': 'query', 'key': 'sid'}, 'class': 'unconfirmed', 'value': ONCE},
            ]}]},
    }


def write(path, text):
    with open(path, 'w') as f:
        f.write(text)


def read(path):
    with open(path) as f:
        return f.read()


def eye(**e):
    return 'eye ' + json.dumps(e)


# A node's log of two learns of one goal: the first route answered, was called for a word the site has nothing for,
# its answer was set aside, and the page for that word was learned in its place.
LOG = '\n'.join([
    eye(kind='started', walk='aaa111', url='https://www.shop.example/find?q=lamps', goal=GOAL, agent='t'),
    eye(kind='picked', walk='aaa111', index=3, method='GET', host='www.shop.example', path='/find', by='the rule', reasons=['its answer holds 40 records with prices']),
    eye(kind='saved', walk='aaa111', route='r0', what=GOAL, site='www.shop.example', steps=1, inputs=['q']),
    '   [verify] GET www.shop.example stands',
    "   [goal] GET www.shop.example was called and its answer not taken: its answer doesn't hold what this goal asks for",
    eye(kind='started', walk='bbb222', url='https://www.shop.example/find?q=zqxvkw', goal=GOAL, agent='t'),
    eye(kind='picked', walk='bbb222', index=2, method='GET', host='www.shop.example', path='/find', by='the rule', reasons=['its answer holds 12 records with prices']),
    eye(kind='saved', walk='bbb222', route='r1', what=GOAL, site='www.shop.example', steps=1, inputs=['q']),
]) + '\n'


def run(*args, env=None):
    return subprocess.run(list(args), capture_output=True, text=True, env=dict(os.environ, **(env or {})), timeout=300)


class ARouteIsReadByShape(unittest.TestCase):
    def test_each_hole_left_unstrung_is_a_finding(self):
        x = X.xray(a_route())
        ids = {f['id'] for f in x['findings']}
        self.assertIn('frozen-clock', ids, 'a time of the walk sent as walked')
        self.assertIn('baked-word', ids, "the caller's word inside a fixed value")
        self.assertIn('open', ids, 'a value seen once with no source')
        self.assertGreaterEqual(x['counts']['break'], 2)

    def test_no_value_of_the_route_is_written(self):
        x = X.xray(a_route())
        said = json.dumps(x) + X.text_for(x)
        for value in (CLOCK, BAKED, ONCE):
            self.assertNotIn(value, said)

    def test_a_value_shaped_like_a_token_is_hidden_from_the_log(self):
        said = G.hush('the call sent %s to https://www.shop.example/find?q=lamps' % ONCE, {'lamps'})
        self.assertNotIn(ONCE, said)
        self.assertNotIn('lamps', said)


class TheLogSaysWhyALearnBegan(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, 'node.log')
        write(self.log, LOG)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_a_learn_after_an_answer_set_aside_is_told_so(self):
        first, second = G.read(self.log)
        self.assertIsNone(first['set_aside'])
        self.assertIn('not taken', second['set_aside'])
        self.assertIn('learned-after-set-aside', [f for f, _ in G.findings(second)])
        self.assertNotIn('learned-after-set-aside', [f for f, _ in G.findings(first)])

    def test_a_route_that_took_the_place_of_one_that_answered_is_a_break(self):
        routes = os.path.join(self.dir, 'routes')
        os.makedirs(routes)
        write(os.path.join(routes, 'r1.json'), json.dumps(a_route('r1', 'zqxvkw')))
        out = run(sys.executable, '-I', os.path.join(HERE, 'route-xray.py'), routes, '--log', self.log, '--text')
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('took the place of one that answered', out.stdout)
        self.assertIn('a learn whose route (r0) is no longer on the node', out.stdout)
        self.assertNotIn('zqxvkw', out.stdout, 'the words asked are written ‹word›')


class PagesStayOutOfARepository(unittest.TestCase):
    def test_pages_are_never_written_into_a_repository(self):
        routes = tempfile.mkdtemp()
        try:
            write(os.path.join(routes, 'r1.json'), json.dumps(a_route()))
            inside = os.path.join(HERE, 'pages-that-must-not-be-written')
            out = run(sys.executable, '-I', os.path.join(HERE, 'route-xray.py'), routes, '--out', inside)
            self.assertNotEqual(out.returncode, 0)
            self.assertIn('refusing to write into a repository', out.stdout + out.stderr)
            self.assertFalse(os.path.exists(inside))
        finally:
            shutil.rmtree(routes, ignore_errors=True)

    def test_pages_outside_one_hold_no_value(self):
        routes, pages = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            write(os.path.join(routes, 'r1.json'), json.dumps(a_route()))
            out = run(sys.executable, '-I', os.path.join(HERE, 'route-xray.py'), routes, '--out', pages)
            self.assertEqual(out.returncode, 0, out.stderr)
            written = ''.join(read(os.path.join(pages, n)) for n in os.listdir(pages) if n.endswith(('.html', '.json')))
            self.assertIn('r1.html', os.listdir(pages))
            for value in (CLOCK, BAKED, ONCE):
                self.assertNotIn(value, written)
        finally:
            shutil.rmtree(routes, ignore_errors=True)
            shutil.rmtree(pages, ignore_errors=True)


class EveryFunctionItNamesIsInTheEngine(unittest.TestCase):
    """`xray_why.WHY` names functions of the engine by file and name. Renaming or removing one without the x-ray fails
    here, not silently on a page."""

    @classmethod
    def setUpClass(cls):
        out = run(sys.executable, '-I', os.path.join(HERE, 'engine-map.py'), 'running=' + TOP)
        assert out.returncode == 0, out.stderr
        cls.engine = json.loads(out.stdout)['running']

    def test_the_engines_source_was_read(self):
        self.assertGreater(len(self.engine['fns']), 1000)

    def test_every_function_of_the_running_engine_it_names_is_there(self):
        gone = []
        for finding, why in Y.WHY.items():
            for part in ('wrote', 'missed', 'seam'):
                selectors = why.get(part)
                if not selectors or selectors == 'hole':
                    continue
                for sel in selectors:
                    if any('gone' in r for r in Y.resolve(self.engine, sel)):
                        gone.append('%s %s %s' % (finding, part, sel))
        self.assertEqual(gone, [], 'named in xray_why.WHY and not in the source: rename them there')


class TheLauncher(unittest.TestCase):
    def test_it_reads_the_engine_and_points_each_finding_at_its_code(self):
        routes, pages = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            write(os.path.join(routes, 'r1.json'), json.dumps(a_route()))
            env = {'XRAY_OUT': pages, 'XRAY_TREE_BIN': os.path.join(pages, 'no-route-tree'), 'XRAY_REBUILD': 'no-such-ref-here', 'UB_DIR': ''}
            out = run('sh', os.path.join(HERE, 'xray.sh'), '--text', routes, env=env)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn('in the engine (the fix goes here, never in the route):', out.stdout)
            self.assertIn('fresh.rs', out.stdout, "the frozen clock points at the clock's readers")
            for value in (CLOCK, BAKED, ONCE):
                self.assertNotIn(value, out.stdout)
        finally:
            shutil.rmtree(routes, ignore_errors=True)
            shutil.rmtree(pages, ignore_errors=True)

    def test_with_nothing_named_and_no_node_it_says_what_to_give(self):
        pages = tempfile.mkdtemp()
        try:
            out = run('sh', os.path.join(HERE, 'xray.sh'), '--text', env={'XRAY_OUT': pages, 'XRAY_TREE_BIN': os.path.join(pages, 'no-route-tree'), 'XRAY_REBUILD': 'no-such-ref-here', 'UB_DIR': ''})
            self.assertEqual(out.returncode, 2)
            self.assertIn('name the routes to read', out.stderr)
        finally:
            shutil.rmtree(pages, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
