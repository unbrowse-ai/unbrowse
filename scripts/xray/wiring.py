#!/usr/bin/env python3
"""How every route is wired, drawn live: each hole of each request strung up to the layer its value comes from.

  wiring.py serve  [--home DIR | --ub-dir NODE]... [--matrix] [--runs N] [--log node.log] [--port P]   the live page
  wiring.py render [same] [--source] --out FILE                                       a snapshot (never into a repository)
  wiring.py state  [same] [--json]                                                    the state the page draws, as JSON
  wiring.py diff   <home A> <home B> [--json]                                         what changed; exit 1 on a new break

The live page reads `/overview` (a line a route, the totals, the pick) and `/route?key=` (one route's holes, when it is
opened); `/version` says when either moved. `/state` is every hole of a group at once, for agents and snapshots.

xray.sh is the front door: it fills in the scratch node ($UB_DIR), the checkout's engine and the rebuild's map. This is
the x-ray harness: route-xray.py's findings sit on the holes they are about, engine-map.py says which functions write
and branch on each kind, xray_why.py's WHY says which decide each finding, and xray_log.py reads the pick.

A home is a node's folder (`~/.unbrowse`, a scratch node's) or its `routes/` folder itself (`UNBROWSE_ROUTES`). With
`--matrix`, every matrix scratch home under $TMPDIR (`unbrowse-test-matrix-<row>-<pid>-<n>/`) is read too, one run
(one pid) to a group, newest first; a row's ceiling is read from `unbrowse-node/app/src/primitives/matrix.json`.

It reads route files (`routes/*.json`), `made.jsonl`, the node's log, the walks' captures and the engine's source, and
nothing else; standard library only, and asks no site. A
route is requests; each value a request sends is a hole; each hole has ways (`body.steps[].holes[].ways[]`, an
expression and its rung), or, for a route the classifier alone wrote, a class (`graph.steps[].fields[]`). The page
draws each hole on the bottom sheet and a string from it up to the layer its value comes from. Everything is derived
from the files: nothing about a site is typed here.

No secret leaves this file: a cookie or stored value is shown by name, a slot marked secret by name, fixed text over
40 characters, or shaped like a token, by its shape. A program's source is left out of the model; the live page
fetches it from 127.0.0.1 when asked, and `render` writes it only with `--source`.
"""
import argparse, glob, hashlib, html, http.server, importlib.util, json, os, re, subprocess, sys, threading, time, urllib.parse as U

HERE = os.path.dirname(os.path.abspath(__file__))
TOP = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import xray_log as G  # noqa: E402
import xray_why as Y  # noqa: E402
import xray_wire as XW  # noqa: E402


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# One catalogue: the findings are route-xray.py's own, asked of its code; the engine is read by engine-map.py.
X = _load('route_xray', 'route-xray.py')
M = _load('engine_map', 'engine-map.py')

E = html.escape

# ------------------------------------------------------------------------------------------------ the vocabulary
# The ops of `Expr` (unbrowse-node/crates/route/src/expr.rs, serde tag `op`, snake_case), as they stand on the branches
# that carry the crate today (learn-by-example's successors: converge-learners, gaps-site-code, gaps-vocabulary).
# `known_ops()` adds whatever the checkout's own expr.rs declares, so an op landed since is known without an edit here.
OPS = ('text', 'slot', 'given', 'cookie', 'stored', 'read', 'pick', 'fresh', 'stamp', 'file', 'sent', 'nothing', 'join',
       'slice', 'piece', 'written', 'wrapped', 'unwrapped', 'swap', 'hash', 'hmac', 'program', 'program_reading', 'solve',
       'format', 'lookup')
EXPR_RS = os.path.join(TOP, 'unbrowse-node', 'crates', 'route', 'src', 'expr.rs')

# The layers a value comes from, top to bottom. `page` is a way of rung 3 and up: the bundle, the kept page, the browser.
LAYERS = [
    ('caller', 'The caller', 'what the agent asks for'),
    ('answer', 'Earlier answers', 'a reply an earlier step got'),
    ('session', 'The session', 'cookies in the jar'),
    ('storage', 'Page storage', 'local and session storage'),
    ('clock', 'The clock', 'time and randomness, read anew'),
    ('script', 'The sending script', 'constants, tables, functions'),
    ('page', 'The page', 'bundle (r3), kept page (r4), browser (r5)'),
    ('person', 'A person', 'no route field marks one yet'),
    ('unknown', 'Unknown', 'an op or class this page does not know'),
]
RUNGS = {0: 'walk values', 1: 'a standard operation', 2: "the site's own function, in the sandbox", 3: 'the bundle', 4: 'the kept page', 5: 'the browser'}

# The classifier's classes (unbrowse-node/crates/learn/src/graph.rs `Class`, serde tag `class`): layer and rung.
CLASSES = {'input': ('caller', 0), 'piece': ('caller', 0), 'file': ('caller', 0), 'constant': ('fixed', 0),
           'derived': ('answer', 0), 'minted': ('session', 0), 'fresh': ('clock', 0), 'recipe': ('script', 1),
           'generated': ('script', 2), 'script': ('page', 3), 'computed': ('page', 5), 'unconfirmed': ('open', 0)}

# Where a route says nothing about which headers are its browser's own, a fixed header is folded by this rule: the
# headers the Fetch standard has the browser write itself. Stated in the page's legend.
BROWSER_RULE = ('sec-*', 'accept', 'accept-language', 'accept-encoding', 'user-agent', 'referer', 'origin', 'priority',
                'cache-control', 'pragma', 'upgrade-insecure-requests', 'dnt')

FLAGS = [
    ('open', 'open', 'a hole with no way: nothing the walks show makes it'),
    ('frozen', 'fixed, but it moves', "sent as fixed text, while the route says it moves: its sightings moved between walks; the classifier's graph of the same route strings it to a source; "
               "the route notes a tie; it equals a value an earlier reply or the page's storage held in the walk (shapes only); or it is a header shaped like a token on a step that follows a write the route left out "
               "(or, the route keeping no call before it, on a call the walk made after others)"),
    ('ceiling', 'above its ceiling', "the last call's rung is above the matrix row's ceiling"),
    ('browser', 'a browser ran', 'the last call ran a browser (made.jsonl)'),
    ('fell', 'fell to the browser', 'it answered without a browser before (made.jsonl), and the last call ran one'),
    ('under', 'rung under-reported', "the last call's rung is below the least the body can be filled at: the highest, over its holes, of each hole's cheapest way"),
    ('unknown', 'unknown op', 'an op (or a class) this page does not know is drawn in its own colour, never dropped'),
] + XW.FLAGS  # route to transport: what the last call put on the wire against the walk's browser (xray_wire.py)


def snake(name):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def ops_in_source(text):
    """The variant names of `pub enum Expr` in a Rust source, snake_cased as serde writes them."""
    m = re.search(r'pub enum Expr\s*\{', text)
    if not m: return set()
    depth, i, body = 1, m.end(), []
    while i < len(text) and depth:
        c = text[i]
        depth += c == '{'
        depth -= c == '}'
        body.append(c if depth == 1 else ' ' if c not in '{}' else c)
        i += 1
    flat = re.sub(r'\{[^{}]*\}', '{}', re.sub(r'//[^\n]*', '', ''.join(body)))
    return {snake(n) for n in re.findall(r'(?m)^\s*([A-Z][A-Za-z0-9]*)\s*(?:\{|\(|,|$)', flat)}


_KNOWN = None


def known_ops():
    global _KNOWN
    if _KNOWN is None:
        _KNOWN = set(OPS)
        try:
            with open(EXPR_RS) as f: _KNOWN |= ops_in_source(f.read())
        except OSError: pass
    return _KNOWN


# ------------------------------------------------------------------------------------------------ never a secret
def tokenish(s):
    """Shaped like a key, an id or a signature (long, no spaces, digits among letters, or long hex), or holding a word
    that is: `Bearer <token>` is a token."""
    words = str(s).split()
    if len(words) > 1: return any(tokenish(w) for w in words)
    return (len(s) >= 16 and not re.search(r'\s', s) and bool(re.search(r'\d', s)) and bool(re.search(r'[A-Za-z]', s))) or bool(re.fullmatch(r'[0-9a-fA-F]{16,}', s))


def idlike(s):
    """Shaped like an id something handed out: a key or a signature as route-xray reads one, or a run of eight or more
    letters and digits mixed (a media type, a language list or a version is not)."""
    return X.looks_minted(s) or any(re.search(r'\d', r) and re.search(r'[A-Za-z]', r) for r in re.findall(r'[A-Za-z0-9]{8,}', str(s)))


def shape(s):
    s = str(s)
    n = len(s)
    if n == 0: return 'empty'
    if re.fullmatch(r'\d+', s): return '%d digits' % n
    if re.fullmatch(r'[0-9a-fA-F]+', s): return '%d hex' % n
    if re.fullmatch(r'[A-Za-z]+', s): return '%d letters' % n
    if tokenish(s): return '%d chars, token-like' % n
    return '%d chars' % n


XW.tokenish, XW.shape = tokenish, shape


# The caller's words of the route being read (its slots' examples and choices, its inputs' walked values): a value of
# the route, so written `‹word›` wherever it shows, as route-xray.py and xray_log.py write it.
HUSH = set()


def caller_words(route):
    out = set()
    body = route.get('body') if isinstance(route.get('body'), dict) else {}
    vals = [s.get('example') for s in body.get('slots') or []] + [c for s in body.get('slots') or [] for c in s.get('choices') or []]
    vals += [i.get('default') for i in route.get('inputs') or [] if isinstance(i, dict)]
    for v in vals:
        v = '' if v is None else str(v)
        if len(v) >= 3 and not re.fullmatch(r'[\d.]+|true|false|null', v): out |= {v, U.quote(v), U.quote_plus(v)}
    return out


def hush(s):
    for w in sorted(HUSH, key=len, reverse=True):
        if w and w.lower() in s.lower(): s = re.sub(re.escape(w), '‹word›', s, flags=re.I)
    return s


XW.hush = lambda s: hush(s)


def fixed(s):
    """Fixed text as it may be shown: up to 40 characters and not shaped like a token, else its shape; a caller's word
    in it is written ‹word›."""
    s = '' if s is None else str(s)
    if HUSH:
        h = hush(s)
        if h != s: return json.dumps(h, ensure_ascii=False) if len(h) <= 60 and not tokenish(h.replace('‹word›', ' ')) else '‹%s, holding the caller\'s word›' % shape(s)
    # A number of six digits or more is a time, an id or a count of the walk: shown by its shape, like a token.
    if len(s) > 40 or tokenish(s) or re.search(r'\d{6,}', s): return '‹%s›' % shape(s)
    return json.dumps(s, ensure_ascii=False)


def cookie_value(s):
    return '‹a cookie value, %d chars›' % len(str(s or ''))


def safe_path(path):
    return '/'.join('‹%s›' % shape(p) if tokenish(p) else p for p in path.split('/'))


def raw_path(url):
    try: return U.unquote(U.urlsplit((url or '').replace('{', '%7B').replace('}', '%7D')).path or '/')
    except ValueError: return ''


def host_path(url):
    try: u = U.urlsplit((url or '').replace('{', '%7B').replace('}', '%7D'))
    except ValueError: return '', ''
    return u.hostname or '', safe_path(U.unquote(u.path or '/'))


# ------------------------------------------------------------------------------------------------ places
def place(at):
    """A body place (`{"in": "query", "key": "q"}`) as words, and its kind."""
    at = at or {}
    kind, key = at.get('in'), at.get('key')
    if kind == 'path': return 'path[%s]' % key, kind
    if kind == 'json': return 'body %s' % key, kind
    if kind == 'part': return 'part %s' % ' '.join(str(k) for k in (key or []) if k), kind
    if kind == 'url': return 'the address', kind
    return '%s %s' % (kind, '' if key is None else key), kind


def graph_place(loc):
    loc = loc or {}
    kind = loc.get('in')
    key = loc.get('key', loc.get('index', loc.get('pointer', loc.get('name'))))
    return place({'in': kind, 'key': key})


def browser_by_rule(label, kind):
    if kind != 'header': return False
    name = label.split(' ', 1)[1].lower() if ' ' in label else ''
    return name.startswith('sec-') or name in BROWSER_RULE


# ------------------------------------------------------------------------------------------------ expressions
class Ctx:
    def __init__(self, secrets=(), step_n=None, mask=False):
        self.secrets, self.step_n, self.mask = set(secrets), step_n or {}, mask
        self.layers, self.sent, self.reads, self.unknown, self.programs, self.rows = [], [], [], [], [], []

    def layer(self, name, why):
        self.layers.append((name, why))


def sent_words(part):
    part = part or {}
    of, key = part.get('of'), part.get('key')
    return '%s%s' % (of, (' ' + str(key)) if key is not None else '')


def at_words(at):
    at = at or {}
    f = at.get('from')
    if f == 'json': return 'json %s' % at.get('pointer')
    if f in ('header', 'set_cookie'): return '%s %s' % (f.replace('_', '-'), at.get('name'))
    if f == 'text': return 'text between markers'
    return str(f)


