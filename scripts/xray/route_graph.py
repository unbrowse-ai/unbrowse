#!/usr/bin/env python3
"""The graph across the routes of a home, derived from what each route already records. Nothing is stored: no route
names another, so every edge here is read from the two routes' own files each time.

For each route, what it GIVES and what it TAKES, as things keyed by the site and a name:

  gives  cookie   a cookie a step's reply set, by name (a `set_cookie` origin, or a body's `read` at `set_cookie`)
         session  the site's signed-in state: a step that establishes it, by the engine's rule (`graph.rs`
                  `establishes_session`: it is not a read, and it set a cookie, sent a secret, or handed back the
                  bearer token a later step signs with)
         door     the credential a wall issues once a browser is let through (`graph.door.credential`): given by the
                  door itself, which is its own node (`door:<site>`), earned in the browser
         stored   a key the route's page wrote to storage, where the walk's capture is in hand (no route file says it)
         field    a leaf of the answer's reply shape, by its key
  takes  cookie   a cookie the jar supplies (`minted`, or a body's `cookie`), less any the route's own steps set first
         session  a bearer `authorization` the route does not make itself (from the jar, or sent as walked)
         stored   a stored value by key (a body's `stored`)
         slot     a value of the caller's, by name
         script   the SHA-256 of a script the route signs or reads a table with (`tests[].over_scripts`; a graph's
                  kept `scripts`, hashed here)
         mint     a header the browser's mint supplies (`minted` at a header): no route gives one
         door     the route's site has a wall (`graph.door`)

An edge A -> B is drawn where B takes what A gives, on the same site, with its kind and evidence (names and shapes,
never a value). `same_step` groups one call carried by several routes (method, the host's site, the path's shape,
the same places in its address and body); `same_script` groups routes by a script's SHA. Both are groups, not
all-pairs edges. Cycles are found over the directed edges and reported, never dropped.

Every lookup is one dict read by key; building is one pass over the routes to index what each gives, one pass over
what each takes, and Tarjan's walk over the edges: O(routes + gives + takes + edges). No two routes are compared
directly.

Standard library only. It asks no site, prints no value, and never writes a route.
"""
import hashlib, json, os, urllib.parse as U

HARD = ('cookie', 'session', 'stored', 'door', 'setup')   # an edge of these kinds is a dependency: the taker fails without it
SOFT = ('feeds',)                                 # an answer's field named as a caller's slot: a proposal, by name only
LEVELS = ('break', 'risk', 'note')

FINDINGS = {
    'session-ungiven': ('break', 'takes a session nothing in the home gives',
                        "it sends a bearer authorization it does not make, and no route of its site establishes a session: the sign-in was never learned, or a person did it"),
    'giver-failing': ('break', 'its only givers are failing or provisional',
                      'every route that gives a thing it takes last failed or is provisional, so it will fail too'),
    'cycle': ('risk', 'in a cycle', 'it takes, through other routes, what it gives: no order runs them all from nothing'),
    'step-duplicated': ('note', 'a step several routes carry', 'the same call is copied into several routes: learned once and referenced, it would change in one place'),
    'script-shared': ('note', 'a script several routes sign with', 'one deploy of this script changes every route that names its hash'),
}


# ------------------------------------------------------------------------------------------------ reading one route
SUFFIXES = None   # a public suffix list, read by `load_suffixes`; without one the shape rule below stands in


def load_suffixes(path):
    """Read a public suffix list (`public_suffix_list.dat`), the list the engine's `identity::site_of` reads."""
    global SUFFIXES
    out = set()
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('//'): out.add(line.lstrip('*.!'))
    SUFFIXES = out


def site_key(host):
    """The site a host is on, as the engine's `identity::site_of` reads it: the public suffix and one label more.
    With no list loaded, a rule of shape stands in: the last two labels, or three where the last is two letters and the
    one before it is three or fewer (the shape of a country's second level). It is a reading, said in the output."""
    host = (host or '').lower().strip('.')
    if not host or host.replace('.', '').isdigit() or ':' in host: return host
    labels = host.split('.')
    if SUFFIXES is not None:
        for i in range(len(labels)):
            if '.'.join(labels[i:]) in SUFFIXES:
                return '.'.join(labels[max(0, i - 1):])
        return '.'.join(labels[-2:])
    if len(labels) >= 3 and len(labels[-1]) == 2 and len(labels[-2]) <= 3: return '.'.join(labels[-3:])
    return '.'.join(labels[-2:])


def site_rule():
    return 'the public suffix list given' if SUFFIXES is not None else "the last two labels, or three under a country's short second level (no public suffix list given)"


def site_of(host, site):
    return site_key(host or site)


def failing(r):
    st = r.get('stats') or {}
    return bool(st.get('last_error'))


def state_of(r):
    if failing(r): return 'failing'
    if r.get('provisional'): return 'provisional'
    st = r.get('stats') or {}
    return 'passing' if st.get('passed') else 'uncalled'


def leaf_keys(shape, most=200):
    """The keys of a reply's shape, each once, depth first: what the answer can hand on, by name."""
    out, stack = [], [shape]
    while stack and len(out) < most:
        v = stack.pop()
        if isinstance(v, dict):
            for k, x in v.items():
                if isinstance(k, str) and k not in out: out.append(k)
                stack.append(x)
        elif isinstance(v, list) and v:
            stack.append(v[0])
    return out


