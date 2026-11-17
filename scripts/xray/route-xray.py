#!/usr/bin/env python3
"""X-ray of a route: every hole of every request, the string that fills it, and what was left unstrung.

  route-xray.py <route.json | folder of routes>... [--map engine-map.json] [--tree tree.jsonl] [--walks walks.jsonl]
                [--out DIR] [--text] [--json]

Reads route files as the node keeps them (`<node>/routes/*.json`), and nothing else: no site is asked, no walk is
needed. For each route it lists every value its steps send (a hole), where the value comes from (its string), and the
findings: holes left unstrung, strings that look wrong, and seams of the route as a whole. It writes a page for each
route with the picture and the list, and an index that adds the findings up across all the routes read, so the gap in
the engine that hurts most routes is at the top.

  --map    the engine's source as engine-map.py read it: each finding is then drawn against the functions that decide
           it, in the running engine and in the rebuild, with the file and line they are at today
  --tree   the same routes said as the rebuild's tree by the engine itself (`route_tree body`): each hole is shown as
           its expression, and what the tree's own code refuses is a finding
  --walks  kept walks as the rebuild's learner reads them (`route_tree walks <corpus>`): a page for each site
  --log    the node's log (a scratch node's node.log): each route's page then shows what the engine surfaced while it
           learned it, step by step: the calls the walk made, every candidate it scored and why each was held back,
           the pick and its reasons, each value's kind at each build, and what it asked of the site afterwards
  (xray.sh makes the first three and passes all four; run that, not this, unless the files are already made)
  --text   print one route's findings as text (for use in a session, straight after a learn)
  --json   print everything found as JSON
  --out    where the pages go (default ~/.unbrowse-xray). Never inside a repository: a route names its site.

No value of a route is written anywhere: a value is described by its shape (its length and what it is made of).
"""
import html, json, math, os, re, sys, time, urllib.parse as U

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xray_why as Y
import xray_log as G

E = html.escape

# ------------------------------------------------------------------------------------------------ the catalogue
# id: (level, title, what it points to in the engine)
CATALOGUE = {
    'baked-word': ('break', "The caller's walked word sits inside a fixed value and nothing swaps it",
                   "The word inside a longer value was not found (`Held` today; `Expr::Swap` in the rebuild's tree). A call for another word still sends the walked one there."),
    'frozen-clock': ('break', 'A value that reads as the time of the walk is sent as walked',
                     "The clock is a source the learner did not recognise at this place: `fresh::ids` claims a reading where two addresses carry it, or where a second walk of the same call reads the clock anew. Every call sends a time that gets older."),
    'walk-time-inside': ('risk', 'A fixed value holds the time of the walk inside it',
                         "An id made at the walk from the clock, or one the site minted then. It is the session's, or made fresh for each call (`Class::Fresh`; `Expr::Fresh`), and here it is neither."),
    'dangling': ('break', 'A value is read from a step the route does not have',
                 "A step was dropped and what read from it was not rewired. The value cannot be filled."),
    'backwards': ('break', 'A value is read from a step that runs at or after its own',
                  "The order of steps does not follow what feeds what."),
    'deaf': ('break', 'The site was shown deaf to an input',
             "The route kept an input the site ignores: the answer does not change with it."),
    'failing': ('break', "The route's last call failed", "Read the error beside it: a refusal, a changed answer and a failed connection are not told apart yet."),
    'no-steps': ('break', 'The route has no step', "Nothing to send."),
    'open': ('risk', 'Seen once with no source, and sent as walked',
             "Nothing settled what the value is. A second walk measures it (`links::measured`), the site settles it by answering without it (`links::by_the_site_alone`), or a model says (`links::proposed`)."),
    'frozen-date': ('risk', "A date of the walk's own day is sent as walked",
                    "A date written from the day of the walk needs a time-format operation, which neither the classes nor the tree has."),
    'looks-minted': ('risk', 'A fixed value shaped like a token, an id or a signature',
                     "The session is never varied between sightings, so a value that lasts only the session reads as fixed."),
    'page-made': ('risk', 'Only the page can make this value',
                  "Rung 3 and below. A recipe fitted to it, or the function cut from the page's script (the plan note's step 11), would make it without a browser."),
    'far-tie': ('risk', "A value is read from another site's answer",
                "One walk cannot tell this tie from chance (an advert service that answered with the same number)."),
    'dead-step': ('risk', 'A step nothing reads from, that sets no cookie and is not the answer',
                  "The least chain should leave it out: it is one more ask of the site on every call."),
    'needs-browser': ('risk', 'A step needs the browser', "Counted against the route by `decide.coverage-kpi`."),
    'no-input': ('risk', 'Nothing the route sends is the caller\'s', "It can only answer what was walked."),
    'provisional': ('risk', 'The route is marked provisional', "It holds values a second sighting never settled."),
    'text-cut': ('note', 'A value is cut from text between two markers', "It breaks when the page's text around it moves."),
    'header-tie': ('note', 'A header is read from an earlier answer', "Often a tracing or request id that the site does not check."),
    'place-name': ('note', 'An input is named for its place', "An address piece taken for a caller's value, or a value nobody named (`trial::the_address_left`; a proposer's `called`)."),
    'off-site-step': ('note', 'A step goes to another site', "Check that the answer needs it."),
    'post-in-read': ('note', 'A step that is not a GET, in a route not marked as a write', "It is sent again on every call: right for a search that posts, wrong for anything that changes the site."),
    'no-shape': ('note', 'The answer has no recorded shape', "A call's answer cannot be held to what the walk's was."),
    'refused-when-learned': ('note', 'A step was not answered 2xx when it was learned', "It is expected to be refused again."),
    'unheard': ('note', 'No record that a second value was ever asked', "The route was kept on one page load's word."),
    'no-fields': ('note', "The answer's fields are not named", "They are chosen by rule at each call (`fields::defaults_on`), from the fields' names."),
    'no-page': ('note', 'No page is kept to learn it again from', "A failed route cannot be learned again as itself."),
    'never-called': ('note', 'Never called since it was learned', ""),
    'long-chain': ('note', 'More than three steps', "Each is an ask of the site on every call."),
    'walked-header': ('note', "The caller's walked word rides in a header as walked", "Usually the page's own address sent along: harmless, and untidy."),
    # Said by the node's own log of the learn (xray_log).
    'picked-without-fields': ('risk', "The call picked as the answer holds none of the goal's fields", "The engine's own reason for its pick says so. On a page read that lists its records as text this is expected; with a second word unanswered beside it, the pick is a shell. Read the candidates it held back."),
    'shell-kept': ('break', "The pick holds none of the goal's fields, the site did not answer it for a second word, and it was kept", "Both of the engine's own lines say the route is a shell, and it stands and answers `ok`."),
    'kept-unanswered': ('risk', 'The site did not answer the route for a second word, and the route was kept', "One word found nothing. Where the route answers other words this is the word's fault; with a pick that holds none of the goal's fields beside it, the route is a shell."),
    'picked-below-top': ('risk', 'The call picked was not the one scored highest', "A candidate scored higher and was held back. The reason is beside it in the list of candidates."),
    'connection-as-refusal': ('risk', "A request that never connected was read as the site's answer", "The trial's request failed to connect, and the verdict says the site did not answer."),
    'second-walk-elsewhere': ('risk', 'The second walk went to another page', "The word it was given led to a page that made none of the first walk's calls, so nothing was measured twice."),
    'learned-after-set-aside': ('risk', "Learned because a called route's answer was set aside", "A route for this goal was called, its answer was not taken, and the page for that value was walked. What this learn kept is read from the page of that value, which may be a value the site has nothing for. The reason logged is beside it."),
    'replaced-a-route': ('break', 'This route took the place of one that answered, after that one\'s answer was set aside', "The older route is no longer on the node (`goal::superseded`). If its answer was the site finding nothing, the route that answered real values was retired for one read from an empty page."),
    # Said by the rebuild's own code (route_tree), never worked out here.
    'tree-refused': ('break', 'Said as a tree, the route is refused whole', "`Route::refused` will not run the body the bridge makes of this graph. The reason is beside it."),
    'tree-unsaid': ('risk', 'The tree and the running graph disagree about this route', "Said as a tree and said back (`body::to_graph`), it is not the graph it was: a seam of the bridge. The reason is beside it."),
    'unsettled': ('break', "The rebuild's learner writes no route from the two walks", "Its own reason is beside it (`lab::answer::Unsettled`)."),
    'second-walk-missed': ('risk', 'The second walk never made the kept call', "Every place of the call was seen once, so nothing about it is settled."),
    'picked-another': ('risk', "The rebuild's learner picks another call than the one that was kept", "Two readers of \"which call is the answer\" disagree on the same walks."),
    'one-walk-tie': ('note', 'A fixed value one walk alone would have tied to a reply', "The running engine, on one walk, makes this a read of an earlier step."),
}
LEVELS = ('break', 'risk', 'note')


