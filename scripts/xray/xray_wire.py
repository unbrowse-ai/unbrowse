"""Route to transport: what a route's last call put on the wire, step by step, beside what the walk's browser sent and
what the route says to send. Read by wiring.py for an opened route; standard library only, asks no site.

Three columns a step, each read from a file and never guessed:

  the browser   the walk's capture (`<node>/tmp/unbrowse-node-walks/learn_<walk>*.jsonl`): the step's first request in
                the walk, its wire headers (`request_extra`: what Chrome's network stack sent, cookies included; their
                pseudo-headers say h2 or h3, none says h1), else the page's own (`request`), and the reply's status.
  the route     the route file: each header and cookie hole and its source, as the wiring view reads it.
  the call      what the engine logged of the last call, in this order of trust: `sent.jsonl` beside `made.jsonl` (the
                engine addition proposed as an engine addition under UNBROWSE_SENT_LOG: one line per request sent, names and shapes only);
                the node's `[wire]` lines (`UNBROWSE_WIRE_DEBUG`: header names as handed to the transport); the names
                the client prints of a refused request (`UNBROWSE_SIGN_DEBUG`); the client's `[debug] step N <path> ->
                <status>` and the call's own `[call] failed ...` words. A column the files do not fill says "not
                recorded" and what would fill it.

Each difference is a kind, a rule read from the data and never a list of names (see KINDS). No value is printed: a
header or cookie is named, a value is measured (its length) and compared on this machine only. A caller's word is
`‹word›`. A name shaped like a token is shown by its shape.
"""
import json, os, re, urllib.parse as U

# Set by wiring.py (one shape rule for the whole harness).
tokenish = lambda s: False
shape = lambda s: '%d chars' % len(str(s))
hush = lambda s: s

# The statuses a door answers with while it decides (`trace::REFUSED`). Read from the engine's source where it is in
# hand (`refused_statuses`); these are its words today.
REFUSED = (403, 429, 503)
REFUSED_RS = re.compile(r'pub const REFUSED:\s*\[u16;\s*\d+\]\s*=\s*\[([\d,\s]+)\]')

# Headers the protocol writes, never the page or the route: the address's own (h2's pseudo-headers, h1's `host`) and a
# body's length, made from the body. They are not compared.
PROTOCOL = ('host', 'content-length', 'connection')

# Each difference kind: its words, and the engine's functions that build that part of the request (`file::fn`, resolved
# against the source as it stands by xray_why.resolve, so a renamed one shows as gone).
KINDS = {
    'missing': ("a header the browser sent that the call did not", ['http.rs::send_once', 'http.rs::add_to', 'replay.rs::by_fields', 'body.rs::filled', 'slots.rs::is_browser_header']),
    'extra': ("a header the call sent that the browser never did", ['http.rs::send_once', 'replay.rs::by_fields', 'body.rs::filled']),
    'order': ("the same headers in another order", ['http.rs::send_once', 'http.rs::held_to_proxy']),
    'cookie': ("a cookie the browser carried that the jar did not give", ['client.rs::with_session_cookies', 'client.rs::keep_set_cookies', 'client.rs::merge_sighting']),
    'empty': ("a value the route fills that came out empty", ['body.rs::filled', 'replay.rs::by_fields']),
    'walked': ("a value the route sends as the walk's own", ['body.rs::filled', 'replay.rs::by_fields', 'fresh.rs::ids']),
    'proto': ("another protocol than the browser's", ['http.rs::held_to_proxy']),
    'identity': ("the transport names another browser than the walk's", ['http.rs::as_sampled', 'http.rs::add_to', 'http.rs::agreeing_user_agent']),
    'reply': ("the reply reads as a refusal or a door", ['replay.rs::run', 'trace.rs::is_refused', 'graph.rs::answered']),
}
# The kinds that say the request is not the browser's (the reply and the session's values are said apart).
SHAPE_KINDS = ('missing', 'extra', 'order', 'cookie', 'empty', 'proto', 'identity')

FLAGS = [
    ('refused-differs', "refused, the request differs", "the last call was refused (a refusal status or the site's door) and what it sent differs from what the walk's browser sent: the wall may be about the request's shape"),
    ('refused-same', "refused, the request identical", "the last call was refused, and what is recorded of it matches the walk's browser: the wall is not about the request's shape"),
    ('walked-session', "sent as walked, the session's", "a hole sent as fixed text whose value, in the walk, was the session's: a cookie the browser carried or the jar holds"),
]