def piece_words(p, words):
    """A fixed piece of a path as the graph may show it: the caller's walked word is `‹word›`, and a piece that could
    be a value (a digit in it, or longer than 24) is its length. wiring.py puts its own reader (`fixed`'s rule) here,
    so the page and this file say a value one way."""
    if p in words: return '‹word›'
    if any(c.isdigit() for c in p) or len(p) > 24: return '‹%d chars›' % len(p)
    return p


def path_shape(url, holes_at, words=()):
    """The address's path with each piece that is a hole written `{}`, and its query's keys, sorted: the call's shape."""
    try: u = U.urlsplit(url or '')
    except ValueError: return '', ''
    pieces = [p for p in (u.path or '/').split('/')[1:]]
    out = []
    for i, p in enumerate(pieces):
        out.append('{}' if i in holes_at or (p.startswith('{') and p.endswith('}')) else piece_words(U.unquote(p), words) if p else p)
    keys = sorted({k for k, _ in U.parse_qsl(u.query or '', keep_blank_values=True)})
    return (u.hostname or '').lower(), '/' + '/'.join(out) + ('?' + '&'.join(keys) if keys else '')


def walked_words(r):
    """The caller's values the route holds as examples (its inputs' defaults, its slots' examples): never shown."""
    b = r.get('body') if isinstance(r.get('body'), dict) else {}
    vals = [i.get('default') for i in r.get('inputs') or [] if isinstance(i, dict)] + [x.get('example') for x in b.get('slots') or []]
    for st in (r.get('graph') or {}).get('steps') or []:
        vals += [f.get('default') for f in st.get('fields') or [] if f.get('class') == 'input']
    return {str(v) for v in vals if v not in (None, '')}


def walk_expr(e, out):
    """Every source an expression names: (op, fields). Operations are walked into."""
    if isinstance(e, dict):
        op = e.get('op')
        if op in ('cookie', 'stored', 'slot', 'given', 'read', 'pick', 'file'): out.append(e)
        for k, v in e.items():
            if k in ('rows', 'source', 'evidence', 'is'): continue
            if isinstance(v, (dict, list)): walk_expr(v, out)
    elif isinstance(e, list):
        for x in e: walk_expr(x, out)
    return out


def place_words(at):
    if isinstance(at, dict):
        k = at.get('in'); v = at.get('key')
        if isinstance(v, list): v = '/'.join(str(x) for x in v if x)
        return '%s %s' % (k, v) if v not in (None, '') else str(k)
    return str(at)


def T(kind, site, name=''):
    return (kind, site or '', name or '')


def read_graph(r, site):
    """gives, takes and steps of a route the classifier wrote (`graph.steps[].fields[]`)."""
    g = r.get('graph') or {}
    steps = g.get('steps') or []
    gives, takes, out_steps = [], [], []
    by_exchange = {s.get('exchange'): i + 1 for i, s in enumerate(steps)}
    set_here = {}   # cookie name -> the step whose reply set it
    for i, s in enumerate(steps):
        for f in s.get('fields') or []:
            o = f.get('origin') if isinstance(f.get('origin'), dict) else None
            if f.get('class') == 'derived' and o and isinstance(o.get('at'), dict) and o['at'].get('from') == 'set_cookie':
                n = by_exchange.get(o.get('exchange'))
                if n and o['at'].get('name'): set_here.setdefault(o['at']['name'], n)
    signs_with = {}  # exchange -> a later step's authorization is read from its reply
    for s in steps:
        for f in s.get('fields') or []:
            loc = f.get('loc') or {}
            o = f.get('origin') if isinstance(f.get('origin'), dict) else None
            if loc.get('in') == 'header' and str(loc.get('key')).lower() == 'authorization' and f.get('class') == 'derived' and o:
                signs_with[o.get('exchange')] = True
    for i, s in enumerate(steps):
        n = i + 1
        fields = s.get('fields') or []
        method = str(s.get('method') or 'GET').upper()
        secret = any(f.get('class') == 'input' and f.get('secret') for f in fields)
        if method not in ('GET', 'HEAD') and (s.get('sets_cookie') or secret or signs_with.get(s.get('exchange'))):
            why = 'it set a cookie' if s.get('sets_cookie') else 'it sent a secret' if secret else 'a later step signs with its token'
            gives.append({'thing': T('session', site), 'step': n, 'why': '%s %s, %s' % (method, 'step #%d' % n, why)})
        holes_at = set()
        places = []
        for f in fields:
            loc = f.get('loc') or {}
            cls = f.get('class') if isinstance(f.get('class'), str) else 'other'
            where = loc.get('in')
            if where == 'path' and cls != 'constant': holes_at.add(loc.get('key'))
            if where in ('query', 'json', 'form', 'part', 'path', 'url') and cls != 'constant': places.append(place_words(loc))
            if cls == 'minted' and where == 'cookie':
                name = f.get('name') or loc.get('key')
                if set_here.get(name, n + 1) < n: continue  # the route's own earlier step sets it
                takes.append({'thing': T('cookie', site, name), 'step': n, 'place': place_words(loc)})
            elif cls == 'minted' and where == 'header':
                if str(loc.get('key')).lower() == 'authorization': takes.append({'thing': T('session', site), 'step': n, 'place': 'header authorization', 'how': 'from the jar'})
                else: takes.append({'thing': T('mint', site, f.get('name') or loc.get('key')), 'step': n, 'place': place_words(loc)})
            elif cls == 'minted':
                takes.append({'thing': T('mint', site, f.get('name') or loc.get('key')), 'step': n, 'place': place_words(loc)})
            elif cls in ('constant', 'unconfirmed') and where == 'header' and str(loc.get('key')).lower() == 'authorization':
                takes.append({'thing': T('session', site), 'step': n, 'place': 'header authorization', 'how': 'sent as walked'})
            elif cls == 'input':
                takes.append({'thing': T('slot', site, f.get('name')), 'step': n, 'place': place_words(loc), 'secret': bool(f.get('secret'))})
        for name, at in set_here.items():
            if at == n: gives.append({'thing': T('cookie', site, name), 'step': n, 'why': "step #%d's reply set it" % n})
        host, shape = path_shape(s.get('url'), holes_at, walked_words(r))
        out_steps.append({'n': n, 'method': method, 'site': site_of(host, site), 'shape': shape, 'places': sorted(set(places)), 'answer': i == len(steps) - 1,
                          'writes': False, 'sets_cookie': bool(s.get('sets_cookie')), 'caller': any(f.get('class') == 'input' for f in fields)})
    if steps and isinstance(steps[-1].get('response_shape'), (dict, list)):
        for k in leaf_keys(steps[-1]['response_shape']): gives.append({'thing': T('field', site, k), 'step': len(steps), 'why': "the answer's reply holds it"})
    door = g.get('door') if isinstance(g.get('door'), dict) else None
    if door:
        takes.append({'thing': T('door', site), 'step': None, 'place': 'the site', 'how': 'the walk met %s' % (door.get('kind') or 'a wall')})
    scripts = [hashlib.sha256((sc.get('body') or '').encode()).hexdigest() for sc in g.get('scripts') or [] if isinstance(sc, dict) and sc.get('body')]
    for sha in scripts: takes.append({'thing': T('script', '', sha), 'step': None, 'place': 'a kept script'})
    return gives, takes, out_steps, door