# ------------------------------------------------------------------------------------------------ shapes
def shape(v):
    """What a value is made of, never the value."""
    if v is None: return 'nothing'
    s = str(v)
    n = len(s)
    if n == 0: return 'empty'
    if re.fullmatch(r'\d{13}', s): return 'a 13-digit number'
    if re.fullmatch(r'\d{10}', s): return 'a 10-digit number'
    if re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', s): return 'a uuid'
    if re.fullmatch(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', s): return 'a JWT, %d chars' % n
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}([T ].*)?', s): return 'a date'
    if re.fullmatch(r'[0-9a-fA-F]{16,}', s): return '%d hex' % n
    if re.fullmatch(r'-?\d+(\.\d+)?', s): return '%d digits' % n if '.' not in s else 'a number'
    if s[:1] in '{[': return 'JSON, %d chars' % n
    if re.match(r'https?://', s): return 'an address, %d chars' % n
    if s.startswith('/'): return 'a path, %d chars' % n
    if s in ('true', 'false', 'null'): return 'a flag'
    if re.fullmatch(r'[A-Za-z0-9+/_=.-]{24,}', s) and re.search(r'\d', s) and re.search(r'[a-z]', s) and re.search(r'[A-Z]', s): return '%d chars, token-like' % n
    if re.fullmatch(r'[A-Za-z][A-Za-z_.-]*', s): return 'a name, %d letters' % n
    return 'text, %d chars' % n


def looks_minted(v):
    sh = shape(v)
    return sh == 'a uuid' or sh.startswith('a JWT') or sh.endswith('token-like') or (sh.endswith(' hex') and len(str(v)) >= 24)


def time_of_walk(v, learned_at):
    """'whole' when the value is a time within a week of the walk, 'inside' when it holds one, else None."""
    s = str(v)
    if not learned_at: return None
    near = lambda t: abs(t - learned_at) < 7 * 86400
    if re.fullmatch(r'\d{13}', s): return 'whole' if near(int(s) / 1000) else None
    if re.fullmatch(r'\d{10}', s): return 'whole' if near(int(s)) else None
    if len(s) >= 200: return None
    for m in re.finditer(r'(?<!\d)(1[6-9]\d{11}|1[6-9]\d{8})(?!\d)', s):
        if near(int(m.group(1)) / (1000 if len(m.group(1)) == 13 else 1)): return 'inside'
    return None


def date_of_walk(v, learned_at):
    m = re.fullmatch(r'(\d{4}-\d{2}-\d{2})([T ].*)?', str(v))
    if not m or not learned_at: return False
    try: day = time.mktime(time.strptime(m.group(1), '%Y-%m-%d'))
    except ValueError: return False
    return abs(day - learned_at) < 2 * 86400


def host_of(url):
    try: return U.urlsplit(url.replace('{', '%7B').replace('}', '%7D')).hostname or ''
    except ValueError: return ''


def site_of(host):
    parts = host.split('.')
    if len(parts) >= 3 and len(parts[-1]) == 2 and len(parts[-2]) <= 3: return '.'.join(parts[-3:])
    return '.'.join(parts[-2:])


def place(loc):
    key = loc.get('key')
    return '%s:%s' % (loc.get('in'), '' if key is None else key)


def leaves(o, p=''):
    if isinstance(o, dict):
        for k, v in o.items(): yield from leaves(v, p + '/' + str(k))
    elif isinstance(o, list):
        for i, v in enumerate(o): yield from leaves(v, p + '/%d' % i)
    elif isinstance(o, str): yield p, o


def written_ways(word):
    w = word.lower()
    return {w, U.quote(w), U.quote_plus(w), w.replace(' ', '-'), w.replace(' ', '+'), w.replace(' ', '%20')}


