"""The graph across routes (route_graph.py): what each route gives and takes, read from its own file, and the edges,
groups, cycles and findings that follow. Made-up routes on shop.example; no site is asked."""
import json, os, sys, tempfile, threading, unittest, urllib.request, http.server

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import route_graph as RG  # noqa: E402
import wiring as W  # noqa: E402

SECRET = 'tok_9f8e7d6c5b4a39281706'
WORD = 'velvetsofa'


def field(loc_in, key, cls, **kw):
    return dict({'loc': {'in': loc_in, 'key': key}, 'class': cls}, **kw)


def step(ex, method, url, fields, **kw):
    return dict({'exchange': ex, 'method': method, 'url': url, 'status': 200, 'fields': fields, 'needs_browser': False}, **kw)


def route(rid, steps, site='www.shop.example', **kw):
    r = {'id': rid, 'site': site, 'what': rid, 'method': steps[-1]['method'], 'path': '/', 'root': 'https://%s/' % site, 'inputs': [], 'steps': len(steps),
         'browser_assisted': False, 'write': False, 'provisional': False, 'learned_at': 0, 'stats': {'calls': 1, 'passed': 1}, 'listing': None, 'yours': True,
         'graph': {'steps': steps, 'provisional': False}}
    r.update(kw)
    return r


def sign_in():
    """A POST that sends a secret and is answered with a session cookie, which its own next step reads."""
    return route('signin', [
        step(0, 'POST', 'https://www.shop.example/api/login', [field('form', 'password', 'input', name='password', secret=True), field('form', 'user', 'input', name='user', default='someone')], sets_cookie=True),
        step(1, 'GET', 'https://www.shop.example/api/me', [field('cookie', 'sid', 'derived', origin={'exchange': 0, 'url': 'https://www.shop.example/api/login', 'at': {'from': 'set_cookie', 'name': 'sid'}})],
             response_shape={'user': {'name': 'string'}, 'orders': ['…']}),
    ])


def orders():
    """A signed-in read: the session's cookie from the jar."""
    return route('orders', [step(0, 'GET', 'https://www.shop.example/api/orders?page=1', [field('cookie', 'sid', 'minted', name='sid'), field('query', 'page', 'input', name='page', default='1')],
                                 response_shape={'items': [{'id': 'number', 'title': 'string'}]})])


def search(rid='search', word=WORD):
    return route(rid, [step(0, 'GET', 'https://api.shop.example/v1/search?q=%s&limit=20' % word, [field('query', 'q', 'input', name='q', default=word), field('query', 'limit', 'constant', value='20'),
                                                                                                    field('cookie', 'visitor', 'minted', name='visitor')])])


def bearer():
    """A read that sends a bearer token it does not make, sent as walked."""
    return route('profile', [step(0, 'GET', 'https://www.shop.example/api/profile', [field('header', 'authorization', 'constant', value='Bearer ' + SECRET)])])


def write_home(d, routes):
    os.makedirs(os.path.join(d, 'routes'), exist_ok=True)
    for r in routes:
        with open(os.path.join(d, 'routes', r['id'] + '.json'), 'w') as f: json.dump(r, f)
    return os.path.join(d, 'routes')


def graph(routes):
    return RG.build([RG.read_route(r, r['id']) for r in routes])


def kinds(g):
    return sorted((e['from'], e['to'], e['kind']) for e in g['edges'])


