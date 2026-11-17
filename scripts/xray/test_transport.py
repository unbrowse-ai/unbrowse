"""Route to transport: what a route's last call put on the wire, beside what the walk's browser sent and what the route
says to send. Every route, capture, log line and sent line here is made up, on shop.example.

  python3 -I -m unittest discover -s scripts/xray -p 'test_*.py' -v
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wiring as W  # noqa: E402
import xray_wire as XW  # noqa: E402
from test_harness import ScratchNode, graph_step, learned, Q_FIELD, TOKEN, WALKED  # noqa: E402

SID = 'sess-Zk3Qm9Lx2Pv7'
CSRF = 'csrf-Q2w8e4r6t1y9u3'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
HINTS = '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"'
URL = 'https://www.shop.example/api/find?q=lamps'


def header(name, cls='constant', **kw):
    return dict({'loc': {'in': 'header', 'key': name}, 'class': cls}, **kw)


def cookie(name, cls='minted', **kw):
    return dict({'loc': {'in': 'cookie', 'key': name}, 'class': cls, 'name': name}, **kw)


def walk_lines(extra, page=None, status=200, sorted_=True, more=()):
    """A walk: the document (the browser's own headers), then the call, with Chrome's wire headers for it."""
    doc = {'type': 'request', 't': 1, 'requestId': 'd1', 'method': 'GET', 'url': 'https://www.shop.example/find?q=lamps', 'resourceType': 'Document',
           'headers': {'Upgrade-Insecure-Requests': '1', 'User-Agent': UA, 'sec-ch-ua': HINTS}, 'initiator': {'type': 'other'}}
    call = {'type': 'request', 't': 2, 'requestId': 'c1', 'method': 'GET', 'url': URL, 'resourceType': 'Fetch', 'initiator': {'type': 'script'},
            'headers': page if page is not None else {'User-Agent': UA, 'sec-ch-ua': HINTS, 'x-token': TOKEN, 'accept': '*/*'}}
    wire = dict(extra)
    if sorted_: wire = dict(sorted(wire.items()))
    lines = [doc, {'type': 'request_extra', 't': 1, 'requestId': 'd1', 'headers': {':authority': 'www.shop.example', 'accept': 'text/html', 'user-agent': UA}},
             call, {'type': 'request_extra', 't': 2, 'requestId': 'c1', 'headers': wire}, {'type': 'response', 't': 3, 'requestId': 'c1', 'status': status, 'body': '{}'}]
    return lines + list(more)


WIRE = {':authority': 'www.shop.example', ':method': 'GET', ':path': '/api/find?q=lamps', ':scheme': 'https', 'accept': '*/*', 'accept-encoding': 'gzip, deflate, br, zstd',
        'cookie': 'sid=%s; csrf=%s' % (SID, CSRF), 'sec-ch-ua': HINTS, 'user-agent': UA, 'x-token': TOKEN}


class Node(ScratchNode):
    def route(self, fields, rid='r1'):
        r = learned({'id': rid, 'site': 'www.shop.example', 'what': 'search products', 'method': 'GET', 'inputs': [{'name': 'q', 'default': 'lamps'}],
                     'graph': {'steps': [graph_step(0, [Q_FIELD] + fields)]}})
        self.put(r)
        return r

    def learn(self, walk='w1', rid='r1'):
        self.eye(kind='started', walk=walk, url='https://www.shop.example/find?q=lamps', goal='search products')
        self.eye(kind='saved', walk=walk, route=rid, what='search products', site='www.shop.example', steps=1)

    def called(self, ok=True, rid='r1', at=WALKED + 100, ms=400, lines=()):
        self.made(route=rid, site='www.shop.example', ok=ok, rung=0, browser=False, at=at, ms=ms)
        self.say('call ' + json.dumps({'id': 1, 'phase': 'start', 'route': rid, 'at_ms': at * 1000 - ms}), *lines,
                 'call ' + json.dumps({'id': 1, 'phase': 'end', 'route': rid, 'ok': ok, 'ms': ms, 'at_ms': at * 1000}))

    def sent(self, **line):
        with open(os.path.join(self.dir, 'sent.jsonl'), 'a') as f: f.write(json.dumps(dict({'v': 1, 'at_ms': (WALKED + 100) * 1000 - 100, 'exchange': 0, 'method': 'GET', 'host': 'www.shop.example'}, **line)) + '\n')

    def jar(self, items, fp=None):
        d = os.path.join(self.dir, 'jars')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'www.shop.example.json'), 'w') as f: json.dump({'v': 1, 'items': items}, f)
        if fp is not None:
            with open(os.path.join(d, 'www.shop.example.json.fp'), 'w') as f: json.dump({'v': 1, 'items': fp}, f)

    def wire(self):
        r, = [r for rs in self.state(no_engine=True)['routes'].values() for r in rs]
        return r, r['wire']

    def state(self, no_engine=False, **kw):
        return self.reader(**kw).state(all_groups=True)


def kinds(wire, n=1):
    st = next(s for s in wire['steps'] if s['n'] == n)
    return {(d['kind'], d.get('name')) for d in st['diffs']}


class TheThreeColumns(unittest.TestCase):
    def setUp(self):
        self.n = Node()

    def tearDown(self):
        self.n.gone()

    def common(self, fields=None):
        self.n.route(fields if fields is not None else [header('x-token', 'derived', origin={'exchange': 0, 'at': {'from': 'json', 'pointer': '/t'}}), header('accept'), cookie('sid'), cookie('csrf')])
        self.n.learn()
        self.n.capture('w1', walk_lines(WIRE))

    def test_a_sent_line_that_names_the_site_not_the_host_fills_the_call_column(self):
        self.common()
        self.n.called()
        with open(os.path.join(self.n.dir, 'sent.jsonl'), 'a') as f:
            f.write(json.dumps({'v': 1, 'at_ms': (WALKED + 100) * 1000 - 100, 'exchange': 0, 'method': 'GET', 'site': 'shop.example', 'headers': ['accept', 'cookie'], 'lens': [3, 40], 'cookies': ['sid'], 'body': 0, 'proto': 'h2', 'status': 200}) + '\n')
        r, w = self.n.wire()
        self.assertEqual(w['steps'][0]['call']['from'], 'sent.jsonl')

    def test_a_body_step_named_by_the_walks_call_matches_the_line_of_the_graphs_step_that_ran(self):
        # The body names its step by the walk's call (x3); the call ran the graph, whose step numbers the lean trace (0),
        # and the engine's sent line carries that number.
        r = self.n.route([header('accept')])
        r['body'] = {'v': 2, 'site': 'www.shop.example', 'slots': [{'name': 'q', 'example': 'lamps'}], 'answer': {'step': 'x3'},
                     'steps': [{'id': 'x3', 'method': 'GET', 'url': 'https://www.shop.example/api/find', 'expect': 200,
                                'holes': [{'at': {'in': 'query', 'key': 'q'}, 'ways': [{'rung': 0, 'expr': {'op': 'slot', 'name': 'q'}}]}]}]}
        self.n.put(r)
        self.n.learn()
        self.n.capture('w1', walk_lines(WIRE))
        self.n.called()
        self.n.sent(exchange=0, headers=['accept'], lens=[3], cookies=[], body=0, proto='h2', status=200)
        _, w = self.n.wire()
        self.assertEqual(w['steps'][0]['call']['from'], 'sent.jsonl')

    def test_a_header_the_browser_sent_that_the_call_did_not_is_a_difference(self):
        self.common()
        self.n.called()
        self.n.sent(headers=['accept', 'cookie', 'user-agent', 'sec-ch-ua'], lens=[3, 40, 117, 64], cookies=['sid', 'csrf'], proto='h2', status=200)
        r, w = self.n.wire()
        self.assertIn(('missing', 'x-token'), kinds(w))
        st = w['steps'][0]
        self.assertEqual(st['call']['from'], 'sent.jsonl')
        self.assertEqual(st['against'], 'call')

    def test_a_header_the_call_sent_that_the_browser_never_did_is_a_difference(self):
        self.common()
        self.n.called()
        self.n.sent(headers=['accept', 'x-token', 'x-debug', 'cookie', 'user-agent', 'sec-ch-ua', 'accept-encoding'], lens=[3, 18, 4, 40, 117, 64, 23], cookies=['sid', 'csrf'], proto='h2', status=200)
        r, w = self.n.wire()
        self.assertEqual(kinds(w), {('extra', 'x-debug')})

    def test_another_order_counts_only_where_the_capture_keeps_the_order(self):
        names = ['accept', 'accept-encoding', 'cookie', 'sec-ch-ua', 'user-agent', 'x-token']
        self.common()
        self.n.capture('w1', walk_lines(WIRE, more=[{'type': 'request_extra', 't': 4, 'requestId': 'z1', 'headers': {'a': '1', 'b': '1'}}]))
        self.n.called()
        self.n.sent(headers=list(reversed(names)), lens=[1] * 6, cookies=['sid', 'csrf'], proto='h2', status=200)
        r, w = self.n.wire()
        self.assertNotIn(('order', None), kinds(w), 'every wire list of the capture is alphabetical: the order is the capture\'s, not Chrome\'s')
        self.assertTrue(any('order' in m for m in w['not_recorded']))
        # A capture that keeps the order Chrome sent them in.
        unsorted = {k: WIRE[k] for k in [':method', ':authority', ':scheme', ':path', 'x-token', 'sec-ch-ua', 'user-agent', 'accept', 'accept-encoding', 'cookie']}
        more = [{'type': 'request_extra', 't': 4, 'requestId': 'z%d' % i, 'headers': {'b': '1', 'a': '1'}} for i in range(3)]
        self.n.capture('w1', walk_lines(unsorted, sorted_=False, more=more))
        r, w = self.n.wire()
        self.assertIn(('order', None), kinds(w))

    def test_a_cookie_the_browser_carried_that_the_jar_did_not_give_is_a_difference(self):
        self.common([header('x-token', 'derived', origin={'exchange': 0, 'at': {'from': 'json', 'pointer': '/t'}}), header('accept'), cookie('sid')])
        self.n.jar({'sid': SID})
        r, w = self.n.wire()
        self.assertIn(('cookie', 'csrf'), kinds(w))
        self.assertNotIn(('cookie', 'sid'), kinds(w))
        self.assertTrue(any('not recorded' in m or 'what the call sent' in m for m in w['not_recorded']), 'with no record of the call, it is held to the jar and the route, and says so')

    def test_the_protocol_is_read_from_the_wire_and_a_call_on_another_is_a_difference(self):
        self.common()
        self.n.called()
        self.n.sent(headers=['accept', 'x-token', 'cookie', 'user-agent', 'sec-ch-ua', 'accept-encoding'], lens=[1] * 6, cookies=['sid', 'csrf'], proto='h1', status=200)
        r, w = self.n.wire()
        self.assertEqual(w['steps'][0]['browser']['proto'], 'h2 or h3', 'pseudo-headers on the wire say h2 or h3')
        self.assertIn(('proto', None), kinds(w))

    def test_a_value_the_route_fills_that_went_out_empty_is_a_difference(self):
        self.common()
        self.n.called()
        self.n.sent(headers=['accept', 'x-token', 'cookie', 'user-agent', 'sec-ch-ua', 'accept-encoding'], lens=[3, 0, 40, 117, 64, 23], cookies=['sid', 'csrf'], proto='h2', status=200)
        r, w = self.n.wire()
        self.assertIn(('empty', 'x-token'), kinds(w))

    def test_without_a_record_of_the_call_its_column_says_not_recorded_and_points_at_the_engine_addition(self):
        self.common()
        self.n.called()
        r, w = self.n.wire()
        self.assertIsNone(w['steps'][0]['call'])
        self.assertTrue(any('what the call sent' in m and 'UNBROWSE_SENT_LOG' in m for m in w['not_recorded']))

    def test_the_client_hints_the_transport_sends_are_held_to_the_walks_browser(self):
        self.common([header('x-token', 'derived', origin={'exchange': 0, 'at': {'from': 'json', 'pointer': '/t'}}), cookie('sid'), cookie('csrf')])
        self.n.jar({'sid': SID, 'csrf': CSRF}, fp={'ua': UA, 'uaData': {'brands': [{'brand': 'Chromium', 'version': '149'}], 'mobile': False, 'platform': 'macOS'}})
        r, w = self.n.wire()
        self.assertIn(('identity', 'sec-ch-ua'), kinds(w))
        self.assertIn(('identity', 'user-agent'), kinds(w), "the transport makes the user agent agree with the hints it sends (149), so it is not the walk's (157)")


class TheReplyAndTheFlags(unittest.TestCase):
    def setUp(self):
        self.n = Node()

    def tearDown(self):
        self.n.gone()

    def test_a_refused_call_whose_request_differs_from_the_browsers_is_flagged_so(self):
        self.n.route([header('accept'), header('cache-control'), cookie('sid'), cookie('csrf')])
        self.n.learn()
        self.n.capture('w1', walk_lines(WIRE, page={'User-Agent': UA, 'sec-ch-ua': HINTS, 'accept': '*/*'}))
        self.n.called(ok=False, lines=['   [debug] step 0 /api/find -> 403 (a wall): the browser runs it',
                                       '   [debug] the refused request sent ["accept", "cache-control", "cookie", "sec-ch-ua=%s"]' % HINTS.replace('"', '\\"')])
        r, w = self.n.wire()
        self.assertIn(('extra', 'cache-control'), kinds(w))
        self.assertEqual(w['steps'][0]['reply']['reads'], 'refusal')
        self.assertEqual([f['kind'] for f in w['flags']], ['refused-differs'])
        self.assertEqual(r['counts']['refused-differs'], 1)
        self.assertNotIn(('missing', 'user-agent'), kinds(w), 'a record made before the transport lacks what the transport writes itself')

    def test_a_refused_call_whose_request_is_the_browsers_says_the_wall_is_not_about_its_shape(self):
        self.n.route([header('accept'), cookie('sid'), cookie('csrf')])
        self.n.learn()
        self.n.capture('w1', walk_lines(WIRE, page={'User-Agent': UA, 'sec-ch-ua': HINTS, 'accept': '*/*'}))
        self.n.called(ok=False)
        self.n.sent(headers=['accept', 'x-token', 'cookie', 'user-agent', 'sec-ch-ua', 'accept-encoding'], lens=[1] * 6, cookies=['sid', 'csrf'], proto='h2', status=429)
        r, w = self.n.wire()
        self.assertEqual([f['kind'] for f in w['flags']], ['refused-same'])
        self.assertIn('429', w['steps'][0]['reply']['words'])

    def test_the_door_is_said_in_the_engines_words(self):
        self.n.route([header('accept')])
        self.n.learn()
        self.n.capture('w1', walk_lines(WIRE))
        self.n.called(ok=False, lines=["   [call] failed before any heal: step 1 (%s) met the site's door: answered 403" % URL])
        r, w = self.n.wire()
        self.assertEqual(w['steps'][0]['reply']['reads'], 'door')
        self.assertIn("met the site's door", w['steps'][0]['reply']['words'])
        self.assertTrue(w['flags'])
        self.assertNotIn('lamps', json.dumps(w), "the caller's word in the call's words is never written out")

    def test_a_refused_request_the_route_no_longer_names_is_held_to_the_walks_own(self):
        self.n.route([header('accept')])
        self.n.learn()
        self.n.capture('w1', walk_lines(WIRE, more=[{'type': 'request', 't': 5, 'requestId': 'p1', 'method': 'GET', 'url': 'https://www.shop.example/find', 'resourceType': 'Document',
                                                     'headers': {'User-Agent': UA}, 'initiator': {'type': 'other'}},
                                                    {'type': 'request_extra', 't': 5, 'requestId': 'p1', 'headers': {':authority': 'www.shop.example', 'accept': 'text/html', 'user-agent': UA}}]))
        self.n.called(ok=False, lines=['   [debug] step 4 /find -> 403 (a wall): the browser runs it', '   [debug] the refused request sent ["accept", "referer"]'])
        r, w = self.n.wire()
        off = [s for s in w['steps'] if s.get('off_route')]
        self.assertEqual(len(off), 1)
        self.assertIn(('extra', 'referer'), {(d['kind'], d.get('name')) for d in off[0]['diffs']})
        self.assertEqual([f['kind'] for f in w['flags']], ['refused-differs'])

    def test_a_cookie_sent_as_walked_and_a_header_holding_a_cookies_value_are_the_sessions(self):
        self.n.route([header('x-csrf', value=CSRF), cookie('sid', 'constant', value=SID), header('accept', value='*/*')])
        self.n.learn()
        self.n.capture('w1', walk_lines(WIRE))
        r, w = self.n.wire()
        flagged = {h['place'] for s in r['steps'] for h in s['holes'] if any(f['kind'] == 'walked-session' for f in h['flags'])}
        self.assertEqual(flagged, {'cookie sid', 'header x-csrf'})
        self.assertEqual(r['counts']['walked-session'], 2)
        self.assertNotIn('header accept', flagged, 'a fixed value no cookie or jar held is not the session\'s')


class NoValueLeavesTheTransport(unittest.TestCase):
    def test_no_value_of_a_header_a_cookie_or_the_jar_is_in_the_state(self):
        n = Node()
        try:
            n.route([header('x-csrf', value=CSRF), cookie('sid', 'constant', value=SID), header('x-token', 'derived', origin={'exchange': 0, 'at': {'from': 'json', 'pointer': '/t'}})])
            n.learn()
            n.capture('w1', walk_lines(WIRE))
            n.jar({'sid': SID, 'csrf': CSRF}, fp={'ua': UA})
            n.called(ok=False, lines=['   [debug] step 0 /api/find -> 403 (a wall): the browser runs it', '   [debug] the refused request sent ["x-token", "user-agent=%s"]' % UA])
            text = json.dumps(n.state(), ensure_ascii=False)
            for v in (SID, CSRF, TOKEN, UA, HINTS):
                self.assertNotIn(v, text)
        finally: n.gone()


class TheViewStaysLight(unittest.TestCase):
    def test_the_overview_carries_the_flags_counts_and_no_transport_detail(self):
        n = Node()
        try:
            n.route([header('accept'), cookie('sid', 'constant', value=SID)])
            n.learn()
            n.capture('w1', walk_lines(WIRE))
            rd = n.reader()
            ov = rd.overview()
            s, = ov['summaries'][ov['group']]
            self.assertNotIn('wire', s)
            self.assertEqual(ov['totals'][ov['group']]['walked-session'], 1)
            self.assertIn('wire', rd.detail(s['key'])['route'], "an opened route carries its transport")
        finally: n.gone()


class TheEngineInOneClick(unittest.TestCase):
    def test_a_difference_lists_the_engines_functions_that_build_that_part_and_a_name_gone_shows_as_gone(self):
        top = tempfile.mkdtemp()
        src = os.path.join(top, 'unbrowse-node', 'crates', 'learn', 'src')
        os.makedirs(src)
        with open(os.path.join(src, 'http.rs'), 'w') as f:
            f.write('impl ChromeFetch {\n    fn send_once(&mut self) -> u16 {\n        let a = 1;\n        a\n    }\n}\npub fn add_to(h: &mut Vec<u8>) {\n    h.push(1);\n}\n')
        eng = W.Engine(top)
        fs = eng.wire('missing')
        self.assertIn('send_once', [f.get('name') for f in fs])
        self.assertIn('add_to', [f.get('name') for f in fs])
        self.assertTrue(any('gone' in f for f in fs), 'a selector the source no longer has is shown as gone')
        for kind, (_, sels) in XW.KINDS.items():
            self.assertTrue(sels and all('::' in s for s in sels), kind)


class OverTime(unittest.TestCase):
    def test_the_diff_reports_a_call_that_newly_differs_from_its_browser(self):
        a, b = Node(), Node()
        try:
            for n in (a, b):
                n.route([header('x-token', 'derived', origin={'exchange': 0, 'at': {'from': 'json', 'pointer': '/t'}}), header('accept'), cookie('sid'), cookie('csrf')])
                n.learn()
                n.capture('w1', walk_lines(WIRE))
                n.called()
            a.sent(headers=['accept', 'x-token', 'cookie', 'user-agent', 'sec-ch-ua', 'accept-encoding'], lens=[1] * 6, cookies=['sid', 'csrf'], proto='h2', status=200)
            b.sent(headers=['accept', 'cookie', 'user-agent', 'sec-ch-ua', 'accept-encoding'], lens=[1] * 5, cookies=['sid'], proto='h2', status=200)
            lines, breaks = W.diff(a.ub, b.ub)
            out = '\n'.join(lines)
            self.assertIn('+ differs step 1: a header the browser sent that the call did not (x-token)', out)
            self.assertIn('+ differs step 1: a cookie the browser carried that the jar did not give (csrf)', out)
        finally:
            a.gone()
            b.gone()

    def test_xray_sh_state_carries_the_transport_for_agents(self):
        n = Node()
        try:
            n.route([header('accept'), cookie('sid', 'constant', value=SID)])
            n.learn()
            n.capture('w1', walk_lines(WIRE))
            out = subprocess.run(['sh', os.path.join(HERE, 'xray.sh'), 'state', '--no-engine'], env=dict(os.environ, UB_DIR=n.ub, XRAY_REBUILD='no-such-ref', XRAY_OUT=os.path.join(n.top, 'x')),
                                 capture_output=True, text=True, timeout=120)
            r, = [r for rs in json.loads(out.stdout)['routes'].values() for r in rs]
            self.assertEqual(r['wire']['steps'][0]['browser']['from'], 'wire')
            self.assertIn('walked-session', [f['kind'] for f in r['flags']])
        finally: n.gone()


if __name__ == '__main__':
    unittest.main()