# ------------------------------------------------------------------------------------------------ the reading
def xray(route):
    g = route.get('graph') or {}
    steps = g.get('steps') or []
    learned_at = route.get('learned_at') or 0
    findings = []

    def find(fid, step=None, at=None, more=''):
        findings.append({'id': fid, 'level': CATALOGUE[fid][0], 'step': step, 'at': at, 'more': more})

    home = site_of(host_of(steps[-1]['url'])) if steps else site_of(route.get('site') or '')
    index_of = {s.get('exchange'): i for i, s in enumerate(steps)}
    inputs = route.get('inputs') or []
    # The words the page was asked, less flags, single letters and pieces named for their place.
    at = U.urlsplit(str(route.get('root') or ''))
    asked_at = U.unquote_plus(at.path + ' ' + at.query).lower()
    words = [(i['name'], str(i['default'])) for i in inputs if i.get('default') and not i.get('secret') and len(str(i['default'])) >= 3
             and not re.fullmatch(r'part\d+', i['name']) and not re.fullmatch(r'[\d.]+|true|false', str(i['default']))
             # The caller's words are the ones the page's own address carried; a setting the route also takes is not one.
             and (not asked_at or str(i['default']).lower() in asked_at)]
    read_from = {i: 0 for i in range(len(steps))}
    out_steps = []
    for n, s in enumerate(steps):
        held = {(place(h.get('loc') or {}), h.get('input')) for h in s.get('held') or []}
        holes, fixed, cookies = [], 0, 0
        fields = list(s.get('fields') or [])
        made = [{'loc': p.get('loc') or {}, 'class': 'computed', '_producer': True} for p in s.get('page_producers') or [] if not any(f.get('loc') == p.get('loc') for f in fields)]
        for k, f in enumerate(fields + made):
            loc, cls, at = f.get('loc') or {}, f.get('class'), place(f.get('loc') or {})
            where = loc.get('in')
            hole = {'at': at, 'in': where, 'class': cls, 'src': None, 'comp': None, 'shape': None, 'findings': [], 'i': k if k < len(fields) else None}

            def flag(fid, more=''):
                hole['findings'].append(fid)
                find(fid, n + 1, at, more)

            if cls == 'input':
                hole['src'] = ('caller', f.get('name'))
                hole['shape'] = 'the caller writes it'
                if re.fullmatch(r'part\d+', f.get('name') or ''): flag('place-name', f.get('name'))
            elif cls == 'piece':
                hole['src'], hole['comp'] = ('caller', f.get('input')), 'a piece of it'
            elif cls == 'derived':
                o = f.get('origin') or {}
                j = index_of.get(o.get('exchange'))
                frm = (o.get('at') or {}).get('from')
                hole['src'] = ('step', j, frm, (o.get('at') or {}).get('pointer') or (o.get('at') or {}).get('name') or '')
                if o.get('wrap'): hole['comp'] = 'wrapped in text'
                if j is None: flag('dangling')
                else:
                    read_from[j] += 1
                    if j >= n: flag('backwards', 'step %d' % (j + 1))
                    if site_of(host_of(steps[j]['url'])) != home and where != 'cookie': flag('far-tie', 'step %d' % (j + 1))
                if frm == 'text': flag('text-cut')
                if where == 'header' and frm != 'set_cookie' and (loc.get('key') or '').lower() not in ('authorization', 'x-csrf-token', 'x-xsrf-token'): flag('header-tie')
            elif cls == 'minted':
                hole['src'] = ('session', f.get('name') or loc.get('key'))
            elif cls in ('computed', 'script'):
                hole['src'] = ('page',)
                flag('page-made')
            elif cls == 'recipe':
                hole['src'], hole['comp'] = ('request',), 'a hash over parts of the request'
            elif cls == 'generated':
                hole['src'], hole['comp'] = ('request',), 'a program'
            elif cls == 'fresh':
                hole['src'], hole['comp'] = ('clock',), 'an id made from the clock'
            elif cls == 'file':
                hole['src'] = ('caller', f.get('name'))
                hole['comp'] = 'a fact about the file'
            elif cls in ('constant', 'unconfirmed'):
                v = f.get('value')
                hole['shape'] = shape(v)
                hole['src'] = ('walk',) if cls == 'unconfirmed' else ('fixed',)
                # A longer value the caller's word is written into is strung to the caller; the rest of it is as walked.
                swapped = next((name for at_h, name in held if at_h == at), None)
                if swapped: hole['src'] = ('caller', swapped)
                if cls == 'unconfirmed' and where != 'cookie' and not swapped: flag('open', hole['shape'])
                if where != 'cookie':
                    when = time_of_walk(v, learned_at)
                    if when == 'whole': flag('frozen-clock', hole['shape'])
                    elif when == 'inside': flag('walk-time-inside', hole['shape'])
                    elif date_of_walk(v, learned_at): flag('frozen-date')
                    elif looks_minted(v): flag('looks-minted', hole['shape'])
                    low = str(v).lower()
                    for name, word in words:
                        if any(w in low for w in written_ways(word)) and (at, name) not in held and low != word.lower():
                            flag('walked-header' if where == 'header' else 'baked-word', 'input %s' % name)
                            break
            else:
                hole['src'] = ('fixed',)
            for at_h, name in held:
                if at_h == at:
                    hole['comp'] = "the caller's %s written into it" % name
                    hole['held'] = name
            if where == 'cookie' and not hole['findings']:
                cookies += 1
                continue
            if cls == 'constant' and not hole['findings'] and not hole.get('held'):
                fixed += 1
                continue
            holes.append(hole)
        # The step's own template: the address and the body hold fixed text too.
        fixed_text = [('address', U.unquote(re.sub(r'\{[^}]*\}', '', s.get('url') or '')).lower())]
        body = s.get('body') or {}
        if isinstance(body.get('template'), (dict, list)):
            fixed_text += [('json:' + p, v.lower()) for p, v in leaves(body['template'])]
        for where_t, text in fixed_text:
            for name, word in words:
                covered = any(name == hn and (where_t == 'address' or at_h == where_t) for at_h, hn in held)
                if not covered and any(w in text for w in written_ways(word)):
                    # The address holds the word where the route's own hole is: `{q}` was cut out above, so what is left is fixed.
                    hole = {'at': where_t if where_t != 'address' else 'the address, outside its holes', 'in': 'template', 'class': 'template', 'src': ('fixed',), 'comp': None, 'shape': 'fixed text', 'findings': ['baked-word']}
                    find('baked-word', n + 1, hole['at'], 'input %s' % name)
                    holes.append(hole)
                    break
        last = n == len(steps) - 1
        off = site_of(host_of(s.get('url') or '')) != home
        marks = []
        if s.get('needs_browser') or s.get('page_signed'):
            marks.append('needs-browser'); find('needs-browser', n + 1)
        if off:
            marks.append('off-site-step'); find('off-site-step', n + 1, None, host_of(s.get('url') or ''))
        if (s.get('method') or 'GET').upper() not in ('GET', 'HEAD') and not route.get('write'):
            marks.append('post-in-read'); find('post-in-read', n + 1, None, s.get('method'))
        if not (200 <= (s.get('status') or 200) < 300):
            marks.append('refused-when-learned'); find('refused-when-learned', n + 1, None, str(s.get('status')))
        if last and not s.get('response_shape') and not s.get('reads_page'):
            marks.append('no-shape'); find('no-shape', n + 1)
        out_steps.append({'n': n + 1, 'method': s.get('method'), 'host': host_of(s.get('url') or ''), 'path': U.urlsplit((s.get('url') or '').replace('{', '%7B').replace('}', '%7D')).path, 'holes': holes,
                          'fixed': fixed, 'cookies': cookies, 'marks': marks, 'sets_cookie': bool(s.get('sets_cookie')), 'on_load': bool(s.get('on_load'))})
    for i, st in enumerate(out_steps[:-1]):
        if read_from[i] == 0 and not st['sets_cookie']:
            st['marks'].append('dead-step'); find('dead-step', i + 1)
    # The route as a whole.
    if not steps and not route.get('socket'): find('no-steps')
    if steps and not inputs: find('no-input')
    if route.get('provisional') or g.get('provisional'): find('provisional')
    heard = route.get('heard') or {}
    # `heard.deaf` holds what the site was deaf to: an input's name, or the word it was asked (never written out).
    names = {i.get('name') for i in inputs}
    for name in heard.get('deaf') or []:
        if name in names: find('deaf', None, None, 'input %s' % name)
        else:
            own = [i['name'] for i in inputs if str(i.get('default')) == str(name)]
            find('deaf', None, None, ('‹word›, the walked value of input %s' % own[0]) if own else '‹word›')
    if steps and not heard.get('said_back') and not heard.get('probed'): find('unheard')
    if steps and not route.get('fields'): find('no-fields')
    if steps and not g.get('page'): find('no-page')
    stats = route.get('stats') or {}
    if stats.get('last_error'): find('failing', None, None, shape_of_error(stats['last_error']))
    if not stats.get('calls'): find('never-called')
    if len(steps) > 3: find('long-chain', None, None, '%d steps' % len(steps))
    all_holes = [h for st in out_steps for h in st['holes']]
    strung = sum(1 for h in all_holes if h['src'] and h['src'][0] not in ('walk', 'fixed', 'page') and not any(CATALOGUE[f][0] == 'break' for f in h['findings']))
    counts = {lv: sum(1 for f in findings if f['level'] == lv) for lv in LEVELS}
    return {'id': route.get('id'), 'site': route.get('site'), 'what': route.get('what'), 'method': route.get('method'), 'steps': out_steps, 'inputs': [i['name'] for i in inputs],
            'plain': not route.get('browser_assisted'), 'write': bool(route.get('write')), 'findings': findings, 'counts': counts, 'holes': len(all_holes), 'strung': strung,
            'fixed': sum(st['fixed'] for st in out_steps), 'cookies': sum(st['cookies'] for st in out_steps), 'score': 10 * counts['break'] + 3 * counts['risk'] + counts['note'],
            'calls': stats.get('calls') or 0, 'passed': stats.get('passed') or 0}


def tally(x):
    x['counts'] = {lv: sum(1 for f in x['findings'] if f['level'] == lv) for lv in LEVELS}
    x['score'] = 10 * x['counts']['break'] + 3 * x['counts']['risk'] + x['counts']['note']
    return x


def note(x, fid, more='', step=None, at=None):
    x['findings'].append({'id': fid, 'level': CATALOGUE[fid][0], 'step': step, 'at': at, 'more': more})