def read_body(r, b, site):
    """gives, takes and steps of a route kept as a body (`body.steps[].holes[].ways[]`)."""
    steps = b.get('steps') or []
    idx = {s.get('id'): i + 1 for i, s in enumerate(steps)}
    secrets = {s.get('name') for s in b.get('slots') or [] if s.get('secret')}
    gives, takes, out_steps = [], [], []
    set_here, signs_with = {}, set()
    srcs_of = []
    for s in steps:
        per = []
        for h in s.get('holes') or []:
            src = walk_expr([w.get('expr') for w in h.get('ways') or []], [])
            per.append((h, src))
            for e in src:
                at = e.get('at') if isinstance(e.get('at'), dict) else {}
                if e.get('op') == 'read' and at.get('from') == 'set_cookie' and at.get('name') and idx.get(e.get('step')):
                    set_here.setdefault(at['name'], idx[e['step']])
                if e.get('op') in ('read', 'pick') and str((h.get('at') or {}).get('key')).lower() == 'authorization' and (h.get('at') or {}).get('in') == 'header':
                    signs_with.add(e.get('step'))
        srcs_of.append(per)
    for i, s in enumerate(steps):
        n = i + 1
        method = str(s.get('method') or 'GET').upper()
        per = srcs_of[i]
        secret = any(e.get('op') in ('slot', 'given') and e.get('name') in secrets for _, src in per for e in src)
        if method not in ('GET', 'HEAD') and (s.get('sets_cookie') or secret or s.get('id') in signs_with):
            why = 'it set a cookie' if s.get('sets_cookie') else 'it sent a secret' if secret else 'a later step signs with its token'
            gives.append({'thing': T('session', site), 'step': n, 'why': '%s step #%d, %s' % (method, n, why)})
        holes_at, places = set(), []
        for h, src in per:
            at = h.get('at') or {}
            where = at.get('in')
            text_only = all((w.get('expr') or {}).get('op') == 'text' for w in h.get('ways') or []) and bool(h.get('ways'))
            if where == 'path' and not text_only: holes_at.add(at.get('key'))
            if where in ('query', 'json', 'form', 'part', 'path', 'url') and not text_only: places.append(place_words(at))
            if where == 'header' and str(at.get('key')).lower() == 'authorization' and not any(e.get('op') in ('read', 'pick') for e in src):
                takes.append({'thing': T('session', site), 'step': n, 'place': 'header authorization', 'how': 'from the jar' if src else 'sent as walked'})
            seen_here = set()
            for e in src:
                op = e.get('op')
                if op == 'cookie':
                    if set_here.get(e.get('name'), n + 1) < n or e.get('name') in seen_here: continue
                    seen_here.add(e.get('name'))
                    takes.append({'thing': T('cookie', site, e.get('name')), 'step': n, 'place': place_words(at)})
                elif op == 'stored':
                    takes.append({'thing': T('stored', site, '%s:%s' % (e.get('area'), e.get('key'))), 'step': n, 'place': place_words(at)})
                elif op in ('slot', 'given'):
                    takes.append({'thing': T('slot', site, e.get('name')), 'step': n, 'place': place_words(at), 'secret': e.get('name') in secrets})
        for name, at_n in set_here.items():
            if at_n == n: gives.append({'thing': T('cookie', site, name), 'step': n, 'why': "step #%d's reply set it" % n})
        host, shape = path_shape(s.get('url'), {int(k) if isinstance(k, int) or str(k).isdigit() else k for k in holes_at}, walked_words(r))
        out_steps.append({'n': n, 'method': method, 'site': site_of(host, site), 'shape': shape, 'places': sorted(set(places)), 'answer': s.get('id') == (b.get('answer') or {}).get('step'),
                          'writes': bool(s.get('writes')), 'sets_cookie': bool(s.get('sets_cookie')), 'lifetime': s.get('lifetime'),
                          'caller': any(e.get('op') in ('slot', 'given') for _, src in per for e in src)})
        if s.get('id') == (b.get('answer') or {}).get('step') and isinstance(s.get('shape'), (dict, list)):
            for k in leaf_keys(s['shape']): gives.append({'thing': T('field', site, k), 'step': n, 'why': "the answer's reply holds it"})
    for t in b.get('tests') or []:
        for sha in t.get('over_scripts') or []:
            takes.append({'thing': T('script', '', sha), 'step': idx.get(t.get('step')), 'place': 'a constant or table of its script'})
    return gives, takes, out_steps


