"""What the engine surfaced while it learned a route, step by step, read from the node's own log.

The node writes one line for each thing it decides (a scratch node, started with SIGN_DEBUG=1, writes them all):

  eye {"kind": "started" | "seen" | "door" | "scored" | "picked" | "saved" | "failed", ...}   the walk, the calls its door
                                                                                    took and why, the candidate calls and
                                                                                    their scores, the pick and its reasons
  [held] ...     each candidate with why it was held back
  [trial] ...    the second walk: the word offered, and whether it was the same page
  [route] ...    how the route was built; `as built, <place> is {...}` gives each value's kind at each build
  [hears] [verify] [links] [sign] [fields] [call] ...   what was asked of the site afterwards, and what it said

This file reads those lines and nothing else. It shows no value: the words a page was asked are written as ‹word›, an
address keeps its host and path and loses its query, a page's text after a status is dropped, and a value's kind is
shown without the value.
"""
import html, json, re, urllib.parse as U

E = html.escape
TAGS = ('held', 'rank', 'try', 'trial', 'route', 'hears', 'verify', 'links', 'sign', 'fields', 'call', 'heal', 'learn', 'goal')
NO_CONNECTION = re.compile(r'dns error|client error \(Connect\)|error sending request|error reading a body|error decoding response body|did not complete', re.I)


def written(word):
    return {word, U.quote(word), U.quote_plus(word), word.replace(' ', '-'), word.replace(' ', '+'), word.replace(' ', '%20')}


def hush(text, words):
    """`text` with no value in it."""
    t = re.sub(r'(answered \d{3}):.*', r'\1', text)
    t = re.sub(r'https?://([^/\s?")]+)([^\s?")]*)(\?[^\s")]*)?', lambda m: m.group(1) + m.group(2) + ('?…' if m.group(3) else ''), t)
    t = re.sub(r'\?[A-Za-z0-9_.~%=&+-]{2,}', '?…', t)
    for w in sorted({v for word in words for v in written(word)}, key=len, reverse=True):
        if len(w) >= 3: t = re.sub(re.escape(w), '‹word›', t, flags=re.I)
    t = re.sub(r'"[^"]{1,200}"', lambda m: m.group(0) if '‹word›' in m.group(0) or re.fullmatch(r'"[a-z_]{2,24}"', m.group(0)) else '"‹…›"', t)
    t = re.sub(r'(?<![A-Za-z0-9])\d{13}(?![0-9])', '‹13 digits›', t)
    t = re.sub(r'(?<![A-Za-z0-9/._-])[A-Za-z0-9_-]{28,}(?![A-Za-z0-9/._-])', '‹token›', t)
    # Shorter where it is mixed as a key or an id is and a word is not: letters of both cases with digits, or hex.
    t = re.sub(r'(?<![A-Za-z0-9/._-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{16,}(?![A-Za-z0-9/._-])', '‹token›', t)
    t = re.sub(r'(?<![A-Za-z0-9/._-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{20,}(?![A-Za-z0-9/._-])', '‹token›', t)
    return t[:260]