def with_tree(x, line):
    """What the engine's own tree says of the route (`route_tree body`): each hole's expression, and what its code refuses."""
    if not line or 'body' not in line:
        x['tree'] = {'unread': (line or {}).get('unread') or 'the engine was not asked'}
        return x
    body, ops, rungs, opened, total = line['body'], {}, {}, 0, 0
    for st, bs in zip(x['steps'], body.get('steps') or []):
        said = bs.get('holes') or []
        for h in said:
            total += 1
            opened += bool(h.get('open'))
            for w in h.get('ways') or []:
                rungs[str(w.get('rung'))] = rungs.get(str(w.get('rung')), 0) + 1
                for o in Y.ops_of(w.get('expr')): ops[o['op']] = ops.get(o['op'], 0) + 1
        for h in st['holes']:
            if h.get('i') is not None and h['i'] < len(said): h['tree'] = Y.hole_words(said[h['i']])
    x['tree'] = {'ops': ops, 'rungs': rungs, 'holes': total, 'open': opened, 'slots': [s.get('name') for s in body.get('slots') or []], 'refused': Y.general(line['refused']) if line.get('refused') else None,
                 'unsaid': Y.general(line['unsaid']) if line.get('unsaid') else None}
    if line.get('refused'): note(x, 'tree-refused', Y.general(line['refused']))
    elif line.get('unsaid'): note(x, 'tree-unsaid', Y.general(line['unsaid']))
    return tally(x)


def walk_x(line):
    """One site of a corpus as the rebuild's learner reads its two walks (`route_tree walks`), as an x-ray of its own."""
    site, kept, learned = line.get('site') or '', line.get('kept') or {}, line.get('learned') or {}
    kinds = {Y.place_words(h.get('at') or {}): str(h.get('kind')).lower() for h in kept.get('holes') or []}
    body = kept.get('body') or learned.get('body') or {'site': site, 'steps': [], 'slots': []}
    x = Y.x_from_body(body, kinds, {'id': 'walk-' + re.sub(r'[^A-Za-z0-9.-]', '_', site), 'what': "Two kept walks, as the rebuild's learner reads them"})
    x['site'] = site
    x['kinds'] = {}
    for k in kinds.values(): x['kinds'][k] = x['kinds'].get(k, 0) + 1
    x['learned'] = 'body' in learned
    x['kept'] = bool(kept)
    if 'unlearned' in learned: note(x, 'unsettled', Y.general(learned['unlearned']))
    if kept and not kept.get('second_walk_made_it'): note(x, 'second-walk-missed')
    if kept and 'body' in learned and (learned['body'].get('answer') or {}).get('step') != 'x%s' % kept.get('at'): note(x, 'picked-another')
    ties = sum(1 for h in kept.get('holes') or [] if h.get('tied'))
    if ties: note(x, 'one-walk-tie', '%d place(s)' % ties)
    return tally(x)


def with_log(all_x, read_log):
    """The node's log laid over the routes read: each route's learn adds the findings the log raises, and a route that
    took the place of one no longer on the node is told so. Returns (learns by route id, learns that kept no route,
    learns whose route is no longer on the node). The live view (wiring.py) asks this same function."""
    # The node's log of each learn, by the route it saved; a later learn of the same route replaces an earlier one.
    learns = {(l['saved'] or {}).get('route'): l for l in read_log if l.get('saved')}
    # Learns that kept no route have no route to x-ray: they are shown by what the engine surfaced, each on its own.
    unkept = [l for l in read_log if not l.get('saved') and (l['seen'] or l['failed'])]
    for x in all_x:
        if x['id'] in learns:
            for fid, more in G.findings(learns[x['id']]): note(x, fid, more)
            tally(x)
    # Learns whose route is no longer on the node: replaced by a later learn, and shown beside it.
    on_node = {x['id'] for x in all_x}
    gone = [l for l in read_log if l.get('saved') and l['saved'].get('route') not in on_node]
    for x in all_x:
        l = learns.get(x['id'])
        before = [g for g in gone if l and l.get('set_aside') and g['goal'] == l['goal'] and read_log.index(g) < read_log.index(l)]
        if before:
            note(x, 'replaced-a-route', 'the route of walk %s, on %s' % (before[-1]['walk'], before[-1]['saved'].get('site') or before[-1]['site']))
            tally(x)
    return learns, unkept, gone


def shape_of_error(e):
    """An error's first words: what kind of failure, without what it carried."""
    return re.sub(r'https?://\S+', '<address>', str(e))[:90]


# ------------------------------------------------------------------------------------------------ the picture
COLORS = {'caller': 'in', 'step': 'dep', 'session': 'ses', 'page': 'pc', 'request': 'pc', 'clock': 'pc', 'walk': 'open', 'fixed': 'fx'}
MOST_HOLES, MOST_STEPS, SP, X0, BAND, GAP = 30, 14, 34, 210, 54, 66