def read_route(r, key, stored_gives=()):
    """One route as a node of the graph: what it gives, what it takes, its steps' shapes, and its state."""
    site = site_key(r.get('site') or '')
    gives, takes, steps, door = read_graph(r, site)
    b = r.get('body') if isinstance(r.get('body'), dict) else None
    if b:
        bg, bt, bs = read_body(r, b, site)
        # The body is what is called where the route keeps one; the graph's door and scripts stand beside it.
        gives = bg + [g for g in gives if g['thing'][0] not in ('cookie', 'session', 'field')]
        takes = bt + [t for t in takes if t['thing'][0] in ('door', 'script', 'mint')]
        steps = bs
    for area_key in stored_gives:
        gives.append({'thing': T('stored', site, area_key), 'step': None, 'why': "the walk's page wrote it (its capture)"})
    gsteps = (r.get('graph') or {}).get('steps') or []
    jar = (U.urlsplit(gsteps[-1].get('url') or '').hostname or '').lower() if gsteps else ''
    st = r.get('stats') or {}
    return {'calls': st.get('calls') or 0, 'pass_days': st.get('pass_days') or 0, 'times': [],
            'key': key, 'id': r.get('id'), 'site': site, 'host': (r.get('site') or '').lower(), 'jar': jar, 'what': r.get('what'), 'by': 'body' if b else 'graph', 'state': state_of(r), 'write': bool(r.get('write')),
            'gives': dedup(gives), 'takes': dedup(takes), 'steps': steps, 'door': ({'kind': door.get('kind'), 'credential': door.get('credential'), 'earn': door.get('earn')} if door else None)}


def dedup(xs):
    seen, out = set(), []
    for x in xs:
        k = (x['thing'], x.get('step'))
        if k in seen: continue
        seen.add(k)
        out.append(x)
    return out


# ------------------------------------------------------------------------------------------------ the graph
def build(routes, setups=()):
    """The graph over `routes` (each `read_route`'s node). One index of what is given, by thing; one pass over takes."""
    nodes = {n['key']: n for n in routes}
    givers = {}  # thing -> [(route key, give)]
    doors = {}
    for n in routes:
        for g in n['gives']: givers.setdefault(g['thing'], []).append((n['key'], g))
        if n.get('door'):
            d = doors.setdefault(n['site'], {'key': 'door:' + n['site'], 'site': n['site'], 'kind': 'door', 'met_by': [], 'credential': set(), 'earn': set()})
            d['met_by'].append(n['key'])
            if n['door'].get('credential'): d['credential'].add(n['door']['credential'])
            if n['door'].get('earn'): d['earn'].add(json.dumps(n['door']['earn'], sort_keys=True) if not isinstance(n['door']['earn'], str) else n['door']['earn'])
    # What a site needs done in its browser (`setups/<site>.json`, `unbrowse_learn::setup`): a sign-in gives the
    # session; a choice gives the cookies it earned, by name. Each is a node of its own, as a door is.
    for su in setups:
        site = site_key(su.get('site'))
        kind = su.get('kind') or 'choice'
        key = 'setup:%s:%s' % (site, kind)
        d = doors.setdefault('%s %s' % (site, kind), {'key': key, 'site': site, 'kind': 'setup', 'setup': kind, 'met_by': [], 'credential': set(), 'earn': set()})
        for c in su.get('earns') or []: d['credential'].add(c)
        if kind == 'sign_in': givers.setdefault(T('session', site), []).append((key, {'thing': T('session', site), 'step': None, 'why': 'the sign-in kept for the site, done in its browser'}))
    for site, d in doors.items():
        if d['kind'] == 'setup':
            for c in d['credential']: givers.setdefault(T('cookie', d['site'], c), []).append((d['key'], {'thing': T('cookie', d['site'], c), 'step': None, 'why': 'a choice kept for the site earns it, made again in its browser when the jar has lost it'}))
            continue
        givers.setdefault(T('door', site), []).append((d['key'], {'thing': T('door', site), 'step': None, 'why': 'the browser passed the wall'}))
        for c in d['credential']: givers.setdefault(T('cookie', site, c), []).append((d['key'], {'thing': T('cookie', site, c), 'step': None, 'why': 'the wall issues it to a browser it lets through'}))
    edges = {}   # (from, to, kind) -> edge
    outside = {}  # route key -> [take with no giver in the home]
    for n in routes:
        for t in n['takes']:
            kind, site, name = t['thing']
            if kind in ('slot', 'script', 'mint'):
                if kind == 'slot':
                    for gk, g in givers.get(T('field', site, name), []):
                        if gk != n['key']: add_edge(edges, gk, n['key'], 'feeds', name, g, t)
                if kind == 'mint': outside.setdefault(n['key'], []).append(t)
                continue
            gs = [(gk, g) for gk, g in givers.get(t['thing'], []) if gk != n['key']]
            if not gs:
                outside.setdefault(n['key'], []).append(t)
                continue
            for gk, g in gs:
                k = 'door' if gk.startswith('door:') else 'setup' if gk.startswith('setup:') else 'session' if kind == 'session' or session_step(nodes.get(gk), g) else kind
                add_edge(edges, gk, n['key'], k, name or kind, g, t)
                e = edges[(gk, n['key'], k)]
                if 'same_jar' not in e and gk in nodes: e['same_jar'] = nodes[gk]['jar'] == n['jar']
    for d in doors.values(): d['credential'], d['earn'] = sorted(d['credential']), sorted(d['earn'])
    E = sorted(edges.values(), key=lambda e: (e['kind'], e['from'], e['to']))
    same_step = groups_of(routes, lambda n: [((s['method'], s['site'], s['shape'], tuple(s['places'])), s) for s in n['steps']])
    same_script = groups_of(routes, lambda n: [(t['thing'][2], t) for t in n['takes'] if t['thing'][0] == 'script'])
    cycles = sccs([n['key'] for n in routes] + [d['key'] for d in doors.values()], [e for e in E if e['kind'] in HARD])
    g = {'nodes': routes, 'doors': list(doors.values()), 'edges': E, 'same_step': same_step, 'same_script': same_script, 'cycles': cycles, 'outside': outside}
    g['findings'] = findings(g, nodes, givers)
    g['costs'] = costs(g, nodes)
    g['counts'] = counts(g)
    return g