def refused_statuses(engine_root):
    try:
        with open(os.path.join(engine_root, 'unbrowse-node', 'crates', 'learn', 'src', 'trace.rs'), encoding='utf-8') as f: m = REFUSED_RS.search(f.read())
        if m: return tuple(int(x) for x in m.group(1).replace(' ', '').split(',') if x)
    except (OSError, TypeError): pass
    return REFUSED


def name_of(n):
    """A header's or a cookie's name as shown: itself, or its shape where it is shaped like a token (a name can carry
    an id). A name is the site's word, never the caller's, so it is not hushed."""
    n = str(n)
    return '‹%s›' % shape(n) if tokenish(n) else n


def cookie_names(header):
    """(names, {name: value}) of a Cookie header, in order. The values stay here: they are compared, never shown."""
    names, vals = [], {}
    for part in str(header or '').split(';'):
        k, eq, v = part.strip().partition('=')
        if k and eq:
            names.append(k)
            vals[k] = v
    return names, vals


def path_fits(template, path):
    a, b = str(template or '/').split('/'), str(path or '/').split('/')
    return len(a) == len(b) and all(x == y or '{' in x for x, y in zip(a, b))


def rust_list(s):
    return [U.unquote(x.encode().decode('unicode_escape')) if '\\' in x else x for x in re.findall(r'"((?:[^"\\]|\\.)*)"', s or '')]


# ------------------------------------------------------------------------------------------------ the node's log
CALL = re.compile(r'^call (\{.*\})\s*$')
WIRE = re.compile(r'\[wire\] (\S+) (\S+) headers=\[(.*)\] body=(\d+)b')
REFUSED_SENT = re.compile(r'\[debug\] the refused request sent \[(.*)\]')
STEP_STATUS = re.compile(r'\[debug\] step (\d+) (\S+) -> (\d+)( \(a wall\))?')
FAILED = re.compile(r'\[call\] (?:failed before any heal|the site drifted \(|[0-9a-f]{8,}: the site drifted)[: ]*(.*)')
DOOR = re.compile(r"\(([a-z]+://[^)\s]+)\) met the site's door: answered (\d+)")
ANSWERED = re.compile(r"\(([a-z]+://[^)\s]+)\) answered (\d+)")
TLS = re.compile(r'\[tls\] (.*)')


def calls_in_log(path):
    """{route id: its last call's block}: the lines between its `call {"phase":"start"}` and `"end"`, its ok and times.
    A block another call ran beside says so (`overlap`): its lines are then matched by address alone. `tls`: the
    process's `[tls]` lines, wherever they are."""
    out, open_, tls = {}, {}, []
    try: f = open(path, encoding='utf-8', errors='replace')
    except (OSError, TypeError): return out, tls
    with f:
        for line in f:
            m = CALL.match(line)
            if m:
                try: c = json.loads(m.group(1))
                except ValueError: continue
                if c.get('phase') == 'start':
                    if open_:
                        for b in open_.values(): b['overlap'] = True
                    open_[c.get('id')] = {'route': c.get('route'), 'start_ms': c.get('at_ms'), 'lines': [], 'overlap': bool(open_)}
                elif c.get('phase') == 'end' and c.get('id') in open_:
                    b = open_.pop(c.get('id'))
                    b.update(end_ms=c.get('at_ms'), ok=c.get('ok'), ms=c.get('ms'))
                    out[b['route']] = b
                continue
            t = TLS.search(line)
            if t and len(tls) < 8 and t.group(1).strip() not in tls: tls.append(t.group(1).strip())
            if open_ and ('[wire]' in line or '[debug]' in line or '[call]' in line or '[door]' in line):
                for b in open_.values():
                    if len(b['lines']) < 400: b['lines'].append(line.rstrip('\n'))
    return out, tls