def read(path):
    """The log as learns, in order: {walk, goal, site, page, seen, candidates, held, picked, saved, failed, builds, after}."""
    learns, by_walk, now, aside = [], {}, None, None
    try:
        with open(path, encoding='utf-8', errors='replace') as f: lines = f.read().split('\n')
    except OSError: return []
    for raw in lines:
        line = raw.strip()
        if line.startswith('eye {'):
            try: e = json.loads(line[4:])
            except ValueError: continue
            kind, walk = e.get('kind'), e.get('walk')
            if kind == 'started':
                url = U.urlsplit(e.get('url') or '')
                words = {v for _, v in U.parse_qsl(url.query) if len(v) >= 3}
                now = {'walk': walk, 'goal': e.get('goal') or '', 'site': url.hostname or '', 'page': url.path, 'words': words, 'seen': [], 'candidates': [], 'held': [], 'picked': None, 'saved': None,
                       'failed': None, 'door': None, 'builds': [[]], 'after': [], 'set_aside': aside}
                aside = None
                learns.append(now)
                by_walk[walk] = now
                continue
            l = by_walk.get(walk) or now
            if l is None: continue
            if kind == 'seen': l['seen'].append({k: e.get(k) for k in ('n', 'method', 'host', 'path', 'status', 'bytes', 'sort')})
            elif kind == 'scored': l['candidates'], l['exchanges'] = e.get('candidates') or [], e.get('exchanges')
            elif kind == 'door': l['door'] = {'took': e.get('took') or 0, 'assets': e.get('assets') or 0,
                                              'calls': [{k: c.get(k) for k in ('index', 'method', 'host', 'path', 'why', 'by')} for c in e.get('calls') or []]}
            elif kind == 'picked': l['picked'] = e
            elif kind == 'saved': l['saved'] = e
            elif kind == 'failed': l['failed'] = e.get('error') or ''
            continue
        m = re.match(r'\[([a-z]+)\]\s*(.*)', line)
        if not m or now is None or m.group(1) not in TAGS: continue
        tag, rest = m.group(1), m.group(2)
        # A called route's answer that was not taken is why the next learn starts: it is kept for that learn.
        if tag == 'goal' and 'its answer not taken' in rest: aside = rest
        if tag in ('trial', 'links', 'hears'):
            now['words'].update(w for w in re.findall(r'"([^"]{3,60})"', rest))
        if tag == 'held':
            h = re.match(r'(\S+) (\S+) (\S+) score (-?[\d.]+): (.*)', rest)
            if h:
                facts = dict(re.findall(r'(shapes|covered|answers)=(true|false)', h.group(5)))
                fails = re.search(r'fails=(.*?)(?: nothing=|$)', h.group(5))
                nothing = re.search(r'nothing=(.*)$', h.group(5))
                now['held'].append({'method': h.group(1), 'host': h.group(2), 'path': h.group(3).split('?')[0], 'score': float(h.group(4)), 'facts': facts,
                                    'fails': (fails.group(1) if fails else '').strip(), 'nothing': (nothing.group(1) if nothing else '').strip()})
                continue
        if tag == 'route':
            if rest.startswith('built from two walks'): now['builds'].append([])
            b = re.match(r'as built, (\w+)\((?:"([^"]*)"|(\d+))?\) is (\{.*\})', rest)
            if b:
                try: cls = json.loads(b.group(4))
                except ValueError: cls = {}
                place = '%s:%s' % (b.group(1).lower(), b.group(2) if b.group(2) is not None else (b.group(3) or ''))
                now['builds'][-1].append((place, cls.get('class') or '?', cls.get('clock') or ''))
                continue
        now['after'].append((tag, rest))
    return learns


DOOR_WHY = {'refused': 'refused', 'another_site': "another site's page", 'went_past': 'a page of script the walk went past'}


def door_said(l):
    """What the walk's door took, in a line: how many calls, by why, and the assets it only counted. Empty with no door."""
    d = l.get('door')
    if not d or not d['took']: return ''
    by = {}
    for c in d['calls']: by[c.get('why') or '?'] = by.get(c.get('why') or '?', 0) + 1
    parts = ['%d %s' % (n, DOOR_WHY.get(w, w)) for w, n in sorted(by.items(), key=lambda kv: -kv[1])]
    return '%d call(s) taken before any was a candidate%s%s' % (d['took'], (': ' + ', '.join(parts)) if parts else '', ('; %d asset(s)' % d['assets']) if d['assets'] else '')


def findings(l):
    """What the log itself says went wrong, as (finding id, more)."""
    out = []
    failure = l.get('failed') or ''
    if not l['saved'] and failure.startswith('the captured navigation did not reach the requested page'):
        out.append(('browser-flow-landing', hush(failure, l['words'])))
    taken = door_said(l)
    if taken and (l.get('door') or {}).get('calls'):
        out.append(('door-took-calls' if l['saved'] else 'door-took-the-walk', taken))
    if l['picked'] and l['candidates']:
        top = max(c.get('score') or 0 for c in l['candidates'])
        mine = next((c.get('score') for c in l['candidates'] if c.get('index') == l['picked'].get('index')), None)
        if mine is not None and mine < top: out.append(('picked-below-top', 'picked at %.1f, the highest scored %.1f' % (mine, top)))
        if any(re.search(r'none of the goal.s fields', r) for r in l['picked'].get('reasons') or []): out.append(('picked-without-fields', "the engine's own reason for the pick"))
    lost = [r for t, r in l['after'] if t == 'call' and NO_CONNECTION.search(r)]
    refused = [r for t, r in l['after'] if t == 'links' and re.search(r'not kept|did not answer', r)]
    if lost and refused: out.append(('connection-as-refusal', '%d request(s) never connected; %d verdict(s) say the site did not answer' % (len(lost), len(refused))))
    if l['saved'] and any(t == 'links' and re.search(r'did not answer it for a second word', r) for t, r in l['after']):
        out.append(('kept-unanswered', ''))
        if any(f == 'picked-without-fields' for f, _ in out): out.append(('shell-kept', ''))
    if l['saved'] and any(t == 'trial' and 'another page' in r for t, r in l['after']): out.append(('second-walk-elsewhere', ''))
    if l['saved'] and l.get('set_aside'): out.append(('learned-after-set-aside', hush(l['set_aside'].split('not taken:', 1)[-1].strip(), l['words'])))
    return out