def sends_once_per(times, lifetime):
    """How many sends a step needs over calls at `times` (seconds) if its reply is kept `lifetime` seconds: a send
    opens a window, and a call inside it is answered from what was kept."""
    n, until = 0, None
    for t in sorted(times):
        if until is None or t >= until:
            n += 1
            until = t + lifetime
    return n


def step_cost(carriers, nodes, lifetime, writes, caller=False):
    """What one step costs today, sent by each carrier on each of its calls, against once per lifetime shared by all
    of them. Counts from the routes: their `stats.calls`, and the call times in `made.jsonl` where the home keeps it."""
    calls = {k: (nodes.get(k) or {}).get('calls', 0) for k in carriers}
    today = sum(calls.values())
    out = {'carriers': len(carriers), 'calls': today, 'today': today}
    if caller:
        out.update({'once_per_lifetime': None, 'saved': 0, 'caller': True,
                    'why': "it sends the caller's value: a kept reply answers only a call with the same values (learn.lifetime), and the routes keep no values to say how often they repeat"})
        return out
    if writes:
        out.update({'once_per_lifetime': today, 'saved': 0, 'why': 'it writes: a step that writes is never skipped (learn.lifetime)'})
        return out
    times = [t for k in carriers for t in (nodes.get(k) or {}).get('times') or []]
    if lifetime and times and len(times) >= today:
        once = sends_once_per(times, lifetime)
        out.update({'once_per_lifetime': once, 'saved': today - once, 'why': 'from %d call times and a lifetime of %ds' % (len(times), lifetime)})
    else:
        least = 1 if today else 0
        days = sum((nodes.get(k) or {}).get('pass_days', 0) for k in carriers)
        out.update({'once_per_lifetime': None, 'at_least': least, 'saved_at_most': today - least,
                    'if_a_day': min(today, days) if days else None,
                    'why': ('no lifetime is recorded for the step' if not lifetime else 'the home keeps no call times (made.jsonl)') +
                           ': once per lifetime is between %d and %d sends; with a lifetime of a day it is at most the days the carriers passed on (%d)' % (least, today, days)})
    return out


def costs(g, nodes):
    """Where requests are sent more often than needed: each step several routes carry, and each giver with two or more
    takers that carry a copy of the giving step."""
    out = {'same_step': [], 'givers': []}
    for grp in g['same_step']:
        items = list(grp['items'].values())
        life = min([x.get('lifetime') for x in items if x.get('lifetime')] or [0]) or None
        c = step_cost(grp['routes'], nodes, life, any(x.get('writes') or x.get('method') not in ('GET', 'HEAD') and x.get('sets_cookie') for x in items), any(x.get('caller') for x in items))
        out['same_step'].append(dict(c, key=grp['key']))
    takers = {}
    for e in g['edges']:
        if e['kind'] in HARD and e['from'] in nodes: takers.setdefault(e['from'], set()).add(e['to'])
    by_step = {}
    for grp in g['same_step']:
        for k, item in grp['items'].items(): by_step[(k, item.get('n'))] = grp
    for giver, ts in takers.items():
        if len(ts) < 2: continue
        steps = sorted({x.get('step') for x in nodes[giver]['gives'] if x.get('step') and x['thing'][0] in ('cookie', 'session')})
        copies = set()
        for n in steps:
            grp = by_step.get((giver, n))
            if grp: copies |= set(grp['routes']) & ts
        carriers = [giver] + sorted(copies)
        c = step_cost(carriers, nodes, None, False)
        out['givers'].append(dict(c, giver=giver, takers=len(ts), takers_with_a_copy=len(copies), steps=steps,
                                  jar_only=len(ts - copies)))
    out['same_step'].sort(key=lambda x: -x['today'])
    out['givers'].sort(key=lambda x: (-x['takers'], -x['today']))
    return out


def session_step(node, give):
    """Whether a cookie a giver sets comes from the step that establishes its session."""
    if not node or give.get('step') is None: return False
    return any(x['thing'][0] == 'session' and x.get('step') == give['step'] for x in node['gives'])