def read_block(block):
    """What a call's block says, as records: wire lines, refused shapes, statuses by path, and the call's failure."""
    out = {'wire': [], 'refused': [], 'status': [], 'failed': None, 'overlap': bool(block and block.get('overlap'))}
    for line in (block or {}).get('lines') or []:
        m = WIRE.search(line)
        if m:
            u = U.urlsplit(m.group(2))
            out['wire'].append({'method': m.group(1).upper(), 'host': u.hostname or '', 'path': U.unquote(u.path or '/'), 'headers': [h.lower() for h in rust_list(m.group(3))], 'body': int(m.group(4))})
            continue
        m = REFUSED_SENT.search(line)
        if m:
            # The client prints a refused request's header names, in order, and the values that say which browser
            # asks (user agent, client hints): those are kept here to be compared, never shown.
            items = rust_list(m.group(1))
            names = [x.split('=', 1)[0].lower() for x in items]
            vals = {x.split('=', 1)[0].lower(): x.split('=', 1)[1] for x in items if '=' in x}
            wall = next((st for st in reversed(out['status']) if st['wall'] and 'names' not in st), None)
            if wall is not None: wall.update(names=names, _values=vals)
            else: out['refused'].append({'names': names, '_values': vals})
            continue
        m = STEP_STATUS.search(line)
        if m:
            out['status'].append({'exchange': int(m.group(1)), 'path': m.group(2), 'status': int(m.group(3)), 'wall': bool(m.group(4))})
            continue
        m = FAILED.search(line)
        if m and out['failed'] is None:
            words = m.group(1)
            d, a = DOOR.search(words), ANSWERED.search(words)
            hit = d or a
            u = U.urlsplit(hit.group(1)) if hit else None
            out['failed'] = {'door': bool(d), 'status': int(hit.group(2)) if hit else None, 'host': u.hostname if u else None, 'path': U.unquote(u.path) if u else None,
                             'words': hush(re.sub(r'[a-z]+://\S+?(?=\)|\s|$)', lambda x: (U.urlsplit(x.group(0)).hostname or '') + '/…', words))[:240]}
    return out


def read_sent(path, most=20000):
    """`sent.jsonl` (the engine addition): one record per request sent, names and shapes only. The last `most` lines."""
    try:
        with open(path, encoding='utf-8', errors='replace') as f: lines = f.readlines()[-most:]
    except (OSError, TypeError): return []
    out = []
    for l in lines:
        try: r = json.loads(l)
        except ValueError: continue
        if isinstance(r, dict) and (r.get('site') or r.get('host')): out.append(r)
    return out


def read_jar(home, host):
    """The names the jar for `host` holds and their values (compared here, never shown), or None without a jar file;
    and the fingerprint sample the transport is shaped from (`jars/<host>.json.fp`), if any."""
    d = os.path.join(home or '', 'jars')
    jar = fp = None
    try:
        with open(os.path.join(d, host + '.json'), encoding='utf-8') as f: o = json.load(f)
        items = o.get('items') if isinstance(o, dict) and isinstance(o.get('items'), dict) else o if isinstance(o, dict) else {}
        jar = {str(k): str(v) for k, v in items.items() if k != 'v'}
    except (OSError, ValueError, TypeError, AttributeError): pass
    try:
        with open(os.path.join(d, host + '.json.fp'), encoding='utf-8') as f: o = json.load(f)
        fp = o.get('items') if isinstance(o, dict) and isinstance(o.get('items'), dict) else o
    except (OSError, ValueError, TypeError): pass
    return jar, fp


def hints_of(fp):
    """The `sec-ch-ua` and user agent the transport sends from a fingerprint sample (`ClientHints::of`, `headers`)."""
    if not isinstance(fp, dict): return None, None
    data = fp.get('uaData') if isinstance(fp.get('uaData'), dict) else None
    ua = fp.get('ua') if isinstance(fp.get('ua'), str) and fp.get('ua').strip() else None
    brands = None
    if data and isinstance(data.get('brands'), list):
        bs = [(b.get('brand'), b.get('version')) for b in data['brands'] if isinstance(b, dict) and b.get('brand') and b.get('version')]
        if bs: brands = ', '.join('"%s";v="%s"' % b for b in bs)
    return brands, ua


def agreeing_user_agent(brands, platform, named):
    """The user agent the transport puts on the wire (`http.rs::agreeing_user_agent`, read as it stands): where the
    request's client hints name a Chrome at a major version and `named` does not, the reduced user agent of that version
    and platform; else `named`. Mirrored here only to compare it with the walk's; it is never shown."""
    m = re.search(r'"(?:Google Chrome|Chromium)";v="(\d+)"', brands or '')
    if not m: return named
    v = m.group(1)
    if named and ('Chrome/%s.' % v) in named: return named
    system = {'windows': 'Windows NT 10.0; Win64; x64', 'linux': 'X11; Linux x86_64', 'macos': 'Macintosh; Intel Mac OS X 10_15_7', '': 'Macintosh; Intel Mac OS X 10_15_7'}.get((platform or '').strip('"').lower())
    if system is None: return named
    return 'Mozilla/5.0 (%s) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s.0.0.0 Safari/537.36' % (system, v)