class Gives(unittest.TestCase):
    def test_a_cookie_a_sign_in_sets_is_a_session_edge_to_the_route_that_takes_it(self):
        g = graph([sign_in(), orders()])
        e = [x for x in g['edges'] if x['to'] == 'orders']
        self.assertEqual([(x['from'], x['kind'], x['names']) for x in e], [('signin', 'session', ['sid'])])
        self.assertEqual(e[0]['evidence'][0]['giver_step'], 1)
        self.assertIs(e[0]['same_jar'], True, "both routes' targets are on one host, and a route's jar is named by its target's host")

    def test_a_cookie_the_routes_own_earlier_step_sets_is_not_a_take(self):
        n = RG.read_route(sign_in(), 'signin')
        self.assertNotIn(('cookie', 'shop.example', 'sid'), [t['thing'] for t in n['takes']])
        self.assertIn(('session', 'shop.example', ''), [x['thing'] for x in n['gives']])

    def test_a_read_that_sets_a_cookie_establishes_no_session(self):
        r = route('page', [step(0, 'GET', 'https://www.shop.example/', [], sets_cookie=True)])
        self.assertNotIn('session', [x['thing'][0] for x in RG.read_route(r, 'page')['gives']])

    def test_hosts_of_one_site_meet_and_another_site_with_the_same_cookie_does_not(self):
        other = orders()
        other['id'], other['site'] = 'elsewhere', 'www.othershop.example'
        other['graph']['steps'][0]['url'] = 'https://www.othershop.example/api/orders'
        g = graph([sign_in(), orders(), other])
        self.assertEqual({e['to'] for e in g['edges'] if e['kind'] in RG.HARD}, {'orders'})

    def test_a_country_second_level_is_read_as_part_of_the_site(self):
        self.assertEqual(RG.site_key('www.shop.co.zz'), 'shop.co.zz')
        self.assertEqual(RG.site_key('api.shop.example'), 'shop.example')


class Findings(unittest.TestCase):
    def test_a_route_that_takes_a_session_nothing_in_the_home_gives_is_found(self):
        g = graph([bearer(), search()])
        self.assertEqual([f['route'] for f in g['findings'] if f['id'] == 'session-ungiven'], ['profile'])
        g = graph([bearer(), sign_in()])
        self.assertEqual([f for f in g['findings'] if f['id'] == 'session-ungiven'], [])
        self.assertIn(('signin', 'profile', 'session'), kinds(g))

    def test_a_route_whose_only_giver_is_failing_is_found(self):
        s = sign_in()
        s['stats'] = {'calls': 3, 'passed': 0, 'last_error': 'the site said no'}
        g = graph([s, orders()])
        self.assertEqual([f['route'] for f in g['findings'] if f['id'] == 'giver-failing'], ['orders'])
        s['stats'], s['provisional'] = {'calls': 1, 'passed': 1}, True
        self.assertEqual([f['route'] for f in graph([s, orders()])['findings'] if f['id'] == 'giver-failing'], ['orders'])
        s['provisional'] = False
        self.assertEqual([f for f in graph([s, orders()])['findings'] if f['id'] == 'giver-failing'], [])

    def test_one_call_several_routes_carry_is_one_group_not_pairs(self):
        g = graph([search('a', 'velvetsofa'), search('b', 'oakdesk'), search('c', 'lamp')])
        self.assertEqual(len(g['same_step']), 1)
        self.assertEqual(g['same_step'][0]['routes'], ['a', 'b', 'c'])
        self.assertEqual(g['edges'], [], 'a group is not drawn as an edge between each pair')
        self.assertEqual(sorted(f['route'] for f in g['findings'] if f['id'] == 'step-duplicated'), ['a', 'b', 'c'])

    def test_another_place_in_the_address_is_another_call(self):
        b = search('b')
        b['graph']['steps'][0]['fields'].append(field('query', 'sort', 'input', name='sort'))
        self.assertEqual(graph([search('a'), b])['same_step'], [])

    def test_routes_signing_with_one_script_are_grouped_by_its_hash(self):
        sha = 'ab' * 32
        def signed(rid):
            r = search(rid)
            r['body'] = {'v': 2, 'site': 'shop.example', 'steps': [{'id': 's', 'method': 'GET', 'url': 'https://api.shop.example/v1/search', 'expect': 200,
                                                                     'holes': [{'at': {'in': 'query', 'key': 'q'}, 'ways': [{'rung': 0, 'expr': {'op': 'slot', 'name': 'q'}}]},
                                                                               {'at': {'in': 'query', 'key': 'sign'}, 'ways': [{'rung': 1, 'expr': {'op': 'hash', 'algo': 'md5', 'of': {'op': 'text', 'is': 'k'}}}]}]}],
                         'answer': {'step': 's'}, 'tests': [{'step': 's', 'sightings': [], 'over_scripts': [sha]}]}
            return r
        g = graph([signed('a'), signed('b'), search('c')])
        self.assertEqual([(x['key'], x['routes']) for x in g['same_script']], [(sha, ['a', 'b'])])

    def test_a_cycle_is_reported_never_hidden(self):
        def r(rid, gives, takes):
            return route(rid, [step(0, 'POST', 'https://www.shop.example/%s' % rid, [field('cookie', takes, 'minted', name=takes)], sets_cookie=True),
                               step(1, 'GET', 'https://www.shop.example/%s/next' % rid, [field('cookie', gives, 'derived', origin={'exchange': 0, 'url': '', 'at': {'from': 'set_cookie', 'name': gives}})])])
        g = graph([r('x', 'cx', 'cy'), r('y', 'cy', 'cx'), search()])
        self.assertEqual(g['cycles'], [['x', 'y']])
        self.assertEqual(sorted(f['route'] for f in g['findings'] if f['id'] == 'cycle'), ['x', 'y'])


