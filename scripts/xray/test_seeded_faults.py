"""The x-ray's detectors, tested by planting faults. One clean made-up route raises nothing; each fault the x-ray has a
finding for is planted in it alone, and the x-ray, run as a user runs it (`route-xray.py --json`, with `--log`, `--tree`
or `--walks` where the finding is said by those), must raise that finding and no other. A finding that cannot come
alone (a read of another site's answer is a step on another site) names what it comes with, and why, in COMES_WITH.

Every finding of the catalogue has a seed here: a finding added without one fails `test_every_finding_has_a_seed`.

The site is made up (shop.example); no site is asked and no real route's data is here. Standard library only.

  python3 -I -m unittest discover -s scripts/xray -p 'test_seeded_faults.py' -v
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
sys.path.insert(0, HERE)
_spec = importlib.util.spec_from_file_location('route_xray', os.path.join(HERE, 'route-xray.py'))
X = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(X)

WALKED = 1794616694  # when the made-up route was learned, in seconds
GOAL = 'search products with names and prices'


def clean(word='lamps', rid='clean'):
    """A route with nothing wrong: the caller's word in its own hole, a setting, the session's cookie from the jar, a
    shape for the answer, named fields, a second word heard, a page kept, and calls that passed."""
    return {
        'id': rid, 'site': 'www.shop.example', 'what': GOAL, 'method': 'GET', 'learned_at': WALKED,
        'root': 'https://www.shop.example/find?q=%s' % word,
        'inputs': [{'name': 'q', 'default': word}],
        'heard': {'probed': True, 'said_back': 'chairs'}, 'fields': ['items[].name'],
        'stats': {'calls': 3, 'passed': 3, 'last_error': None},
        'graph': {'page': 'https://www.shop.example/find?q={q}', 'steps': [{
            'exchange': 4, 'method': 'GET', 'status': 200, 'needs_browser': False, 'response_shape': {'items': [{'name': 'string'}]},
            'url': 'https://www.shop.example/find?q={q}&lang=en',
            'fields': [
                {'loc': {'in': 'query', 'key': 'q'}, 'class': 'input', 'name': 'q', 'default': word, 'secret': False},
                {'loc': {'in': 'query', 'key': 'lang'}, 'class': 'constant', 'value': 'en'},
                {'loc': {'in': 'cookie', 'key': 'sid'}, 'class': 'minted', 'name': 'sid'},
            ]}]},
    }


def answer(r):
    return r['graph']['steps'][-1]


def add(r, key, cls, value=None, where='query', **more):
    """A field on the answer's call; a query value is written into its address too, as the engine keeps it."""
    f = {'loc': {'in': where, 'key': key}, 'class': cls}
    if value is not None:
        f['value'] = value
    f.update(more)
    answer(r)['fields'].append(f)
    if where == 'query' and value is not None:
        answer(r)['url'] += '&%s=%s' % (key, value)
    return r


def before(r, exchange, url='https://www.shop.example/', **more):
    """An earlier step, ahead of the answer's call."""
    s = {'exchange': exchange, 'method': 'GET', 'status': 200, 'needs_browser': False, 'url': url, 'fields': []}
    s.update(more)
    r['graph']['steps'].insert(len(r['graph']['steps']) - 1, s)
    return s


def read_of(exchange, frm='json', pointer='/token'):
    return {'exchange': exchange, 'at': {'from': frm, 'pointer': pointer}}


# ---------------------------------------------------------------------------------------------- faults in a route
def _no_input(r):
    r['inputs'] = []
    answer(r)['fields'][0] = {'loc': {'in': 'query', 'key': 'q'}, 'class': 'constant', 'value': 'lamps'}


def _far_tie(r):
    before(r, 7, 'https://ads.other.example/id')
    add(r, 'cat', 'derived', origin=read_of(7, pointer='/id'))


def _off_site(r):
    before(r, 7, 'https://login.other.example/hello', sets_cookie=True)


def _long_chain(r):
    for n in range(3):
        before(r, 10 + n, 'https://www.shop.example/s%d' % n, sets_cookie=True)


def _text_cut(r):
    before(r, 7)
    add(r, 'tok', 'derived', origin=read_of(7, 'text', 'a..b'))