def draw(x):
    steps = x['steps']
    shown = steps if len(steps) <= MOST_STEPS else steps[-MOST_STEPS:]
    skipped = len(steps) - len(shown)
    sources = [('caller', 'The caller', 'what an agent writes'), ('session', 'The session', 'what the browser earned'), ('code', 'Made by code', 'page code, a recipe, the clock')]
    callers, sessions = [], []
    for st in shown:
        for h in st['holes']:
            if h['src'] and h['src'][0] == 'caller' and h['src'][1] not in callers: callers.append(h['src'][1])
            if h.get('held') and h['held'] not in callers: callers.append(h['held'])
            if h['src'] and h['src'][0] == 'session' and h['src'][1] not in sessions: sessions.append(h['src'][1])
    for name in x['inputs']:
        if name not in callers: callers.append(name)
    sessions = sessions[:MOST_HOLES]
    code = ["the page's code", 'a recipe or a program', 'the clock']
    widest = max([len(callers), len(sessions), 3] + [min(len(st['holes']), MOST_HOLES) + 2 for st in shown])
    W = X0 + widest * SP + 60
    out, y, pos = [], 16, {}

    def band(key, title, sub, cls=''):
        nonlocal y
        out.append(f'<rect class="band {cls}" x="{X0 - 26}" y="{y}" width="{W - X0 + 6}" height="{BAND}" rx="8"/>')
        out.append(f'<text class="bn" x="{X0 - 38}" y="{y + 23}" text-anchor="end">{E(title)}</text><text class="bs" x="{X0 - 38}" y="{y + 39}" text-anchor="end">{E(sub)}</text>')
        top = y
        y += BAND + GAP
        return top

    def dot(name, bx, by, cls, label):
        pos[name] = (bx, by)
        out.append(f'<circle class="dot f-{cls}" cx="{bx}" cy="{by}" r="6"/><text class="dl" transform="translate({bx + 4},{by + 22}) rotate(32)">{E(str(label)[:22])}</text>')

    top = band('caller', *sources[0][1:])
    for k, name in enumerate(callers[:MOST_HOLES]): dot(('caller', name), X0 + k * SP, top + BAND / 2, 'in', name)
    top = band('session', *sources[1][1:])
    for k, name in enumerate(sessions): dot(('session', name), X0 + k * SP, top + BAND / 2, 'ses', name)
    top = band('code', *sources[2][1:])
    for k, (name, key) in enumerate(zip(code, ('page', 'request', 'clock'))): dot((key,), X0 + k * SP * 4, top + BAND / 2, 'pc', name)
    if skipped: out.append(f'<text class="bs" x="{X0}" y="{y - 20}">{skipped} earlier step(s) are not drawn</text>')
    strings, ports = [], {}
    for st in shown:
        mark = ' brk' if any(CATALOGUE[m][0] == 'break' for m in st['marks']) else (' rsk' if any(CATALOGUE[m][0] == 'risk' for m in st['marks']) else '')
        sub = f'{st["method"]} {st["host"]}{st["path"]}'
        top = band(('step', st['n']), f'Step {st["n"]}' + (' (the answer)' if st is steps[-1] else ''), sub[:34] + ('…' if len(sub) > 34 else ''), 'req' + mark)
        pos[('band', st['n'])] = top
        order = sorted(st['holes'], key=lambda h: -max([0] + [3 - LEVELS.index(CATALOGUE[f][0]) for f in h['findings']]))[:MOST_HOLES]
        for k, h in enumerate(order):
            hx, hy = X0 + k * SP, top + BAND / 2
            worst = min([LEVELS.index(CATALOGUE[f][0]) for f in h['findings']] or [3])
            kind = COLORS.get(h['src'][0] if h['src'] else 'fixed', 'fx')
            ring = ['brk', 'rsk', 'nte', ''][worst]
            tip = f'{h["at"]}: {h["class"]}' + (f' ({h["shape"]})' if h.get('shape') else '') + (f'; {h["comp"]}' if h.get('comp') else '') + ''.join('; ' + CATALOGUE[f][1] for f in h['findings'])
            out.append(f'<ellipse class="hole h-{kind} {ring}" cx="{hx}" cy="{hy}" rx="11" ry="8"><title>{E(tip)}</title></ellipse>')
            if kind == 'open': out.append(f'<text class="q" x="{hx}" y="{hy + 4}" text-anchor="middle">?</text>')
            out.append(f'<text class="hl {ring}" transform="translate({hx - 2},{top + BAND + 13}) rotate(36)">{E(h["at"][:24])}</text>')
            src = h['src']
            if not src or src[0] in ('walk', 'fixed'): continue
            if src[0] == 'step':
                if src[1] is None: continue
                key = ('port', src[1] + 1, src[3])
                if key not in ports and ('band', src[1] + 1) in pos:
                    n_ports = sum(1 for p in ports if p[1] == src[1] + 1)
                    ports[key] = (X0 + 12 + n_ports * 22, pos[('band', src[1] + 1)] + BAND)
                    out.append(f'<circle class="dot f-dep" cx="{ports[key][0]}" cy="{ports[key][1]}" r="4"><title>{E(str(src[2]))} {E(str(src[3]))}</title></circle>')
                start = ports.get(key)
            else:
                start = pos.get((src[0], src[1]) if src[0] in ('caller', 'session') else (src[0],))
            if start: strings.append((start, (hx, hy - 8), kind, h.get('comp'), ring))
        extra = len(st['holes']) - len(order)
        notes = ([f'+{extra} more holes'] if extra > 0 else []) + ([f'{st["fixed"]} fixed'] if st['fixed'] else []) + ([f'{st["cookies"]} cookies'] if st['cookies'] else []) + [CATALOGUE[m][1] for m in st['marks']]
        out.append(f'<text class="bs" x="{X0 - 22}" y="{top - 7}">{E(" · ".join(notes)[:170])}</text>')
    for (sx, sy), (tx, ty), kind, comp, ring in strings:
        my = (sy + ty) / 2
        out.append(f'<path class="st c-{kind}" d="M{sx:.0f},{sy:.0f} C{sx:.0f},{my:.0f} {tx:.0f},{my:.0f} {tx:.0f},{ty:.0f}"/>')
        if comp:
            t = 0.55
            bx = (1 - t) ** 3 * sx + 3 * (1 - t) ** 2 * t * sx + 3 * (1 - t) * t * t * tx + t ** 3 * tx
            by = (1 - t) ** 3 * sy + 3 * (1 - t) ** 2 * t * my + 3 * (1 - t) * t * t * my + t ** 3 * ty
            out.append(f'<rect class="comp c-{kind}" x="{bx - 5:.0f}" y="{by - 5:.0f}" width="10" height="10" transform="rotate(45 {bx:.0f} {by:.0f})"><title>{E(comp)}</title></rect>')
    return f'<svg viewBox="0 0 {W} {y - GAP + 46}" style="min-width:{min(W, 1400)}px;max-width:{max(W, 900)}px" role="img" aria-label="The route\'s steps with the string that fills each hole">' + '\n'.join(out) + '</svg>'


STYLE = '''
:root{--bg:#f7f6f2;--ink:#1c1b19;--mute:#6b675f;--card:#fff;--line:#d6d2c7;--band:#fff;--req:#fff6e6;--in:#1d7a4f;--dep:#1f5fbf;--ses:#0d7f8c;--pc:#6b3fb5;--fx:#8a857a;--open:#c2410c;--brk:#c0271e;--rsk:#c2410c;--holein:#e9e6dd}
@media(prefers-color-scheme:dark){:root{--bg:#141412;--ink:#eceae4;--mute:#9a968c;--card:#1e1d1a;--line:#38362f;--band:#211f1b;--req:#2e2515;--in:#6fd3a0;--dep:#7fb0ff;--ses:#5fd0dc;--pc:#b99cf0;--fx:#8f8a7f;--open:#ff9a5c;--brk:#ff6b5e;--rsk:#ff9a5c;--holein:#0c0c0b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
.wrap{max-width:1320px;margin:0 auto}h1{font-size:21px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 6px}.sub{color:var(--mute);margin:0 0 10px}a{color:var(--dep)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}.scroll{overflow-x:auto}
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0}.num1{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 12px}.num1 b{display:block;font-size:22px}.num1 span{font-size:12.5px;color:var(--mute)}
table{border-collapse:collapse;width:100%;font-size:12.5px}td,th{padding:4px 7px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.ft td:nth-child(2){min-width:250px}.ft td:nth-child(3){max-width:380px;word-break:break-all}.ft td:nth-child(5){min-width:300px}.dim{color:var(--mute)}
.lv{display:inline-block;font-size:11px;font-weight:700;border-radius:9px;padding:0 7px;border:1px solid}.lv-break{color:var(--brk);border-color:var(--brk)}.lv-risk{color:var(--rsk);border-color:var(--rsk)}.lv-note{color:var(--mute);border-color:var(--mute)}
svg{display:block;height:auto;width:100%}svg text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.band{fill:var(--band);stroke:var(--line)}.band.req{fill:var(--req)}.band.brk{stroke:var(--brk);stroke-width:1.8}.band.rsk{stroke:var(--rsk);stroke-dasharray:6 4}
.bn{font-size:13px;font-weight:600;fill:var(--ink)}.bs{font-size:11px;fill:var(--mute)}.dl{font-size:10.5px;fill:var(--mute)}.hl{font-size:10.5px;fill:var(--ink)}.hl.brk{fill:var(--brk);font-weight:700}.hl.rsk{fill:var(--rsk)}
.hole{fill:var(--holein);stroke-width:2}.h-in{stroke:var(--in)}.h-dep{stroke:var(--dep)}.h-ses{stroke:var(--ses)}.h-pc{stroke:var(--pc)}.h-fx{stroke:var(--fx)}.h-open{stroke:var(--open);stroke-dasharray:4 3}
.hole.brk{stroke:var(--brk);stroke-width:3.4;stroke-dasharray:none}.hole.rsk{stroke-width:2.8}.q{font-size:11px;font-weight:700;fill:var(--open)}
.st{fill:none;stroke-width:1.9;stroke-linecap:round;stroke-opacity:.8}.c-in{stroke:var(--in)}.c-dep{stroke:var(--dep)}.c-ses{stroke:var(--ses);stroke-opacity:.45}.c-pc{stroke:var(--pc)}
.comp{fill:var(--card);stroke-width:1.8}.dot{stroke:none}.f-in{fill:var(--in)}.f-dep{fill:var(--dep)}.f-ses{fill:var(--ses)}.f-pc{fill:var(--pc)}
.wt td{min-width:150px}.wt td:first-child{min-width:0}
.leg{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:12.5px;color:var(--mute);margin:0 0 8px}.leg b{font-weight:600}
'''
LEGEND = ('<div class="leg"><span style="color:var(--in)">● the caller\'s</span><span style="color:var(--dep)">● read from an earlier step</span><span style="color:var(--ses)">● the session\'s</span>'
          '<span style="color:var(--pc)">● made by code</span><span style="color:var(--open)">◌ ? seen once, no string</span><span style="color:var(--fx)">○ fixed</span>'
          '<span style="color:var(--brk)"><b>thick red ring</b>: a break</span><span>◇ on a string: something is computed on the way</span></div>')