def add_edge(edges, a, b, kind, name, give, take):
    e = edges.setdefault((a, b, kind), {'from': a, 'to': b, 'kind': kind, 'names': [], 'evidence': []})
    if name not in e['names']: e['names'].append(name)
    if len(e['evidence']) < 12:
        e['evidence'].append({'name': name, 'giver_step': give.get('step'), 'why': give.get('why'), 'taker_step': take.get('step'), 'at': take.get('place'), 'how': take.get('how')})


def groups_of(routes, keys_of):
    """Routes grouped by a key each yields: only keys two or more routes carry. One dict, one pass."""
    by = {}
    for n in routes:
        for k, item in keys_of(n):
            ent = by.setdefault(k, {})
            ent.setdefault(n['key'], item)
    out = []
    for k, members in by.items():
        if len(members) < 2: continue
        out.append({'key': k, 'routes': sorted(members), 'n': len(members), 'items': members})
    out.sort(key=lambda g: (-g['n'], str(g['key'])))
    return out


def sccs(keys, edges):
    """Strongly connected components of two or more, by Tarjan's walk, iteratively: the cycles, every one reported."""
    adj = {k: [] for k in keys}
    for e in edges:
        adj.setdefault(e['from'], []).append(e['to'])
        adj.setdefault(e['to'], [])
    index, low, on, stack, out, i = {}, {}, set(), [], [], [0]
    for root in adj:
        if root in index: continue
        work = [(root, 0)]
        while work:
            v, pi = work.pop()
            if pi == 0:
                index[v] = low[v] = i[0]; i[0] += 1
                stack.append(v); on.add(v)
            recurse = False
            for j in range(pi, len(adj[v])):
                w = adj[v][j]
                if w not in index:
                    work.append((v, j + 1)); work.append((w, 0)); recurse = True
                    break
                if w in on: low[v] = min(low[v], index[w])
            if recurse: continue
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop(); on.discard(w); comp.append(w)
                    if w == v: break
                if len(comp) > 1: out.append(sorted(comp))
            if work:
                u = work[-1][0]
                low[u] = min(low[u], low[v])
    return out


def findings(g, nodes, givers):
    out = []
    session_sites = {t[1] for t in givers if t[0] == 'session'}
    for n in g['nodes']:
        for t in n['takes']:
            if t['thing'][0] == 'session' and t['thing'][1] not in session_sites:
                out.append({'id': 'session-ungiven', 'route': n['key'], 'evidence': 'step #%s sends %s (%s)' % (t.get('step'), t.get('place'), t.get('how'))})
                break
    by_taker = {}
    for e in g['edges']:
        if e['kind'] in HARD: by_taker.setdefault(e['to'], {}).setdefault(tuple(e['names']), []).append(e['from'])
    for taker, needs in by_taker.items():
        for names, gs in needs.items():
            states = [(k.split(':', 1)[0] if k.startswith(('door:', 'setup:')) else (nodes.get(k) or {}).get('state')) for k in gs]
            if states and all(s in ('failing', 'provisional') for s in states):
                out.append({'id': 'giver-failing', 'route': taker, 'evidence': '%s from %s, each %s' % (', '.join(names), ', '.join(gs), '/'.join(sorted(set(states))))})
    for c in g['cycles']:
        for k in c:
            if not k.startswith(('door:', 'setup:')): out.append({'id': 'cycle', 'route': k, 'evidence': 'with %s' % ', '.join(x for x in c if x != k)})
    for grp in g['same_step']:
        m, site, shape, places = grp['key']
        for k in grp['routes']: out.append({'id': 'step-duplicated', 'route': k, 'evidence': '%s %s%s, carried by %d routes' % (m, site, shape, grp['n'])})
    for grp in g['same_script']:
        for k in grp['routes']: out.append({'id': 'script-shared', 'route': k, 'evidence': 'script %s… names %d routes' % (grp['key'][:12], grp['n'])})
    return out


def counts(g):
    c = {'routes': len(g['nodes']), 'doors': len(g['doors']), 'edges': len(g['edges']), 'cycles': len(g['cycles']),
         'same_step_groups': len(g['same_step']), 'same_script_groups': len(g['same_script'])}
    for e in g['edges']: c['edges:' + e['kind']] = c.get('edges:' + e['kind'], 0) + 1
    for f in g['findings']: c['finding:' + f['id']] = c.get('finding:' + f['id'], 0) + 1
    for f in FINDINGS: c.setdefault('finding:' + f, 0)
    c['edges:other_jar'] = sum(1 for e in g['edges'] if e.get('same_jar') is False)
    cs = (g.get('costs') or {}).get('same_step') or []
    c['shared_step_sends_today'] = sum(x['today'] for x in cs)
    c['shared_step_sends_today_callers'] = sum(x['today'] for x in cs if x.get('caller'))
    c['shared_steps_with_no_caller_value'] = sum(1 for x in cs if not x.get('caller'))
    c['shared_step_sends_saved_at_most'] = sum(x.get('saved', x.get('saved_at_most', 0)) for x in cs)
    return c


# ------------------------------------------------------------------------------------------------ questions of it
def resolve(g, ask):
    """A route named by its id, its file, its key, or a prefix of its id."""
    for n in g['nodes']:
        if ask in (n['id'], n['key'], os.path.basename(n['key']), os.path.basename(n['key'])[:-5]): return n['key']
    hits = [n['key'] for n in g['nodes'] if str(n['id'] or '').startswith(ask)]
    return hits[0] if len(hits) == 1 else None