def transport_build(engine_root):
    """What the engine's source says of the transport's identity: its emulation, and whether the ClientHello patch
    measured against the minting Chrome is vendored into this build. Read from the source, never per call."""
    out = {}
    base = os.path.join(engine_root or '', 'unbrowse-node')
    try:
        with open(os.path.join(base, 'crates', 'learn', 'src', 'http.rs'), encoding='utf-8') as f: src = f.read()
        m = re.search(r'Emulation::(\w+)\.into_emulation', src)
        if m: out['emulation'] = m.group(1)
        out['ech_grease'] = 'enable_ech_grease = true' in src
        out['alps'] = 'alps_protocols' in src
        out['sigalgs'] = 'sigalgs_list' in src
    except (OSError, TypeError): pass
    if os.path.isdir(os.path.join(base, 'crates', 'learn', 'assets', 'chrome-clienthello')): out['measured'] = 'crates/learn/assets/chrome-clienthello'
    out['vendored'] = os.path.isfile(os.path.join(base, 'vendor', 'btls-sys', 'patches', 'chrome-ext.patch'))
    return out


# ------------------------------------------------------------------------------------------------ the walk's browser
def browser_side(cap, step):
    """The step's first request in the walk, as the browser sent it. None where the capture holds none."""
    if cap is None: return None
    r = cap.first_call(step)
    if r is None: return None
    wire = (getattr(cap, 'extra', {}) or {}).get((r['walk'], r['id']))
    raw = wire if wire is not None else r['headers']
    names, lens, pseudo, cookie = [], {}, [], ''
    for k, v in raw.items():
        k = str(k).lower()
        if k.startswith(':'):
            pseudo.append(k)
            continue
        names.append(k)
        lens[k] = len(str(v))
        if k == 'cookie': cookie = str(v)
    cnames, cvals = cookie_names(cookie)
    # What the page's own request named (`request`): a name only the wire list has is one Chrome's network stack wrote
    # itself (its encodings, its cookies), as the transport writes its own.
    page = [str(k).lower() for k in r['headers']]
    return {'from': 'wire' if wire is not None else 'page', 'names': names, 'lens': lens, 'cookies': cnames, '_cookies': cvals, 'page': page,
            '_values': {str(k).lower(): str(v) for k, v in raw.items()}, 'proto': ('h2 or h3' if pseudo else 'h1') if wire is not None else None,
            'status': (getattr(cap, 'status', {}) or {}).get((r['walk'], r['id'])), 'kind': r.get('kind'), 'method': r['method']}


def order_kept(cap):
    """Whether the capture keeps the order headers went out in: not where every wire header list it holds (three or
    more) is in alphabetical order, which is the capture sorting them, not Chrome sending them so."""
    lists = [list(h) for h in (getattr(cap, 'extra', {}) or {}).values()]
    if len(lists) < 3: return None
    return not all(l == sorted(l) for l in lists)


# ------------------------------------------------------------------------------------------------ the call
def same_place(line, host):
    """Whether a sent line went to the step's host: the engine writes the host's site, never the whole host (a host may
    carry the caller's word); an older line wrote the host itself."""
    site = line.get('site')
    if site: return bool(host) and (host == site or str(host).endswith('.' + site))
    return line.get('host') == host


def call_side(step, sent, block, made, window_ms=3000):
    """What the last call sent for this step, from the most exact record there is, or None."""
    host, method, ex = step.get('host'), str(step.get('method') or 'GET').upper(), step.get('exchange')
    if made and sent:
        at, ms = (made.get('at') or 0) * 1000, made.get('ms') or 0
        hits = [r for r in sent if same_place(r, host) and str(r.get('method') or '').upper() == method and at - ms - window_ms <= (r.get('at_ms') or 0) <= at + window_ms
                and (ex is None or r.get('exchange') is None or r.get('exchange') == ex or r.get('exchange') in (step.get('_also') or ()))]
        if hits:
            r = hits[-1]
            names = [str(h).lower() for h in r.get('headers') or []]
            return {'from': 'sent.jsonl', 'names': names, 'lens': dict(zip(names, r.get('lens') or [])), 'order': True, 'cookies': list(r.get('cookies') or []),
                    'proto': r.get('proto'), 'status': r.get('status'), 'body': r.get('body')}
    if block:
        w = [x for x in block['wire'] if x['host'] == host and x['method'] == method and path_fits(step.get('_path'), x['path'])]
        if w:
            return {'from': "the node's [wire] line", 'names': w[-1]['headers'], 'lens': {}, 'order': True, 'cookies': None, 'proto': None, 'status': None, 'body': w[-1]['body'], 'pre': True,
                    'note': "header names as handed to the transport; its emulation adds its own defaults where a name is missing, and the wire's order is its own"}
        r = next((st for st in reversed(block['status']) if st.get('names') and path_fits(step.get('_path'), st['path'])), None)
        if r:
            return refused_call(r)
    return None