def _header_tie(r):
    before(r, 7)
    add(r, 'x-request-id', 'derived', where='header', origin=read_of(7, pointer='/rid'))


ITEM = '1468513870'


def item_page(r, shape, said_back=None):
    """The route of an item's page (`/p/<id>/`): its call sends the item's id, and answers with `shape`."""
    r.update(root='https://www.shop.example/p/%s/' % ITEM, inputs=[{'name': 'p', 'default': ITEM}], heard=dict({'probed': True}, **({'said_back': said_back} if said_back else {})))
    r['graph']['page'] = 'https://www.shop.example/p/{p}/'
    answer(r).update(url='https://www.shop.example/related?product_id={p}&lang=en', response_shape=shape)
    answer(r)['fields'][0] = {'loc': {'in': 'query', 'key': 'product_id'}, 'class': 'input', 'name': 'p', 'default': ITEM, 'secret': False}
    return r


def landed_page(r, url='https://www.shop.example/item/{id}/oak-desk-lamp', reads_page=True):
    """The route of an item's page asked at `/item/<id>`, whose step reads the page at `url`."""
    r.update(root='https://www.shop.example/item/%s' % ITEM, inputs=[{'name': 'id', 'default': ITEM}])
    r['graph']['page'] = 'https://www.shop.example/item/{id}'
    s = answer(r)
    s.update(url=url, reads_page=reads_page)
    s.pop('response_shape')
    if not reads_page: s['response_shape'] = {'title': 'string'}
    s['fields'] = [{'loc': {'in': 'path', 'key': 1}, 'class': 'input', 'name': 'id', 'default': ITEM, 'secret': False},
                   {'loc': {'in': 'cookie', 'key': 'sid'}, 'class': 'minted', 'name': 'sid'}]
    return r


def _place_name(r):
    r['inputs'].append({'name': 'part0', 'default': 'find'})
    add(r, 'p0', 'input', name='part0', default='find')


# name: (what is planted, the finding it must raise). Each starts from clean().
ROUTE_SEEDS = {
    'frozen-clock': lambda r: add(r, '_', 'constant', str(WALKED * 1000 + 321)),
    'walk-time-inside': lambda r: add(r, 'rid', 'constant', 'req_%d321_x' % WALKED),
    'frozen-date': lambda r: add(r, 'day', 'constant', '2026-11-14'),
    'baked-word': lambda r: add(r, 'ref', 'constant', 'lamps_box'),
    'walked-header': lambda r: add(r, 'referer', 'constant', 'https://www.shop.example/find?q=lamps', where='header'),
    'open': lambda r: add(r, 'v', 'unconfirmed', 'abc12'),
    'looks-minted': lambda r: add(r, 'key', 'constant', '9f36aeafbe60771e321a7cc95a78140772ab3e96'),
    'dangling': lambda r: add(r, 'tok', 'derived', origin=read_of(9)),
    'backwards': lambda r: add(r, 'tok', 'derived', origin=read_of(4)),
    # The origin's place written as a bare pointer, not a record: the reader once stopped here with a traceback.
    'bad-origin': lambda r: add(r, 'tok', 'derived', origin={'exchange': 4, 'at': '/token'}),
    'far-tie': _far_tie,
    'off-site-step': _off_site,
    'dead-step': lambda r: before(r, 7, 'https://www.shop.example/warm'),
    'long-chain': _long_chain,
    'text-cut': _text_cut,
    'header-tie': _header_tie,
    # A session's cookie written into the step as the walk's text, where the jar should fill it.
    'fixed-cookie': lambda r: add(r, 'visitor', 'constant', 'v1.8f3a2c9e41d07b55', where='cookie'),
    # The page is one item's, the call sends its id, and the answer is a list of other records that never names it.
    'related-list': lambda r: item_page(r, {'results': [{'id': 'string', 'title': 'string'}], 'total': 'number'}),
    # The page asked at /item/<id> landed at /item/<id>/<its name>, and the route reads it there with the name fixed.
    'redirected-piece': landed_page,
    'page-made': lambda r: add(r, 'sig', 'computed'),
    'needs-browser': lambda r: answer(r).update(needs_browser=True),
    'post-in-read': lambda r: answer(r).update(method='POST'),
    'refused-when-learned': lambda r: answer(r).update(status=403),
    'no-shape': lambda r: answer(r).pop('response_shape'),
    'place-name': _place_name,
    'no-input': _no_input,
    'no-steps': lambda r: r['graph'].update(steps=[]),
    'deaf': lambda r: r.update(heard={'probed': True, 'deaf': ['q']}),
    'unheard': lambda r: r.pop('heard'),
    'provisional': lambda r: r.update(provisional=True),
    'no-page': lambda r: r['graph'].pop('page'),
    'no-fields': lambda r: r.update(fields=[]),
    'failing': lambda r: r['stats'].update(last_error='step 1 answered 403'),
    'never-called': lambda r: r.update(stats={'calls': 0, 'passed': 0, 'last_error': None}),
}