class Questions(unittest.TestCase):
    def chain(self):
        # signin -> orders (session); orders' answer field `id` named as track's slot (feeds, a proposal only).
        track = route('track', [step(0, 'GET', 'https://www.shop.example/api/track', [field('query', 'id', 'input', name='id'), field('cookie', 'sid', 'minted', name='sid')])])
        return graph([sign_in(), orders(), track])

    def test_dependents_are_what_breaks_if_a_route_changes_transitively(self):
        d = RG.dependents(self.chain(), 'signin')
        self.assertEqual(sorted(x['route'] for x in d['takers']), ['orders', 'track'])

    def test_needs_are_what_must_hold_before_a_call_and_what_comes_from_outside(self):
        g = self.chain()
        n = RG.needs(g, 'track')
        self.assertEqual([x['route'] for x in n['givers']], ['signin'])
        self.assertEqual(n['caller'], ['id'])
        self.assertEqual([x['route'] for x in n['may_feed']], ['orders'], 'a field named as a slot is offered, never required')
        n = RG.needs(graph([search()]), 'search')
        self.assertEqual([(x['kind'], x['name']) for x in n['outside']['search']], [('cookie', 'visitor')])

    def test_a_route_is_named_by_id_file_or_prefix(self):
        g = self.chain()
        self.assertEqual(RG.resolve(g, 'sign'), 'signin')
        self.assertIsNone(RG.resolve(g, 'nothing-like-it'))


class Doors(unittest.TestCase):
    def test_the_door_is_a_node_of_its_own_and_gives_its_credential(self):
        a = search('a')
        a['graph']['door'] = {'kind': 'challenge', 'statuses': [403], 'credential': 'visitor', 'earn': 'browser'}
        g = graph([a, search('b')])
        self.assertEqual([d['key'] for d in g['doors']], ['door:shop.example'])
        self.assertEqual(sorted((e['from'], e['to'], e['kind']) for e in g['edges']), [('door:shop.example', 'a', 'door'), ('door:shop.example', 'b', 'door')])

    def test_a_sign_in_or_a_choice_kept_for_the_site_gives_as_a_door_does(self):
        g = RG.build([RG.read_route(bearer(), 'profile'), RG.read_route(search(), 'search')],
                     [{'site': 'www.shop.example', 'kind': 'sign_in', 'earns': []}, {'site': 'www.shop.example', 'kind': 'choice', 'earns': ['visitor']}])
        self.assertEqual(kinds(g), [('setup:shop.example:choice', 'search', 'setup'), ('setup:shop.example:sign_in', 'profile', 'setup')])
        self.assertEqual([f for f in g['findings'] if f['id'] == 'session-ungiven'], [])

    def test_a_homes_setups_folder_is_read_by_name_only(self):
        with tempfile.TemporaryDirectory() as d:
            rdir = write_home(d, [search()])
            os.makedirs(os.path.join(d, 'setups'))
            with open(os.path.join(d, 'setups', 'www.shop.example.json'), 'w') as f:
                json.dump([{'kind': 'choice', 'page': 'https://www.shop.example/', 'earns': ['visitor'], 'steps': [{'fill': {'at': '#zip', 'value': '90210'}}]}], f)
            g = RG.read_home(rdir)
            self.assertEqual([e['kind'] for e in g['edges']], ['setup'])
            self.assertNotIn('90210', json.dumps(RG.public(g)))