def history(l, final=None):
    """Each place's kind at each build, and in the kept route where `final` (place -> kind) is given."""
    places, rows = [], {}
    for n, build in enumerate(l['builds']):
        for place, cls, clock in build:
            if place not in rows:
                rows[place] = {}
                places.append(place)
            rows[place][n] = cls + ((' (' + clock + ')') if clock else '')
    return [(p, [rows[p].get(n, '') for n in range(len(l['builds']))], (final or {}).get(p, '')) for p in places]


def text(l, final=None):
    w = l['words']
    out = ['  what the engine surfaced (from the node log):']
    if l.get('set_aside'): out.append('    why this learn began: [goal] %s' % hush(l['set_aside'], w))
    sorts = {}
    for s in l['seen']: sorts[s.get('sort') or '?'] = sorts.get(s.get('sort') or '?', 0) + 1
    out.append('    the walk: %d calls seen (%s)' % (len(l['seen']), ', '.join('%d %s' % (v, k) for k, v in sorted(sorts.items(), key=lambda kv: -kv[1])[:5])))
    if l['failed']: out.append('    the learn failed: %s' % hush(l['failed'], w))
    if door_said(l):
        out.append('    the door: %s' % door_said(l))
        for c in l['door']['calls'][:8]:
            out.append('      %s %s  (%s, held by the page at #%s)' % (c.get('method'), hush((c.get('host') or '') + (c.get('path') or ''), w), DOOR_WHY.get(c.get('why'), c.get('why')), c.get('by')))
    picked = (l['picked'] or {}).get('index')
    held = {(h['method'], h['host'], h['path']): h for h in l['held']}
    for c in sorted(l['candidates'], key=lambda c: -(c.get('score') or 0))[:8]:
        h = held.get((c.get('method'), c.get('host'), c.get('path'))) or {}
        why = h.get('fails') or h.get('nothing') or ''
        out.append('    %s %6.1f  %s %s%s%s' % ('PICKED' if c.get('index') == picked else '      ', c.get('score') or 0, c.get('method'), hush((c.get('host') or '') + (c.get('path') or ''), w),
                                                 ' (noise)' if c.get('noise') else '', ('  held back: ' + hush(why, w)) if why and why != '-' else ''))
    if l['picked']: out.append('    picked by %s: %s' % (l['picked'].get('by'), '; '.join(hush(r, w) for r in l['picked'].get('reasons') or [])))
    hist = history(l, final)
    if hist:
        out.append('    each value, build by build:')
        for place, per, last in hist: out.append('      %-34s %s%s' % (place, ' -> '.join(p or '.' for p in per), ('  => ' + last) if last else ''))
    for tag, rest in l['after']:
        if tag in ('sign', 'rank', 'try'): continue
        out.append('    [%s] %s' % (tag, hush(rest, w)))
    return out


LOG_STYLE = '''
.lg td{font-size:12.5px}.lg .pick td{background:rgba(31,95,191,.12);font-weight:600}.lg .bad{color:var(--brk)}.stage{display:inline-block;font-size:11px;font-weight:700;border-radius:9px;padding:0 7px;border:1px solid var(--line);color:var(--mute);margin-right:6px}
.stage.s-links,.stage.s-verify,.stage.s-hears{color:var(--dep);border-color:var(--dep)}.stage.s-call,.stage.s-goal{color:var(--brk);border-color:var(--brk)}.stage.s-trial{color:var(--in);border-color:var(--in)}.stage.s-route{color:var(--pc);border-color:var(--pc)}
.flow{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px}.flow div{border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--card);font-size:12.5px}.flow b{display:block;font-size:15px}
'''