def evidence_words(ev):
    """What a program's evidence carries, with no value: producer script, sightings, who proposed it, hash."""
    if not isinstance(ev, dict): return []
    out = []
    p = ev.get('producer') or {}
    if p.get('script'):
        h, pth = host_path(p['script'])
        out.append('producer script %s%s%s%s' % (h, pth, (' at %s' % p['at']) if p.get('at') is not None else '', ', in a frame' if p.get('frame') else ''))
    if ev.get('header'): out.append('made for header %s' % ev['header'])
    if ev.get('sightings') is not None: out.append('held to %s sighting(s)%s' % (ev['sightings'], ', exactly' if ev.get('exact') else ''))
    if ev.get('proposed_by'): out.append('proposed by %s' % ev['proposed_by'])
    if ev.get('evidence_hash'): out.append('hash %s' % ev['evidence_hash'])
    for k, v in ev.items():
        if k not in ('producer', 'header', 'sightings', 'exact', 'proposed_by', 'evidence_hash') and isinstance(v, (int, float, bool)): out.append('%s %s' % (k, v))
    return out


def expr(e, ctx, depth=0):
    """(one line, lines of the tree) for an expression, with no value of a secret in either."""
    pad = '  ' * depth
    if not isinstance(e, dict) or 'op' not in e:
        ctx.unknown.append('not an expression')
        ctx.layer('unknown', 'not an expression')
        return 'unknown op ?', [pad + 'unknown op ? (not an expression)']
    op = e.get('op')
    kids = []

    def sub(k, label=None):
        one, tree = expr(e.get(k), ctx, depth + 1)
        kids.append(('  ' * (depth + 1) + label + ':') if label else None)
        kids.extend(tree)
        return one

    def tree(head, extra=()):
        return pad + head, [pad + head] + ['  ' * (depth + 1) + x for x in extra] + [k for k in kids if k]

    if op == 'text':
        s = e.get('is') or ''
        one = 'text %s' % ('‹a cookie value, %d chars›' % len(s) if ctx.mask else fixed(s))
        return one, [pad + one]
    if op in ('slot', 'given'):
        name = e.get('name')
        secret = name in ctx.secrets
        ctx.layer('caller', name)
        ex = '' if secret or e.get('or') is None else ', walked %s' % fixed(e.get('or'))
        one = '%s %s%s%s%s' % (op, name, ' (secret)' if secret else '', ', optional' if e.get('optional') else '', ex)
        return one, [pad + one]
    if op == 'cookie':
        ctx.layer('session', 'cookie ' + str(e.get('name')))
        one = 'cookie %s%s' % (e.get('name'), ', optional' if e.get('optional') else '')
        return one, [pad + one]
    if op == 'stored':
        ctx.layer('storage', '%s %s' % (e.get('area'), e.get('key')))
        one = 'stored %s %s' % (e.get('area'), e.get('key'))
        return one, [pad + one]
    if op == 'read':
        n = ctx.step_n.get(e.get('step'))
        ctx.layer('answer', '%s %s' % (e.get('step'), at_words(e.get('at'))))
        ctx.reads.append({'step': e.get('step'), 'n': n, 'what': at_words(e.get('at'))})
        one = 'read step %s%s, %s' % (e.get('step'), '' if n is None else ' (#%d)' % n, at_words(e.get('at')))
        return one, [pad + one]
    if op == 'pick':
        n = ctx.step_n.get(e.get('step'))
        ctx.layer('answer', '%s %s' % (e.get('step'), e.get('list')))
        ctx.reads.append({'step': e.get('step'), 'n': n, 'what': 'item of %s' % e.get('list')})
        fits = fits_words(e.get('fits'), ctx, depth + 1, kids)
        return tree('pick from step %s list %s the item where %s, take %s' % (e.get('step'), e.get('list'), fits, e.get('take')))
    if op == 'fresh':
        ctx.layer('clock', 'fresh ' + str(e.get('clock')))
        one = 'fresh %s id, read anew each call' % e.get('clock')
        return one, [pad + one]
    if op == 'stamp':
        ctx.layer('clock', 'stamp ' + str(e.get('form')))
        forms = ' '.join(re.findall(r'\{[a-z0-9_]+\}', e.get('form') or '')) or '?'
        one = 'stamp %s' % forms
        return one, [pad + one]
    if op == 'file':
        ctx.layer('caller', 'file ' + str(e.get('slot')))
        one = 'file %s %s' % (e.get('slot'), e.get('fact'))
        return one, [pad + one]
    if op == 'sent':
        w = sent_words(e.get('part'))
        ctx.sent.append(w)
        one = 'sent %s' % w
        return one, [pad + one]
    if op == 'nothing':
        one = 'nothing' + ((' after ' + str(e['after'])) if e.get('after') else '')
        return one, [pad + one]
    if op == 'join':
        parts = []
        for p in e.get('parts') or []:
            one, t = expr(p, ctx, depth + 1)
            parts.append(one)
            kids.extend(t)
        w = e.get('with') or ''
        line = 'join%s(%s)' % ((' with ' + fixed(w)) if w else '', ', '.join(parts[:5]) + (', … %d more' % (len(parts) - 5) if len(parts) > 5 else ''))
        return line, [pad + 'join%s' % ((' with ' + fixed(w)) if w else '')] + kids
    if op == 'slice':
        inner = sub('of')
        return 'slice(%s, %s+%s)' % (inner, e.get('from'), e.get('len')), tree('slice from %s, %s long, of' % (e.get('from'), e.get('len')))[1]
    if op == 'piece':
        inner = sub('of')
        return 'piece #%s split %s of %s' % (e.get('index'), fixed(e.get('split')), inner), tree('piece #%s, split on %s, of' % (e.get('index'), fixed(e.get('split'))))[1]
    if op in ('written', 'wrapped', 'unwrapped'):
        inner = sub('of')
        return '%s %s(%s)' % (op, e.get('how'), inner), tree('%s %s, of' % (op, e.get('how')))[1]
    if op == 'swap':
        was = e.get('was')
        within = sub('within', 'within') if isinstance(e.get('within'), dict) else fixed(e.get('within'))
        now = sub('now', 'now') if isinstance(e.get('now'), dict) else fixed(e.get('now'))
        inside = (' inside ' + str(e['inside'])) if e.get('inside') else ''
        return 'swap %s for %s in %s%s' % (fixed(was), now, within, inside), tree('swap the walked %s%s' % (fixed(was), inside))[1]
    if op in ('hash', 'hmac'):
        ctx.layer('script', '%s %s' % (op, e.get('algo')))
        key = sub('key', 'key') if op == 'hmac' else None
        of = sub('of', 'of')
        one = '%s(%s)' % (('hmac-%s' % e.get('algo')) if op == 'hmac' else e.get('algo'), of + ((', key ' + key) if key else ''))
        return one, tree('%s %s' % (op, e.get('algo')))[1]
    if op in ('program', 'program_reading'):
        ctx.layer('script', op)
        src = e.get('source') or ''
        ev = evidence_words(e.get('evidence'))
        ctx.programs.append({'op': op, 'bytes': len(src.encode()), 'evidence': ev, 'source': src})
        reads = []
        for feed in e.get('reads') or []:
            r = feed.get('read') or {}
            one, t = expr(feed.get('from'), ctx, depth + 2)
            reads.append('%s %s <- %s' % (r.get('of'), r.get('key') or '', one))
        head = '%s, %d bytes of source%s' % (op.replace('_', ' '), len(src.encode()), (' reading ' + '; '.join(reads)) if reads else '')
        return head, [pad + head] + ['  ' * (depth + 1) + 'evidence: ' + x for x in ev]
    if op == 'solve':
        ctx.layer('script', 'solve ' + str(e.get('algo')))
        before = sub('before', 'before')
        after = sub('after', 'after') if isinstance(e.get('after'), dict) else ''
        one = 'solve %s: least count with %s leading zeros over %s + count%s' % (e.get('algo'), e.get('zeros'), before, (' + ' + after) if after else '')
        return one, tree('solve %s, %s leading zero hex digits' % (e.get('algo'), e.get('zeros')))[1]
    if op == 'format':
        inner = sub('of')
        rd, wr = e.get('read') or {}, e.get('write') or {}
        one = 'format %s read as %s %s, written %s' % (inner, rd.get('as'), rd.get('form'), wr.get('form'))
        return one, tree('format: read as %s %s, write %s %s' % (rd.get('as'), rd.get('form'), wr.get('as'), wr.get('form')))[1]
    if op == 'lookup':
        ctx.layer('script', 'a table of %d rows' % len(e.get('rows') or []))
        rows = e.get('rows') or []
        cols = sorted({k for r in rows if isinstance(r, dict) for k in r})
        fits = fits_words(e.get('fits'), ctx, depth + 1, kids)
        one = 'lookup in a table of %d rows (%s) where %s, take %s' % (len(rows), ', '.join(cols), fits, e.get('take'))
        return one, tree(one)[1]
    # An op this page does not draw. Known to the source: drawn generically. Not known: drawn as unknown.
    nested = [(k, v) for k, v in e.items() if k != 'op' and isinstance(v, dict) and 'op' in v]
    for k, v in nested: sub(k, k)
    if op not in known_ops():
        ctx.unknown.append(str(op))
        ctx.layer('unknown', str(op))
        head = 'unknown op %s' % op
    else:
        head = '%s (%s)' % (op, ', '.join(k for k in e if k != 'op'))
    return head, tree(head, ['fields: ' + ', '.join(k for k in e if k != 'op')])[1]


def fits_words(f, ctx, depth, kids):
    f = f or {}
    if isinstance(f.get('is'), dict):
        one, t = expr(f['is'], ctx, depth)
        kids.extend(t)
    else: one = fixed(f.get('is'))
    return '%s %s %s' % (f.get('at'), f.get('when'), one)


# ------------------------------------------------------------------------------------------------ a route, from body
def exchange_of(step_id):
    """A body's step is named for the walk's call it was cut from (`x2`: the walk's call #2)."""
    m = re.fullmatch(r'x(\d+)', str(step_id or ''))
    return int(m.group(1)) if m else None


def tied_words(t):
    """A `tied` note as words, with no value: what it is tied to (a step, a place), never what it holds."""
    if not t: return None
    if isinstance(t, dict):
        bits = []
        if t.get('step') is not None: bits.append('step %s' % t['step'])
        if isinstance(t.get('at'), dict): bits.append(at_words(t['at']))
        for k in ('from', 'kind', 'how'):
            if isinstance(t.get(k), str) and len(t[k]) <= 24 and not tokenish(t[k]): bits.append('%s %s' % (k, t[k]))
        return 'tied to ' + (', '.join(bits) if bits else 'an earlier value')
    if isinstance(t, list): return '; '.join(filter(None, (tied_words(x) for x in t))) or None
    return 'tied (the route notes it)'


def person_mark(h, sightings):
    """A person's hand, where the route says so: a `person` or `door` field on the hole, or a sighting from one. No route
    field marks one yet; when one does, it is read here and the legend says so."""
    for k in ('person', 'door'):
        v = h.get(k)
        if v: return k if v is True else '%s: %s' % (k, v if isinstance(v, str) and len(v) <= 40 and not tokenish(v) else 'marked')
    if any(x.get('from') in ('person', 'door') for x in sightings): return 'a sighting says a person made it'
    return None


def camel(op):
    return ''.join(p.capitalize() for p in str(op).split('_'))


def kinds_of_ways(ways):
    """The engine's kinds a hole's ways are made of: each op as `Expr::<Op>`, as engine-map.py names them."""
    out = []
    for w in ways:
        for o in Y.ops_of(w.get('expr')):
            k = 'Expr::' + camel(o.get('op'))
            if k not in out: out.append(k)
    return out


