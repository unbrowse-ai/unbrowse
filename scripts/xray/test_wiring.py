"""The wiring view's own tests. Each draws from small route files made up here, on shop.example: no real site's data.
They check that what the page shows is read from the files by rule (an unknown op is drawn, a graph-only route draws,
each flag is raised by its rule and only then) and that no secret leaves the reader.

  python3 -I -m unittest discover -s scripts/xray -p 'test_*.py' -v
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wiring as W  # noqa: E402

SECRET_SLOT_EXAMPLE = 'hunter2-the-callers-password'
COOKIE_VALUE = 'sess-Zk3Qm9Lx2Pv7'
STORED_VALUE = 'stored-Rt8Ws4Yb6Nc1'
LONG_TEXT = 'a fixed value that is far longer than forty characters, sent as walked'
TOKEN_TEXT = 'Q7d9KfP2xLm4Rt8Ws4Yb'
SOURCE = 'function sign(q) { return "only-in-the-source-" + q; }'


def body_step(sid, holes, url='https://www.shop.example/api/find'):
    return {'id': sid, 'method': 'GET', 'url': url, 'holes': holes, 'expect': 200}


def hole(kind, key, *ways, open_=False):
    h = {'at': {'in': kind, 'key': key}, 'ways': [{'rung': r, 'expr': e} for r, e in ways]}
    if open_: h['open'] = True
    return h


def a_route(rid='r1', body=None, graph_steps=None):
    r = {'id': rid, 'site': 'www.shop.example', 'what': 'search products', 'method': 'GET', 'inputs': [{'name': 'q', 'default': 'lamps'}],
         'graph': {'steps': graph_steps if graph_steps is not None else [{'exchange': 0, 'method': 'GET', 'url': 'https://www.shop.example/api/find?q=lamps', 'status': 200,
                                                                         'needs_browser': False, 'fields': [{'loc': {'in': 'query', 'key': 'q'}, 'class': 'input', 'name': 'q', 'secret': False, 'default': 'lamps'}]}]}}
    if body is not None: r['body'] = body
    return r


def a_body(steps, tests=(), slots=({'name': 'q', 'example': 'lamps'},), answer=None):
    return {'v': 1, 'site': 'www.shop.example', 'slots': list(slots), 'steps': steps, 'answer': answer or {'step': steps[-1]['id']}, 'tests': list(tests)}


Q = ('query', 'q', (0, {'op': 'slot', 'name': 'q', 'or': 'lamps'}))


class Home:
    """A made-up node home: routes/*.json and made.jsonl."""

    def __init__(self, name=None):
        self.top = tempfile.mkdtemp()
        self.dir = os.path.join(self.top, name or 'node')
        os.makedirs(os.path.join(self.dir, 'routes'))

    def put(self, route):
        with open(os.path.join(self.dir, 'routes', route['id'] + '.json'), 'w') as f: json.dump(route, f)

    def made(self, **m):
        with open(os.path.join(self.dir, 'made.jsonl'), 'a') as f: f.write(json.dumps(dict({'v': 1, 'at': 1794616694, 'ms': 5, 'steps': [0], 'model_requests': 0}, **m)) + '\n')

    def state(self, **kw):
        return W.Reader([self.dir], **kw).state(all_groups=True)

    def routes(self, **kw):
        return [r for rs in self.state(**kw)['routes'].values() for r in rs]

    def gone(self):
        shutil.rmtree(self.top, ignore_errors=True)


def holes_of(route):
    return {h['place']: h for s in route['steps'] for h in s['holes']}


class TheVocabulary(unittest.TestCase):
    def test_an_unknown_op_is_drawn_never_dropped(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('header', 'x-new', (1, {'op': 'teleport', 'of': {'op': 'cookie', 'name': 'sid'}}))])])))
            r, = h.routes()
            x = holes_of(r)['header x-new']
            self.assertIn('unknown op teleport', x['ways'][0]['line'])
            self.assertIn('unknown', [l['layer'] for l in x['layers']])
            self.assertIn('session', [l['layer'] for l in x['layers']], 'what the unknown op holds is still strung')
            self.assertEqual(r['counts']['unknown'], 1)
            self.assertIn('unknown op teleport', W.page(h.state(), live=False))
        finally: h.gone()

    def test_the_ops_are_read_from_the_source_of_expr(self):
        src = '''pub enum Expr {
    /// text
    Text { is: String },
    Slot {
        name: String,
        #[serde(default)]
        or: Option<String>,
    },
    ProgramReading { source: String, reads: Vec<Feed> },
    Solve { algo: Algo, before: Box<Expr>, zeros: u32 },
}
pub enum Other { Nope }'''
        self.assertEqual(W.ops_in_source(src), {'text', 'slot', 'program_reading', 'solve'})

    def test_the_ops_new_on_other_branches_are_known(self):
        for op in ('program_reading', 'solve', 'format', 'lookup'):
            self.assertIn(op, W.known_ops())


class NoSecretLeavesTheReader(unittest.TestCase):
    def test_a_secret_is_never_printed(self):
        h = Home()
        try:
            prog = {'op': 'program', 'source': SOURCE, 'evidence': {'sightings': 2, 'proposed_by': 'the sending script', 'producer': {'script': 'https://www.shop.example/s/app.js', 'at': 7}}}
            h.put(a_route(body=a_body(
                [body_step('x1', [hole('query', 'pw', (0, {'op': 'slot', 'name': 'pw', 'or': SECRET_SLOT_EXAMPLE})),
                                  hole('cookie', 'sid', (0, {'op': 'text', 'is': COOKIE_VALUE})),
                                  hole('header', 'x-store', (0, {'op': 'stored', 'area': 'local', 'key': 'token'})),
                                  hole('header', 'x-long', (0, {'op': 'text', 'is': LONG_TEXT})),
                                  hole('header', 'x-token', (0, {'op': 'text', 'is': TOKEN_TEXT})),
                                  hole('header', 'authorization', (0, {'op': 'text', 'is': 'Bearer ' + TOKEN_TEXT})),
                                  hole('header', 'x-sig', (2, prog))])],
                slots=[{'name': 'pw', 'secret': True, 'example': SECRET_SLOT_EXAMPLE}]),
                graph_steps=[{'exchange': 0, 'method': 'GET', 'url': 'https://www.shop.example/api/find', 'status': 200, 'fields': [
                    {'loc': {'in': 'cookie', 'key': 'sid'}, 'class': 'constant', 'value': COOKIE_VALUE},
                    {'loc': {'in': 'query', 'key': 'pw'}, 'class': 'input', 'name': 'pw', 'secret': True, 'default': SECRET_SLOT_EXAMPLE}]}]))
            st = h.state()
            said = json.dumps(st, ensure_ascii=False) + W.page(st, live=False)
            for secret in (SECRET_SLOT_EXAMPLE, COOKIE_VALUE, STORED_VALUE, LONG_TEXT, TOKEN_TEXT, SOURCE):
                self.assertNotIn(secret, said)
            x = holes_of(st['routes'][next(iter(st['routes']))][0])
            self.assertIn('pw (secret)', x['query pw']['ways'][0]['line'], 'a secret slot is shown by its name')
            self.assertIn('stored local token', x['header x-store']['ways'][0]['line'], 'a stored value is shown by its name')
            self.assertIn('the sending script', x['header x-sig']['ways'][0]['tree'], "a program's evidence is shown")
        finally: h.gone()

    def test_a_programs_source_is_written_only_when_asked(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x1', [hole('header', 'x-sig', (2, {'op': 'program', 'source': SOURCE}))])])))
            r = W.Reader([h.dir])
            self.assertNotIn(SOURCE, W.page(r.state(all_groups=True), live=False))
            self.assertIn(json.dumps(SOURCE)[1:-1], W.page(r.state(all_groups=True, with_source=True), live=False))
        finally: h.gone()


class EachFlagIsARuleReadFromTheFiles(unittest.TestCase):
    def setUp(self): self.h = Home()

    def tearDown(self): self.h.gone()

    def test_a_hole_with_no_way_is_open(self):
        self.h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('query', 'z', open_=True)])])))
        r, = self.h.routes()
        self.assertTrue(holes_of(r)['query z']['open'])
        self.assertEqual(r['counts']['open'], 1)

    def test_an_under_reported_rung_is_flagged(self):
        self.h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('header', 'x-sig', (2, {'op': 'program', 'source': SOURCE}))])])))
        self.h.made(route='r1', ok=True, rung=0, browser=False)
        r, = self.h.routes()
        self.assertEqual(r['floor'], 2)
        self.assertEqual(r['counts']['under'], 1)
        self.assertEqual([f['kind'] for f in r['flags']], ['under'])

    def test_a_rung_at_the_bodys_floor_is_not_flagged(self):
        # A cheaper way (r0) beside a dear one (r2): the body can be filled at r0, and a call at r0 is right.
        self.h.put(a_route(body=a_body([body_step('x1', [hole('header', 'x-sig', (0, {'op': 'cookie', 'name': 'sig'}), (2, {'op': 'program', 'source': SOURCE}))])])))
        self.h.made(route='r1', ok=True, rung=0, browser=False)
        r, = self.h.routes()
        self.assertEqual(r['counts']['under'], 0)

    def test_the_last_call_of_the_route_is_the_one_read(self):
        self.h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2])])])))
        self.h.made(route='r1', ok=False, rung=5, browser=True)
        self.h.made(route='other', ok=True, rung=0, browser=False)
        self.h.made(route='r1', ok=True, rung=0, browser=False)
        r, = self.h.routes()
        self.assertEqual((r['made']['ok'], r['made']['rung'], r['made']['browser']), (True, 0, False))
        self.assertEqual(r['counts']['browser'], 0)

    def test_a_call_where_a_browser_ran_is_flagged(self):
        self.h.put(a_route())
        self.h.made(route='r1', ok=False, rung=5, browser=True)
        r, = self.h.routes()
        self.assertEqual(r['counts']['browser'], 1)

    def test_fixed_text_whose_sightings_moved_is_flagged(self):
        sights = [{'seen': [{'at': {'in': 'header', 'key': 'x-token'}, 'from': 'fixed', 'shape': {'len': n, 'of': 'token'}}]} for n in (18, 22)]
        self.h.put(a_route(body=a_body([body_step('x1', [hole('header', 'x-token', (0, {'op': 'text', 'is': 't_1'}))])], tests=[{'step': 'x1', 'sightings': sights}])))
        r, = self.h.routes()
        self.assertEqual([f['kind'] for f in holes_of(r)['header x-token']['flags']], ['frozen'])

    def test_fixed_text_the_classifier_derives_from_an_earlier_step_is_flagged(self):
        issue = {'exchange': 0, 'method': 'POST', 'url': 'https://www.shop.example/api/issue', 'status': 200, 'fields': []}
        find = {'exchange': 1, 'method': 'GET', 'url': 'https://www.shop.example/api/find?q=lamps', 'status': 200, 'fields': [
            {'loc': {'in': 'header', 'key': 'x-token'}, 'class': 'derived', 'origin': {'exchange': 0, 'url': 'https://www.shop.example/api/issue', 'at': {'from': 'json', 'pointer': '/token'}}}]}
        self.h.put(a_route(body=a_body([body_step('x1', [hole('header', 'x-token', (0, {'op': 'text', 'is': 't_1'}))])]), graph_steps=[issue, find]))
        r, = self.h.routes()
        f = holes_of(r)['header x-token']['flags']
        self.assertEqual([x['kind'] for x in f], ['frozen'])
        self.assertIn('derived', f[0]['why'])

    def test_a_browsers_own_value_that_moves_is_not_frozen(self):
        sights = [{'seen': [{'at': {'in': 'header', 'key': 'referer'}, 'from': 'browser', 'shape': {'len': n, 'of': 'mixed'}}]} for n in (40, 44)]
        self.h.put(a_route(body=a_body([body_step('x1', [hole('header', 'referer', (0, {'op': 'text', 'is': 'https://www.shop.example/'}))])], tests=[{'step': 'x1', 'sightings': sights}])))
        r, = self.h.routes()
        x = holes_of(r)['header referer']
        self.assertEqual(x['fold'], 'sightings')
        self.assertEqual(x['flags'], [])


class AboveItsRowsCeiling(unittest.TestCase):
    def test_a_call_above_its_rows_ceiling_is_flagged_and_runs_group_by_pid(self):
        tmp = tempfile.mkdtemp()
        try:
            for name, rung in (('unbrowse-test-matrix-plain-100-0', 2), ('unbrowse-test-matrix-signed-own-100-1', 2), ('unbrowse-test-matrix-plain-200-0', 0)):
                d = os.path.join(tmp, name)
                os.makedirs(os.path.join(d, 'routes'))
                with open(os.path.join(d, 'routes', 'r1.json'), 'w') as f: json.dump(a_route(), f)
                with open(os.path.join(d, 'made.jsonl'), 'w') as f: f.write(json.dumps({'route': 'r1', 'ok': True, 'rung': rung, 'browser': False}) + '\n')
            os.utime(os.path.join(tmp, 'unbrowse-test-matrix-plain-200-0', 'routes'), (2e9, 2e9))
            r = W.Reader(matrix=True, tmp=tmp)
            r.rows = {'plain': {'value': 0, 'row': 'plain', 'from': 'test'}, 'signed-own': {'value': 2, 'row': 'signed-own', 'from': 'test'}}
            st = r.state(all_groups=True)
            self.assertEqual([g['key'] for g in st['groups']], ['run:200', 'run:100'], 'one group per run, newest first')
            run = {x['row']: x for x in st['routes']['run:100']}
            self.assertEqual(run['plain']['counts']['ceiling'], 1)
            self.assertEqual(run['signed-own']['counts']['ceiling'], 0)
            self.assertEqual(st['routes']['run:200'][0]['counts']['ceiling'], 0)
        finally: shutil.rmtree(tmp, ignore_errors=True)


class GraphOnlyRoutesDraw(unittest.TestCase):
    def test_graph_only_routes_draw(self):
        h = Home()
        try:
            steps = [{'exchange': 0, 'method': 'GET', 'url': 'https://www.shop.example/session', 'status': 200, 'fields': []},
                     {'exchange': 3, 'method': 'GET', 'url': 'https://www.shop.example/api/find?q=lamps&_=1', 'status': 200, 'fields': [
                         {'loc': {'in': 'query', 'key': 'q'}, 'class': 'input', 'name': 'q', 'secret': False, 'default': 'lamps'},
                         {'loc': {'in': 'query', 'key': 'c'}, 'class': 'derived', 'origin': {'exchange': 0, 'at': {'from': 'json', 'pointer': '/c'}}},
                         {'loc': {'in': 'cookie', 'key': 'sid'}, 'class': 'minted', 'name': 'sid'},
                         {'loc': {'in': 'query', 'key': '_'}, 'class': 'fresh', 'value': '{ms}', 'id': '{ms}', 'clock': 'millis'},
                         {'loc': {'in': 'header', 'key': 'x-sig'}, 'class': 'recipe', 'recipe': {'algo': 'sha256', 'separator': ':', 'parts': [{'part': 'query', 'key': 'q'}]}},
                         {'loc': {'in': 'query', 'key': 'v'}, 'class': 'unconfirmed', 'value': 'abc'},
                         {'loc': {'in': 'header', 'key': 'sec-fetch-mode'}, 'class': 'constant', 'value': 'cors'},
                         {'loc': {'in': 'query', 'key': 'w'}, 'class': 'teleported'}]}]
            h.put(a_route(graph_steps=steps))
            r, = h.routes()
            self.assertEqual(r['by'], 'graph')
            x = holes_of(r)
            layer = lambda p: [l['layer'] for l in x[p]['layers']]
            self.assertEqual(layer('query q'), ['caller'])
            self.assertEqual(layer('query c'), ['answer'])
            self.assertEqual(x['query c']['reads'][0]['n'], 1, 'a derived value is strung to the step its exchange is')
            self.assertEqual(layer('cookie sid'), ['session'])
            self.assertEqual(layer('query _'), ['clock'])
            self.assertEqual(layer('header x-sig'), ['script'])
            self.assertEqual(x['header x-sig']['sent'], ['query q'], 'a recipe reads the holes of its own request')
            self.assertTrue(x['query v']['open'])
            self.assertEqual(x['header sec-fetch-mode']['fold'], 'rule')
            self.assertEqual(layer('query w'), ['unknown'], 'an unknown class is drawn, never dropped')
            self.assertEqual(r['counts']['unknown'], 1)
        finally: h.gone()


class SideBySide(unittest.TestCase):
    def test_a_route_with_a_body_carries_its_graph_to_set_beside_it(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2])])])))
            r, = h.routes()
            self.assertEqual(r['by'], 'body')
            self.assertEqual(r['graph']['by'], 'graph')
            self.assertEqual(holes_of(r['graph'])['query q']['layers'][0]['layer'], 'caller')
        finally: h.gone()


class ThePage(unittest.TestCase):
    def test_the_page_asks_nothing_outside_itself(self):
        page = W.page(None, live=True)
        for outside in ('<link', '<script src', '@import', 'url(http', 'fonts.googleapis', 'cdn.'):
            self.assertNotIn(outside, page)

    def test_it_says_the_pick_lives_in_the_log(self):
        self.assertIn('lives in the pick log', W.page({'groups': [], 'routes': {}}, live=False))


class SnapshotsStayOutOfARepository(unittest.TestCase):
    def test_a_snapshot_is_never_written_into_a_repository(self):
        h = Home()
        inside = os.path.join(HERE, 'wiring-that-must-not-be-written.html')
        try:
            h.put(a_route())
            self.assertEqual(W.main(['render', '--home', h.dir, '--out', inside]), 2)
            self.assertFalse(os.path.exists(inside))
            with open(inside, 'w') as f:  # `render > inside`: stdout is a file in the repository
                out = W.subprocess.run([sys.executable, '-I', os.path.join(HERE, 'wiring.py'), 'render', '--home', h.dir], stdout=f, stderr=W.subprocess.PIPE, text=True)
            self.assertEqual(out.returncode, 2, out.stderr)
            self.assertIn('refusing to write into a repository', out.stderr)
            outside = os.path.join(h.top, 'page.html')
            self.assertEqual(W.main(['render', '--home', h.dir, '--out', outside]), 0)
            self.assertIn('How each route is wired', open(outside).read())
        finally:
            if os.path.exists(inside): os.remove(inside)
            h.gone()


class Live(unittest.TestCase):
    def test_the_server_serves_state_and_its_version_moves_when_a_route_changes(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('header', 'x-sig', (2, {'op': 'program', 'source': SOURCE}))])])))
            W.Handler.reader = W.Reader([h.dir])
            srv = W.http.server.ThreadingHTTPServer(('127.0.0.1', 0), W.Handler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            base = 'http://127.0.0.1:%d' % srv.server_address[1]
            get = lambda p: urllib.request.urlopen(base + p, timeout=10).read().decode()
            try:
                self.assertIn('How each route is wired', get('/'))
                before = json.loads(get('/version'))
                st = json.loads(get('/state'))
                self.assertNotIn(SOURCE, json.dumps(st))
                r = next(iter(st['routes'].values()))[0]
                self.assertEqual(get('/source?' + urllib.parse.urlencode({'route': r['key'], 'step': 0, 'hole': 1, 'way': 0, 'n': 0})), SOURCE)
                h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('header', 'x-sig', (1, {'op': 'hash', 'algo': 'sha256', 'of': {'op': 'sent', 'part': {'of': 'query', 'key': 'q'}}}))])])))
                os.utime(os.path.join(h.dir, 'routes', 'r1.json'), ns=(1, 1))
                self.assertNotEqual(json.loads(get('/version')), before)
                st = json.loads(get('/state'))
                self.assertEqual(holes_of(next(iter(st['routes'].values()))[0])['header x-sig']['rung'], 1)
            finally:
                srv.shutdown()
                srv.server_close()
        finally: h.gone()


if __name__ == '__main__':
    unittest.main()


class CostStripTests(unittest.TestCase):
    """The cost strip: what a home cost, read from the node's own records (names, counts and sizes), against budgets."""

    def test_a_home_over_its_budgets_is_flagged_on_each_field(self):
        home = tempfile.mkdtemp(prefix='cost')
        self.addCleanup(shutil.rmtree, home, True)
        log = os.path.join(home, 'node.log')
        with open(log, 'w') as f:
            f.write('eye {"kind":"started","walk":"w1"}\n' + 'browser {"launched":1,"open":1}\n' * 3)
            f.write('reply {"tool":"unbrowse_do","bytes":18029}\nreply {"tool":"unbrowse_do","bytes":900}\n')
        os.makedirs(os.path.join(home, 'browsers-launched'))
        gone = subprocess_dead_pid()
        with open(os.path.join(home, 'browsers-launched', '1.launch'), 'w') as f:
            json.dump({'owner': gone, 'browser': os.getpid(), 'profile': '/x'}, f)
        made = {'r1': [{'ms': 200}, {'ms': 220}]}
        sent = [{'site': 'shop.example'}] * 4
        c = W.cost_of(home, W.cost_lines(log), made, sent)
        self.assertEqual((c['walks'], c['launches'], c['calls'], c['sent'], c['browsers_left']), (1, 3, 2, 4, 1))
        self.assertEqual(sorted(o['field'] for o in c['over']), ['browsers_left', 'launches_per_walk', 'reply_bytes_max', 'sent_per_call'])

    def test_a_home_within_its_budgets_has_no_flag(self):
        home = tempfile.mkdtemp(prefix='cost')
        self.addCleanup(shutil.rmtree, home, True)
        log = os.path.join(home, 'node.log')
        with open(log, 'w') as f:
            f.write('eye {"kind":"started","walk":"w1"}\nbrowser {"launched":1,"open":1}\nreply {"tool":"unbrowse_do","bytes":900}\n')
        c = W.cost_of(home, W.cost_lines(log), {'r1': [{'ms': 40}]}, [{'site': 'shop.example'}])
        self.assertEqual(c['over'], [])


def subprocess_dead_pid():
    import subprocess
    p = subprocess.Popen(['true'])
    p.wait()
    return p.pid