TITLES = {k: v[1] for k, v in CATALOGUE.items()}
LEVEL_OF = {k: v[0] for k, v in CATALOGUE.items()}


def blame_rows(x, emap):
    """The findings of one route against the engine: [(finding id, places, who decides it)], worst first."""
    places = {}
    for f in x['findings']: places[f['id']] = places.get(f['id'], 0) + 1
    classes = {} if x.get('by') == 'rebuild' else Y.classes_of(x)
    b = Y.blame(places, classes, emap, x.get('by') == 'rebuild')
    order = sorted(places, key=lambda i: (LEVELS.index(LEVEL_OF[i]), -places[i]))
    return [(i, places[i], b[i]) for i in order if i in b]


def why_for(x, emap):
    if not emap: return '<h2>Why, in the engine</h2><div class="card dim">The engine\'s source was not read for this page: run xray.sh, which maps it and passes it here.</div>'
    rows = blame_rows(x, emap)
    drawn = [r for r in rows if LEVEL_OF[r[0]] != 'note'] or rows
    tips = ' · '.join('%s at %s' % (k, emap[k].get('tip') or '?') for k in ('running', 'rebuild') if k in emap)
    return ('<h2>Why, in the engine</h2><p class="sub">Each finding against the functions that decide it, read from the source as it is now (%s). The fix goes in one of these, with a test of the property, and never in the route.</p>'
            '<div class="card scroll">%s%s</div><div class="card scroll">%s</div>') % (E(tips), Y.BLAME_LEGEND, Y.draw_blame(drawn[:14], TITLES, LEVEL_OF), Y.why_table(rows, TITLES, LEVEL_OF))


def tree_card(x):
    t = x.get('tree')
    if not t: return ''
    if t.get('unread'): return '<div class="card dim">Not said as a tree: %s.</div>' % E(t['unread'])
    ops = ', '.join('%s %d' % kv for kv in sorted(t['ops'].items(), key=lambda kv: -kv[1]))
    rungs = ', '.join('rung %s: %d' % kv for kv in sorted(t['rungs'].items()))
    bad = ''.join('<br><span style="color:var(--brk)">%s: %s</span>' % (k, E(t[k])) for k in ('refused', 'unsaid') if t.get(k))
    return ('<div class="card">Said as the rebuild\'s tree by the engine itself (<span class="mono">body::from_graph</span>): %d holes, %d of them open; slots: <span class="mono">%s</span>.<br>'
            '<span class="dim">Expressions: %s. Ways: %s.</span>%s</div>') % (t['holes'], t['open'], E(', '.join(t['slots']) or 'none'), E(ops), E(rungs), bad)


def final_kinds(x):
    return {h['at']: str(h['class']) for h in (x['steps'][-1]['holes'] if x['steps'] else [])}


def page_for(x, emap=None, learn=None):
    by_level = {lv: [f for f in x['findings'] if f['level'] == lv] for lv in LEVELS}
    rows = ''.join(f'<tr><td><span class="lv lv-{f["level"]}">{f["level"]}</span></td><td>{E(CATALOGUE[f["id"]][1])}</td><td class="mono">{("step %d" % f["step"]) if f["step"] else "the route"}{(" · " + E(str(f["at"]))) if f["at"] else ""}</td><td class="dim">{E(f["more"])}</td><td class="dim">{E(CATALOGUE[f["id"]][2])}</td></tr>'
                   for lv in LEVELS for f in by_level[lv])
    holes = ''.join(f'<tr><td class="num">{st["n"]}</td><td class="mono">{E(h["at"])}</td><td>{E(str(h["class"]))}</td><td>{E(source_words(h))}</td><td class="mono">{E(h.get("tree") or "")}</td><td class="dim">{E(h.get("shape") or "")}</td><td>{badges(h)}</td></tr>'
                    for st in x['steps'] for h in st['holes'])
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{E(x["site"] or "")}: route x-ray</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>{STYLE}{Y.BLAME_STYLE}{G.LOG_STYLE}</style></head><body><div class="wrap">
<p class="sub"><a href="index.html">all routes</a></p>
<h1>{E(x["what"] or "")}</h1>
<p class="sub"><span class="mono">{E(x["site"] or "")}</span> · route <span class="mono">{E(x["id"] or "")}</span> · {len(x["steps"])} step(s) · inputs: <span class="mono">{E(", ".join(x["inputs"]) or "none")}</span> · {"plain HTTP" if x["plain"] else "needs the browser"}{" · writes" if x["write"] else ""} · called {x["calls"]} time(s), {x["passed"]} passed</p>
<div class="nums"><div class="num1"><b>{x["holes"]}</b><span>holes that are not plain fixed text</span></div><div class="num1"><b>{x["strung"]}</b><span>strung to a source</span></div>
<div class="num1"><b style="color:var(--brk)">{x["counts"]["break"]}</b><span>breaks</span></div><div class="num1"><b style="color:var(--rsk)">{x["counts"]["risk"]}</b><span>risks</span></div><div class="num1"><b>{x["counts"]["note"]}</b><span>notes</span></div>
<div class="num1"><b>{x["fixed"]}</b><span>fixed values, and {x["cookies"]} cookies, not drawn</span></div></div>
<h2>The strings</h2><div class="card scroll">{LEGEND}{draw(x)}</div>
<h2>What is not strung, and the seams</h2><div class="card"><table class="ft"><tr><th></th><th>finding</th><th>where</th><th></th><th>what it points to in the engine</th></tr>{rows or "<tr><td colspan=5>Nothing found.</td></tr>"}</table></div>
{G.section(learn, final_kinds(x)) if learn else ""}
{why_for(x, emap)}
<h2>Every hole</h2>{tree_card(x)}<div class="card scroll"><table><tr><th class="num">step</th><th>place</th><th>kind</th><th>string</th><th>as the tree says it</th><th>shape</th><th>findings</th></tr>{holes}</table></div>
</div></body></html>'''


def badges(h):
    return ' '.join('<span class="lv lv-%s">%s</span>' % (CATALOGUE[f][0], f) for f in h['findings'])


def source_words(h):
    s = h['src']
    if not s: return ''
    words = {'caller': lambda: "the caller's " + str(s[1]), 'session': lambda: 'the session: ' + str(s[1]), 'page': lambda: "the page's code", 'request': lambda: 'this request',
             'clock': lambda: 'the clock', 'walk': lambda: 'none: sent as walked', 'fixed': lambda: 'none: fixed',
             'step': lambda: ('a step the route lacks' if s[1] is None else 'step %d, %s %s' % (s[1] + 1, s[2], s[3]))}[s[0]]()
    return words + ((' (' + h['comp'] + ')') if h.get('comp') else '')


def engine_for(all_x, emap):
    """Every route's findings against the engine at once: the picture, and the functions that answer for the most routes."""
    if not emap: return ''
    total, classes, per_route = {}, {}, []
    for x in all_x:
        places = {}
        for f in x['findings']: places[f['id']] = places.get(f['id'], 0) + 1
        own = {} if x.get('by') == 'rebuild' else Y.classes_of(x)
        for fid, n in places.items():
            t = total.setdefault(fid, [0, 0])
            t[0] += 1
            t[1] += n
            classes.setdefault(fid, set()).update(own.get(fid) or ())
        heavy = {fid: n for fid, n in places.items() if LEVEL_OF[fid] != 'note'}
        per_route.append((heavy, Y.blame(heavy, own, emap, x.get('by') == 'rebuild')))
    b = Y.blame(total, classes, emap)
    order = sorted((i for i in total if i in b and LEVEL_OF[i] != 'note'), key=lambda i: (LEVELS.index(LEVEL_OF[i]), -total[i][0]))
    rows = [(i, total[i][0], b[i]) for i in order][:16]
    ranked = Y.rank_functions(per_route)
    words = dict(Y.ROLES)
    fn_rows = ''.join('<tr><td>%s</td><td class="mono">%s:%d</td><td class="mono">%s</td><td class="num">%d</td><td class="num">%d</td><td class="num">%d</td><td>%s</td><td class="dim">%s</td></tr>' % (
        'rebuild' if rebuild else 'running', E(t['f']['file']), t['f']['line'], E(t['f']['name']), t['f']['lines'], t['routes'], t['places'], E(', '.join(words[r] for r, _ in Y.ROLES if r in t['roles'])),
        E(', '.join(sorted(t['findings'])))) for (rebuild, _), t in ranked[:40])
    gaps = ''.join('<tr><td><span class="lv lv-%s">%s</span></td><td>%s</td><td class="num">%d</td><td>%s</td></tr>' % (LEVEL_OF[i], LEVEL_OF[i], E(TITLES[i]), total[i][0], E(b[i].get('gap') or 'The tree has no way to say this yet.'))
                   for i in sorted(total, key=lambda i: -total[i][0]) if i in b and (b[i]['tree'] is None or b[i].get('gap')))
    tips = ' · '.join('%s at %s' % (k, emap[k].get('tip') or '?') for k in ('running', 'rebuild') if k in emap)
    return f'''<h2>Where the findings land in the engine</h2>