def refused_call(st):
    return {'from': "the client's line for a refused request (UNBROWSE_SIGN_DEBUG)", 'names': st['names'], 'lens': {}, 'order': True, 'cookies': None, 'proto': None, 'status': st['status'], 'body': None, 'pre': True,
            '_values': st.get('_values') or {}, 'note': 'header names as the client handed them to the transport, in order; the cookie header is named, its cookies are not'}


def reply_of(step, call, block, refused):
    """The reply's status and how the engine reads it, with where each was read."""
    status, said, where = (call or {}).get('status'), None, None
    if status is not None: where = (call or {}).get('from')
    if block:
        for s in block['status']:
            if path_fits(step.get('_path'), s['path']) and status is None:
                status, where = s['status'], "the client's [debug] step line"
                if s['wall']: return {'status': status, 'reads': 'refusal', 'words': '%d (a wall): the browser runs it' % status, 'said': None, 'from': where}
        f = block['failed']
        if f and f.get('host') == step.get('host') and path_fits(step.get('_path'), f.get('path')):
            if status is None and f.get('status') is not None: status, where = f['status'], "the call's failure"
            said = f['words']
            if f['door']: return {'status': status, 'reads': 'door', 'words': "met the site's door: answered %s" % status, 'said': said, 'from': where}
    if status is None: return None
    if status in refused: return {'status': status, 'reads': 'refusal', 'words': 'a refusal a door answers with while it decides (trace::REFUSED %s)' % '/'.join(map(str, refused)), 'said': said, 'from': where}
    if status >= 400: return {'status': status, 'reads': 'failed', 'words': 'the site answered %d' % status, 'said': said, 'from': where}
    return {'status': status, 'reads': 'answered', 'words': 'answered', 'said': said, 'from': where}


# ------------------------------------------------------------------------------------------------ one route
def route_side(step):
    """The step's header and cookie holes, by name, each with its source as the wiring view strung it."""
    heads, cookies = [], []
    for h in step['holes']:
        name = h['place'].split(' ', 1)[-1] if ' ' in h['place'] else ''
        if h['in'] == 'header': name = name.lower()
        src = ', '.join(l['layer'] + (' (' + l['why'] + ')' if l.get('why') else '') for l in h['layers']) or ('open' if h['open'] else 'fixed text, as walked' if h['fixed'] else 'nothing')
        row = {'name': name_of(name), 'source': hush(src), 'rung': h.get('rung'), 'fixed': h['fixed'], 'flags': [f['kind'] for f in h['flags']]}
        if h['in'] == 'header': heads.append((name, row, h))
        elif h['in'] == 'cookie': cookies.append((name, row, h))
    return heads, cookies