# Findings that cannot come alone, with what they come with and why.
COMES_WITH = {
    # A read of another site's answer needs a step on that other site, and a step on another site is a note of its own.
    'far-tie': {'off-site-step'},
    # The pick holds none of the goal's fields and the site did not answer a second word: shell-kept is those two at once.
    'shell-kept': {'picked-without-fields', 'kept-unanswered'},
    # A route that took another's place was learned after that route's answer was set aside.
    'replaced-a-route': {'learned-after-set-aside'},
}


def seeded(name, seeds=ROUTE_SEEDS):
    r = clean(rid='seed-' + name)
    seeds[name](r)
    return r


# ---------------------------------------------------------------------------------------------- faults in a learn's log
def eye(**e):
    return 'eye ' + json.dumps(e)


# What a walk's door took, as the node logs it (`Eye::Door`): the refused page and a check's call beside it.
DOOR = dict(took=3, assets=1, calls=[{'index': 0, 'method': 'GET', 'host': 'www.shop.example', 'path': '/find', 'why': 'refused', 'by': 0},
                                      {'index': 1, 'method': 'POST', 'host': 'www.shop.example', 'path': '/.check/ping', 'why': 'refused', 'by': 0}])


def learn(walk, route, goal=GOAL, scores=(9,), picked=1, reasons=('its answer holds 40 records with prices',), after=(), door=None):
    """One learn as the node logs it: the walk began, its candidates were scored, one was picked and its route saved."""
    return [eye(kind='started', walk=walk, url='https://www.shop.example/find?q=lamps', goal=goal, agent='t')] + (
        [eye(kind='door', walk=walk, **door)] if door else []) + [
            eye(kind='scored', walk=walk, candidates=[{'index': n + 1, 'score': s, 'method': 'GET', 'host': 'www.shop.example', 'path': '/find'} for n, s in enumerate(scores)]),
            eye(kind='picked', walk=walk, index=picked, method='GET', host='www.shop.example', path='/find', by='the rule', reasons=list(reasons))] + list(after) + [
            eye(kind='saved', walk=walk, route=route, what=goal, site='www.shop.example', steps=1, inputs=['q'])]


NONE_OF_THE_FIELDS = "its answer holds none of the goal's fields"
UNANSWERED = '[links] the site did not answer it for a second word'
SET_ASIDE = "[goal] GET www.shop.example was called and its answer not taken: its answer doesn't hold what this goal asks for"

# name: the log's lines, ending with the learn that saved the route `r`.
LOG_SEEDS = {
    'picked-below-top': learn('w1', 'r', scores=(5, 9), picked=1),
    'door-took-calls': learn('w1', 'r', door=DOOR),
    'picked-without-fields': learn('w1', 'r', reasons=(NONE_OF_THE_FIELDS,)),
    'connection-as-refusal': learn('w1', 'r', after=('[call] GET www.shop.example/find error sending request', '[links] the second word was not kept')),
    'kept-unanswered': learn('w1', 'r', after=(UNANSWERED,)),
    'shell-kept': learn('w1', 'r', reasons=(NONE_OF_THE_FIELDS,), after=(UNANSWERED,)),
    'second-walk-elsewhere': learn('w1', 'r', after=('[trial] the word offered led to another page',)),
    # A route of another goal was called and its answer set aside, and this learn followed.
    'learned-after-set-aside': learn('w0', 'r0', goal='list the shop opening hours') + [SET_ASIDE] + learn('w1', 'r'),
    # The route of this goal was called, its answer set aside, and the route this learn kept is no longer beside it.
    'replaced-a-route': learn('w0', 'r-gone') + [SET_ASIDE] + learn('w1', 'r'),
}