<p class="sub">Read from the source as it is now ({E(tips)}). A line is as heavy as the number of routes the finding shows on. Left to middle: the running engine. Left to right: the rebuild's tree.</p>
<div class="card scroll">{Y.BLAME_LEGEND}{Y.draw_blame(rows, TITLES, LEVEL_OF, 'What the routes show')}</div>
<h2>The functions that answer for the most routes</h2>
<p class="sub">Breaks and risks only. A function is counted once for each route with a finding it decides. "wrote it this way" counts every function that writes the kind, because a route does not record which one wrote a hole.</p>
<div class="card scroll"><table><tr><th>engine</th><th>where</th><th>function</th><th class="num">lines</th><th class="num">routes</th><th class="num">places</th><th>its part</th><th>findings</th></tr>{fn_rows}</table></div>
<h2>What neither engine can say yet</h2>
<div class="card"><table><tr><th></th><th>finding</th><th class="num">routes</th><th>what is missing</th></tr>{gaps or "<tr><td colspan=4>Nothing.</td></tr>"}</table></div>'''


def trees_for(all_x):
    seen = [x['tree'] for x in all_x if x.get('tree') and not x['tree'].get('unread')]
    if not seen: return ''
    ops, rungs, reasons = {}, {}, {}
    for t in seen:
        for k, v in t['ops'].items(): ops[k] = ops.get(k, 0) + v
        for k, v in t['rungs'].items(): rungs[k] = rungs.get(k, 0) + v
        for k in ('refused', 'unsaid'):
            if t.get(k): reasons[(k, t[k])] = reasons.get((k, t[k]), 0) + 1
    holes, opened = sum(t['holes'] for t in seen), sum(t['open'] for t in seen)
    cells = ''.join('<div class="num1"><b>%s</b><span>%s</span></div>' % ('{:,}'.format(v), E(k)) for k, v in sorted(ops.items(), key=lambda kv: -kv[1]))
    why = ''.join('<tr><td class="num">%d</td><td>%s</td><td class="dim">%s</td></tr>' % (n, 'refused whole' if k == 'refused' else 'not the same graph when said back', E(r)) for (k, r), n in sorted(reasons.items(), key=lambda kv: -kv[1]))
    return f'''<h2>The same routes, said as trees by the engine</h2>
<p class="sub">{len(seen)} routes read by the rebuild's own bridge (<span class="mono">body::from_graph</span>, route_tree built at {E(os.environ.get("XRAY_TREE_TIP") or "an unrecorded commit")}): {holes:,} holes, {opened:,} of them open (sent as walked, so the body would not be published). Ways by rung: {E(", ".join("rung %s: %s" % (k, "{:,}".format(v)) for k, v in sorted(rungs.items())))}. Expressions used:</p>
<div class="nums">{cells}</div>
<div class="card"><table><tr><th class="num">routes</th><th>what the tree's code says</th><th>its reason, with the route's own names taken out</th></tr>{why or "<tr><td colspan=3>Every body runs as it stands and says back the graph it came from.</td></tr>"}</table></div>'''


def walks_for(walk_xs):
    if not walk_xs: return ''
    kinds = {}
    for x in walk_xs:
        for k, v in x['kinds'].items(): kinds[k] = kinds.get(k, 0) + v
    learned = sum(1 for x in walk_xs if x['learned'])
    cells = ''.join('<div class="num1"><b>%s</b><span>places: %s</span></div>' % ('{:,}'.format(v), E(k)) for k, v in sorted(kinds.items(), key=lambda kv: -kv[1]))
    rows = ''.join('<tr><td class="mono"><a href="%s.html">%s</a></td><td>%s</td><td class="num">%d</td><td class="num">%s</td><td class="num">%s</td><td class="num" style="color:var(--rsk)">%s</td><td class="dim">%s</td></tr>' % (
        E(x['id']), E(x['site']), 'writes a route' if x['learned'] else '<span style="color:var(--brk)">writes none</span>', len(x['steps']), x['kinds'].get('callers', '') , x['kinds'].get('read', ''), x['kinds'].get('open', ''),
        E('; '.join('%s%s' % (TITLES[f['id']], (' (' + f['more'] + ')') if f['more'] else '') for f in x['findings'] if f['id'] in ('unsettled', 'second-walk-missed', 'picked-another'))[:230]))
                   for x in sorted(walk_xs, key=lambda x: (x['learned'], -x['score'])))
    return f'''<h2>Kept walks, as the rebuild's learner reads them</h2>
<p class="sub">{len(walk_xs)} sites with two kept walks, read by <span class="mono">lab::synth</span> and <span class="mono">lab::compile::learn</span> (route_tree built at {E(os.environ.get("XRAY_TREE_TIP") or "an unrecorded commit")}) with no site asked. {learned} it writes a route for by itself; for the rest its own reason is in the last column. A place it leaves open is a hole no expression rebuilt on both walks.</p>
<div class="nums"><div class="num1"><b>{learned}</b><span>of {len(walk_xs)} sites learned from two walks alone</span></div>{cells}</div>
<div class="card scroll"><table><tr><th>site</th><th></th><th class="num">steps</th><th class="num">caller's</th><th class="num">read</th><th class="num">open</th><th>what stops it</th></tr>{rows}</table></div>'''