def compare(b, c, heads, cks, cap, keep_order, jar, hints, build):
    """The differences of one request: the browser's (`b`) against the call's record (`c`) where there is one, else
    against what the route says (`heads`, `cks`). Each a kind of KINDS, with a name where it is about one, and why."""
    diffs = []
    if not b: return diffs
    jar_names = set(jar or {})
    bn = [n for n in b['names'] if n not in PROTOCOL and n != 'cookie']
    own = cap.browsers_own() if cap else None
    # Names only Chrome's network stack wrote (in the wire list, not the page's request) or the browser writes on what
    # the document loads by itself: on a record made before the transport (`pre`), the transport writes these itself.
    writes_itself = {n for n in bn if n not in b['page']} | (own or set()) | {'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'} if c and c.get('pre') else set()
    if c:
        cn = [n for n in c['names'] if n not in PROTOCOL and n != 'cookie']
        for n in bn:
            if n not in cn and n not in writes_itself: diffs.append({'kind': 'missing', 'name': name_of(n), 'why': 'the browser sent it (%d chars); the call did not' % b['lens'].get(n, 0)})
        for n in cn:
            if n not in bn: diffs.append({'kind': 'extra', 'name': name_of(n), 'why': 'the call sent it; the browser did not, on this request'})
        both = [n for n in cn if n in bn]
        if keep_order and c.get('order') and both != [n for n in bn if n in cn]:
            diffs.append({'kind': 'order', 'name': None, 'why': 'the %d headers both sent, in another order' % len(both)})
    else:
        # The route alone: what the page set (a name the page's own request carried that is not one the browser writes
        # itself); the browser's own the transport writes as its emulation does.
        rn = [n for n, _, _ in heads]
        for n in bn:
            if n in b['page'] and (own is None or n not in own) and n not in rn:
                diffs.append({'kind': 'missing', 'name': name_of(n), 'why': "the page set it (%d chars) on the browser's request; the route has no hole for it" % b['lens'].get(n, 0)})
        for n in rn:
            if n not in bn: diffs.append({'kind': 'extra', 'name': name_of(n), 'why': 'the route sends it; the browser did not, on this request'})
    # Cookies: the call's own names, else what the jar holds and the route fills.
    given = set(c['cookies']) if c and c.get('cookies') is not None else (jar_names | {n for n, _, _ in cks}) if jar is not None else None
    for n in b['cookies']:
        if given is not None and n not in given:
            diffs.append({'kind': 'cookie', 'name': name_of(n), 'why': 'the browser carried it; %s' % ('the call did not' if c and c.get('cookies') is not None else 'the jar does not hold it and the route does not fill it')})
    if c and c.get('proto') and b.get('proto') and (c['proto'].startswith('h1') or 'HTTP/1' in c['proto']) != (b['proto'] == 'h1'):
        diffs.append({'kind': 'proto', 'name': None, 'why': 'the browser spoke %s; the call %s' % (b['proto'], c['proto'])})
    # Which browser each says it is: the call's own values where the client printed them, else what the transport
    # sends from the jar's fingerprint sample. Compared here; neither value is shown.
    bv, cv = b['_values'], (c or {}).get('_values') or {}
    hint_ua, fp_ua = hints
    for name in ('sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile', 'user-agent'):
        if name in cv and bv.get(name) and cv[name] != bv[name]:
            diffs.append({'kind': 'identity', 'name': name, 'why': "the call's %s is not the walk's browser's (compared on this machine; neither is shown)" % name})
    if 'sec-ch-ua' not in cv and hint_ua is not None and bv.get('sec-ch-ua') and bv['sec-ch-ua'] != hint_ua:
        diffs.append({'kind': 'identity', 'name': 'sec-ch-ua', 'why': "the client hints the transport sends (the jar's fingerprint sample) name other brands than the walk's browser did"})
    if 'sec-ch-ua' not in cv and hint_ua is None and bv.get('sec-ch-ua') and 'sec-ch-ua' not in [n for n, _, _ in heads] and not (c and 'sec-ch-ua' in c['names']):
        diffs.append({'kind': 'identity', 'name': 'sec-ch-ua', 'why': "the browser sent client hints; neither the route nor the jar's fingerprint sample gives any, so the transport's emulation (%s) sends its own" % ((build or {}).get('emulation') or 'its profile')})
    # The user agent on the wire: the request's own, else the jar's sample, made to agree with the request's client
    # hints (the route's, else the sample's) as the transport does.
    route_ua = 'user-agent' in [n for n, _, _ in heads]
    if 'user-agent' not in cv and not route_ua and fp_ua is not None and bv.get('user-agent'):
        sent_hints = (bv.get('sec-ch-ua') if 'sec-ch-ua' in [n for n, _, _ in heads] or 'sec-ch-ua' in cv else None) or cv.get('sec-ch-ua') or hint_ua
        ua = agreeing_user_agent(sent_hints, cv.get('sec-ch-ua-platform') or bv.get('sec-ch-ua-platform'), fp_ua)
        if ua != bv['user-agent']:
            diffs.append({'kind': 'identity', 'name': 'user-agent', 'why': "the user agent the transport sends (the jar's sample, agreed with the request's client hints as http.rs::agreeing_user_agent does) is not the walk's browser's"})
    return diffs


def find_in_walk(cap, path, hosts):
    """The walk's first request to `path` on one of `hosts`, as a step to compare (a refused request the route as it
    stands no longer names)."""
    for r in (cap.requests if cap else []):
        if r['host'] in hosts and path_fits(path, r['path']):
            return {'method': r['method'], 'host': r['host'], '_path': r['path']}
    return None