def reach(g, start, forward, kinds=HARD):
    """Every node reached from `start` over edges of `kinds`, with the depth each is first met at, breadth first."""
    adj = {}
    for e in g['edges']:
        if e['kind'] not in kinds: continue
        a, b = (e['from'], e['to']) if forward else (e['to'], e['from'])
        adj.setdefault(a, []).append((b, e))
    seen, order, frontier, depth = {start: 0}, [], [start], 0
    while frontier:
        depth += 1
        nxt = []
        for v in frontier:
            for w, e in adj.get(v, []):
                if w in seen: continue
                seen[w] = depth
                order.append({'route': w, 'depth': depth, 'via': {'from': e['from'], 'to': e['to'], 'kind': e['kind'], 'names': e['names']}})
                nxt.append(w)
        frontier = nxt
    return order


def dependents(g, key):
    """What breaks if this route changes: every route that takes from it, transitively; and the routes that carry one
    of its steps or name one of its scripts, which change with it when the site changes that call or that script."""
    with_ = [x for grp in g['same_step'] if key in grp['routes'] for x in grp['routes'] if x != key]
    scripts = [x for grp in g['same_script'] if key in grp['routes'] for x in grp['routes'] if x != key]
    return {'route': key, 'takers': reach(g, key, True), 'same_step': sorted(set(with_)), 'same_script': sorted(set(scripts)),
            'feeds': [x for x in reach(g, key, True, SOFT) if x['depth'] == 1]}


def needs(g, key):
    """What must hold before this route can be called: every giver of what it takes, transitively; what it takes that
    nothing in the home gives (the jar, the mint, a person); and the caller's slots."""
    node = next((n for n in g['nodes'] if n['key'] == key), None) or {}
    caller = sorted({t['thing'][2] for t in node.get('takes') or [] if t['thing'][0] == 'slot'})
    up = reach(g, key, False)
    out = {}
    for x in [{'route': key}] + up:
        for t in g['outside'].get(x['route'], []):
            out.setdefault(x['route'], []).append({'kind': t['thing'][0], 'name': t['thing'][2], 'step': t.get('step'), 'at': t.get('place')})
    return {'route': key, 'givers': up, 'outside': out, 'caller': caller, 'may_feed': [x for x in reach(g, key, False, SOFT) if x['depth'] == 1]}


# ------------------------------------------------------------------------------------------------ as JSON
def public(g, site=None):
    """The graph as JSON for agents and the page: names and shapes only. With `site`, that site's routes and the edges
    between them; the groups are cut to the routes kept."""
    keep = {n['key'] for n in g['nodes'] if site is None or n['site'] == site} | {d['key'] for d in g['doors'] if site is None or d['site'] == site}
    fs = {}
    for f in g['findings']: fs.setdefault(f['route'], []).append({'id': f['id'], 'level': FINDINGS[f['id']][0], 'evidence': f['evidence']})
    nodes = []
    for n in g['nodes']:
        if n['key'] not in keep: continue
        nodes.append({'key': n['key'], 'id': n['id'], 'site': n['site'], 'what': n['what'], 'by': n['by'], 'state': n['state'], 'write': n['write'],
                      'gives': folded(n['gives']), 'takes': folded(n['takes'], outside={t['thing'] for t in g['outside'].get(n['key'], [])}), 'findings': fs.get(n['key'], [])})
    groups = lambda gs, f: [{'key': f(x['key']), 'n': len([r for r in x['routes'] if r in keep]), 'routes': [r for r in x['routes'] if r in keep],
                             'steps': {r: x['items'][r].get('n') for r in x['routes'] if r in keep and isinstance(x['items'][r], dict)}}
                            for x in gs if len([r for r in x['routes'] if r in keep]) >= 2]
    return {'site': site, 'site_rule': site_rule(), 'counts': g['counts'] if site is None else counts_of_site(g, keep), 'findings_catalogue': {k: {'level': v[0], 'title': v[1], 'why': v[2]} for k, v in FINDINGS.items()},
            'nodes': nodes, 'doors': [d for d in g['doors'] if d['key'] in keep],
            'edges': [e for e in g['edges'] if e['from'] in keep and e['to'] in keep],
            'same_step': groups(g['same_step'], lambda k: {'method': k[0], 'site': k[1], 'shape': k[2], 'places': list(k[3])}),
            'same_script': groups(g['same_script'], lambda k: {'sha256': k}),
            'cycles': [c for c in g['cycles'] if all(k in keep for k in c)],
            'costs': {'same_step': [dict(x, key={'method': x['key'][0], 'site': x['key'][1], 'shape': x['key'][2], 'places': list(x['key'][3])}) for x in (g.get('costs') or {}).get('same_step') or []
                                    if site is None or x['key'][1] == site or any(r in keep for grp in g['same_step'] if grp['key'] == x['key'] for r in grp['routes'])],
                      'givers': [x for x in (g.get('costs') or {}).get('givers') or [] if x['giver'] in keep]},
            'not_recorded': ["which cookies a step set, unless a later step of the same route reads one: a step keeps only `sets_cookie`, so a cookie edge is drawn only where a giver names it",
                             "whether a given cookie reaches its taker: a call keeps what it was set in the jar of its route's target host (`client.rs` `jar_name`), so an edge between two routes of other target hosts says `same_jar: false`",
                             "storage keys a page writes: no route file records them; they are read from a walk's capture where one is in hand"]}