# name: the log's lines for a learn that kept no route: its findings are the pick's, with no route to sit on.
PICK_SEEDS = {
    'browser-flow-landing': [eye(kind='started', walk='w8', url='https://www.shop.example', goal=GOAL, agent='t'),
                             eye(kind='failed', walk='w8', error='the captured navigation did not reach the requested page (3 exchanges, main document statuses [200, 404])')],
    # The door took the walk's calls before any was scored, and the learn kept nothing (hn.algolia.com on staging
    # c1907d01b: a shell read as a check, every call taken, "a check asks a person").
    'door-took-the-walk': [eye(kind='started', walk='w9', url='https://www.shop.example/find?q=lamps', goal=GOAL, agent='t'),
                           eye(kind='door', walk='w9', **DOOR), eye(kind='scored', walk='w9', exchanges=4, candidates=[]),
                           eye(kind='failed', walk='w9', error='loading the page sends no call that answers the goal: it needs clicks or typing')],
}

# ---------------------------------------------------------------------------------------------- faults in the tree
TREE_SEEDS = {
    'tree-refused': {'refused': 'step x3 reads step x5, which runs after it'},
    'tree-unsaid': {'unsaid': 'query q: the graph said input, the tree says text'},
}


# ---------------------------------------------------------------------------------------------- faults in kept walks
def walks(**kept):
    """Two kept walks as the rebuild's learner reads them: the call kept at x0, made again by the second walk, and the
    route the learner writes answering from that call."""
    step = {'id': 'x0', 'method': 'GET', 'url': 'https://www.shop.example/find', 'holes': []}
    line = {'site': 'www.shop.example',
            'kept': {'at': 0, 'second_walk_made_it': True, 'holes': []},
            'learned': {'body': {'site': 'www.shop.example', 'steps': [step], 'slots': [], 'answer': {'step': 'x0'}}}}
    line['kept'].update(kept)
    return line


def _unsettled():
    line = walks()
    line['learned'] = {'unlearned': 'no reply says the value back on both walks'}
    return line


def _picked_another():
    line = walks()
    line['learned']['body']['steps'].append({'id': 'x2', 'method': 'GET', 'url': 'https://www.shop.example/more', 'holes': []})
    line['learned']['body']['answer'] = {'step': 'x2'}
    return line


WALK_SEEDS = {
    'unsettled': _unsettled,
    'second-walk-missed': lambda: walks(second_walk_made_it=False),
    'picked-another': _picked_another,
    'one-walk-tie': lambda: walks(holes=[{'at': {'in': 'query', 'key': 'cat'}, 'kind': 'Fixed', 'tied': True}]),
}


# ---------------------------------------------------------------------------------------------- the x-ray, as run
def run_xray(*args):
    out = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'route-xray.py')] + list(args) + ['--json'], capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        raise AssertionError('route-xray.py failed:\n' + out.stderr)
    return json.loads(out.stdout)


def ids(x):
    return {f['id'] for f in x['findings']}


class Seeded(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='seeded')
        self.addCleanup(shutil.rmtree, self.dir, True)

    def routes(self, *rs):
        d = tempfile.mkdtemp(dir=self.dir)
        for r in rs:
            with open(os.path.join(d, r['id'] + '.json'), 'w') as f:
                json.dump(r, f)
        return d

    def file(self, name, lines):
        p = os.path.join(self.dir, name)
        with open(p, 'w') as f:
            f.write('\n'.join(json.dumps(l) if isinstance(l, dict) else l for l in lines) + '\n')
        return p

    def wanted(self, name):
        return {name} | COMES_WITH.get(name, set())