def index_for(all_x, emap=None, walk_xs=()):
    total = {}
    for x in all_x:
        seen = set()
        for f in x['findings']:
            t = total.setdefault(f['id'], {'routes': 0, 'places': 0})
            t['places'] += 1
            if f['id'] not in seen:
                t['routes'] += 1
                seen.add(f['id'])
    ranked = sorted(total.items(), key=lambda kv: (LEVELS.index(CATALOGUE[kv[0]][0]), -kv[1]['routes']))
    roll = ''.join(f'<tr><td><span class="lv lv-{CATALOGUE[i][0]}">{CATALOGUE[i][0]}</span></td><td>{E(CATALOGUE[i][1])}</td><td class="num">{t["routes"]}</td><td class="num">{t["places"]}</td><td class="dim">{E(CATALOGUE[i][2])}</td></tr>' for i, t in ranked)
    rows = ''.join(f'<tr><td class="mono"><a href="{E(x["id"])}.html">{E(x["site"] or "")}</a></td><td>{E((x["what"] or "")[:70])}</td><td class="num">{len(x["steps"])}</td><td class="num">{x["holes"]}</td><td class="num">{x["strung"]}</td>'
                   f'<td class="num" style="color:var(--brk)">{x["counts"]["break"] or ""}</td><td class="num" style="color:var(--rsk)">{x["counts"]["risk"] or ""}</td><td class="num">{x["counts"]["note"] or ""}</td><td>{"plain" if x["plain"] else "browser"}</td><td class="num">{x["passed"]}/{x["calls"]}</td></tr>'
                   for x in sorted(all_x, key=lambda x: -x['score']))
    holes, strung = sum(x['holes'] for x in all_x), sum(x['strung'] for x in all_x)
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Route x-ray</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>{STYLE}{Y.BLAME_STYLE}</style></head><body><div class="wrap">
<h1>Route x-ray: {len(all_x)} routes</h1>
<p class="sub">Each route's own graph, read for the holes it sends and the string that fills each. Made {time.strftime("%d %B %Y, %H:%M")}. No site was asked and no value is shown.</p>
<div class="nums"><div class="num1"><b>{len(all_x)}</b><span>routes read</span></div><div class="num1"><b>{holes:,}</b><span>holes that are not plain fixed text</span></div><div class="num1"><b>{strung:,}</b><span>strung to a source ({100 * strung // max(holes, 1)}%)</span></div>
<div class="num1"><b style="color:var(--brk)">{sum(1 for x in all_x if x["counts"]["break"])}</b><span>routes with a break</span></div><div class="num1"><b style="color:var(--rsk)">{sum(1 for x in all_x if x["counts"]["risk"])}</b><span>routes with a risk</span></div>
<div class="num1"><b>{sum(1 for x in all_x if not x["plain"])}</b><span>routes that need the browser</span></div></div>
<h2>What to fix in the engine, by how many routes it shows on</h2>
<div class="card"><table><tr><th></th><th>finding</th><th class="num">routes</th><th class="num">places</th><th>what it points to in the engine</th></tr>{roll}</table></div>
{engine_for(list(all_x) + list(walk_xs), emap)}
{trees_for(all_x)}
{walks_for(walk_xs)}
<h2>Every route, worst first</h2>
<div class="card"><table><tr><th>site</th><th>what it does</th><th class="num">steps</th><th class="num">holes</th><th class="num">strung</th><th class="num">breaks</th><th class="num">risks</th><th class="num">notes</th><th></th><th class="num">passed/calls</th></tr>{rows}</table></div>
</div></body></html>'''


def text_for(x, emap=None, learn=None):
    lines = ['%s  %s  (%s)' % (x['site'], x['what'], x['id']),
             '%d step(s), inputs %s, %s; %d holes, %d strung; %d break(s), %d risk(s), %d note(s)' % (len(x['steps']), x['inputs'] or 'none', 'plain' if x['plain'] else 'needs the browser', x['holes'], x['strung'], x['counts']['break'], x['counts']['risk'], x['counts']['note'])]
    for lv in LEVELS:
        for f in x['findings']:
            if f['level'] != lv: continue
            where = ('step %d' % f['step'] if f['step'] else 'route') + ((' ' + str(f['at'])) if f['at'] else '')
            lines.append('  [%s] %-22s %s%s' % (lv, where, CATALOGUE[f['id']][1], (' (' + f['more'] + ')') if f['more'] else ''))
    if learn: lines += G.text(learn, final_kinds(x))
    if emap:
        lines.append('  in the engine (the fix goes here, never in the route):')
        for fid, places, b in blame_rows(x, emap):
            if LEVEL_OF[fid] == 'note': continue
            lines.append('    %s, %d place(s)' % (fid, places))
            lines += Y.text_lines(fid, b)
    return '\n'.join(lines)


def main():
    args = sys.argv[1:]
    out = os.path.expanduser('~/.unbrowse-xray')
    if '--out' in args:
        out = args[args.index('--out') + 1]
        del args[args.index('--out'):args.index('--out') + 2]
    given = {}
    for flag in ('--map', '--tree', '--walks', '--log'):
        if flag in args:
            given[flag] = args[args.index(flag) + 1]
            del args[args.index(flag):args.index(flag) + 2]
    as_text, as_json = '--text' in args, '--json' in args
    paths = [a for a in args if not a.startswith('--')]
    emap = json.load(open(given['--map'])) if '--map' in given else None
    lines_of = lambda f: [json.loads(l) for l in open(f) if l.strip()] if f else []
    trees = {os.path.basename(str(l.get('file'))): l for l in lines_of(given.get('--tree'))}
    walk_xs = [walk_x(l) for l in lines_of(given.get('--walks'))]
    read_log = G.read(given['--log']) if '--log' in given else []
    if not paths and walk_xs: paths = []
    elif not paths: sys.exit(__doc__)
    files = []
    for p in paths:
        p = os.path.expanduser(p)
        files += sorted(os.path.join(p, n) for n in os.listdir(p) if n.endswith('.json')) if os.path.isdir(p) else [p]
    all_x = []
    for f in files:
        try: route = json.load(open(f))
        except (OSError, ValueError) as e:
            print('not read: %s (%s)' % (f, e), file=sys.stderr); continue
        if not isinstance(route, dict) or 'graph' not in route: continue
        x = xray(route)
        if trees: with_tree(x, trees.get(os.path.basename(f)))
        all_x.append(x)
    learns, unkept, gone = with_log(all_x, read_log)
    if not files: gone = []
    if as_json:
        json.dump({'routes': all_x, 'walks': walk_xs}, sys.stdout); return
    if as_text:
        print('\n\n'.join(text_for(x, emap, learns.get(x['id'])) for x in sorted(all_x + walk_xs, key=lambda x: -x['score'])))
        for l in unkept:
            print('\n%s%s  a learn that kept no route (walk %s): %s' % (l['site'], G.hush(l['page'], l['words']), l['walk'], G.hush(l['failed'] or 'no reason logged', l['words'])))
            print('\n'.join(G.text(l)))
        for l in gone:
            print('\n%s%s  a learn whose route (%s) is no longer on the node (walk %s)' % (l['site'], G.hush(l['page'], l['words']), l['saved'].get('route'), l['walk']))
            print('\n'.join(G.text(l)))
        return
    here = os.path.realpath(out)
    probe = here
    while probe != os.path.dirname(probe):
        if os.path.exists(os.path.join(probe, '.git')): sys.exit('refusing to write into a repository (%s): a route names its site. Give --out a folder outside one.' % probe)
        probe = os.path.dirname(probe)
    os.makedirs(here, exist_ok=True)
    for x in all_x + walk_xs:
        open(os.path.join(here, '%s.html' % x['id']), 'w').write(page_for(x, emap, learns.get(x['id'])))
    for l in unkept:
        body = '<p class="sub"><a href="index.html">all routes</a></p><h1>A learn that kept no route</h1><p class="sub"><span class="mono">%s%s</span> · %s</p>%s' % (
            E(l['site']), E(G.hush(l['page'], l['words'])), E(G.hush(l['failed'] or 'no reason logged', l['words'])), G.section(l))
        open(os.path.join(here, 'learn-%s.html' % re.sub(r'[^A-Za-z0-9]', '', str(l['walk']))), 'w').write(
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A learn that kept no route</title><style>%s%s</style></head><body><div class="wrap">%s</div></body></html>' % (STYLE, G.LOG_STYLE, body))
    open(os.path.join(here, 'index.html'), 'w').write(index_for(all_x, emap, walk_xs))
    json.dump({'routes': all_x, 'walks': walk_xs}, open(os.path.join(here, 'xray.json'), 'w'))
    print('read %d route(s) and %d kept site(s); wrote %s/index.html' % (len(all_x), len(walk_xs), here))


if __name__ == '__main__':
    main()