def public_side(b):
    return {k: v for k, v in b.items() if not k.startswith('_') and k != 'page'} | {'names': [name_of(n) for n in b['names']], 'cookies': [name_of(n) for n in b['cookies']],
                                                                                 'lens': {name_of(k): v for k, v in b['lens'].items()}}


def public_call(c):
    return None if c is None else {k: v for k, v in c.items() if not k.startswith('_')} | {'names': [name_of(n) for n in c['names']], 'lens': {name_of(k): v for k, v in c['lens'].items()},
                                                                                          'cookies': None if c.get('cookies') is None else [name_of(n) for n in c['cookies']]}


def transport(model, cap, made, block, sent, jar, fp, refused=REFUSED, build=None, tls=()):
    """The route's last call, step by step, in three columns, with each difference and the flags it raises. Marks the
    holes it flags (`walked-session`) and returns the route's flags; the model's `wire` is what the page draws."""
    rb = read_block(block) if block else None
    keep_order = order_kept(cap) if cap else None
    steps, differs, refusedc, basis = [], 0, False, []
    jar_vals = {v: k for k, v in (jar or {}).items() if len(v) >= 6}
    walk_cookies = {}
    for r in (cap.requests if cap else []):
        cv = ((getattr(cap, 'extra', {}) or {}).get((r['walk'], r['id'])) or {}).get('cookie') or r['headers'].get('cookie')
        for k, v in cookie_names(cv)[1].items():
            if len(v) >= 6: walk_cookies.setdefault(v, k)
    hints = hints_of(fp)
    matched = []
    for s in model['steps']:
        b = browser_side(cap, s)
        c = call_side(s, sent, rb, made)
        if c and c.get('from', '').startswith("the client's line"): matched.append(c)
        heads, cks = route_side(s)
        diffs = compare(b, c, heads, cks, cap, keep_order, jar, hints, build)
        if c and c.get('lens'):
            for n, row, h in heads:
                if c['lens'].get(n) == 0 and not h['fixed']: diffs.append({'kind': 'empty', 'name': name_of(n), 'why': 'the route fills it (%s); the call sent it empty' % row['source']})
        for n, row, h in heads + cks:
            v = h.get('_value')
            if not h['fixed'] or not isinstance(v, str): continue
            why = None
            if h['in'] == 'cookie': why = "a cookie sent as walked: in the walk it was the session's, and a cookie the request carries is not replaced by the jar's"
            elif len(v) >= 6 and v in walk_cookies: why = "it equals the walk's cookie %s" % name_of(walk_cookies[v])
            elif len(v) >= 6 and v in jar_vals: why = "it equals what the jar holds under %s" % name_of(jar_vals[v])
            if why:
                h['flags'].append({'kind': 'walked-session', 'why': 'sent as fixed text, and ' + why})
                diffs.append({'kind': 'walked', 'name': row['name'], 'why': why})
            elif 'frozen' in row['flags']:
                diffs.append({'kind': 'walked', 'name': row['name'], 'why': "sent as the walk sent it, while it moves (see the hole's flag)"})
        reply = reply_of(s, c, rb, refused)
        if reply and reply['reads'] in ('door', 'refusal'):
            refusedc = True
            diffs.append({'kind': 'reply', 'name': None, 'why': '%s: %s' % (reply['status'], reply['words'])})
            # Only the refused request's own differences say whether the wall is about its shape.
            differs += sum(1 for d in diffs if d['kind'] in SHAPE_KINDS)
            basis.append('call' if c else 'route')
        steps.append({'n': s['n'], 'method': s['method'], 'host': s['host'], 'path': s['path'], 'against': 'call' if c else 'route',
                      'browser': None if b is None else public_side(b) | {'order': keep_order}, 'route': {'headers': [r for _, r, _ in heads], 'cookies': [r for _, r, _ in cks]},
                      'call': public_call(c), 'reply': reply, 'diffs': diffs})
    # A request the last call sent and was refused for that the route as it stands does not name (it was learned again
    # since, or the request was a heal's): compared with the walk's own request to the same address.
    hosts = {s['host'] for s in model['steps']}
    for st in (rb or {}).get('status') or []:
        if not st.get('names') or any(c is not None and c.get('names') is st['names'] for c in matched): continue
        if any(path_fits(s.get('_path'), st['path']) for s in model['steps']): continue
        at = find_in_walk(cap, st['path'], hosts) or {'method': None, 'host': next(iter(sorted(hosts)), ''), '_path': st['path']}
        b = browser_side(cap, at) if at.get('method') else None
        c = refused_call(st)
        diffs = compare(b, c, [], [], cap, keep_order, jar, hints, build)
        refusedc = True
        diffs.append({'kind': 'reply', 'name': None, 'why': '%d (a wall): the browser runs it' % st['status']})
        differs += sum(1 for d in diffs if d['kind'] in SHAPE_KINDS)
        basis.append('call' if b else 'nothing')
        steps.append({'n': 'x%d' % st['exchange'], 'method': at.get('method') or '?', 'host': at['host'], 'path': hush(st['path']), 'against': 'call', 'off_route': True,
                      'browser': None if b is None else public_side(b) | {'order': keep_order}, 'route': {'headers': [], 'cookies': []}, 'call': public_call(c),
                      'reply': {'status': st['status'], 'reads': 'refusal', 'words': '%d (a wall): the browser runs it' % st['status'], 'said': None, 'from': "the client's [debug] step line"}, 'diffs': diffs})
    if rb and rb['failed'] and rb['failed']['door'] and not refusedc:
        refusedc = True  # the call met the site's door on a request the route as it stands does not name
    flags = []
    if refusedc:
        said = "read against the call's own record" if 'call' in basis else "read against the route (what the call sent is not recorded)"
        if differs: flags.append({'kind': 'refused-differs', 'why': "the last call was refused, and the refused request differs from the browser's in %d way(s), %s" % (differs, said)})
        elif basis and set(basis) != {'nothing'} and any(st['browser'] for st in steps): flags.append({'kind': 'refused-same', 'why': "the last call was refused, and what is recorded of the refused request matches the browser's, %s" % said})
    missing = []
    if not any(st['call'] for st in steps): missing.append("what the call sent: no sent.jsonl line, [wire] line or refused-request line for it (the engine writes it where UNBROWSE_SENT_LOG is set, once the sent-log addition lands)")
    elif not any(st['call'] and st['call'].get('from') == 'sent.jsonl' for st in steps): missing.append("the call's cookies by name, its protocol and every request's status: only sent.jsonl records them (the engine writes it where UNBROWSE_SENT_LOG is set, once the sent-log addition lands)")
    if not any(st['browser'] for st in steps): missing.append("what the browser sent: no capture of the route's walk in hand" if cap is None else "what the browser sent: the walk holds no request of these steps")
    if cap is not None and keep_order is False: missing.append("the browser's header order: the capture keeps every wire header list in alphabetical order")
    return {'steps': steps, 'flags': flags, 'not_recorded': missing, 'build': build or {}, 'tls': list(tls), 'last': made and {k: made.get(k) for k in ('ok', 'rung', 'ms', 'at', 'browser')},
            'block': None if rb is None else {'overlap': rb['overlap'], 'failed': rb['failed'] and rb['failed']['words']}}