class ACleanRouteRaisesNothing(Seeded):
    def test_the_clean_route_raises_no_finding(self):
        got = run_xray(self.routes(clean()))['routes']
        self.assertEqual([ids(x) for x in got], [set()])

    def test_a_clean_learn_a_clean_tree_and_clean_walks_raise_nothing(self):
        d = self.routes(clean(rid='r'))
        log = self.file('node.log', learn('w1', 'r'))
        tree = self.file('tree.jsonl', [{'file': 'r.json', 'body': {'steps': [], 'slots': []}}])
        got = run_xray(d, '--log', log, '--tree', tree)['routes']
        self.assertEqual([ids(x) for x in got], [set()])
        self.assertEqual([ids(x) for x in run_xray('--walks', self.file('walks.jsonl', [walks()]))['walks']], [set()])


class EachFaultRaisesItsFindingAlone(Seeded):
    def test_each_fault_planted_in_a_route_raises_its_finding_and_no_other(self):
        got = {x['id']: ids(x) for x in run_xray(self.routes(*[seeded(n) for n in ROUTE_SEEDS]))['routes']}
        for name in ROUTE_SEEDS:
            with self.subTest(finding=name):
                self.assertEqual(got['seed-' + name], self.wanted(name))

    def test_each_fault_in_a_learns_log_raises_its_finding_and_no_other(self):
        for name, lines in LOG_SEEDS.items():
            with self.subTest(finding=name):
                d = self.routes(clean(rid='r'))
                got = run_xray(d, '--log', self.file(name + '.log', lines))['routes']
                self.assertEqual([ids(x) for x in got], [self.wanted(name)])

    def test_each_fault_in_a_learn_that_kept_nothing_raises_its_finding_and_no_other(self):
        import xray_log as G
        details = {'door-took-the-walk': '2 refused', 'browser-flow-landing': 'main document statuses [200, 404]'}
        for name, lines in PICK_SEEDS.items():
            with self.subTest(finding=name):
                learned, = G.read(self.file(name + '.log', lines))
                self.assertEqual([f for f, _ in G.findings(learned)], [name])
                self.assertIn(details[name], dict(G.findings(learned))[name])

    def test_each_fault_the_tree_says_raises_its_finding_and_no_other(self):
        for name, said in TREE_SEEDS.items():
            with self.subTest(finding=name):
                d = self.routes(clean(rid='r'))
                tree = self.file(name + '.jsonl', [dict({'file': 'r.json', 'body': {'steps': [], 'slots': []}}, **said)])
                got = run_xray(d, '--tree', tree)['routes']
                self.assertEqual([ids(x) for x in got], [self.wanted(name)])

    def test_each_fault_in_kept_walks_raises_its_finding_and_no_other(self):
        for name, line in WALK_SEEDS.items():
            with self.subTest(finding=name):
                got = run_xray('--walks', self.file(name + '.jsonl', [line()]))['walks']
                self.assertEqual([ids(x) for x in got], [self.wanted(name)])


class ACookieAsFixedText(Seeded):
    def test_a_cookie_header_kept_whole_is_a_fixed_cookie_and_settings_are_not(self):
        header = lambda v: add(clean(rid='h%d' % len(v)), 'cookie', 'constant', v, where='header')
        rs = [header('sid=Zk3Qm9Lx2Pv7Rt8Ws4Yb6Nc1; lang=en'), header('lang=en; cur=SGD; seen=1'),
              add(clean(rid='setting'), 'currency', 'constant', 'SGD', where='cookie'),
              add(clean(rid='jar'), 'visitor', 'minted', name='visitor', where='cookie')]
        got = {x['id']: ids(x) for x in run_xray(self.routes(*rs))['routes']}
        self.assertEqual(got[rs[0]['id']], {'fixed-cookie'}, "a session's value inside a Cookie header kept as text")
        self.assertEqual(got[rs[1]['id']], set(), 'a Cookie header of settings only')
        self.assertEqual(got['setting'], set(), 'a cookie that is a setting the page wrote')
        self.assertEqual(got['jar'], set(), 'a cookie the jar fills')