class Bodies(unittest.TestCase):
    def test_a_body_takes_its_cookies_and_stored_keys_and_not_what_its_own_step_set(self):
        r = route('body', [step(0, 'GET', 'https://www.shop.example/api/x', [])])
        r['body'] = {'v': 2, 'site': 'shop.example', 'slots': [{'name': 'q'}],
                     'steps': [{'id': 'a', 'method': 'GET', 'url': 'https://www.shop.example/api/token', 'expect': 200, 'holes': []},
                               {'id': 'b', 'method': 'GET', 'url': 'https://www.shop.example/api/x', 'expect': 200, 'holes': [
                                   {'at': {'in': 'cookie', 'key': 't'}, 'ways': [{'rung': 0, 'expr': {'op': 'read', 'step': 'a', 'at': {'from': 'set_cookie', 'name': 't'}}}]},
                                   {'at': {'in': 'header', 'key': 'x-key'}, 'ways': [{'rung': 0, 'expr': {'op': 'stored', 'area': 'local', 'key': 'apiKey'}}]},
                                   {'at': {'in': 'cookie', 'key': 'sid'}, 'ways': [{'rung': 0, 'expr': {'op': 'cookie', 'name': 'sid'}}]},
                                   {'at': {'in': 'query', 'key': 'q'}, 'ways': [{'rung': 0, 'expr': {'op': 'slot', 'name': 'q'}}]}]}],
                     'answer': {'step': 'b'}}
        n = RG.read_route(r, 'body')
        self.assertEqual(sorted(t['thing'] for t in n['takes']), [('cookie', 'shop.example', 'sid'), ('slot', 'shop.example', 'q'), ('stored', 'shop.example', 'local:apiKey')])
        self.assertIn(('cookie', 'shop.example', 't'), [x['thing'] for x in n['gives']])

    def test_a_page_that_wrote_a_key_gives_it_to_the_route_that_reads_it(self):
        reader = route('reader', [step(0, 'GET', 'https://www.shop.example/api/y', [])])
        reader['body'] = {'v': 2, 'site': 'shop.example', 'steps': [{'id': 'b', 'method': 'GET', 'url': 'https://www.shop.example/api/y', 'expect': 200, 'holes': [
            {'at': {'in': 'header', 'key': 'x-key'}, 'ways': [{'rung': 0, 'expr': {'op': 'stored', 'area': 'local', 'key': 'apiKey'}}]}]}], 'answer': {'step': 'b'}}
        g = RG.build([RG.read_route(search('writer'), 'writer', ['local:apiKey']), RG.read_route(reader, 'reader')])
        self.assertEqual(kinds(g), [('writer', 'reader', 'stored')])


class NoValue(unittest.TestCase):
    def test_the_graph_says_names_and_shapes_and_never_a_value(self):
        r = search('word', WORD)
        r['graph']['steps'][0]['url'] = 'https://api.shop.example/v1/%s/items/%s?q=x' % (WORD, '4815162342')
        g = graph([sign_in(), orders(), bearer(), r, search('b')])
        text = json.dumps(RG.public(g))
        for v in (SECRET, WORD, '4815162342', 'someone'):
            self.assertNotIn(v, text)
        self.assertIn('sid', text)