def sig(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def from_body(route, body):
    HUSH.clear()
    HUSH.update(caller_words(route))
    secrets = {s.get('name') for s in body.get('slots') or [] if s.get('secret')}
    steps_in = body.get('steps') or []
    step_n = {s.get('id'): i + 1 for i, s in enumerate(steps_in)}
    answer = body.get('answer') or {}
    # Sightings by step and place: each walk's `from` and shape.
    seen = {}
    for t in body.get('tests') or []:
        for w, sg in enumerate(t.get('sightings') or []):
            for s in sg.get('seen') or []:
                label, _ = place(s.get('at'))
                sh = s.get('shape') or {}
                seen.setdefault((t.get('step'), label), []).append({'walk': w + 1, 'from': s.get('from'), 'shape': '%s %s' % (sh.get('len'), sh.get('of')), 'tied': tied_words(s.get('tied'))})
    tests = {t.get('step'): t for t in body.get('tests') or []}
    steps = []
    for i, s in enumerate(steps_in):
        host, path = host_path(s.get('url'))
        holes = []
        for h in s.get('holes') or []:
            label, kind = place(h.get('at'))
            ways = []
            hole_ctx = None
            for w in h.get('ways') or []:
                ctx = Ctx(secrets, step_n, mask=kind == 'cookie')
                one, tree = expr(w.get('expr'), ctx)
                hole_ctx = hole_ctx or ctx
                ways.append({'rung': w.get('rung', 0), 'line': one.strip(), 'tree': '\n'.join(tree), 'layers': sorted({l for l, _ in ctx.layers}),
                             'unknown': ctx.unknown, 'programs': [{k: v for k, v in p.items() if k != 'source'} for p in ctx.programs],
                             '_sources': [p['source'] for p in ctx.programs]})
            first = hole_ctx or Ctx()
            sightings = seen.get((s.get('id'), label), [])
            pure_text = bool(ways) and ways[0]['line'].startswith('text ') and not first.layers and not first.sent
            layers = []
            for l, why in first.layers:
                if l not in [x['layer'] for x in layers]: layers.append({'layer': l, 'why': why})
            if ways and not layers and not pure_text and ways[0]['rung'] >= 3: layers.append({'layer': 'page', 'why': RUNGS.get(ways[0]['rung'], '')})
            browser_seen = bool(sightings) and all(x['from'] == 'browser' for x in sightings)
            fold = None
            if pure_text and browser_seen: fold = 'sightings'
            elif pure_text and browser_by_rule(label, kind): fold = 'rule'
            person = person_mark(h, sightings)
            if person and 'person' not in [x['layer'] for x in layers]: layers.append({'layer': 'person', 'why': person})
            tied = [t for t in [tied_words(h.get('tied'))] + [tied_words(w.get('tied')) for w in h.get('ways') or []] + [x['tied'] for x in sightings] if t]
            first_expr = ((h.get('ways') or [{}])[0] or {}).get('expr') or {}
            holes.append({'place': label, 'in': kind, 'ways': ways, 'layers': layers, 'sent': first.sent, 'reads': first.reads, 'open': bool(h.get('open')) or not ways,
                          'fixed': pure_text, 'fold': fold, 'over': bool(h.get('over')), 'sightings': sightings, 'rung': min((w['rung'] for w in ways), default=None), 'flags': [],
                          'tied': tied, 'kinds': kinds_of_ways(h.get('ways') or []), 'findings': [],
                          '_value': first_expr.get('is') if pure_text and first_expr.get('op') == 'text' else None})
        t = tests.get(s.get('id')) or {}
        steps.append({'id': s.get('id'), 'n': i + 1, 'exchange': exchange_of(s.get('id')), '_path': raw_path(s.get('url')), 'findings': [], 'method': s.get('method'), 'host': host, 'path': path, 'page': bool(s.get('page')), 'writes': bool(s.get('writes')),
                      'on_load': bool(s.get('on_load')), 'sets_cookie': bool(s.get('sets_cookie')), 'answer': s.get('id') == answer.get('step'),
                      'script': host_path((s.get('script') or {}).get('origin'))[0] if s.get('script') else None, 'body': (s.get('body') or {}).get('kind') if isinstance(s.get('body'), dict) else None,
                      'over_scripts': len(t.get('over_scripts') or []), 'walks': len(t.get('sightings') or []), 'holes': holes})
    dec = answer.get('decode')
    plan = body.get('plan') or {}
    return {'by': 'body', 'steps': steps, 'slots': [{'name': s.get('name'), 'secret': bool(s.get('secret')),
                                                     'example': None if s.get('secret') or s.get('example') is None else fixed(s.get('example'))} for s in body.get('slots') or []],
            'answer': {'step': answer.get('step'), 'page': bool(answer.get('page')), 'decode': None if not dec else {'bytes': len((dec.get('source') or '').encode()), 'evidence': evidence_words(dec.get('evidence'))}},
            '_decode_source': (dec or {}).get('source'),
            'plan': {'goal': plan.get('goal'), 'page': ''.join(host_path(plan.get('page'))), 'asked': [{'slot': a.get('slot'), 'by': a.get('by')} for a in plan.get('asked') or []]} if plan else None}


# ------------------------------------------------------------------------------------------------ a route, from graph
def from_graph(route):
    HUSH.clear()
    HUSH.update(caller_words(route))
    g = route.get('graph') or {}
    steps_in = g.get('steps') or []
    by_exchange = {s.get('exchange'): i + 1 for i, s in enumerate(steps_in)}
    secrets = {f.get('name') for s in steps_in for f in s.get('fields') or [] if f.get('class') == 'input' and f.get('secret')}
    steps = []
    for i, s in enumerate(steps_in):
        host, path = host_path(s.get('url'))
        holes = []
        for f in s.get('fields') or []:
            label, kind = graph_place(f.get('loc'))
            cls = f.get('class') if isinstance(f.get('class'), str) else json.dumps(f.get('class'))[:40]
            layer, rung = CLASSES.get(cls, ('unknown', 0))
            reads, sent, layers, unknown, programs, sources = [], [], [], [], [], []
            if cls == 'input':
                secret = bool(f.get('secret'))
                line = 'input %s%s%s' % (f.get('name'), ' (secret)' if secret else '', '' if secret or f.get('default') is None else ', walked %s' % fixed(f.get('default')))
            elif cls == 'piece': line = 'piece of input %s, %s+%s' % (f.get('input'), f.get('from'), f.get('len'))
            elif cls == 'file': line = 'file %s %s' % (f.get('name'), f.get('of'))
            elif cls == 'constant':
                o = f.get('origin') or {}
                line = 'constant %s%s' % (cookie_value(f.get('value')) if kind == 'cookie' else fixed(f.get('value')), (', seen at exchange %s' % o.get('exchange')) if isinstance(o, dict) and o.get('exchange') is not None else '')
            elif cls == 'derived':
                o = f.get('origin') or {}
                n = by_exchange.get(o.get('exchange'))
                oh, op_ = host_path(o.get('url'))
                what = at_words(o.get('at'))
                reads.append({'step': o.get('exchange'), 'n': n, 'what': what})
                line = 'derived from %s, %s%s' % ('step #%d' % n if n else 'exchange %s (not a step of the route)' % o.get('exchange'), what, (' of %s%s' % (oh, op_)) if not n else '')
            elif cls == 'minted': line = 'minted %s, from the session' % f.get('name')
            elif cls == 'fresh': line = 'fresh %s id, read anew each call' % f.get('clock')
            elif cls == 'recipe':
                r = f.get('recipe') or {}
                parts = []
                for p in r.get('parts') or []:
                    w = '%s %s' % (p.get('part'), p.get('name') or p.get('key') or '')
                    if p.get('part') in ('header', 'query', 'cookie', 'body', 'path', 'method'): sent.append(w.strip())
                    parts.append(w.strip())
                line = 'recipe %s over %s, joined %s' % (r.get('algo'), ', '.join(parts), fixed(r.get('separator') or ''))
            elif cls == 'generated':
                src = f.get('program') or ''
                ev = evidence_words(f.get('evidence'))
                programs.append({'op': 'generated', 'bytes': len(src.encode()), 'evidence': ev})
                sources.append(src)
                line = 'generated program, %d bytes of source' % len(src.encode())
            elif cls == 'script': line = "script: the page's producer, run by the transport"
            elif cls == 'computed': line = "computed: only a browser makes it"
            elif cls == 'unconfirmed': line = 'unconfirmed: seen once, %s, sent as walked' % (cookie_value(f.get('value')) if kind == 'cookie' else fixed(f.get('value')))
            else:
                unknown.append('class ' + cls)
                line = 'unknown class %s' % cls
            if layer not in ('fixed', 'open'):
                why = {'derived': ('#%s %s' % (reads[0]['n'] or reads[0]['step'], reads[0]['what'])) if reads else cls, 'minted': 'cookie %s' % f.get('name') if kind == 'cookie' else 'minted %s' % f.get('name'),
                       'input': 'input %s' % f.get('name')}.get(cls, cls)
                layers.append({'layer': layer, 'why': why})
            pure = cls == 'constant'
            fold = None
            if pure and browser_by_rule(label, kind): fold = 'rule'
            elif pure and kind == 'path': fold = 'address'
            way = {'rung': rung, 'line': line, 'tree': line + ''.join('\n  evidence: ' + e for p in programs for e in p['evidence']), 'layers': [l['layer'] for l in layers], 'unknown': unknown,
                   'programs': programs, '_sources': sources, 'class': cls}
            person = person_mark(f, [])
            if person: layers.append({'layer': 'person', 'why': person})
            holes.append({'place': label, 'in': kind, 'ways': [way], 'layers': layers, 'sent': sent, 'reads': reads, 'open': cls == 'unconfirmed', 'fixed': pure, 'fold': fold,
                          'over': False, 'sightings': [], 'rung': rung, 'class': cls, 'flags': [], 'findings': [], 'tied': [t for t in [tied_words(f.get('tied'))] if t],
                          'kinds': ['Class::' + cls.capitalize()] + (['Held'] if any((hd.get('loc') or {}) == f.get('loc') for hd in s.get('held') or []) else []),
                          '_value': f.get('value') if cls in ('constant', 'unconfirmed') else None})
        steps.append({'id': s.get('exchange'), 'n': i + 1, 'exchange': s.get('exchange') if isinstance(s.get('exchange'), int) else None, 'findings': [], '_path': raw_path(s.get('url')),
                      'method': s.get('method'), 'host': host, 'path': path, 'page': bool(s.get('needs_browser')), 'writes': False,
                      'on_load': bool(s.get('on_load')), 'sets_cookie': bool(s.get('sets_cookie')), 'answer': i == len(steps_in) - 1, 'script': None, 'body': None,
                      'over_scripts': 0, 'walks': 0, 'status': s.get('status'), 'holes': holes})
    return {'by': 'graph', 'steps': steps, 'slots': [{'name': i.get('name'), 'secret': i.get('name') in secrets, 'example': None if i.get('name') in secrets or i.get('default') is None else fixed(i.get('default'))}
                                                     for i in route.get('inputs') or [] if isinstance(i, dict)],
            'answer': {'step': len(steps_in), 'page': False, 'decode': None}, 'plan': None}


# ------------------------------------------------------------------------------------------------ flags
def floor_of(model):
    """The least rung the body can be filled at: the highest, over its holes, of each hole's cheapest way."""
    rungs = [h['rung'] for s in model['steps'] for h in s['holes'] if h['rung'] is not None]
    return max(rungs) if rungs else 0


def step_key(s):
    return (str(s.get('method')).upper(), s.get('host'), s.get('path'))


WRITES = ('POST', 'PUT', 'PATCH', 'DELETE')


def left_out_writes(model, step, graph, walk):
    """The writes the walk made before `step` that the drawn route does not send: from the route's own graph (its steps
    carry the walk's call numbers), and, with the walk's capture in hand, from the walk itself. Words only."""
    out = []
    kept = {step_key(s) for s in model['steps']}
    kept_x = {s.get('exchange') for s in model['steps'] if s.get('exchange') is not None}
    e = step.get('exchange')
    for gs in (graph or {}).get('steps') or []:
        if str(gs.get('method')).upper() in WRITES and step_key(gs) not in kept and gs.get('exchange') not in kept_x and (e is None or gs.get('exchange') is None or gs['exchange'] < e):
            out.append("%s %s%s, the walk's call #%s, in the route's own graph" % (gs['method'], gs['host'], gs['path'], gs.get('exchange')))
    for c in (walk or {}).get('writes_before', lambda st: [])(step):
        w = '%s %s%s' % (c['method'], c['host'], c['path'])
        if (str(c['method']).upper(), c['host'], c['path']) not in kept and not any(o.startswith(w) for o in out): out.append(w + ', in the walk')
    return out


def frozen_evidence(model, s, h, graph, gplaces, walk):
    """Why a hole sent as fixed text moves, each a rule read from what the route (and its walk, where in hand) carries."""
    out = []
    shapes = {(x['from'], x['shape']) for x in h['sightings']}
    if len(shapes) > 1 and h['fold'] != 'sightings':
        out.append('its sightings moved between walks: ' + '; '.join('walk %d %s %s' % (x['walk'], x['from'], x['shape']) for x in h['sightings']))
    g = gplaces.get((step_key(s), h['place']))
    if g and g.get('class') not in ('constant', 'unconfirmed', None) and g['layers']:
        out.append("the classifier's graph of this route has it %s (%s)" % (g['class'], g['ways'][0]['line']))
    for t in h.get('tied') or []: out.append('the route notes it: %s' % t)
    v = h.get('_value')
    if walk and isinstance(v, str) and len(v) >= 6:
        out += walk['held_before'](s, v)
    if h['in'] == 'header' and not h['fold'] and isinstance(v, str) and idlike(v):
        ws = left_out_writes(model, s, graph, walk)
        if ws: out.append('a header shaped like a token, on a step that follows %s the route left out: %s' % ('a write' if len(ws) == 1 else '%d writes' % len(ws), '; '.join(ws[:4]) + ('; …' if len(ws) > 4 else '')))
        if not out and s.get('exchange') and not any((o.get('exchange') or 0) < s['exchange'] for o in model['steps'] if o is not s and o.get('exchange') is not None):
            out.append("a header shaped like a token, on the walk's call #%d, and the route keeps none of the calls before it (one of them may have handed it out, or it is made anew for each call)" % s['exchange'])
    return out


def merge_flags(h):
    """One flag of each kind on a hole, its reasons joined."""
    by = {}
    for f in h['flags']:
        if f['kind'] in by: by[f['kind']]['why'] += '; and ' + f['why']
        else: by[f['kind']] = dict(f)
    h['flags'] = list(by.values())


def flag(model, made, ceiling, graph=None, walk=None, calls=()):
    """Each flag is a rule read from the files. Marks the holes and the route; `recount` adds them up."""
    gplaces = {}
    if graph:
        for gs in graph['steps']:
            for gh in gs['holes']: gplaces[(step_key(gs), gh['place'])] = gh
    for s in model['steps']:
        for h in s['holes']:
            if h['open']:
                h['flags'].append({'kind': 'open', 'why': 'no way: nothing the walks show makes it' if not h['ways'] else 'marked open: seen with no source, sent as walked'})
            if any(w['unknown'] for w in h['ways']):
                h['flags'].append({'kind': 'unknown', 'why': 'unknown: ' + ', '.join(sorted({u for w in h['ways'] for u in w['unknown']}))})
            if h['fixed']:
                evs = frozen_evidence(model, s, h, graph if model['by'] == 'body' else model, gplaces, walk)
                if evs: h['flags'].append({'kind': 'frozen', 'why': 'sent as fixed text, and ' + '; and '.join(evs), 'evidence': evs})
            merge_flags(h)
    route_flags = []
    if made:
        r = made.get('rung')
        if made.get('browser'):
            route_flags.append({'kind': 'browser', 'why': 'the last call ran a browser'})
            plain = [c for c in calls[:-1] if c.get('ok') and not c.get('browser')]
            if plain: route_flags.append({'kind': 'fell', 'why': 'it answered without a browser %d time(s) before (last at rung %s); the last call fell to the browser' % (len(plain), plain[-1].get('rung'))})
        if ceiling and ceiling.get('value') is not None and isinstance(r, int) and r > ceiling['value']:
            route_flags.append({'kind': 'ceiling', 'why': 'the last call reached rung %d; its row (%s) has ceiling %d' % (r, ceiling.get('row'), ceiling['value'])})
        fl = floor_of(model)
        if model['by'] == 'body' and isinstance(r, int) and r < fl:
            route_flags.append({'kind': 'under', 'why': 'the last call logged rung %d; the body cannot be filled below rung %d' % (r, fl)})
    model['route_flags'] = route_flags
    return recount(model)


def recount(model):
    """The route's counts, as drawn: a flag kind counts each hole that has it once, and each route-level flag once; a
    finding counts once wherever it is drawn (a hole, a step, the route). `flags` lists every kind the route has."""
    counts = {k: 0 for k, _, _ in FLAGS}
    for s in model['steps']:
        for h in s['holes']:
            for f in h['flags']: counts[f['kind']] = counts.get(f['kind'], 0) + 1
    for f in model.get('route_flags') or []: counts[f['kind']] = counts.get(f['kind'], 0) + 1
    out = [dict(f, on='route', n=1) for f in model.get('route_flags') or []]
    names = {k: n for k, n, _ in FLAGS}
    for k, _, _ in FLAGS:
        n = sum(1 for s in model['steps'] for h in s['holes'] if any(f['kind'] == k for f in h['flags']))
        if n: out.append({'kind': k, 'on': 'holes', 'n': n, 'why': '%d hole(s): %s' % (n, names[k])})
    model['flags'] = out
    model['counts'] = counts
    found = [f for s in model['steps'] for h in s['holes'] for f in h.get('findings') or []] + [f for s in model['steps'] for f in s.get('findings') or []] + list(model.get('findings') or [])
    model['found'] = {lv: sum(1 for f in found if f['level'] == lv) for lv in X.LEVELS}
    return counts


# ------------------------------------------------------------------------------------------------ the walk's capture
CONTEXTS = ('worker', 'service_worker', 'shared_worker', 'iframe')
CALLS = ('Fetch', 'XHR', 'EventSource', 'WebSocket', 'Ping', 'Other')
ALONE = ('Document', 'Stylesheet', 'Image', 'Font', 'Media')  # what the document loads by itself: no page code sets a header there


def own_url(u):
    """An address on the network (the page's calls are among these)."""
    return bool(u) and bool(re.match(r'(https?|wss?):', u))


def browsers_page(u):
    """An address of the browser's own pages (its new-tab page, its tools): what runs there is not the page's."""
    return bool(re.match(r'(chrome|chrome-untrusted|chrome-search|chrome-extension|devtools|edge):', u or ''))


def initiator_urls(i):
    """Every address an initiator names: its own and each frame of its stack."""
    if not isinstance(i, dict): return []
    out = [i['url']] if i.get('url') else []
    for f in i.get('frames') or []:
        if isinstance(f, dict) and f.get('url'): out.append(f['url'])
    st = i.get('stack') or {}
    for f in (st.get('callFrames') or []) if isinstance(st, dict) else []:
        if isinstance(f, dict) and f.get('url'): out.append(f['url'])
    return out


def json_leaves(text, most=4000):
    """{string leaf: pointer} of a JSON text, strings of 6 to 400 characters, at most `most` of them."""
    try: o = json.loads(text)
    except (ValueError, TypeError): return {}
    out = {}

    def go(x, p):
        if len(out) >= most: return
        if isinstance(x, dict):
            for k, v in x.items(): go(v, p + '/' + str(k))
        elif isinstance(x, list):
            for i, v in enumerate(x[:200]): go(v, p + '/%d' % i)
        elif isinstance(x, (str, int)) and not isinstance(x, bool):
            t = str(x)
            if 6 <= len(t) <= 400 and t not in out: out[t] = p or '/'
    go(o, '')
    return out


class Capture:
    """A walk's capture (`<node>/tmp/unbrowse-node-walks/learn_<walk>*.jsonl`), read for what it says of the route and
    the walk: which replies and storage held a value earlier (said by place, never by value), which writes the walk made,
    which headers the browser sent by itself, and whether a worker or frame the page started made any call."""

    def __init__(self, files):
        self.requests, self.replies, self.storage, self.contexts, self.said_context, self.page = [], {}, [], {}, False, None
        # What Chrome's network stack put on the wire for a request (`request_extra`: cookies, client hints, pseudo-
        # headers), and each reply's status, by (walk, request id): read by xray_wire for the transport's columns.
        self.extra, self.status = {}, {}
        for f in files:
            try:
                with open(f, encoding='utf-8', errors='replace') as fh: lines = fh.readlines()
            except OSError: continue
            walk = os.path.basename(f)
            for line in lines:
                try: e = json.loads(line)
                except ValueError: continue
                t = e.get('type')
                if 'context' in e: self.said_context = True
                ctx = e.get('context')
                if t == 'mint' and not self.page: self.page = e.get('url')
                if t == 'script' and ctx in CONTEXTS:
                    c = self.contexts.setdefault(ctx, {'scripts': 0, 'frames': {}})
                    c['scripts'] += not browsers_page(e.get('url'))
                    c['internal'] = c.get('internal', False) or browsers_page(e.get('url'))
                if t == 'request' and ctx in CONTEXTS:
                    # A frame is the browser's own (its new-tab page, say) where its calls trace back to a browser page.
                    preflight = isinstance(e.get('initiator'), dict) and e['initiator'].get('type') == 'preflight'
                    if not preflight:  # a preflight is the browser's, sent before a call: it says nothing of who called
                        c = self.contexts.setdefault(ctx, {'scripts': 0, 'frames': {}})
                        fr = c['frames'].setdefault(e.get('frameId') or '', {'calls': 0, 'loads': 0, 'internal': False})
                        fr['internal'] = fr['internal'] or browsers_page(e.get('url')) or any(browsers_page(u) for u in initiator_urls(e.get('initiator')))
                        fr['calls' if e.get('resourceType') in CALLS else 'loads'] += 1
                if t == 'request' and own_url(e.get('url')):
                    u = U.urlsplit(e.get('url') or '')
                    rq = {'walk': walk, 't': e.get('t') or 0, 'id': e.get('requestId'), 'method': str(e.get('method') or 'GET').upper(), 'host': u.hostname or '', 'path': U.unquote(u.path or '/'),
                          'kind': e.get('resourceType'), 'context': ctx, 'frame': (ctx, e.get('frameId') or ''), 'by': ((e.get('initiator') or {}).get('type') if isinstance(e.get('initiator'), dict) else None),
                          'internal': any(browsers_page(u) for u in initiator_urls(e.get('initiator'))),
                          'headers': {str(k).lower(): str(v) for k, v in (e.get('headers') or {}).items()}}
                    self.requests.append(rq)
                elif t == 'request_extra' and isinstance(e.get('headers'), dict):
                    self.extra[(walk, e.get('requestId'))] = {str(k): str(v) for k, v in e['headers'].items()}
                if t == 'response' and isinstance(e.get('status'), int):
                    self.status[(walk, e.get('requestId'))] = e['status']
                if t == 'response' and isinstance(e.get('body'), str):
                    self.replies[(walk, e.get('requestId'))] = (e.get('t') or 0, json_leaves(e['body']))
                elif t in ('origin_storage', 'storage'):
                    for area in ('local', 'session'):
                        for k, v in (e.get(area) or {}).items():
                            self.storage.append((area, str(k), str(v), json_leaves(v) if isinstance(v, str) and v[:1] in '{[' else {}))
        # What the browser's own frames sent is not the page's: left out of every reading below.
        theirs = {(ctx, fid) for ctx, c in self.contexts.items() for fid, f in c['frames'].items() if f['internal']}
        self.requests = [r for r in self.requests if not r['internal'] and r['frame'] not in theirs and r['by'] != 'preflight']
        self.by_id = {(r['walk'], r['id']): r for r in self.requests}

    def first_call(self, step):
        """The walk's first request that is this step's: its method, host and path (a templated piece matches any)."""
        segs = str(step.get('_path') or '').split('/')
        for r in self.requests:
            if r['method'] != str(step.get('method') or 'GET').upper() or r['host'] != step.get('host'): continue
            rs = r['path'].split('/')
            if len(rs) == len(segs) and all(a == b or '{' in a for a, b in zip(segs, rs)): return r
        return None

    def held_before(self, step, value):
        me = self.first_call(step)
        out = []
        for (walk, rid), (t, leaves) in self.replies.items():
            if me and (walk != me['walk'] or t >= me['t']): continue
            if value in leaves:
                rq = self.by_id.get((walk, rid)) or {}
                out.append('it equals %s of the reply to %s %s%s%s' % (leaves[value], rq.get('method', '?'), rq.get('host', ''), safe_path(rq.get('path', '')), ', earlier in the walk' if me else ', in the walk'))
                break
        for area, key, v, leaves in self.storage:
            if value == v or value in leaves:
                out.append("it equals what the page's %s storage held under %s%s" % (area, '‹%s›' % shape(key) if tokenish(key) else key, (' at ' + leaves[value]) if value in leaves and value != v else ''))
                break
        return out

    def writes_before(self, step):
        me = self.first_call(step)
        return [{'method': r['method'], 'host': r['host'], 'path': safe_path(r['path'])} for r in self.requests
                if r['method'] in WRITES and (not me or (r['walk'] == me['walk'] and r['t'] < me['t']))]

    def browsers_own(self):
        """The header names the browser sent by itself (on what the document loads, where no page code sets a header),
        or None where the capture holds no such request (then the name list stands, and the legend says so)."""
        alone = [r for r in self.requests if r['kind'] in ALONE or (r['by'] == 'parser' and r['kind'] not in CALLS)]
        if not alone: return None
        return {k for r in alone for k in r['headers']}

    def early(self):
        """Whether a worker or frame the page started made no call (the walk ended before it did), in words."""
        if not self.requests: return None
        if not self.said_context: return 'the capture does not say which context sent each call, so it cannot tell whether a worker or frame of the page called'
        words = []
        for ctx, c in sorted(self.contexts.items()):
            what = {'iframe': 'a frame', 'worker': 'a worker', 'service_worker': 'a service worker', 'shared_worker': 'a shared worker'}[ctx]
            page = [f for f in c['frames'].values() if not f['internal'] and f['calls'] + f['loads']]
            mine = [f for f in c['frames'].values() if f['internal']]
            calls = sum(f['calls'] for f in page)
            if calls: words.append('%s of the page made %d call(s)' % (what, calls))
            elif page or (c['scripts'] and not mine and not c.get('internal')):
                words.append('the page started %s (%d script(s) ran, %d load(s)) and the trace holds no call from it: the walk ended before it called' % (what, c['scripts'], sum(f['loads'] for f in page)))
            elif mine: words.append("%s of the browser's own (its calls trace back to a browser page) ran; it is not the page's" % what)
        return '; '.join(words) or 'no worker or frame of the page ran in the walk'


def capture_files(folder, walk):
    if not folder or not walk: return []
    return sorted(glob.glob(os.path.join(folder, 'learn_%s*.jsonl' % glob.escape(str(walk)))))


# ------------------------------------------------------------------------------------------------ the engine
class Engine:
    """The engine's source, read by engine-map.py: the checkout the harness is run from, as it stands (uncommitted edits
    included), read again when a source file changes; and the rebuild from a map xray.sh made (`--map`)."""
    FOLDERS = ('crates/learn/src', 'crates/route/src', 'app/src')

    def __init__(self, root=None, mapfile=None):
        self.root, self.mapfile, self.stamp, self.tree, self.lock = root or TOP, mapfile, None, None, threading.Lock()
        self.rebuild, self.checked = None, 0
        if mapfile:
            try:
                with open(mapfile) as f: self.rebuild = json.load(f).get('rebuild')
            except (OSError, ValueError): pass

    def files(self):
        base = os.path.join(self.root, 'unbrowse-node')
        out = []
        for folder in self.FOLDERS:
            for d, _, names in os.walk(os.path.join(base, folder)):
                out += [os.path.join(d, n) for n in names if n.endswith('.rs')]
        return sorted(out)

    def running(self, at_most_every=0):
        """The running engine's map, read again when a source file moved. `at_most_every`: seconds to trust the last
        look (the page's poll asks every second or so; a read for a route always looks)."""
        with self.lock:
            if not os.path.isdir(os.path.join(self.root, 'unbrowse-node')): return None
            if self.tree is not None and time.time() - self.checked < at_most_every: return self.tree
            self.checked = time.time()
            st = sig(stamp_of(self.files()))
            if st != self.stamp:
                tree = M.read_tree(self.root)
                try:
                    tip = subprocess.run(['git', '-C', self.root, 'log', '-1', '--format=%h, %cd', '--date=format:%d %b %H:%M'], capture_output=True, text=True, timeout=10).stdout.strip()
                    dirty = subprocess.run(['git', '-C', self.root, 'status', '--porcelain', '--', 'unbrowse-node/crates', 'unbrowse-node/app/src'], capture_output=True, text=True, timeout=10).stdout.strip()
                except (OSError, subprocess.SubprocessError): tip, dirty = '', ''
                tree['tip'] = '%s%s (%s)' % (tip or '?', ' with uncommitted edits' if dirty else '', os.path.relpath(self.root, os.path.dirname(TOP)) if self.root.startswith(os.path.dirname(TOP)) else self.root)
                self.tree, self.stamp = tree, st
            return self.tree

    def emap(self):
        out = {}
        r = self.running()
        if r: out['running'] = r
        if self.rebuild: out['rebuild'] = self.rebuild
        return out

    @staticmethod
    def fn_row(tree, key):
        f = tree['fns'][key]
        return {'file': Y.short(f['file']), 'line': f['line'], 'name': f['name'], 'lines': f['lines'], 'callers': [tree['fns'][c]['name'] for c in f['callers'][:6]], 'ncallers': len(f['callers'])}

    def kind(self, kind):
        """The functions that write a kind and that branch on it, in the running engine and the rebuild."""
        out = {}
        for name, tree in self.emap().items():
            row = {}
            for role in ('writes', 'reads'):
                keys = []
                for m in tree[role].get(kind, []):
                    if m['fn'] not in keys: keys.append(m['fn'])
                row[role] = [self.fn_row(tree, k) for k in keys[:12]]
                row[role + '_n'] = len(keys)
            out[name] = row
        return out

    def why(self, fid, classes):
        """`WHY`'s line for a finding, its selectors resolved against the source as it stands."""
        b = Y.blame([fid], {fid: set(classes)}, self.emap()).get(fid)
        if not b: return None
        clean = lambda fs: [({'gone': f['gone']} if 'gone' in f else {'file': f['file'], 'line': f['line'], 'name': f['name'], 'lines': f['lines'], 'callers': f.get('callers')}) for f in fs[:8]]
        return {'tree': b['tree'], 'gap': b.get('gap'), **{role: clean(b[role]) for role, _ in Y.ROLES}}

    def tips(self):
        return {k: v.get('tip') for k, v in self.emap().items()}

    def wire(self, kind):
        """The functions of the running engine that build the part of a request a transport difference is about
        (`xray_wire.KINDS`), resolved against the source as it stands: a name it no longer has is shown as gone."""
        running = self.emap().get('running')
        out = []
        for sel in XW.KINDS.get(kind, ('', []))[1]:
            for f in Y.resolve(running, sel):
                out.append({'gone': f['gone']} if 'gone' in f else {'file': f['file'], 'line': f['line'], 'name': f['name'], 'lines': f['lines'], 'callers': f.get('callers')})
        return out


# ------------------------------------------------------------------------------------------------ homes
MATRIX_HOME = re.compile(r'^unbrowse-test-matrix-(.+)-(\d+)-(\d+)$')


def routes_dir(home):
    """(the home, its routes folder) for a home or a routes folder given."""
    home = os.path.abspath(os.path.expanduser(home))
    if os.path.isdir(os.path.join(home, 'routes')): return home, os.path.join(home, 'routes')
    return os.path.dirname(home), home


def route_files(rdir):
    try: return sorted(os.path.join(rdir, n) for n in os.listdir(rdir) if n.endswith('.json'))
    except OSError: return []


def stamp_of(paths):
    out = []
    for p in paths:
        try:
            st = os.stat(p)
            out.append((p, st.st_mtime_ns, st.st_size))
        except OSError: out.append((p, 0, 0))
    return out


def matrix_rows():
    """row id -> {ceiling, person, from}: the checkout's matrix.json first, then the other worktrees' (a row may have
    landed on a branch the matrix ran from)."""
    files = [os.path.join(TOP, 'unbrowse-node', 'app', 'src', 'primitives', 'matrix.json')]
    try:
        out = subprocess.run(['git', '-C', TOP, 'worktree', 'list', '--porcelain'], capture_output=True, text=True, timeout=10).stdout
        files += [os.path.join(l[9:], 'unbrowse-node', 'app', 'src', 'primitives', 'matrix.json') for l in out.splitlines() if l.startswith('worktree ')]
    except (OSError, subprocess.SubprocessError): pass
    rows = {}
    for f in files:
        try:
            with open(f) as fh: m = json.load(fh)
        except (OSError, ValueError): continue
        for r in m.get('rows') or []:
            if r.get('id') not in rows: rows[r['id']] = {'value': r.get('ceiling'), 'person': bool(r.get('person')), 'from': os.path.relpath(f, os.path.dirname(TOP)), 'row': r['id']}
    return rows


def matrix_homes(tmp=None):
    tmp = tmp or os.environ.get('TMPDIR') or '/tmp'
    out = []
    try: names = os.listdir(tmp)
    except OSError: return out
    for n in names:
        m = MATRIX_HOME.match(n)
        if m and os.path.isdir(os.path.join(tmp, n, 'routes')): out.append((os.path.join(tmp, n), m.group(1), int(m.group(2)), int(m.group(3))))
    return out


def fits(a, b):
    """Two readings of one call: the same method and path, a templated piece of either matching any piece."""
    sa, sb = str(a.get('path') or '').split('/'), str(b.get('path') or '').split('/')
    return str(a.get('method')).upper() == str(b.get('method')).upper() and len(sa) == len(sb) and all(x == y or '{' in x or '{' in y or '‹' in x or '‹' in y for x, y in zip(sa, sb))


# A finding of the catalogue and a flag of this page that say the same thing: the finding is kept, the flag's evidence
# goes with it.
SAME = {'open': 'open', 'frozen-clock': 'frozen', 'walk-time-inside': 'frozen', 'frozen-date': 'frozen'}


def finding(f, x_hole=None):
    level, title, points = X.CATALOGUE[f['id']]
    where = ('step %d' % f['step'] if f.get('step') else 'the route') + ((' · ' + str(f['at'])) if f.get('at') else '')
    return {'id': f['id'], 'level': level, 'title': title, 'points': points, 'more': f.get('more') or '', 'where': where,
            'classes': sorted({str(x_hole.get('class'))} if x_hole and x_hole.get('class') else []), 'why': None}


def attach(model, gmodel, x):
    """route-xray's findings for this route, each laid on the hole or step it is about (or the route), with its words.
    The graph's holes are matched by the field's own index; a body's by the step that is the same call and the place."""
    model['findings'] = []
    for st in model['steps']:
        st['findings'] = []
        for h in st['holes']: h['findings'] = []
    if gmodel is not model:
        gmodel['findings'] = []
        for st in gmodel['steps']:
            st['findings'] = []
            for h in st['holes']: h['findings'] = []
    for f in x['findings']:
        n, at = f.get('step'), f.get('at')
        xs = x['steps'][n - 1] if n and n - 1 < len(x['steps']) else None
        xh = next((h for h in (xs or {}).get('holes') or [] if h['at'] == at and f['id'] in h['findings']), None) if at else None
        F = finding(f, xh)
        gs = gmodel['steps'][n - 1] if n and n - 1 < len(gmodel['steps']) else None
        gh = gs['holes'][xh['i']] if gs and xh and xh.get('i') is not None and xh['i'] < len(gs['holes']) else None
        targets = []
        if gmodel is not model:
            if gh: gh['findings'].append(dict(F))
            elif gs: gs['findings'].append(dict(F))
            else: gmodel['findings'].append(dict(F))
            ms = next((s for s in model['steps'] if gs and fits(s, gs)), None)
            mh = next((h for h in (ms or {}).get('holes') or [] if gh and h['place'].lower() == gh['place'].lower()), None)
        else: ms, mh = gs, gh
        if mh: targets = mh['findings']
        elif ms: targets = ms['findings']
        else: targets = model['findings']
        if mh and SAME.get(F['id']):
            kind = SAME[F['id']]
            same = [fl for fl in mh['flags'] if fl['kind'] == kind]
            if same:
                F['also'] = '%s flag: %s' % (dict((k, n_) for k, n_, _ in FLAGS)[kind], same[0]['why'])
                mh['flags'] = [fl for fl in mh['flags'] if fl['kind'] != kind]
        targets.append(F)
    recount(model)
    if gmodel is not model: recount(gmodel)


class Reader:
    """Reads homes into groups: each route's wiring, flags and findings, its calls, the node's log of each learn and
    the walk's capture where they are in hand, and the engine's functions for each kind and finding drawn."""

    def __init__(self, homes=(), matrix=False, runs=None, log=None, tmp=None, engine=None, captures=None):
        self.homes, self.matrix, self.runs, self.log, self.tmp = list(homes), matrix, runs, log, tmp
        self.captures = captures or (os.path.join(os.path.dirname(os.path.abspath(log)), 'tmp', 'unbrowse-node-walks') if log else None)
        self.engine = engine
        self.cache, self.rcache, self.built, self.lock = {}, {}, 0, threading.RLock()
        self.rows = matrix_rows() if matrix else {}
        self.log_cache, self.cap_cache, self.made_cache = (None, None), {}, {}
        self.calls_cache, self.sent_cache, self.wire_engine = (None, ({}, [])), {}, None

    def groups(self):
        gs = []
        for h in self.homes:
            home, rdir = routes_dir(h)
            gs.append({'key': 'home:' + home, 'title': home.replace(os.path.expanduser('~'), '~'), 'kind': 'home', 'homes': [{'home': home, 'routes': rdir, 'label': os.path.basename(home), 'row': None}]})
        if self.matrix:
            runs = {}
            for home, row, pid, n in matrix_homes(self.tmp):
                runs.setdefault(pid, []).append({'home': home, 'routes': os.path.join(home, 'routes'), 'label': row, 'row': row, 'n': n})
            order = []
            for pid, hs in runs.items():
                newest = max((os.stat(h['routes']).st_mtime for h in hs), default=0)
                hs.sort(key=lambda h: h['n'])
                order.append((newest, pid, hs))
            order.sort(reverse=True)
            for newest, pid, hs in order[:self.runs] if self.runs else order:
                gs.append({'key': 'run:%d' % pid, 'title': 'matrix run %d, %s, %d row(s)' % (pid, time.strftime('%d %b %H:%M', time.localtime(newest)), len(hs)), 'kind': 'matrix', 'pid': pid,
                           'newest': newest, 'homes': hs})
        return gs

    def side_paths(self):
        out = [self.log] if self.log else []
        if self.captures and os.path.isdir(self.captures): out += sorted(glob.glob(os.path.join(self.captures, '*.jsonl')))
        return out

    def home_paths(self, h):
        return route_files(h['routes']) + [os.path.join(h['home'], 'made.jsonl'), os.path.join(h['home'], 'sent.jsonl')]

    def calls(self):
        """Each route's last call in the node's log (its start to its end), read once per change: xray_wire's blocks."""
        if not self.log: return {}, []
        st = stamp_of([self.log])
        if self.calls_cache[0] != st: self.calls_cache = (st, XW.calls_in_log(self.log))
        return self.calls_cache[1]

    def sent(self, home):
        """`sent.jsonl` beside made.jsonl (the engine addition): one line per request sent, names and shapes only."""
        p = os.path.join(home, 'sent.jsonl')
        st = stamp_of([p])[0]
        hit = self.sent_cache.get(p)
        if not hit or hit[0] != st: self.sent_cache[p] = hit = (st, XW.read_sent(p))
        return hit[1]

    def wire_of_engine(self):
        """The engine's refusal statuses and its transport's build, read from its source once."""
        if self.wire_engine is None:
            root = self.engine.root if self.engine else TOP
            self.wire_engine = (XW.refused_statuses(root), XW.transport_build(root))
        return self.wire_engine

    def version(self, group):
        paths = self.side_paths()
        for h in group['homes']: paths += self.home_paths(h)
        return sig(stamp_of(paths) + [self.engine.stamp if self.engine else None])

    def made(self, home):
        """Each route's recent calls, oldest first: ok, rung, the rung of each step, a browser, ms."""
        p = os.path.join(home, 'made.jsonl')
        st = stamp_of([p])[0]
        hit = self.made_cache.get(p)
        if hit and hit[0] == st: return hit[1]
        calls = {}
        try:
            with open(p, encoding='utf-8', errors='replace') as f:
                for line in f:
                    try: m = json.loads(line)
                    except ValueError: continue
                    if isinstance(m, dict) and m.get('route'):
                        calls.setdefault(m['route'], []).append({k: m.get(k) for k in ('ok', 'rung', 'steps', 'browser', 'ms', 'at', 'model_requests')})
        except OSError: pass
        out = {k: v[-12:] for k, v in calls.items()}
        self.made_cache[p] = (st, out)
        return out

    def cost(self, g):
        """What the group's homes cost (`cost_of`), the log read once per change."""
        st = stamp_of([self.log] if self.log else [])
        hit = getattr(self, 'cost_cache', None)
        if not hit or hit[0] != st:
            self.cost_cache = hit = (st, cost_lines(self.log))
        return [cost_of(h['home'], hit[1], self.made(h['home']), self.sent(h['home'])) | {'label': h['label']} for h in g['homes']]

    def learns(self):
        """The node's log, read once per change."""
        if not self.log: return []
        st = stamp_of([self.log])
        if self.log_cache[0] != st: self.log_cache = (st, G.read(self.log))
        return self.log_cache[1]

    def capture(self, walk):
        files = capture_files(self.captures, walk)
        if not files: return None
        st = sig(stamp_of(files))
        hit = self.cap_cache.get(walk)
        if not hit or hit[0] != st: self.cap_cache[walk] = hit = (st, Capture(files))
        return hit[1]

    def route(self, path, home, made, ceiling, learned):
        try:
            with open(path, encoding='utf-8') as f: r = json.load(f)
        except (OSError, ValueError) as e:
            return {'key': path, 'file': os.path.basename(path), 'error': 'cannot read: %s' % type(e).__name__, 'steps': [], 'counts': {}, 'flags': [], 'found': {}, 'findings': []}, None
        if not isinstance(r, dict):
            return {'key': path, 'file': os.path.basename(path), 'error': 'not a route', 'steps': [], 'counts': {}, 'flags': [], 'found': {}, 'findings': []}, None
        st = stamp_of([path])[0]
        calls, learn = made.get(r.get('id')) or [], learned.get(r.get('id'))
        graph = from_graph(r)
        body = r.get('body') if isinstance(r.get('body'), dict) else None
        model = from_body(r, body) if body else graph
        cap = self.capture(learn['walk']) if learn else None
        fold_by_walk(model, cap)
        if body: fold_by_walk(graph, cap)
        walk = {'held_before': cap.held_before, 'writes_before': cap.writes_before} if cap else None
        m = calls[-1] if calls else None
        flag(model, m, ceiling, graph if body else None, walk, calls)
        if body: flag(graph, None, None, None, walk)
        for s_ in model['steps']: s_['ran'] = None
        if m and isinstance(m.get('steps'), list):
            # made.jsonl names a step by its place in the run, the answer's being the last.
            ran = m['steps']
            for k, s_ in enumerate(reversed(model['steps'])):
                if k < len(ran): s_['ran'] = ran[len(ran) - 1 - k]
        # Route to transport: the last call's request against the walk's browser, step by step (xray_wire).
        blocks, tls = self.calls()
        refused, build = self.wire_of_engine()
        jar_host = host_path(r.get('root'))[0] or (model['steps'][-1]['host'] if model['steps'] else '')
        jar, fp = XW.read_jar(home['home'], jar_host)
        if jar is None and model['steps']: jar, fp = XW.read_jar(home['home'], model['steps'][-1]['host'])
        # A body names a step by the walk's call; the call runs the graph, whose steps number the lean trace: the engine's
        # sent line carries the graph's. Each body step is given the number of the graph's step for the same call too.
        for s_ in model['steps']:
            s_['_also'] = [g['exchange'] for g in ((graph or {}).get('steps') or []) if body and g.get('exchange') is not None
                           and str(g.get('method')).upper() == str(s_.get('method')).upper() and g.get('host') == s_.get('host') and XW.path_fits(s_.get('_path') or s_.get('path'), g.get('path'))]
        model['wire'] = XW.transport(model, cap, m, blocks.get(r.get('id')), self.sent(home['home']), jar, fp, refused, build, tls)
        for f in model['wire']['flags']: model['route_flags'].append(dict(f))
        for s_ in model['steps']:
            for h in s_['holes']: merge_flags(h)
        recount(model)
        model.update({'key': path, 'file': os.path.basename(path), 'home': home['label'], 'row': home.get('row'), 'id': r.get('id'), 'site': r.get('site'), 'what': r.get('what'),
                      'mtime': st[1] / 1e9, 'made': m, 'calls': calls, 'ceiling': ceiling, 'floor': floor_of(model), 'graph': graph if body else None,
                      'walk': learn['walk'] if learn else None, 'capture': bool(cap)})
        x = X.xray(r) if isinstance(r.get('graph'), dict) else None
        return model, x

    def read(self, group):
        with self.lock:
            log = self.learns()
            out = []
            for h in group['homes']:
                st = sig(stamp_of(self.home_paths(h) + self.side_paths()))
                hit = self.cache.get(h['home'])
                if hit and hit[0] == st:
                    out += hit[1]
                    continue
                calls = self.made(h['home'])
                ceiling = self.rows.get(h['row']) if h.get('row') else None
                if h.get('row') and not ceiling: ceiling = {'value': None, 'row': h['row'], 'from': 'no matrix.json read names this row'}
                learned = {(l.get('saved') or {}).get('route'): l for l in log if l.get('saved')}
                files = route_files(h['routes'])
                # Each route is rebuilt only when what it is read from moved: its file, its calls, its learn and walk,
                # its row's ceiling, and (with a log) the log and which routes are on the node.
                logst = (sig(stamp_of([self.log])), sig(files)) if log else None
                sentst = sig(stamp_of([os.path.join(h['home'], 'sent.jsonl')] + sorted(glob.glob(os.path.join(h['home'], 'jars', '*.json*')))))
                models, built = [], []
                for p in files:
                    st_p = stamp_of([p])[0]
                    hit = self.rcache.get(p)
                    rid = hit['rid'] if hit and hit['st'] == st_p else None
                    learn = learned.get(rid) if rid else None
                    cap = capture_files(self.captures, learn['walk']) if learn else []
                    key = sig([st_p, calls.get(rid) if rid else None, learn['walk'] if learn else None, stamp_of(cap), ceiling, logst, sentst])
                    if hit and hit['st'] == st_p and hit['key'] == key:
                        models.append((hit['model'], None))
                        continue
                    model, x = self.route(p, h, calls, ceiling, learned)
                    rid = model.get('id')
                    learn = learned.get(rid)
                    cap = capture_files(self.captures, learn['walk']) if learn else []
                    key = sig([st_p, calls.get(rid) if rid else None, learn['walk'] if learn else None, stamp_of(cap), ceiling, logst, sentst])
                    model['sig'] = key
                    self.rcache[p] = {'st': st_p, 'rid': rid, 'key': key, 'model': model}
                    self.built += 1
                    models.append((model, x))
                    built.append((model, x))
                xs = [x for _, x in built if x]
                if log and xs:
                    # The log's findings are laid on the routes rebuilt; the others stand in by id, so a route that
                    # took the place of one no longer on the node is still told apart from one that is.
                    stubs = [{'id': m.get('id'), 'findings': [], 'steps': []} for m, x in models if x is None]
                    X.with_log(xs + stubs, log)
                for model, x in built:
                    if x: attach(model, model['graph'] or model, x)
                    else: recount(model)
                for gone in set(self.rcache) - set(files):
                    if os.path.dirname(gone) == h['routes']: del self.rcache[gone]
                rs = [m for m, _ in models]
                self.cache[h['home']] = (st, rs)
                out += rs
            return out

    def source(self, key, step, hole, way, n=0):
        """A program's source, for the live page only."""
        with self.lock:
            model = next((m for _, rs in self.cache.values() for m in rs if m.get('key') == key), None)
        if not model: return None
        if step == 'decode': return model.get('_decode_source')
        try: return model['steps'][int(step)]['holes'][int(hole)]['ways'][int(way)]['_sources'][int(n)]
        except (IndexError, KeyError, ValueError, TypeError): return None

    def pick(self):
        """Each learn of the node's log: every candidate call, its score, why it was held back, which was picked; a learn
        that kept no route or had no candidate at all; and whether the walk ended before a worker or frame called."""
        if not self.log: return None
        out = []
        for l in self.learns():
            w = l['words']
            held = {(h['method'], h['host'], h['path']): h for h in l['held']}
            picked = (l['picked'] or {}).get('index')
            cands = []
            for c in sorted(l['candidates'], key=lambda c: -(c.get('score') or 0)):
                hd = held.get((c.get('method'), c.get('host'), (c.get('path') or '').split('?')[0])) or {}
                why = '; '.join(x for x in (hd.get('fails'), hd.get('nothing')) if x and x != '-')
                facts = hd.get('facts') or {}
                cands.append({'score': c.get('score') or 0, 'call': '%s %s' % (c.get('method'), G.hush((c.get('host') or '') + (c.get('path') or ''), w)), 'noise': bool(c.get('noise')),
                              'picked': c.get('index') == picked, 'held': G.hush(why, w) if why else '', 'holds': [k for k in ('shapes', 'covered', 'answers') if facts.get(k) == 'true']})
            sorts = {}
            for x in l['seen']: sorts[x.get('sort') or '?'] = sorts.get(x.get('sort') or '?', 0) + 1
            outcome = 'kept a route' if l['saved'] else ('kept no route' if l['failed'] else 'kept no route (nothing logged after it)')
            if not l['candidates']: outcome += ', with no candidate at all'
            cap = self.capture(l['walk'])
            early = cap.early() if cap else ('no capture of this walk was found (%s)' % (self.captures or 'no capture folder') if not l['saved'] or not l['candidates'] else None)
            fs = G.findings(l)
            out.append({'walk': l.get('walk'), 'goal': l.get('goal'), 'site': l.get('site'), 'page': G.hush(l.get('page') or '', w), 'outcome': outcome, 'kept': bool(l['saved']),
                        'route': (l['saved'] or {}).get('route'), 'failed': G.hush(l['failed'], w) if l['failed'] else None, 'seen': len(l['seen']), 'sorts': sorts, 'candidates': cands,
                        'picked': {'by': l['picked'].get('by'), 'reasons': [G.hush(r, w) for r in l['picked'].get('reasons') or []]} if l['picked'] else None,
                        'set_aside': G.hush(l['set_aside'], w) if l.get('set_aside') else None, 'early': early,
                        'findings': [{'id': f, 'level': X.CATALOGUE[f][0], 'title': X.CATALOGUE[f][1], 'more': more} for f, more in fs], 'text': G.text(l)})
        return out

    def engine_for(self, routes, with_pick=True):
        """The engine's functions for each kind drawn and each finding raised, so a click on a hole is one step."""
        if not self.engine: return None
        kinds, why = set(), {}
        for r in routes:
            for m in [r] + ([r['graph']] if r.get('graph') else []):
                for s_ in m.get('steps') or []:
                    for h in s_['holes']:
                        kinds.update(h.get('kinds') or [])
                        for f in h.get('findings') or []: why.setdefault('%s|%s' % (f['id'], ','.join(f['classes'])), (f['id'], f['classes']))
                    for f in s_.get('findings') or []: why.setdefault('%s|' % f['id'], (f['id'], []))
                for f in m.get('findings') or []: why.setdefault('%s|' % f['id'], (f['id'], []))
        if self.log and with_pick:
            for l in self.pick() or []:
                for f in l['findings']: why.setdefault('%s|' % f['id'], (f['id'], []))
        wire = {d['kind'] for r in routes for st in (r.get('wire') or {}).get('steps') or [] for d in st['diffs']}
        wire |= {'reply'} if any((r.get('wire') or {}).get('flags') for r in routes) else set()
        return {'tips': self.engine.tips(), 'kinds': {k: self.engine.kind(k) for k in sorted(kinds)}, 'why': {k: self.engine.why(*v) for k, v in why.items()},
                'wire': {k: self.engine.wire(k) for k in sorted(wire)}}

    def overview(self, group_key=None):
        """What the page needs to open: one summary a route, the group's totals, the pick and the legend. Every hole
        stays on the server until its route is opened (`detail`)."""
        gs = self.groups()
        g = next((x for x in gs if x['key'] == group_key), None) or (gs[0] if gs else None)
        rs = self.read(g) if g else []
        pick = self.pick()
        eng = None
        if self.engine:
            why = {}
            for l in pick or []:
                for f in l['findings']: why.setdefault(f['id'] + '|', self.engine.why(f['id'], []))
            eng = {'tips': self.engine.tips(), 'kinds': {}, 'why': why}
        sums = [summary(m, self.engine.stamp if self.engine else None) for m in rs]
        totals = {}
        for x in sums:
            for k, v in list((x.get('counts') or {}).items()) + list((x.get('found') or {}).items()): totals[k] = totals.get(k, 0) + v
        return {'now': time.time(), 'layers': LAYERS, 'rungs': RUNGS, 'flags': FLAGS, 'levels': list(X.LEVELS), 'rule': BROWSER_RULE, 'known_ops': sorted(known_ops()),
                'wire_kinds': {k: v[0] for k, v in XW.KINDS.items()}, 'groups': [{k: v for k, v in x.items() if k != 'homes'} | {'homes': len(x['homes']), 'version': self.version(x)} for x in gs], 'group': g['key'] if g else None,
                'summaries': {g['key']: sums} if g else {}, 'totals': {g['key']: totals} if g else {}, 'cost': {g['key']: self.cost(g)} if g else {}, 'pick': pick, 'with_source': False, 'log': self.log,
                'captures': self.captures if self.captures and os.path.isdir(self.captures) else None, 'engine': eng, 'legend': legend_sources(rs)}

    def detail(self, key, with_source=False):
        """One route, every hole of it, and the engine's functions for its kinds and findings."""
        with self.lock:
            m = next((r['model'] for r in self.rcache.values() if r['model'].get('key') == key), None)
        if m is None: return None
        return {'route': compact(public([m], with_source)[0]), 'engine': self.engine_for([m], with_pick=False)}

    def state(self, group_key=None, all_groups=False, with_source=False):
        gs = self.groups()
        chosen = gs if all_groups else [g for g in gs if g['key'] == group_key][:1] or gs[:1]
        out = {'now': time.time(), 'layers': LAYERS, 'rungs': RUNGS, 'flags': FLAGS, 'levels': list(X.LEVELS), 'rule': BROWSER_RULE, 'known_ops': sorted(known_ops()),
               'wire_kinds': {k: v[0] for k, v in XW.KINDS.items()}, 'groups': [{k: v for k, v in g.items() if k != 'homes'} | {'homes': len(g['homes']), 'version': self.version(g)} for g in gs], 'routes': {}, 'pick': self.pick(), 'with_source': with_source,
               'log': self.log, 'captures': self.captures if self.captures and os.path.isdir(self.captures) else None}
        drawn = []
        for g in chosen:
            rs = self.read(g)
            drawn += rs
            out['routes'][g['key']] = public(rs, with_source)
        out['engine'] = self.engine_for(drawn)
        out['legend'] = legend_sources(drawn)
        out['cost'] = {g['key']: self.cost(g) for g in chosen}
        return out


# The budgets the cost strip holds a home to (docs/PERFORMANCE.md): each a count or a size, over which it is flagged.
COST_BUDGETS = {
    'browsers_left': (0, 'browsers a stopped node of this home left running (browsers-launched records whose launcher is gone)'),
    'launches_per_walk': (1, 'browsers launched per walk of a page: the walk, plus each probe the A/B keeps'),
    'sent_per_call': (1, 'requests sent to the site per call (sent.jsonl lines over made.jsonl calls)'),
    'reply_bytes_max': (12000, 'the largest reply an agent was sent (bytes of its text)'),
}


def cost_lines(log):
    """The node log's cost lines, counted: walks begun (`eye … started`), browsers launched (`browser {…}`) and each
    reply's size by tool (`reply {…}`). Names and sizes only; the log holds no value here."""
    out = {'walks': 0, 'launches': 0, 'replies': {}}
    if not log: return out
    try:
        with open(log, encoding='utf-8', errors='replace') as f:
            for line in f:
                if line.startswith('eye ') and '"kind":"started"' in line: out['walks'] += 1
                elif line.startswith('browser {') and '"launched"' in line: out['launches'] += 1
                elif line.startswith('reply {'):
                    try: r = json.loads(line[6:])
                    except ValueError: continue
                    out['replies'].setdefault(r.get('tool') or '?', []).append(int(r.get('bytes') or 0))
    except OSError: pass
    return out


def _alive(pid):
    try: os.kill(int(pid), 0); return True
    except (OSError, ValueError, TypeError): return False


def cost_of(home, lines, made, sent):
    """One home's cost, against its budgets: page loads, launches, calls and what they sent, reply sizes, and browsers
    a dead node left. Each over its budget is a flag."""
    left = 0
    rdir = os.path.join(home, 'browsers-launched')
    for name in (os.listdir(rdir) if os.path.isdir(rdir) else []):
        try:
            with open(os.path.join(rdir, name), encoding='utf-8') as f: r = json.load(f)
        except (OSError, ValueError): continue
        if not _alive(r.get('owner')) and _alive(r.get('browser')): left += 1
    calls = sum(len(v) for v in made.values())
    replies = [b for v in lines['replies'].values() for b in v]
    c = {'walks': lines['walks'], 'launches': lines['launches'], 'calls': calls, 'sent': len(sent), 'browsers_left': left,
         'launches_per_walk': round(lines['launches'] / lines['walks'], 2) if lines['walks'] else 0,
         'sent_per_call': round(len(sent) / calls, 2) if calls else 0,
         'reply_bytes_max': max(replies) if replies else 0,
         'reply_bytes_median': sorted(replies)[len(replies) // 2] if replies else 0,
         'replies_by_tool': {k: {'n': len(v), 'max': max(v)} for k, v in lines['replies'].items()}}
    c['over'] = [{'field': k, 'value': c[k], 'budget': b, 'why': why} for k, (b, why) in COST_BUDGETS.items() if c[k] > b]
    return c


def summary(m, engine_stamp=None):
    """A route as one line: what the overview draws and counts, with no hole in it. `sig` moves when anything the
    route's detail is read from moves, so the page fetches the detail again only then."""
    if m.get('error'): return {k: m.get(k) for k in ('key', 'file', 'error')} | {'counts': {}, 'found': {}, 'flags': [], 'sig': sig([m.get('key'), m.get('error')])}
    layers, holes, fixed = {}, 0, 0
    for st in m['steps']:
        for h in st['holes']:
            holes += 1
            if h.get('fold'): continue
            if h['layers']:
                for l in h['layers'][:1]: layers[l['layer']] = layers.get(l['layer'], 0) + 1
            elif h['open']: layers['open'] = layers.get('open', 0) + 1
            else: fixed += 1
    layers['fixed'] = fixed

    def worst(fs):
        return next((lv for lv in X.LEVELS if any(f['level'] == lv for f in fs or [])), None)
    return {'key': m['key'], 'file': m['file'], 'id': m.get('id'), 'site': m.get('site'), 'what': m.get('what'), 'row': m.get('row'), 'home': m.get('home'), 'by': m['by'],
            'graph': bool(m.get('graph')), 'counts': m['counts'], 'found': m['found'], 'flags': [{k: f.get(k) for k in ('kind', 'on', 'n', 'why')} for f in m['flags']],
            'made': m.get('made') and {k: m['made'].get(k) for k in ('ok', 'rung', 'browser', 'ms')},
            'calls': [[c.get('ok'), c.get('rung'), c.get('browser'), c.get('ms')] for c in m.get('calls') or []],
            'ms_median': (lambda ms: sorted(ms)[len(ms) // 2] if ms else None)([c['ms'] for c in m.get('calls') or [] if isinstance(c.get('ms'), (int, float))]),
            'ceiling': m.get('ceiling') and {'value': m['ceiling'].get('value'), 'row': m['ceiling'].get('row')}, 'floor': m.get('floor'), 'holes': holes, 'layers': layers,
            'steps': [[st['n'], st['method'], cut_words(st['path'], 48), st.get('ran'), worst((st.get('findings') or []) + [f for h in st['holes'] for f in h.get('findings') or []]),
                       sum(1 for h in st['holes'] if h['flags'])] for st in m['steps']],
            'sig': sig([m.get('sig'), engine_stamp])}


def compact(route):
    """A route's detail without what the page can do without: a way's tree that only says its line again, and empty
    lists and false marks on a hole (the page reads a missing one as empty)."""
    def hole(h):
        for w in h.get('ways') or []:
            if w.get('tree') == w.get('line'): w.pop('tree', None)
            for k in ('unknown', 'programs', 'layers'):
                if not w.get(k): w.pop(k, None)
        for k in ('sent', 'reads', 'sightings', 'tied', 'findings', 'over'):
            if not h.get(k): h.pop(k, None)
        if h.get('fold') is None: h.pop('fold', None)
        return h
    for m in [route] + ([route['graph']] if route.get('graph') else []):
        for st in m.get('steps') or []:
            st['holes'] = [hole(h) for h in st['holes']]
    return route


def cut_words(s, n):
    s = str(s or '')
    return s if len(s) <= n else s[:n - 1] + '…'


def fold_by_walk(model, cap):
    """Which headers are the browser's own, read from the walk where its capture is in hand (a header the browser sent
    on what the document loads by itself, where no page code sets one: `slots::BrowsersOwn`'s property). The name list
    stands only where the walk holds no such request."""
    own = cap.browsers_own() if cap else None
    model['fold_by'] = 'walk' if own is not None else 'rule'
    if own is None: return
    for s in model['steps']:
        for h in s['holes']:
            if h['fold'] == 'rule':
                h['fold'] = 'walk' if h['in'] == 'header' and h['place'].split(' ', 1)[-1].lower() in own else None
            elif h['fold'] is None and h['fixed'] and h['in'] == 'header' and h['place'].split(' ', 1)[-1].lower() in own:
                h['fold'] = 'walk'


def legend_sources(routes):
    """Which reading the page used, for the legend: how the browser's own headers were told, and the person layer."""
    folds, person = {}, 0
    for r in routes:
        for m in [r] + ([r['graph']] if r.get('graph') else []):
            for s in m.get('steps') or []:
                for h in s['holes']:
                    if h.get('fold'): folds[h['fold']] = folds.get(h['fold'], 0) + 1
                    person += any(l['layer'] == 'person' for l in h['layers'])
    return {'folds': folds, 'person': person}


def public(routes, with_source=False):
    """The model with every private field taken out (`_sources`, `_decode_source`), unless sources are asked for."""
    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items() if not k.startswith('_') or (with_source and k in ('_sources', '_decode_source'))}
        if isinstance(o, list): return [clean(v) for v in o]
        return o
    return clean(routes)


# ------------------------------------------------------------------------------------------------ the page
def as_page(state):
    """A full state (every hole of every route, as `state` prints it) in the shape the page reads: an overview of one
    summary a route, and every route's detail beside it (a snapshot has no server to ask)."""
    if state is None or 'summaries' in state: return state
    st = {k: v for k, v in state.items() if k != 'routes'}
    routes = state.get('routes') or {}
    st['summaries'] = {g: [summary(m) for m in rs] for g, rs in routes.items()}
    st['totals'] = {}
    for g, xs in st['summaries'].items():
        t = st['totals'][g] = {}
        for x in xs:
            for k, v in list((x.get('counts') or {}).items()) + list((x.get('found') or {}).items()): t[k] = t.get(k, 0) + v
    st['details'] = {m['key']: compact(json.loads(json.dumps(m))) for rs in routes.values() for m in rs if not m.get('error')}
    st['group'] = next(iter(routes), None)
    return st


def page(state=None, live=True):
    with open(os.path.join(HERE, 'wiring.html'), encoding='utf-8') as f: tpl = f.read()
    data = json.dumps(as_page(state), ensure_ascii=False).replace('</', '<\\/') if state is not None else 'null'
    return tpl.replace('/*STATE*/null', data).replace('/*LIVE*/false', 'true' if live else 'false')


class Handler(http.server.BaseHTTPRequestHandler):
    reader = None

    def log_message(self, *a): pass

    def send(self, code, body, kind='application/json'):
        b = body.encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', kind + '; charset=utf-8')
        self.send_header('cache-control', 'no-store')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    hits = {}  # path -> requests served: what the page asked for, read by the tests

    def do_GET(self):
        if self.client_address[0] not in ('127.0.0.1', '::1'): return self.send(403, 'local only', 'text/plain')
        u = U.urlsplit(self.path)
        Handler.hits[u.path] = Handler.hits.get(u.path, 0) + 1
        q = dict(U.parse_qsl(u.query))
        try:
            if u.path == '/': return self.send(200, page(None, True), 'text/html')
            if u.path == '/state': return self.send(200, json.dumps(self.reader.state(q.get('group')), ensure_ascii=False))
            if u.path == '/overview': return self.send(200, json.dumps(self.reader.overview(q.get('group')), ensure_ascii=False))
            if u.path == '/route':
                d = self.reader.detail(q.get('key'))
                return self.send(200 if d else 404, json.dumps(d or {'error': 'no such route (read its group first)'}, ensure_ascii=False))
            if u.path == '/version':
                if self.reader.engine: self.reader.engine.running(at_most_every=1)  # a few stats when nothing moved
                return self.send(200, json.dumps({g['key']: self.reader.version(g) for g in self.reader.groups()}))
            if u.path == '/source':
                s = self.reader.source(q.get('route'), q.get('step'), q.get('hole'), q.get('way'), q.get('n', 0))
                return self.send(200 if s is not None else 404, s or 'no such program', 'text/plain')
        except Exception as e:  # a file that breaks the reader is said, never a dead page
            return self.send(500, json.dumps({'error': '%s: %s' % (type(e).__name__, e)}))
        self.send(404, 'not found', 'text/plain')


def stdout_path():
    """Where stdout goes, when it is a file (so `render > page.html` is held to the same rule as --out)."""
    try:
        import stat
        if not stat.S_ISREG(os.fstat(1).st_mode): return None
        if os.path.exists('/proc/self/fd/1'): return os.path.realpath('/proc/self/fd/1')
        import fcntl
        return os.fsdecode(fcntl.fcntl(1, getattr(fcntl, 'F_GETPATH', 50), b'\0' * 1024).rstrip(b'\0'))
    except (OSError, ValueError, ImportError): return None


def repo_of(path):
    probe = os.path.dirname(os.path.realpath(path))
    while probe != os.path.dirname(probe):
        if os.path.exists(os.path.join(probe, '.git')): return probe
        probe = os.path.dirname(probe)
    return None


# ------------------------------------------------------------------------------------------------ over time
def snapshot(home, log=None):
    """One home as the diff reads it: {route key: {title, holes {place key: reading}, flags, findings, wire}}. A scratch
    node's folder (UB_DIR) is read with its log and walks, so the diff sees what each call sent against its browser."""
    if os.path.isdir(os.path.join(home, 'home', 'node')):
        log = log or (os.path.join(home, 'node.log') if os.path.isfile(os.path.join(home, 'node.log')) else None)
        home = os.path.join(home, 'home', 'node')
    rd = Reader([home], log=log)
    g = rd.groups()[0]
    out = {}
    for r in rd.read(g):
        if r.get('error'): continue
        holes, steps = {}, []
        for s in r['steps']:
            steps.append(s)
            for h in s['holes']:
                holes[(s['n'], str(s['method']).upper(), s['path'], h['place'])] = {
                    'src': ','.join(l['layer'] for l in h['layers']) or ('open' if h['open'] else 'fixed' if h['fixed'] else 'none'),
                    'rung': h['rung'], 'expr': h['ways'][0]['line'] if h['ways'] else 'no way', 'step': s}
        fl = {(f['kind'], 'the route' if f['on'] == 'route' else 'holes') for f in r['flags'] if f['on'] == 'route'}
        for s in r['steps']:
            for h in s['holes']:
                for f in h['flags']: fl.add((f['kind'], 'step %d %s' % (s['n'], h['place'])))
        fs = {(f['id'], f['level'], f['where']) for f in r.get('findings') or []}
        for s in r['steps']:
            fs |= {(f['id'], f['level'], f['where']) for f in s.get('findings') or []}
            for h in s['holes']: fs |= {(f['id'], f['level'], f['where']) for f in h.get('findings') or []}
        out[r.get('id') or r['file']] = {'title': '%s  %s' % (r.get('site') or '', r.get('what') or ''), 'site': r.get('site'), 'what': r.get('what'), 'holes': holes, 'steps': steps, 'flags': fl, 'findings': fs,
                                         'wire': XW.summary_of(r.get('wire'))}
    return out


def pair_routes(A, B):
    """Routes of two homes paired: by id, else by site and what it does, else (one route a side) by what it does alone."""
    pairs, la, lb = [], dict(A), dict(B)
    for k in list(la):
        if k in lb: pairs.append((k, la.pop(k), lb.pop(k)))
    for k, a in list(la.items()):
        twin = [j for j, b in lb.items() if (b['site'], b['what']) == (a['site'], a['what'])]
        if len(twin) == 1: pairs.append((k, la.pop(k), lb.pop(twin[0])))
    for k, a in list(la.items()):
        twin = [j for j, b in lb.items() if b['what'] == a['what']]
        if len(twin) == 1 and len([1 for x in la.values() if x['what'] == a['what']]) == 1: pairs.append((k, la.pop(k), lb.pop(twin[0])))
    return pairs, la, lb


def diff(home_a, home_b, log_a=None, log_b=None):
    """(lines, new breaks): what changed from A to B, as text, with no value in it."""
    A, B = snapshot(home_a, log_a), snapshot(home_b, log_b)
    pairs, lost, gained = pair_routes(A, B)
    lines, breaks = [], 0
    for k, r in sorted(gained.items(), key=lambda kv: kv[1]['title']):
        nb = sum(1 for f in r['findings'] if f[1] == 'break')
        breaks += nb
        lines.append('+ route %s (%s)%s' % (r['title'], k, ', %d break(s)' % nb if nb else ''))
        for f in sorted(r['findings']):
            if f[1] == 'break': lines.append('    + [break] %s %s' % (f[0], f[2]))
    for k, r in sorted(lost.items(), key=lambda kv: kv[1]['title']): lines.append('- route %s (%s)' % (r['title'], k))
    changed = 0
    for k, a, b in sorted(pairs, key=lambda p: p[1]['title']):
        out = []
        ha, hb = a['holes'], b['holes']

        def match(key, other):
            if key in other: return key
            n, m, path, place = key
            return next((o for o in other if o[3] == place and o[1] == m and fits({'method': m, 'path': path}, {'method': o[1], 'path': o[2]})), None)
        seen_b = set()
        for key, x in ha.items():
            kb = match(key, hb)
            if kb is None:
                out.append('  - hole step %d %s %s · %s (was %s, r%s: %s)' % (key[0], key[1], key[2], key[3], x['src'], x['rung'], x['expr']))
                continue
            seen_b.add(kb)
            y = hb[kb]
            what = ['%s %s -> %s' % (n, x[f], y[f]) for n, f in (('source', 'src'), ('rung', 'rung'), ('expression', 'expr')) if x[f] != y[f]]
            if what: out.append('  ~ hole step %d %s %s · %s: %s' % (key[0], key[1], key[2], key[3], '; '.join(what)))
        for kb, y in hb.items():
            if kb not in seen_b: out.append('  + hole step %d %s %s · %s (%s, r%s: %s)' % (kb[0], kb[1], kb[2], kb[3], y['src'], y['rung'], y['expr']))
        for f in sorted(b['flags'] - a['flags']): out.append('  + flag %s (%s)' % f)
        for f in sorted(a['flags'] - b['flags']): out.append('  - flag %s (%s)' % f)
        # Route to transport: a call that newly differs from its browser, and one that no longer does.
        words = {k: v[0] for k, v in XW.KINDS.items()}
        for n, kind, name in sorted(b.get('wire', set()) - a.get('wire', set())): out.append('  + differs step %d: %s%s' % (n, words.get(kind, kind), ' (%s)' % name if name else ''))
        for n, kind, name in sorted(a.get('wire', set()) - b.get('wire', set())): out.append('  - differs step %d: %s%s' % (n, words.get(kind, kind), ' (%s)' % name if name else ''))
        fa = {(i, w) for i, _, w in a['findings']}
        for f in sorted(b['findings'], key=lambda f: (X.LEVELS.index(f[1]), f[0])):
            if (f[0], f[2]) not in fa:
                out.append('  + [%s] %s %s' % (f[1], f[0], f[2]))
                breaks += f[1] == 'break'
        fb = {(i, w) for i, _, w in b['findings']}
        for f in sorted(a['findings'], key=lambda f: (X.LEVELS.index(f[1]), f[0])):
            if (f[0], f[2]) not in fb: out.append('  - [%s] %s %s' % (f[1], f[0], f[2]))
        if out:
            changed += 1
            lines.append('~ route %s (%s%s)' % (a['title'], k, '' if k in B else ' -> another id'))
            lines += out
    lines.append('%d route(s) in A, %d in B: %d gained, %d lost, %d changed; %d new break(s)' % (len(A), len(B), len(gained), len(lost), changed, breaks))
    return lines, breaks


def main(argv=None):
    ap = argparse.ArgumentParser(prog='wiring.py', description=__doc__.split('\n\n')[0])
    ap.add_argument('what', choices=('serve', 'render', 'state', 'diff'))
    ap.add_argument('homes', nargs='*', help='diff: <home A> <home B>')
    ap.add_argument('--home', action='append', default=[], help='a node home or its routes folder (repeat for more)')
    ap.add_argument('--ub-dir', default=None, help="a scratch node's folder: its home (home/node), its log (node.log) and its walks (tmp/unbrowse-node-walks). Default $UB_DIR when no home is named")
    ap.add_argument('--matrix', action='store_true', help="also every matrix scratch home under $TMPDIR, a group per run")
    ap.add_argument('--runs', type=int, default=None, help='only the newest N matrix runs (render: default 3)')
    ap.add_argument('--log', help="a node's log (SIGN_DEBUG=1): the pick, read by xray_log. Default: the scratch node's node.log")
    ap.add_argument('--captures', help="the walks' captures (default: tmp/unbrowse-node-walks beside the log)")
    ap.add_argument('--engine', default=None, help="the checkout whose engine is read (default: the one this file is in; uncommitted edits included)")
    ap.add_argument('--map', default=None, help="engine-map.json as xray.sh writes it: its `rebuild` is read beside the running engine")
    ap.add_argument('--no-engine', action='store_true', help='do not read the engine')
    ap.add_argument('--port', type=int, default=7317)
    ap.add_argument('--out', help='render: the file to write (default stdout). Never inside a repository: a route names its site.')
    ap.add_argument('--source', action='store_true', help="render: write programs' source into the snapshot (collapsed)")
    ap.add_argument('--json', action='store_true', help='state: the same state the page draws, as JSON (the default for state); diff: as JSON')
    a = ap.parse_args(argv)
    if a.what == 'diff':
        if len(a.homes) != 2:
            print('wiring.py diff <home A> <home B>', file=sys.stderr)
            return 2
        lines, breaks = diff(*a.homes)
        if a.json: print(json.dumps({'lines': lines, 'new_breaks': breaks}, ensure_ascii=False))
        else: print('\n'.join(lines))
        return 1 if breaks else 0
    ub = a.ub_dir or (os.environ.get('UB_DIR') if not a.home and not a.matrix else None)
    if ub:
        ub = os.path.abspath(os.path.expanduser(ub))
        a.home.append(os.path.join(ub, 'home', 'node') if os.path.isdir(os.path.join(ub, 'home', 'node')) else ub)
        if not a.log and os.path.isfile(os.path.join(ub, 'node.log')): a.log = os.path.join(ub, 'node.log')
        if not a.captures: a.captures = os.path.join(ub, 'tmp', 'unbrowse-node-walks')
    if not a.home and not a.matrix:
        env = os.environ.get('UNBROWSE_ROUTES')
        a.home = [env] if env else ([os.path.expanduser('~/.unbrowse')] if os.path.isdir(os.path.expanduser('~/.unbrowse/routes')) else [])
        if not a.home:
            print('name a home (--home DIR), a scratch node (--ub-dir, or UB_DIR), or --matrix', file=sys.stderr)
            return 2
    runs = a.runs if a.runs is not None else (3 if a.what == 'render' else None)
    engine = None if a.no_engine else Engine(os.path.abspath(a.engine) if a.engine else TOP, a.map)
    reader = Reader(a.home, a.matrix, runs, a.log, engine=engine, captures=a.captures)
    if a.what == 'state':
        print(json.dumps(reader.state(all_groups=True), ensure_ascii=False, indent=1))
        return 0
    if a.what == 'render':
        target = a.out or stdout_path()
        if target and repo_of(target):
            print('refusing to write into a repository (%s): a route names its site. Write the page outside one.' % repo_of(target), file=sys.stderr)
            return 2
        text = page(reader.state(all_groups=True, with_source=a.source), live=False)
        if a.out:
            with open(a.out, 'w', encoding='utf-8') as f: f.write(text)
            print(os.path.realpath(a.out))
        else: sys.stdout.write(text)
        return 0
    Handler.reader = reader
    reader.overview()  # read every route once before the address is printed, so the first page is served warm
    for port in (a.port, 0):
        try:
            srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            continue
    print('http://127.0.0.1:%d/' % srv.server_address[1], flush=True)
    print('reading %s%s%s' % (', '.join(a.home) + (' and the matrix runs' if a.matrix else ''), '; the log ' + a.log if a.log else '; no node log (--log)',
                             '; the engine at ' + engine.root if engine else ''), flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