def section(l, final=None):
    """One learn as a section of the route's page: the walk, the pick, each value build by build, and what came after."""
    w = l['words']
    sorts, statuses = {}, {}
    for s in l['seen']:
        sorts[s.get('sort') or '?'] = sorts.get(s.get('sort') or '?', 0) + 1
        st = str(s.get('status') or '?')[:1] + 'xx'
        statuses[st] = statuses.get(st, 0) + 1
    picked = (l['picked'] or {}).get('index')
    held = {(h['method'], h['host'], h['path']): h for h in l['held']}
    rows = ''
    for c in sorted(l['candidates'], key=lambda c: -(c.get('score') or 0)):
        h = held.get((c.get('method'), c.get('host'), c.get('path'))) or {}
        facts = h.get('facts') or {}
        why = '; '.join(x for x in (h.get('fails'), h.get('nothing')) if x and x != '-')
        said = ', '.join(k for k in ('shapes', 'covered', 'answers') if facts.get(k) == 'true')
        rows += '<tr class="%s"><td>%s</td><td class="num">%.1f</td><td class="mono">%s %s</td><td>%s</td><td class="dim">%s</td></tr>' % (
            'pick' if c.get('index') == picked else '', 'picked' if c.get('index') == picked else ('noise' if c.get('noise') else ''), c.get('score') or 0, E(str(c.get('method'))),
            E(hush((c.get('host') or '') + (c.get('path') or ''), w)), E(said), E(hush(why, w)))
    reasons = ''
    if l['picked']: reasons = '<p class="sub">Picked by <b>%s</b>: %s.</p>' % (E(str(l['picked'].get('by'))), E('; '.join(hush(r, w) for r in l['picked'].get('reasons') or [])))
    hist = history(l, final)
    builds = len(l['builds'])
    head = ''.join('<th>%s</th>' % ('after one walk' if n == 0 else 'built from two walks' if n == 1 else 'build %d' % (n + 1)) for n in range(builds))
    hrows = ''.join('<tr><td class="mono">%s</td>%s<td>%s</td></tr>' % (E(p), ''.join('<td>%s</td>' % E(x) for x in per), E(last)) for p, per, last in hist)
    after = ''.join('<tr><td><span class="stage s-%s">%s</span></td><td class="%s">%s</td></tr>' % (t, t, 'bad' if t == 'call' or re.search(r'not kept|did not answer|another page|refus', r) else '', E(hush(r, w)))
                    for t, r in l['after'] if t not in ('sign', 'rank', 'try'))
    flow = ('<div class="flow"><div><b>%d</b>calls the walk made (%s)</div><div><b>%d</b>candidates scored</div><div><b>%s</b>the pick</div><div><b>%d</b>build(s) of the route</div><div><b>%d</b>line(s) after the pick</div></div>') % (
        len(l['seen']), E(', '.join('%d %s' % (v, k) for k, v in sorted(statuses.items()))), len(l['candidates']), E('by ' + str(l['picked'].get('by')) if l['picked'] else 'none'), builds, len(l['after']))
    failed = ('<p class="sub bad" style="color:var(--brk)">The learn failed: %s</p>' % E(hush(l['failed'], w))) if l['failed'] else ''
    if door_said(l):
        failed += '<p class="sub">The walk\'s door: %s (%s).</p>' % (E(door_said(l)), E('; '.join('%s %s, %s' % (c.get('method'), hush((c.get('host') or '') + (c.get('path') or ''), w), DOOR_WHY.get(c.get('why'), c.get('why'))) for c in l['door']['calls'][:8])))
    return ('<h2>What the engine surfaced, step by step</h2><p class="sub">Read from the node\'s own log of this learn (walk <span class="mono">%s</span>). The words the page was asked are written ‹word›; no value is shown.</p>%s%s'
            '<div class="card scroll"><b>1. Which call is the answer.</b> Every candidate the walk offered, as the engine scored it, and why each was held back.%s<table class="lg"><tr><th></th><th class="num">score</th><th>call</th><th>holds</th><th>why it was held back</th></tr>%s</table></div>'
            '%s<div class="card scroll"><b>3. What it asked of the site afterwards, and what it concluded.</b><table class="lg">%s</table></div>') % (
        E(str(l['walk'])), flow, failed, reasons, rows or '<tr><td colspan=5>The log holds no scored candidates for this learn.</td></tr>',
        ('<div class="card scroll"><b>2. Each value of the answer\'s call, build by build.</b><table class="lg"><tr><th>place</th>%s<th>in the kept route</th></tr>%s</table></div>' % (head, hrows)) if hrows else
        '<div class="card dim"><b>2. Each value, build by build.</b> The log holds no "as built" lines for this learn (the route is a page read, or the node was not started with SIGN_DEBUG=1).</div>',
        after or '<tr><td>Nothing was logged after the pick.</td></tr>')