def counts_of_site(g, keep):
    sub = {'nodes': [n for n in g['nodes'] if n['key'] in keep], 'doors': [d for d in g['doors'] if d['key'] in keep], 'edges': [e for e in g['edges'] if e['from'] in keep and e['to'] in keep],
           'cycles': [c for c in g['cycles'] if all(k in keep for k in c)], 'findings': [f for f in g['findings'] if f['route'] in keep],
           'costs': {'same_step': [x for x in (g.get('costs') or {}).get('same_step') or [] if any(grp['key'] == x['key'] and len([r for r in grp['routes'] if r in keep]) >= 2 for grp in g['same_step'])]},
           'same_step': [x for x in g['same_step'] if len([r for r in x['routes'] if r in keep]) >= 2], 'same_script': [x for x in g['same_script'] if len([r for r in x['routes'] if r in keep]) >= 2]}
    return counts(sub)


def folded(xs, most_fields=12, outside=()):
    """Things as the page shows them: one line a thing, with the steps it is at, and a route's answer keys cut to
    `most_fields` (the count of the rest said). A step's repeats of one cookie are one line; a take nothing in the
    home gives is marked `outside`."""
    by, order, fields = {}, [], 0
    for x in xs:
        if x['thing'][0] == 'field':
            fields += 1
            if fields > most_fields: continue
        k = x['thing']
        if k not in by:
            by[k] = dict(thing_words(x), steps=[])
            by[k].pop('step', None)
            if k in outside: by[k]['outside'] = True
            order.append(k)
        if x.get('step') is not None and x['step'] not in by[k]['steps']: by[k]['steps'].append(x['step'])
    out = [by[k] for k in order]
    if fields > most_fields: out.append({'kind': 'field', 'name': '… %d more keys' % (fields - most_fields), 'steps': []})
    return out


def thing_words(x):
    kind, site, name = x['thing']
    out = {'kind': kind, 'name': name, 'step': x.get('step')}
    for k in ('place', 'how', 'why'):
        if x.get(k): out[k] = x[k]
    if x.get('secret'): out['secret'] = True
    return out


def sites(g):
    """Each site's routes and edges, counted: the overview's line a site, so the page loads a site's graph only when opened."""
    per = {}
    by_key = {n['key']: n['site'] for n in g['nodes']}
    by_key.update({d['key']: d['site'] for d in g['doors']})
    for n in g['nodes']: per.setdefault(n['site'], {'site': n['site'], 'routes': 0, 'edges': 0, 'findings': 0})['routes'] += 1
    for e in g['edges']:
        s = by_key.get(e['from'])
        if s == by_key.get(e['to']) and s in per: per[s]['edges'] += 1
    for f in g['findings']:
        s = by_key.get(f['route'])
        if s in per: per[s]['findings'] += 1
    return sorted(per.values(), key=lambda x: (-x['edges'], -x['findings'], -x['routes'], x['site']))


def merge(parts):
    """Several homes' graphs as one: their lists side by side, counted again. No edge is drawn between two homes."""
    if len(parts) == 1: return parts[0]
    g = {k: [x for p in parts for x in p[k]] for k in ('nodes', 'doors', 'edges', 'same_step', 'same_script', 'cycles', 'findings', 'unread')}
    g['outside'] = {k: v for p in parts for k, v in p['outside'].items()}
    g['costs'] = {k: [x for p in parts for x in (p.get('costs') or {}).get(k, [])] for k in ('same_step', 'givers')}
    g['counts'] = counts(g)
    return g


def read_setups(folder):
    """The setups a node keeps, one file a site: kind and the cookie names a choice earned. Never a step's value."""
    out = []
    try: names = sorted(n for n in os.listdir(folder) if n.endswith('.json'))
    except OSError: return out
    for n in names:
        try:
            with open(os.path.join(folder, n), encoding='utf-8') as f: xs = json.load(f)
        except (OSError, ValueError): continue
        for x in xs if isinstance(xs, list) else []:
            if isinstance(x, dict): out.append({'site': n[:-5], 'kind': x.get('kind'), 'earns': [c for c in x.get('earns') or [] if isinstance(c, str)]})
    return out


def call_times(path):
    """route id -> the times (seconds) of its calls, from the node's `made.jsonl` where the home keeps one."""
    out = {}
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                try: m = json.loads(line)
                except ValueError: continue
                if isinstance(m, dict) and m.get('route') and isinstance(m.get('at'), (int, float)):
                    out.setdefault(m['route'], []).append(m['at'] / 1000 if m['at'] > 1e11 else m['at'])
    except OSError: pass
    return out


def read_home(rdir, stored_gives=None):
    """Every route file of a routes folder, read into the graph. A file that does not read is listed, never dropped."""
    nodes, unread = [], []
    try: names = sorted(n for n in os.listdir(rdir) if n.endswith('.json'))
    except OSError: names = []
    for name in names:
        p = os.path.join(rdir, name)
        try:
            with open(p, encoding='utf-8') as f: r = json.load(f)
        except (OSError, ValueError) as e:
            unread.append({'file': name, 'why': type(e).__name__}); continue
        if not isinstance(r, dict) or not isinstance(r.get('graph'), dict):
            unread.append({'file': name, 'why': 'not a route'}); continue
        nodes.append(read_route(r, p, (stored_gives or {}).get(r.get('id'), ())))
    times = call_times(os.path.join(os.path.dirname(os.path.abspath(rdir)), 'made.jsonl'))
    for n in nodes: n['times'] = times.get(n['id'], [])
    g = build(nodes, read_setups(os.path.join(os.path.dirname(os.path.abspath(rdir)), 'setups')))
    g['unread'] = unread
    return g