class Live(unittest.TestCase):
    def test_the_overview_carries_counts_and_a_line_a_site_and_the_graph_loads_per_site(self):
        with tempfile.TemporaryDirectory() as d:
            write_home(d, [sign_in(), orders(), search()])
            reader = W.Reader([d])
            ov = reader.overview()
            self.assertEqual(ov['graph']['counts']['edges:session'], 1)
            self.assertEqual([s['site'] for s in ov['graph']['sites']], ['shop.example'])
            self.assertNotIn('nodes', ov['graph'])
            W.Handler.reader = reader
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), W.Handler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            try:
                got = json.loads(urllib.request.urlopen('http://127.0.0.1:%d/graph?site=shop.example' % srv.server_address[1]).read())
            finally:
                srv.shutdown(); srv.server_close()
            self.assertEqual(sorted(n['id'] for n in got['nodes']), ['orders', 'search', 'signin'])
            self.assertEqual([(e['kind'], e['names']) for e in got['edges']], [('session', ['sid'])])

    def test_wiring_answers_graph_dependents_and_needs_from_the_command_line(self):
        import io, contextlib
        with tempfile.TemporaryDirectory() as d:
            write_home(d, [sign_in(), orders()])
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): self.assertEqual(W.main(['dependents', 'signin', '--home', d]), 0)
            self.assertEqual([x['route'].rsplit('/', 1)[-1] for x in json.loads(buf.getvalue())['takers']], ['orders.json'])
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): self.assertEqual(W.main(['graph', '--home', d]), 0)
            self.assertEqual(json.loads(buf.getvalue())['groups'][0]['counts']['edges'], 1)


class Costs(unittest.TestCase):
    def token(self, rid, calls):
        """A route whose first step fetches a token with no value of the caller's, then asks with it."""
        r = route(rid, [step(0, 'GET', 'https://www.shop.example/api/token', []),
                        step(1, 'GET', 'https://www.shop.example/api/%s' % rid, [field('header', 'x-token', 'derived', origin={'exchange': 0, 'url': '', 'at': {'from': 'json', 'pointer': '/t'}}),
                                                                                    field('query', 'q', 'input', name='q')])])
        r['stats'] = {'calls': calls, 'passed': calls, 'pass_days': 1}
        return r

    def test_a_step_several_routes_carry_is_sent_once_per_carrier_per_call_today(self):
        g = graph([self.token('a', 5), self.token('b', 3)])
        c = g['costs']['same_step'][0]
        self.assertEqual((c['carriers'], c['today'], c['at_least'], c['saved_at_most']), (2, 8, 1, 7))
        self.assertIsNone(c['once_per_lifetime'], 'no lifetime and no call times: a range, never a guess')

    def test_with_call_times_and_a_lifetime_the_sends_are_counted_exactly(self):
        a, b = self.token('a', 3), self.token('b', 2)
        nodes = [RG.read_route(a, 'a'), RG.read_route(b, 'b')]
        nodes[0]['times'], nodes[1]['times'] = [0, 10, 700], [20, 800]
        by = {n['key']: n for n in nodes}
        c = RG.step_cost(['a', 'b'], by, 600, False)
        self.assertEqual((c['today'], c['once_per_lifetime'], c['saved']), (5, 2, 3))

    def test_a_step_that_sends_the_callers_value_saves_nothing(self):
        a, b = search('a'), search('b')
        a['stats'] = b['stats'] = {'calls': 4, 'passed': 4}
        c = graph([a, b])['costs']['same_step'][0]
        self.assertEqual((c['today'], c['saved'], c['caller']), (8, 0, True))

    def test_a_step_that_writes_is_never_counted_as_saved(self):
        self.assertEqual(RG.step_cost(['a'], {'a': {'calls': 4}}, 600, True)['saved'], 0)

    def test_a_giver_whose_takers_carry_a_copy_of_its_step_says_so(self):
        def copy(rid):
            r = orders()
            r['id'] = rid
            r['graph']['steps'] = sign_in()['graph']['steps'][:1] + r['graph']['steps']
            r['graph']['steps'][1]['fields'][0] = field('cookie', 'sid', 'minted', name='sid')
            return r
        g = graph([sign_in(), copy('x'), orders()])
        giv = [x for x in g['costs']['givers'] if x['giver'] == 'signin']
        self.assertEqual([(x['takers'], x['takers_with_a_copy'], x['jar_only']) for x in giv], [(2, 1, 1)])


if __name__ == '__main__':
    unittest.main()