def summary_of(wire):
    """(step n, kind, name) of each difference, for the diff over time."""
    return {(st['n'], d['kind'], d.get('name') or '') for st in (wire or {}).get('steps') or [] for d in st['diffs']}


def text(wire):
    """The route's transport as lines of text (`state` carries the same as JSON)."""
    out = []
    for st in (wire or {}).get('steps') or []:
        b, c, r = st['browser'], st['call'], st['reply']
        out.append('  step %s %s %s%s' % (st['n'], st['method'], st['host'], st['path']))
        out.append('    browser: %s' % ('not in the capture' if not b else '%d header(s) from the %s, %s, cookies %s' % (len(b['names']), b['from'], b.get('proto') or 'protocol not recorded', ', '.join(b['cookies']) or 'none')))
        out.append('    route:   %s' % ', '.join('%s <- %s' % (h['name'], h['source']) for h in st['route']['headers'] + st['route']['cookies']) or '    route:   no header or cookie hole')
        out.append('    call:    %s' % ('not recorded' if not c else '%d header(s), from %s' % (len(c['names']), c['from'])))
        if r: out.append('    reply:   %s %s' % (r['status'], r['words']))
        for d in st['diffs']: out.append('    ≠ %s%s: %s' % (d['kind'], ' ' + d['name'] if d.get('name') else '', d['why']))
    return out