class ARelatedListPickedAsTheAnswer(Seeded):
    def test_the_items_own_answer_is_not_a_related_list(self):
        rs = [item_page(clean(rid='detail'), {'product': {'id': 'string', 'title': 'string'}, 'related': [{'id': 'string'}]}),
              item_page(clean(rid='names-it'), {'results': [{'product_id': 'string', 'title': 'string'}]}),
              item_page(clean(rid='said-back'), {'results': [{'id': 'string'}]}, said_back='1468513871'),
              item_page(clean(rid='nested'), {'data': {'items': [{'id': 'string'}]}})]
        got = {x['id']: ids(x) for x in run_xray(self.routes(*rs))['routes']}
        self.assertEqual(got['detail'], set(), 'an answer with a record of its own beside the list is the item')
        self.assertEqual(got['names-it'], set(), "records that carry the place the page's item is sent at")
        self.assertEqual(got['said-back'], set(), 'a second item was said back')
        self.assertEqual(got['nested'], {'related-list'}, 'a list under one key that holds only it')

    def test_a_search_answered_with_a_list_is_not_a_related_list(self):
        r = clean(rid='search')
        r['heard'] = {'probed': True}
        self.assertEqual([ids(x) for x in run_xray(self.routes(r))['routes']], [set()], 'the page asked for a word, not one item')


class ARedirectedPieceKeptAsFixedText(Seeded):
    def test_a_page_read_where_it_was_asked_or_a_call_beside_it_is_not_a_redirected_piece(self):
        rs = [landed_page(clean(rid='as-asked'), 'https://www.shop.example/item/{id}'),
              landed_page(clean(rid='api'), 'https://www.shop.example/item/{id}/reviews', reads_page=False),
              landed_page(clean(rid='query'), 'https://www.shop.example/item/{id}?variant=7')]
        got = {x['id']: {(f['id'], f['at']) for f in x['findings']} for x in run_xray(self.routes(*rs))['routes']}
        self.assertEqual(got['as-asked'], set(), 'the page read at the address it was asked at')
        self.assertEqual(got['api'], set(), 'a call of its own beside the page is not the page moved')
        self.assertEqual(got['query'], {('redirected-piece', 'query:variant')}, 'a query key the site added')

    def test_the_piece_is_said_by_its_place_never_its_text(self):
        x = run_xray(self.routes(seeded('redirected-piece')))['routes'][0]
        self.assertEqual([(f['id'], f['at']) for f in x['findings']], [('redirected-piece', 'path piece 2')])
        self.assertNotIn('oak-desk-lamp', json.dumps(x['findings']))


class AMalformedOriginIsAFindingNotACrash(Seeded):
    MALFORMED = {
        'its place a bare pointer': {'exchange': 4, 'at': '/token'},
        'the origin a string': '/token',
        'the origin a list': [4, '/token'],
        'its step a string': {'exchange': 'x4', 'at': {'from': 'json', 'pointer': '/token'}},
    }

    def test_each_malformed_origin_is_read_as_bad_origin_beside_the_routes_around_it(self):
        rs = [clean(rid='before')]
        for n, (why, origin) in enumerate(self.MALFORMED.items()):
            rs.append(add(clean(rid='bad%d' % n), 'tok', 'derived', origin=origin))
        rs.append(clean(rid='after'))
        got = {x['id']: ids(x) for x in run_xray(self.routes(*rs))['routes']}
        self.assertEqual(got.pop('before'), set())
        self.assertEqual(got.pop('after'), set(), 'the routes after a malformed one are still read')
        for n, why in enumerate(self.MALFORMED):
            with self.subTest(origin=why):
                self.assertEqual(got['bad%d' % n], {'bad-origin'})

    def test_the_text_and_the_pages_read_it_too(self):
        d = self.routes(seeded('bad-origin'))
        out = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'route-xray.py'), d, '--text'], capture_output=True, text=True, timeout=300)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn(X.CATALOGUE['bad-origin'][1], out.stdout)
        pages = tempfile.mkdtemp(dir=self.dir)
        out = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'route-xray.py'), d, '--out', pages], capture_output=True, text=True, timeout=300)
        self.assertEqual(out.returncode, 0, out.stderr)
        with open(os.path.join(pages, 'seed-bad-origin.html')) as f:
            self.assertNotIn('/token', f.read(), 'the origin is said by its shape')


# ---------------------------------------------------------------------------------------------- the cost strip
def a_dead_pid():
    p = subprocess.Popen(['true'])
    p.wait()
    return p.pid


