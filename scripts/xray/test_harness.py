"""The harness's own tests: the live view as the one x-ray. Findings from route-xray.py's catalogue sit on the holes they
are about; a click reaches the engine's functions; the pick shows learns that kept nothing; each route's calls; the
evidence that a fixed value moves; route flags that agree with what is drawn; the person layer; the diff over time;
the state as JSON; and the front door. Every route, log and walk here is made up, on shop.example.

  python3 -I -m unittest discover -s scripts/xray -p 'test_*.py' -v
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wiring as W  # noqa: E402
from test_wiring import Home, a_body, a_route, body_step, hole, holes_of, Q  # noqa: E402

WALKED = 1794616694
CLOCK = '1794616694321'          # a time of the walk, sent as walked
TOKEN = 'tok-9f3k2m8q7z1x4b'     # a token the walk's first call handed out
STORED = 'st-Q2w8e4r6t1y9u3'     # a value the page kept in its storage
SECRET = 'hunter2-Zk3Qm9Lx2Pv7'


def text(v):
    return {'op': 'text', 'is': v}


def graph_step(ex, fields, method='GET', url='https://www.shop.example/api/find?q={q}'):
    return {'exchange': ex, 'method': method, 'url': url, 'status': 200, 'needs_browser': False, 'response_shape': {'items': []}, 'fields': fields}


Q_FIELD = {'loc': {'in': 'query', 'key': 'q'}, 'class': 'input', 'name': 'q', 'secret': False, 'default': 'lamps'}


def learned(r):
    r.update({'learned_at': WALKED, 'root': 'https://www.shop.example/find?q=lamps', 'heard': {'probed': True}, 'fields': ['name']})
    r['graph']['page'] = 'https://www.shop.example/find?q=lamps'
    return r


def everything(state):
    return json.dumps(state, ensure_ascii=False)


class ScratchNode(Home):
    """A made-up scratch node: home/node/routes, node.log and tmp/unbrowse-node-walks."""

    def __init__(self):
        self.top = tempfile.mkdtemp()
        self.ub = os.path.join(self.top, 'ub')
        self.dir = os.path.join(self.ub, 'home', 'node')
        os.makedirs(os.path.join(self.dir, 'routes'))
        self.walks = os.path.join(self.ub, 'tmp', 'unbrowse-node-walks')
        os.makedirs(self.walks)
        self.log = os.path.join(self.ub, 'node.log')

    def say(self, *lines):
        with open(self.log, 'a') as f:
            for l in lines: f.write((json.dumps(l) if isinstance(l, dict) else l) + '\n')

    def eye(self, **e):
        self.say('eye ' + json.dumps(e))

    def capture(self, walk, lines):
        with open(os.path.join(self.walks, 'learn_%s.jsonl' % walk), 'w') as f:
            for l in lines: f.write(json.dumps(l) + '\n')

    def reader(self, **kw):
        return W.Reader([self.dir], log=self.log, captures=self.walks, **kw)

    def state(self, **kw):
        return self.reader(**kw).state(all_groups=True)


def request(rid, t, url, method='GET', kind='XHR', context='page', initiator=None, headers=None):
    return {'type': 'request', 't': t, 'requestId': rid, 'method': method, 'url': url, 'headers': headers or {}, 'resourceType': kind, 'frameId': 'F-' + context, 'context': context,
            'initiator': initiator or {'type': 'script'}}


class FindingsSitOnTheirHoles(unittest.TestCase):
    def test_a_finding_of_the_catalogue_is_drawn_on_its_hole_in_its_own_words(self):
        h = Home()
        try:
            r = learned(a_route(graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'query', 'key': '_'}, 'class': 'constant', 'value': CLOCK}])]))
            h.put(r)
            m, = h.routes()
            x = W.X.xray(r)
            f, = holes_of(m)['query _']['findings']
            self.assertEqual(f['id'], 'frozen-clock')
            self.assertEqual(f['title'], W.X.CATALOGUE['frozen-clock'][1])
            self.assertEqual(m['found'], x['counts'], 'counted at the top as route-xray counts them, each drawn once')
            self.assertNotIn(CLOCK, everything(h.state()))
        finally: h.gone()

    def test_a_finding_on_a_body_route_lands_on_the_same_place_of_the_same_call(self):
        h = Home()
        try:
            body = a_body([body_step('x0', [hole(*Q[:2], Q[2]), hole('query', '_', (0, text(CLOCK)))], url='https://www.shop.example/api/find?q={q}')])
            h.put(learned(a_route(body=body, graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'query', 'key': '_'}, 'class': 'constant', 'value': CLOCK}])])))
            m, = h.routes()
            self.assertEqual(m['by'], 'body')
            self.assertEqual([f['id'] for f in holes_of(m)['query _']['findings']], ['frozen-clock'])
        finally: h.gone()

    def test_where_a_flag_and_a_finding_say_the_same_thing_one_is_kept(self):
        h = Home()
        try:
            h.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'query', 'key': 'sid'}, 'class': 'unconfirmed', 'value': 'Zk3Qm9Lx2Pv7Rt8Ws4Yb6Nc1'}])])))
            m, = h.routes()
            x = holes_of(m)['query sid']
            self.assertEqual([f['kind'] for f in x['flags']], [], 'the open flag folds into the open finding')
            self.assertIn('open', [f['id'] for f in x['findings']])
            self.assertTrue(any(f.get('also') for f in x['findings']), "the finding says the flag's evidence")
            self.assertEqual(m['counts']['open'], 0)
        finally: h.gone()

    def test_a_finding_about_the_learn_comes_from_the_log_through_route_xray(self):
        n = ScratchNode()
        try:
            n.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD])])))
            n.eye(kind='started', walk='w1', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='scored', walk='w1', exchanges=3, candidates=[{'index': 0, 'method': 'GET', 'host': 'www.shop.example', 'path': '/api/find', 'score': 9.0}])
            n.eye(kind='picked', walk='w1', index=0, by='the rule', reasons=["its answer holds none of the goal's fields (0 records)"])
            n.eye(kind='saved', walk='w1', route='r1', site='www.shop.example', steps=1, inputs=['q'])
            m, = n.routes()
            self.assertIn('picked-without-fields', [f['id'] for f in m['findings']])
        finally: n.gone()


class NoValueInAFinding(unittest.TestCase):
    def test_a_word_the_site_was_deaf_to_is_said_by_its_input_never_written_out(self):
        h = Home()
        try:
            r = learned(a_route(graph_steps=[graph_step(0, [Q_FIELD])]))
            r['heard'] = {'probed': True, 'deaf': ['lamps']}
            h.put(r)
            m, = h.routes()
            f, = [f for f in m['findings'] if f['id'] == 'deaf']
            self.assertEqual(f['more'], '‹word›, the walked value of input q')
            self.assertNotIn('lamps', f['more'])
        finally: h.gone()


    def test_the_callers_walked_word_is_written_as_a_word_never_as_itself(self):
        h = Home()
        try:
            hl = hole('header', 'referer', (0, text('https://www.shop.example/find?q=lamps')))
            h.put(a_route(body=a_body([body_step('x0', [hole(*Q[:2], Q[2]), hl])])))
            st = everything(h.state())
            self.assertNotIn('lamps', st)
            self.assertIn('walked \\"‹word›\\"', st)
        finally: h.gone()


class FromAHoleToTheEngine(unittest.TestCase):
    def tree(self, top, fn='made_fresh'):
        src = os.path.join(top, 'unbrowse-node', 'crates', 'learn', 'src')
        os.makedirs(src, exist_ok=True)
        with open(os.path.join(src, 'graph.rs'), 'w') as f:
            f.write('pub enum Class { Fresh, Constant }\nfn %s(x: u8) -> Class { Class::Fresh }\nfn branch(c: Class) -> bool { match c { Class::Fresh => true, _ => false } }\n'
                    'fn caller() { let _ = %s(1); }\n' % (fn, fn))

    def test_a_hole_lists_the_functions_that_write_its_kind_and_branch_on_it_read_from_the_checkout_as_it_stands(self):
        h, top = Home(), tempfile.mkdtemp()
        try:
            self.tree(top)
            h.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'query', 'key': 'id'}, 'class': 'fresh', 'clock': 'ms'}])])))
            eng = W.Engine(top)
            st = W.Reader([h.dir], engine=eng).state(all_groups=True)
            k = st['engine']['kinds']['Class::Fresh']['running']
            self.assertEqual([f['name'] for f in k['writes']], ['made_fresh'])
            self.assertEqual(k['writes'][0]['callers'], ['caller'])
            self.assertEqual([f['name'] for f in k['reads']], ['branch'])
            self.assertEqual(k['writes'][0]['file'], 'graph.rs')
            self.tree(top, 'made_anew')  # an uncommitted edit: read again, never from memory
            k = W.Reader([h.dir], engine=eng).state(all_groups=True)['engine']['kinds']['Class::Fresh']['running']
            self.assertEqual([f['name'] for f in k['writes']], ['made_anew'])
        finally:
            h.gone()
            shutil.rmtree(top, ignore_errors=True)

    def test_a_finding_carries_whys_line_resolved_against_the_source(self):
        h, top = Home(), tempfile.mkdtemp()
        try:
            self.tree(top)
            h.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'query', 'key': '_'}, 'class': 'constant', 'value': CLOCK}])])))
            st = W.Reader([h.dir], engine=W.Engine(top)).state(all_groups=True)
            w = st['engine']['why']['frozen-clock|constant']
            self.assertEqual(w['tree'], W.Y.WHY['frozen-clock']['tree'])
            self.assertIn('made_fresh', [f.get('name') for f in w['missed']], 'who would have strung it: the writers of Class::Fresh')
            self.assertTrue(any('gone' in f for f in w['seam']), 'a function WHY names that the source lacks is said to be gone')
        finally:
            h.gone()
            shutil.rmtree(top, ignore_errors=True)


class ThePick(unittest.TestCase):
    def test_a_learn_that_kept_no_route_shows_its_candidates_and_its_reason(self):
        n = ScratchNode()
        try:
            n.eye(kind='started', walk='w2', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='seen', walk='w2', n=1, method='GET', host='www.shop.example', path='/find', status=200, bytes=900, sort='page')
            n.eye(kind='scored', walk='w2', exchanges=4, candidates=[{'index': 1, 'method': 'GET', 'host': 'www.shop.example', 'path': '/find', 'score': 3.1}])
            n.say('   [held] GET www.shop.example /find?q=lamps score 3.1: shapes=true covered=false answers=true fails=a page that says nothing of what was asked nothing=-')
            n.eye(kind='failed', walk='w2', error='loading the page sends no call that answers the goal: it needs clicks or typing')
            p, = n.state()['pick']
            self.assertFalse(p['kept'])
            self.assertIn('needs clicks or typing', p['failed'])
            c, = p['candidates']
            self.assertEqual((c['score'], c['picked']), (3.1, False))
            self.assertIn('says nothing of what was asked', c['held'])
            self.assertNotIn('lamps', everything(p))
        finally: n.gone()

    def test_a_walk_with_no_candidate_at_all_is_said(self):
        n = ScratchNode()
        try:
            n.eye(kind='started', walk='w3', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='scored', walk='w3', exchanges=2, candidates=[])
            n.eye(kind='failed', walk='w3', error='loading the page sends no call that answers the goal: it needs clicks or typing')
            p, = n.state()['pick']
            self.assertIn('no candidate at all', p['outcome'])
        finally: n.gone()

    def test_a_worker_the_page_started_that_never_called_says_the_walk_ended_early(self):
        n = ScratchNode()
        try:
            n.eye(kind='started', walk='w4', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='failed', walk='w4', error='it needs clicks or typing')
            n.capture('w4', [request('1', 1, 'https://www.shop.example/find?q=lamps', kind='Document'),
                             {'type': 'script', 't': 2, 'scriptId': '9', 'url': 'https://www.shop.example/s/worker.js', 'context': 'worker'}])
            p, = n.state()['pick']
            self.assertIn('the walk ended before it called', p['early'])
        finally: n.gone()

    def test_a_frame_of_the_browsers_own_page_is_not_the_pages(self):
        n = ScratchNode()
        try:
            n.eye(kind='started', walk='w5', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='failed', walk='w5', error='it needs clicks or typing')
            n.capture('w5', [request('1', 1, 'https://www.shop.example/find?q=lamps', kind='Document'),
                             request('2', 2, 'https://bar.example/rpc', method='POST', context='iframe', initiator={'type': 'script', 'frames': [{'url': 'chrome-untrusted://new-tab-page/bar'}]})])
            p, = n.state()['pick']
            self.assertNotIn('ended before', p['early'])
            self.assertIn("the browser's own", p['early'])
        finally: n.gone()


class TheCallLog(unittest.TestCase):
    def test_a_route_that_answered_plain_and_now_runs_a_browser_is_flagged(self):
        h = Home()
        try:
            h.put(a_route())
            h.made(route='r1', ok=True, rung=0, browser=False)
            h.made(route='r1', ok=True, rung=5, browser=True)
            m, = h.routes()
            self.assertEqual([c['browser'] for c in m['calls']], [False, True])
            self.assertEqual(m['counts']['fell'], 1)
        finally: h.gone()

    def test_each_step_takes_the_rung_it_ran_at_the_answer_last(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x0', [], url='https://www.shop.example/api/challenge'), body_step('x1', [hole(*Q[:2], Q[2])])])))
            h.made(route='r1', ok=True, rung=1, steps=[0, 1])
            m, = h.routes()
            self.assertEqual([s['ran'] for s in m['steps']], [0, 1])
        finally: h.gone()


class FixedButItMoves(unittest.TestCase):
    def test_a_tied_note_is_evidence(self):
        h = Home()
        try:
            hl = hole('header', 'x-token', (0, text(TOKEN)))
            hl['tied'] = {'step': 'x0', 'at': {'from': 'json', 'pointer': '/token'}}
            h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hl])])))
            m, = h.routes()
            f, = holes_of(m)['header x-token']['flags']
            self.assertEqual(f['kind'], 'frozen')
            self.assertIn('tied to step x0', f['why'])
            self.assertNotIn(TOKEN, everything(h.state()))
        finally: h.gone()

    def test_a_header_on_a_step_after_a_write_the_body_left_out_is_evidence(self):
        h = Home()
        try:
            graph = [graph_step(0, [], method='POST', url='https://www.shop.example/api/issue'),
                     graph_step(1, [Q_FIELD, {'loc': {'in': 'header', 'key': 'x-token'}, 'class': 'constant', 'value': TOKEN}])]
            h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('header', 'x-token', (0, text(TOKEN)))])]), graph_steps=graph))
            m, = h.routes()
            f, = holes_of(m)['header x-token']['flags']
            self.assertIn('follows a write the route left out: POST www.shop.example/api/issue', f['why'])
        finally: h.gone()

    def test_on_one_call_with_none_before_it_kept_a_token_header_is_evidence(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x2', [hole(*Q[:2], Q[2]), hole('header', 'x-token', (0, text(TOKEN))), hole('header', 'accept', (0, text('application/json')))])])))
            m, = h.routes()
            self.assertIn("the walk's call #2", holes_of(m)['header x-token']['flags'][0]['why'])
            self.assertEqual(holes_of(m)['header accept']['flags'], [], 'a media type is not shaped like an id')
        finally: h.gone()

    def test_a_value_an_earlier_reply_or_the_pages_storage_held_is_evidence_by_place_only(self):
        n = ScratchNode()
        try:
            n.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('header', 'x-token', (0, text(TOKEN))), hole('header', 'x-kept', (0, text(STORED)))])])))
            n.eye(kind='started', walk='w6', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='saved', walk='w6', route='r1', site='www.shop.example', steps=1, inputs=['q'])
            n.capture('w6', [request('1', 1, 'https://www.shop.example/api/issue', method='POST'),
                             {'type': 'response', 't': 1.5, 'requestId': '1', 'url': 'https://www.shop.example/api/issue', 'status': 200, 'body': json.dumps({'token': TOKEN})},
                             {'type': 'origin_storage', 't': 1.6, 'local': {'kept': STORED}, 'session': {}},
                             request('2', 2, 'https://www.shop.example/api/find?q=lamps')])
            st = n.state()
            m, = st['routes'].values()
            x = holes_of(m[0])
            self.assertIn('it equals /token of the reply to POST www.shop.example/api/issue, earlier in the walk', x['header x-token']['flags'][0]['why'])
            self.assertIn("the page's local storage held under kept", x['header x-kept']['flags'][0]['why'])
            self.assertNotIn(TOKEN, everything(st))
            self.assertNotIn(STORED, everything(st))
        finally: n.gone()


class WhatIsCountedIsDrawn(unittest.TestCase):
    def test_route_flags_list_every_kind_its_holes_have_and_agree_with_its_counts(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x0', [hole(*Q[:2], Q[2]), hole('query', 'a', open_=True), hole('query', 'b', open_=True)])])))
            m, = h.routes()
            self.assertEqual(m['counts']['open'], 2)
            self.assertEqual([(f['kind'], f['n']) for f in m['flags']], [('open', 2)])
            for k, n in m['counts'].items():
                self.assertEqual(n, sum(f['n'] for f in m['flags'] if f['kind'] == k), k)
        finally: h.gone()

    def test_a_hole_with_two_reasons_to_move_counts_once(self):
        h = Home()
        try:
            hl = hole('header', 'x-token', (0, text(TOKEN)))
            hl['tied'] = {'step': 'x0'}
            graph = [graph_step(0, [], method='POST', url='https://www.shop.example/api/issue'),
                     graph_step(1, [Q_FIELD, {'loc': {'in': 'header', 'key': 'x-token'}, 'class': 'constant', 'value': TOKEN}])]
            h.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hl])]), graph_steps=graph))
            m, = h.routes()
            self.assertEqual(len(holes_of(m)['header x-token']['flags']), 1)
            self.assertEqual(m['counts']['frozen'], 1)
        finally: h.gone()


class TheLayersAndTheFolds(unittest.TestCase):
    def test_a_hole_a_route_marks_with_a_person_is_strung_to_the_person_and_the_legend_says_so(self):
        h = Home()
        try:
            hl = hole('body', 'answer', (5, {'op': 'nothing'}))
            hl['person'] = True
            h.put(a_route(body=a_body([body_step('x0', [hole(*Q[:2], Q[2]), hl])])))
            st = h.state()
            m = [r for rs in st['routes'].values() for r in rs][0]
            self.assertIn('person', [l['layer'] for l in holes_of(m)['body answer']['layers']])
            self.assertEqual(st['legend']['person'], 1)
        finally: h.gone()

    def test_with_the_walk_in_hand_the_browsers_own_headers_are_read_from_it_not_the_list(self):
        n = ScratchNode()
        try:
            n.put(a_route(body=a_body([body_step('x1', [hole(*Q[:2], Q[2]), hole('header', 'x-shell', (0, text('v1'))), hole('header', 'accept-language', (0, text('en')))])])))
            n.eye(kind='started', walk='w7', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='saved', walk='w7', route='r1', site='www.shop.example', steps=1, inputs=['q'])
            n.capture('w7', [request('1', 1, 'https://www.shop.example/find?q=lamps', kind='Document', headers={'x-shell': 'v1', 'user-agent': 'x'})])
            st = n.state()
            m = [r for rs in st['routes'].values() for r in rs][0]
            x = holes_of(m)
            self.assertEqual(x['header x-shell']['fold'], 'walk', 'sent on a navigation, where no page code sets a header')
            self.assertIsNone(x['header accept-language']['fold'], 'the list stands only where the walk does not say')
            self.assertEqual(st['legend']['folds'], {'walk': 1})
        finally: n.gone()

    def test_a_flagged_hole_is_never_folded_away(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x0', [hole(*Q[:2], Q[2]), hole('header', 'sec-fetch-id', (0, text('a')), open_=True)])])))
            m, = h.routes()
            x = holes_of(m)['header sec-fetch-id']
            self.assertTrue(x['flags'])
            with open(os.path.join(HERE, 'wiring.html')) as f: page = f.read()
            self.assertIn('h.fold && !h.flags.length', page, 'the page folds only a hole with no flag and no finding')
        finally: h.gone()


class TheDiff(unittest.TestCase):
    def homes(self):
        a, b = Home('a'), Home('b')
        a.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'header', 'key': 'x-token'}, 'class': 'derived', 'origin': {'exchange': 0, 'at': {'from': 'json', 'pointer': '/t'}}}])])))
        return a, b

    def test_a_hole_whose_source_changed_and_a_new_break_are_listed_and_fail(self):
        a, b = self.homes()
        try:
            b.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'header', 'key': 'x-token'}, 'class': 'constant', 'value': TOKEN},
                                                              {'loc': {'in': 'query', 'key': '_'}, 'class': 'constant', 'value': CLOCK}])])))
            lines, breaks = W.diff(a.dir, b.dir)
            out = '\n'.join(lines)
            self.assertIn('header x-token: source answer -> fixed', out)
            self.assertIn('+ [break] frozen-clock', out)
            self.assertEqual(breaks, 1)
            self.assertNotIn(TOKEN, out)
            self.assertNotIn(CLOCK, out)
            buf = io.StringIO()
            with redirect_stdout(buf): code = W.main(['diff', a.dir, b.dir])
            self.assertEqual(code, 1)
        finally:
            a.gone()
            b.gone()

    def test_routes_gained_and_lost_are_listed_and_no_break_passes(self):
        a, b = self.homes()
        try:
            r = learned(a_route(rid='r2', graph_steps=[graph_step(0, [Q_FIELD])]))
            r['what'] = 'list categories'
            b.put(r)
            lines, breaks = W.diff(a.dir, b.dir)
            self.assertTrue(any(l.startswith('+ route') and 'list categories' in l for l in lines))
            self.assertTrue(any(l.startswith('- route') for l in lines))
            self.assertEqual(breaks, 0)
        finally:
            a.gone()
            b.gone()


class TheStateAsJson(unittest.TestCase):
    def test_state_json_is_what_the_page_draws_with_no_secret(self):
        h = Home()
        try:
            h.put(a_route(body=a_body([body_step('x0', [hole('query', 'pw', (0, {'op': 'slot', 'name': 'pw', 'or': SECRET}))])], slots=({'name': 'pw', 'secret': True, 'example': SECRET},))))
            buf = io.StringIO()
            with redirect_stdout(buf): W.main(['state', '--home', h.dir, '--json', '--no-engine'])
            st = json.loads(buf.getvalue())
            self.assertNotIn(SECRET, buf.getvalue())
            drawn = W.Reader([h.dir]).state(all_groups=True)
            self.assertEqual(list(st['routes'].values())[0][0]['steps'], list(drawn['routes'].values())[0][0]['steps'])
        finally: h.gone()


class TheFrontDoor(unittest.TestCase):
    def test_xray_sh_state_reads_the_scratch_node_in_ub_dir(self):
        n = ScratchNode()
        try:
            n.put(a_route())
            n.eye(kind='started', walk='w8', url='https://www.shop.example/find?q=lamps', goal='search products')
            n.eye(kind='failed', walk='w8', error='it needs clicks or typing')
            out = subprocess.run(['sh', os.path.join(HERE, 'xray.sh'), 'state', '--no-engine'], env=dict(os.environ, UB_DIR=n.ub, XRAY_REBUILD='no-such-ref', XRAY_OUT=os.path.join(n.top, 'x')),
                                 capture_output=True, text=True, timeout=120)
            st = json.loads(out.stdout)
            self.assertEqual(st['log'], n.log)
            self.assertIn('kept no route', st['pick'][0]['outcome'])
            self.assertEqual(len([r for rs in st['routes'].values() for r in rs]), 1)
        finally: n.gone()

    def test_xray_sh_with_no_arguments_serves_the_live_view(self):
        with open(os.path.join(HERE, 'xray.sh')) as f: sh = f.read()
        self.assertRegex(sh, r'""\|serve\)\s*\n(.*\n){0,3}.*wiring\.py" serve')

    def test_xray_sh_diff_fails_on_a_new_break(self):
        a, b = Home('a'), Home('b')
        try:
            a.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD])])))
            b.put(learned(a_route(graph_steps=[graph_step(0, [Q_FIELD, {'loc': {'in': 'query', 'key': '_'}, 'class': 'constant', 'value': CLOCK}])])))
            out = subprocess.run(['sh', os.path.join(HERE, 'xray.sh'), 'diff', a.dir, b.dir], env=dict(os.environ, XRAY_REBUILD='no-such-ref', XRAY_OUT=os.path.join(a.top, 'x')),
                                 capture_output=True, text=True, timeout=120)
            self.assertEqual(out.returncode, 1, out.stderr)
            self.assertIn('frozen-clock', out.stdout)
        finally:
            a.gone()
            b.gone()



# ------------------------------------------------------------------------------------------------ a light page
OVERVIEW_PER_ROUTE = 1500   # bytes: what the page opens on, a line a route, holds no hole
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


def a_big_home(n=300, steps=3, holes=40):
    h = Home()
    for i in range(n):
        st = [body_step('x%d' % k, [hole(*Q[:2], Q[2])] + [hole('header', 'x-h%d' % j, (0, text('v%d' % j))) for j in range(holes)],
                        url='https://www.shop.example/api/s%d?q={q}' % k) for k in range(steps)]
        h.put(a_route(rid='r%03d' % i, body=a_body(st)))
        for _ in range(12): h.made(route='r%03d' % i, ok=True, rung=0, browser=False)
    return h


class TheOverviewIsLight(unittest.TestCase):
    def test_the_overview_of_a_big_home_stays_under_its_stated_size_and_counts_what_the_full_state_counts(self):
        h = a_big_home()
        try:
            rd = W.Reader([h.dir])
            ov = rd.overview()
            size = len(json.dumps(ov, ensure_ascii=False).encode())
            self.assertLess(size, OVERVIEW_PER_ROUTE * 300, 'the overview of 300 routes stays under %d bytes a route' % OVERVIEW_PER_ROUTE)
            full = W.Reader([h.dir]).state(all_groups=True)
            self.assertGreater(len(json.dumps(full)), 10 * size, 'every hole stays on the server until a route is opened')
            sums = {}
            for r in [r for rs in full['routes'].values() for r in rs]:
                for k, v in list(r['counts'].items()) + list(r['found'].items()): sums[k] = sums.get(k, 0) + v
            self.assertEqual(ov['totals'][ov['group']], sums, 'the counts at the top are every hole counted, drawn or not')
            self.assertTrue(all(isinstance(x['holes'], int) for x in ov['summaries'][ov['group']]), 'a summary counts its holes and carries none')
        finally: h.gone()

    def test_an_unchanged_home_is_not_read_again_and_one_changed_route_is_read_alone(self):
        h = a_big_home(n=20)
        try:
            rd = W.Reader([h.dir])
            first = {x['key']: x['sig'] for x in rd.overview()['summaries']['home:' + h.dir]}
            built = rd.built
            again = {x['key']: x['sig'] for x in rd.overview()['summaries']['home:' + h.dir]}
            self.assertEqual(rd.built, built, 'nothing moved: no route is read again')
            self.assertEqual(first, again)
            r = a_route(rid='r007', body=a_body([body_step('x0', [hole(*Q[:2], Q[2]), hole('query', 'z', (0, text('new')))])]))
            h.put(r)
            os.utime(os.path.join(h.dir, 'routes', 'r007.json'), (WALKED + 99, WALKED + 99))
            moved = {x['key']: x['sig'] for x in rd.overview()['summaries']['home:' + h.dir]}
            self.assertEqual(rd.built, built + 1, 'only the route that moved is read again')
            self.assertEqual([k for k in moved if moved[k] != first[k]], [os.path.join(h.dir, 'routes', 'r007.json')])
        finally: h.gone()

    def test_a_routes_detail_is_served_on_its_own_without_empty_fields(self):
        h = a_big_home(n=3)
        try:
            rd = W.Reader([h.dir])
            key = rd.overview()['summaries']['home:' + h.dir][0]['key']
            d = rd.detail(key)['route']
            self.assertEqual(len(d['steps']), 3)
            hl = d['steps'][0]['holes'][1]
            self.assertNotIn('sightings', hl, 'an empty list is left out')
            self.assertNotIn('tree', hl['ways'][0], "a way's tree that only says its line again is left out")
        finally: h.gone()

    @unittest.skipUnless(os.path.exists(CHROME), 'needs Chrome to load the live page')
    def test_the_live_page_fetches_no_route_detail_while_nothing_changes(self):
        import threading, http.server
        h = a_big_home(n=60)
        prof = tempfile.mkdtemp()
        try:
            W.Handler.reader, W.Handler.hits = W.Reader([h.dir]), {}
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), W.Handler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            key = sorted(os.listdir(os.path.join(h.dir, 'routes')))[0]
            url = 'http://127.0.0.1:%d/#view=one&route=%s' % (srv.server_address[1], os.path.join(h.dir, 'routes', key))
            subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--user-data-dir=' + prof, '--virtual-time-budget=9000', '--dump-dom', url], capture_output=True, timeout=120)
            srv.shutdown()
            hits = W.Handler.hits
            self.assertEqual(hits.get('/overview'), 1, hits)
            self.assertEqual(hits.get('/route'), 1, 'the open route is read once, and not again while it does not change: %s' % hits)
            self.assertNotIn('/state', hits, 'the page never asks for every hole: %s' % hits)
            self.assertGreaterEqual(hits.get('/version', 0), 3, 'it keeps polling: %s' % hits)
        finally:
            h.gone()
            shutil.rmtree(prof, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