def a_home(walks=1, launches=1, calls=1, sent=1, reply=900, left=0):
    """A node's home as it keeps its records: routes, the node's log (walks begun, browsers launched, replies' sizes),
    made.jsonl (calls), sent.jsonl (requests sent) and the browsers it launched. Names, counts and sizes only."""
    home = tempfile.mkdtemp(prefix='cost')
    os.makedirs(os.path.join(home, 'routes'))
    with open(os.path.join(home, 'routes', 'r1.json'), 'w') as f:
        json.dump(clean(rid='r1'), f)
    log = os.path.join(home, 'node.log')
    with open(log, 'w') as f:
        f.write('eye {"kind":"started","walk":"w1"}\n' * walks + 'browser {"launched":1,"open":1}\n' * launches + 'reply {"tool":"unbrowse_do","bytes":%d}\n' % reply)
    with open(os.path.join(home, 'made.jsonl'), 'w') as f:
        f.write(''.join(json.dumps({'route': 'r1', 'ok': True, 'ms': 40}) + '\n' for _ in range(calls)))
    with open(os.path.join(home, 'sent.jsonl'), 'w') as f:
        f.write(''.join(json.dumps({'site': 'shop.example', 'method': 'GET'}) + '\n' for _ in range(sent)))
    rdir = os.path.join(home, 'browsers-launched')
    os.makedirs(rdir)
    # A browser whose node still runs is not left behind; one whose node is gone and that still runs is.
    with open(os.path.join(rdir, 'alive.launch'), 'w') as f:
        json.dump({'owner': os.getpid(), 'browser': os.getpid(), 'profile': '/p'}, f)
    for n in range(left):
        with open(os.path.join(rdir, 'left%d.launch' % n), 'w') as f:
            json.dump({'owner': a_dead_pid(), 'browser': os.getpid(), 'profile': '/p'}, f)
    return home, log


# Each budget flag of the strip, and the home that goes over it alone.
COST_SEEDS = {
    'browsers_left': dict(left=1),
    'launches_per_walk': dict(launches=2),
    'sent_per_call': dict(sent=2),
    'reply_bytes_max': dict(reply=12001),
}


class TheCostStripFlagsEachBudgetAlone(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import wiring
        cls.W = wiring

    def over(self, **seed):
        home, log = a_home(**seed)
        self.addCleanup(shutil.rmtree, home, True)
        reader = self.W.Reader(homes=[home], log=log)
        (group,) = reader.groups()
        (cost,) = reader.cost(group)
        return sorted(o['field'] for o in cost['over'])

    def test_a_clean_home_raises_no_flag(self):
        self.assertEqual(self.over(), [])

    def test_each_budget_flag_fires_alone_on_the_home_over_it(self):
        for field, seed in COST_SEEDS.items():
            with self.subTest(flag=field):
                self.assertEqual(self.over(**seed), [field])

    def test_at_its_budget_a_home_is_not_flagged(self):
        b = {k: v[0] for k, v in self.W.COST_BUDGETS.items()}
        self.assertEqual(self.over(reply=b['reply_bytes_max']), [])

    def test_every_budget_has_a_seed(self):
        self.assertEqual(sorted(self.W.COST_BUDGETS), sorted(COST_SEEDS), 'a budget of the cost strip with no planted fault: add one here')


class EveryFindingHasASeed(unittest.TestCase):
    def test_every_finding_has_a_seed(self):
        seeded_ids = set(ROUTE_SEEDS) | set(LOG_SEEDS) | set(PICK_SEEDS) | set(TREE_SEEDS) | set(WALK_SEEDS)
        self.assertEqual(sorted(set(X.CATALOGUE) - seeded_ids), [], 'a finding with no planted fault: add one here')
        self.assertEqual(sorted(seeded_ids - set(X.CATALOGUE)), [], 'a seed for a finding the catalogue no longer has')

    def test_every_finding_has_a_why(self):
        import xray_why as Y
        self.assertEqual(sorted(set(X.CATALOGUE) - set(Y.WHY)), [], 'a finding WHY does not point at the engine for')


if __name__ == '__main__':
    unittest.main()
