"""The x-ray's link to the engine: for each finding, the code that decides it, read from the source by engine-map.py;
and each hole said as the rebuild's tree, read from the engine's own `route_tree` (never worked out here).

Nothing in this file knows a line number or whether a function still exists: WHY names kinds and functions, and the map
of the source says where they are today. A name the source no longer has is drawn as gone, so this table cannot quietly
drift from the code.
"""
import html, json, re

E = html.escape

# What a selector is:
#   ('Class', 'Fresh')        every function of the running engine that writes that kind
#   ('Kind', 'Clock')         every function of the rebuild's learner that writes that kind
#   ('Expr', 'Stamp')         every function of the rebuild that writes that expression
#   'learn/links.rs::measured' one function, by the end of its file's path and its name
# For each finding:
#   wrote    'hole' = whoever writes the kind the hole has (read off the hole), or selectors
#   missed   the readers that would have strung it and did not claim it (running engine)
#   seam     the pass that decides this seam in the running engine
#   tree     how the rebuild's tree says it once it is strung. None: the tree has no way to say it yet
#   rebuild  who writes that in the rebuild
#   gap      what is missing, in a sentence, where something is
WHY = {
    'baked-word': dict(wrote='hole', missed=[('Held',)], seam=['learn/links.rs::measured', 'learn.rs::held_where_with'], tree='swap(within, was -> written(given))',
                       rebuild=[('Expr', 'Swap'), 'lab/synth.rs::holding', 'lab/synth.rs::holding_inside']),
    'frozen-clock': dict(wrote='hole', missed=[('Class', 'Fresh')], seam=['fresh.rs::ids', 'fresh.rs::read_anew', 'learn/links.rs::measured'], tree='fresh(ms | s)',
                         rebuild=[('Kind', 'Clock'), 'lab/synth.rs::clock', 'lab/synth.rs::reading'],
                         gap='One walk cannot say a number near its request is the clock\'s: fresh::ids claims it where two addresses carry it, or where a second walk makes the same request and reads the clock anew there (fresh::read_anew). A route kept on one sighting of the call still sends it as walked.'),
    'walk-time-inside': dict(wrote='hole', missed=[('Class', 'Fresh')], seam=['fresh.rs::ids', 'fresh.rs::holds'], tree='join(text, fresh, text) or stamp',
                             rebuild=[('Expr', 'Stamp'), 'lab/synth.rs::stamp_form']),
    'dangling': dict(wrote=[('Class', 'Derived')], seam=['learn.rs::the_least_chain', 'learn/links.rs::applied'], tree='read(step, at); a body that reads a step it lacks is refused whole',
                     rebuild=['route/src/body.rs::refused', 'lab/compile.rs::route']),
    'bad-origin': dict(wrote=[('Class', 'Derived')], seam=['provenance.rs::find_origin_on', 'learn/links.rs::applied'], tree='read(step, at); a read with no step or place is refused whole',
                       rebuild=['route/src/body.rs::refused', 'lab/compile.rs::route']),
    'backwards': dict(wrote=[('Class', 'Derived')], seam=['learn.rs::the_least_chain'], tree='read(step, at); a read of a later step is refused whole', rebuild=['route/src/body.rs::refused', 'lab/compile.rs::route']),
    'deaf': dict(seam=['learn/links.rs::borne_out', 'learn/trial.rs::with_another_word'], tree='a slot the answer does not change with is not a slot', rebuild=['lab/answer.rs::told', 'lab/answer.rs::settle_of_two']),
    'failing': dict(seam=['client.rs::call_with_ledger', 'replay.rs::replay_ledgered'], tree=None, rebuild=['lab/call.rs::call', 'lab/call.rs::not_the_answer'],
                    gap='A refusal, a changed answer and a connection that failed are one outcome to the caller, so a route that could not connect is learned again as if it were dead.'),
    'no-steps': dict(seam=['learn.rs::route_of'], tree='a body has at least the answer step', rebuild=['lab/compile.rs::route']),
    'open': dict(wrote=[('Class', 'Unconfirmed')], seam=['learn/links.rs::measured', 'learn/links.rs::by_the_site_alone', 'learn/links.rs::proposed'], tree='hole.open: sent as walked, and the body is not published',
                 rebuild=[('Kind', 'Open'), 'lab/synth.rs::holes', 'lab/synth.rs::rebuilds']),
    'frozen-date': dict(wrote='hole', missed=[('Class', 'Fresh')], seam=['fresh.rs::readings'], tree=None, rebuild=['route/src/expr.rs::stamped', 'lab/synth.rs::stamp_form'],
                        gap='No expression writes a date from the clock: a stamp knows {ms}, {s} and {dN} only. Until one does, a date of the walk is a caller\'s slot or stays as walked.'),
    'looks-minted': dict(wrote='hole', missed=[('Class', 'Derived'), ('Class', 'Minted')], seam=['provenance.rs::find_origin_on', 'learn/links.rs::measured'], tree='read(step, at) or cookie(name)',
                         rebuild=[('Kind', 'Session'), ('Kind', 'Read'), 'lab/sighting.rs::axes'],
                         gap='Both walks of a learn share one session, so a value that lasts only the session is the same on both and reads as fixed.'),
    'page-made': dict(wrote='hole', missed=[('Class', 'Recipe'), ('Class', 'Generated')], seam=['signing.rs::discover', 'signing.rs::fit_by_search'], tree='hash(join(sent ...)) at rung 1, or program at rung 2',
                      rebuild=[('Kind', 'Digest'), 'lab/synth.rs::digest']),
    'far-tie': dict(wrote=[('Class', 'Derived')], seam=['provenance.rs::find_origin_on', 'learn/links.rs::measured'], tree='read(step, at), kept only where it holds on both walks', rebuild=['lab/synth.rs::holes', 'lab/synth.rs::rebuilds']),
    'dead-step': dict(seam=['learn.rs::the_least_chain'], tree='a body holds the answer and the steps its reads need, and no other', rebuild=['lab/compile.rs::route']),
    'needs-browser': dict(seam=['learn/links.rs::made_by_the_page', 'graph.rs::minted_or_computed'], tree='step.page: made at rung 3 or below', rebuild=['route/src/fill.rs::rung', 'lab/compile.rs::step']),
    'no-input': dict(missed=[('Class', 'Input')], seam=['learn/trial.rs::second_walk', 'learn.rs::path_inputs'], tree='slot(name)', rebuild=[('Kind', 'Callers'), 'lab/synth.rs::callers', 'lab/sighting.rs::asked_again']),
    'provisional': dict(wrote=[('Class', 'Unconfirmed')], seam=['learn/links.rs::with_proposed_links'], tree='hole.open', rebuild=[('Kind', 'Open')]),
    'text-cut': dict(seam=['provenance.rs::extract'], tree='read(step, text before..after)', rebuild=['lab/synth.rs::read']),
    'header-tie': dict(wrote=[('Class', 'Derived')], seam=['provenance.rs::find_origin_on'], tree='read(step, header)', rebuild=['lab/synth.rs::holes']),
    'place-name': dict(seam=['learn/trial.rs::the_address_left', 'learn.rs::path_inputs', 'learn.rs::note_address'], tree=None, rebuild=['lab/sighting.rs::asked_again', 'lab/kept.rs::asked'],
                       gap='A slot has a name, an example and choices. Nothing says what kind of value it is or what the page calls it, so an unnamed piece keeps its place for a name.'),
    # A page read at the address the walk landed on: the landing is told apart from the asking (learn::landed), a plain
    # page read asks at the page's own address and follows the redirect (learn::learn_plain), and the classifier makes
    # an address piece the caller's only where a caller's value sits (graph::classify, learn::address_ids).
    'redirected-piece': dict(wrote='hole', missed=[('Class', 'Input')], seam=['learn.rs::landed', 'learn.rs::learn_plain', 'graph.rs::classify', 'learn.rs::address_ids'],
                             tree='slot(name), or the page asked at its own address with the redirect followed', rebuild=['lab/sighting.rs::asked_again']),
    'off-site-step': dict(seam=['learn.rs::the_least_chain'], tree='a step of another site is a step like any other', rebuild=['lab/compile.rs::route']),
    'post-in-read': dict(seam=['ledger.rs::writes'], tree='step.writes: never sent to try, never sent twice', rebuild=['lab/compile.rs::writes']),
    'no-shape': dict(seam=['learn.rs::route_of'], tree='step.shape of the answer', rebuild=['lab/compile.rs::step']),
    'refused-when-learned': dict(seam=['learn.rs::route_of'], tree='step.expect', rebuild=['lab/compile.rs::step']),
    'unheard': dict(seam=['learn/trial.rs::with_another_word', 'learn/links.rs::borne_out'], tree='an answer two walks settle', rebuild=['lab/answer.rs::settle', 'lab/answer.rs::settle_of_two']),
    'no-fields': dict(seam=['fields.rs::defaults_on', 'learn/links.rs::with_proposed_fields'], tree=None, rebuild=['lab/answer.rs::said_lines'],
                      gap='The answer names a step and whether it is a page. It names no fields, so which fields are the result is worked out again at each call.'),
    # The pick is held to the goal's fields; that its answer names the item the page is about is asked of a goal for one
    # thing only, so a list beside the item (related, similar) passes for the page's answer.
    'related-list': dict(seam=['learn.rs::fails_goal', 'learn.rs::pick_and_keep', 'learn.rs::holding_of', 'learn.rs::address_ids'], tree='answer.step, settled by two walks or not written',
                         rebuild=['lab/answer.rs::own_lines_back', 'lab/answer.rs::settle_of_two']),
    'no-page': dict(seam=['learn.rs::route_of'], tree=None, rebuild=[], gap='A body keeps no page to learn it again from.'),
    'never-called': dict(seam=[], tree='', rebuild=[]),
    'long-chain': dict(seam=['learn.rs::the_least_chain'], tree='the steps the answer\'s reads need, and no other', rebuild=['lab/compile.rs::route']),
    # A cookie in the step as text: the readers that make a cookie the jar's (a value the walk's browser held, a value a
    # call set) did not claim it, and nothing between them and the store refuses a cookie kept as a constant.
    'fixed-cookie': dict(wrote='hole', missed=[('Class', 'Minted'), ('Class', 'Derived')],
                         seam=['graph.rs::held_under', 'graph.rs::minted_or_computed', 'graph.rs::walked_cookies', 'client.rs::with_session_cookies'], tree='cookie(name)',
                         rebuild=[('Kind', 'Session')]),
    'walked-header': dict(wrote='hole', seam=['graph.rs::held_in_text'], tree='swap, or text where the site does not read it', rebuild=['lab/synth.rs::holding']),
    # What the node's log of the learn says (xray_log).
    'picked-without-fields': dict(seam=['learn.rs::pick_and_keep', 'learn.rs::verify_learned'], tree='answer.step, settled by two walks or not written', rebuild=['lab/answer.rs::settle_of_two', 'lab/answer.rs::own_lines_back'],
                                  gap='A pick whose own reason says it holds none of what was asked for is still kept and answered as ok. The rebuild writes no route where no reply says the value back.'),
    'shell-kept': dict(seam=['learn.rs::verify_learned', 'learn.rs::pick_and_keep', 'learn/links.rs::borne_out'], tree='answer.step, settled by two walks or not written', rebuild=['lab/answer.rs::settle_of_two', 'lab/compile.rs::learn']),
    'kept-unanswered': dict(seam=['learn.rs::verify_learned', 'learn/links.rs::borne_out'], tree='answer.step, settled by two walks or not written', rebuild=['lab/answer.rs::settle_of_two', 'lab/compile.rs::learn']),
    'picked-below-top': dict(seam=['learn.rs::pick_and_keep'], tree='answer.step', rebuild=['lab/answer.rs::settle', 'lab/answer.rs::answer_of_two']),
    'connection-as-refusal': dict(seam=['learn/links.rs::borne_out', 'learn/links.rs::put_to_the_site', 'client.rs::call_with_ledger'], tree=None, rebuild=['lab/call.rs::call'],
                                  gap='A refusal, a changed answer and a connection that failed are one outcome to the pass that asked, so a trial that never reached the site is counted against the route.'),
    'second-walk-elsewhere': dict(seam=['learn/trial.rs::second_walk', 'learn/trial.rs::asked_the_same_page', 'learn/trial.rs::another_word'], tree='a hole is settled by two sightings', rebuild=['lab/sighting.rs::asked_again', 'lab/sighting.rs::sightings']),
    'learned-after-set-aside': dict(seam=['api/goal.rs::unanswered', 'api/goal.rs::found_nothing_of_the_goal', 'api/goal.rs::nothing_for_this_value', 'run.rs::found_nothing'], tree=None, rebuild=[],
                                    gap='What a called route\'s answer for another value means (the site finding nothing, or the route at fault) is decided at call time, outside the route. The tree says nothing of it.'),
    'replaced-a-route': dict(seam=['api/goal.rs::superseded', 'store.rs::retire_route_for', 'api/goal.rs::unanswered', 'api/goal.rs::found_nothing_of_the_goal'], tree=None, rebuild=[],
                             gap='Which of two routes for one goal stands is the store\'s, not the route\'s: a body does not say what it replaced.'),
    # What only the tree's own code can say (route_tree).
    'tree-refused': dict(seam=[], tree='the body does not run as it stands', rebuild=['route/src/body.rs::refused', 'body.rs::from_graph']),
    'tree-unsaid': dict(seam=[], tree='the tree says here what the running graph has no kind for', rebuild=['body.rs::to_graph', 'body.rs::class_of', 'body.rs::ways_of']),
    # What the rebuild's learner says of kept walks (route_tree walks).
    'unsettled': dict(seam=[], tree='answer.step', rebuild=['lab/answer.rs::settle_of_two', 'lab/answer.rs::told', 'lab/answer.rs::own_lines_back']),
    'second-walk-missed': dict(seam=['graph.rs::the_same_call_there', 'learn/trial.rs::asked_the_same_page'], tree='a hole is settled by two sightings', rebuild=['lab/sighting.rs::same_operation', 'lab/sighting.rs::sightings'],
                               gap='Two readers answer "is this the same call on another walk": the running engine pairs calls by mutual best match, the rebuild by a rule on the address.'),
    'picked-another': dict(seam=['learn.rs::pick_and_keep'], tree='answer.step', rebuild=['lab/answer.rs::settle', 'lab/answer.rs::answer_of_two']),
    'one-walk-tie': dict(wrote=[('Class', 'Derived')], seam=['provenance.rs::find_origin_on'], tree='text; the tie is kept beside it and not believed', rebuild=['lab/synth.rs::holes']),
}

ROLES = (('wrote', 'wrote it this way'), ('missed', 'would have strung it'), ('seam', 'decides this seam'), ('rebuild', 'the rebuild'))
SHORT = (('crates/learn/src/', ''), ('crates/route/src/', 'route/'), ('app/src/', 'app/'))
MOST_WRITERS = 5


def short(path):
    for a, b in SHORT:
        if path.startswith(a): return b + path[len(a):]
    return path


_RESOLVED = {}


def resolve(engine, sel):
    """A selector as the functions it names in `engine` (one tree of the map): [{key, file, name, line, lines, callers}], or one {'gone': …}."""
    if not engine: return []
    memo = (id(engine), sel)
    if memo not in _RESOLVED: _RESOLVED[memo] = _resolve(engine, sel)
    return _RESOLVED[memo]


def _resolve(engine, sel):
    fns = engine['fns']
    row = lambda k: dict(key=k, file=short(fns[k]['file']), name=fns[k]['name'], line=fns[k]['line'], lines=fns[k]['lines'], callers=len(fns[k]['callers']))
    if isinstance(sel, tuple):
        kind = sel[0] if len(sel) == 1 else '%s::%s' % sel
        keys = []
        for w in engine['writes'].get(kind, []):
            if sel[0] == 'Kind' and '/lab/' not in fns[w['fn']]['file']: continue
            if w['fn'] not in keys: keys.append(w['fn'])
        return [dict(row(k), kind=kind) for k in keys] or [{'gone': 'nothing writes ' + kind}]
    path, _, name = sel.partition('::')
    hits = [k for k, f in fns.items() if f['name'] == name and (f['file'].endswith('/' + path) or f['file'].endswith(path))]
    return [row(hits[0])] if hits else [{'gone': sel}]


def class_selector(cls):
    return ('Class', cls.capitalize()) if cls and cls not in ('template',) else None


def blame(finding_ids, classes, emap, by_rebuild=False):
    """For each finding id (with the kinds the holes it sits on have): who wrote, who missed, the seam, the rebuild.
    `by_rebuild`: the reading is the rebuild's own, so no function of the running engine wrote or missed anything in it;
    its pass for the same seam is still shown, as what the rebuild has to do as well."""
    out = {}
    for fid in finding_ids:
        why = WHY.get(fid)
        if why is None: continue
        running, rebuild = (emap or {}).get('running'), (emap or {}).get('rebuild')
        wrote_sel = [class_selector(c) for c in sorted(classes.get(fid) or [])] if why.get('wrote') == 'hole' else (why.get('wrote') or [])
        if by_rebuild: wrote_sel = []
        row = {'tree': why.get('tree'), 'gap': why.get('gap'), 'wrote': [], 'missed': [], 'seam': [], 'rebuild': []}
        for role, sels, engine in (('wrote', wrote_sel, running), ('missed', [] if by_rebuild else why.get('missed') or [], running), ('seam', why.get('seam') or [], running), ('rebuild', why.get('rebuild') or [], rebuild)):
            seen = set()
            for sel in sels:
                if sel is None: continue
                for f in resolve(engine, sel):
                    k = f.get('key') or f.get('gone')
                    if k in seen: continue
                    seen.add(k)
                    row[role].append(f)
        out[fid] = row
    return out


def classes_of(x):
    """finding id -> the kinds of the holes it was found on, for one x-rayed route."""
    out = {}
    for st in x['steps']:
        for h in st['holes']:
            for fid in h['findings']: out.setdefault(fid, set()).add(str(h.get('was') or h['class']))
    return out


# ---------------------------------------------------------------------------------------------- the tree, as words
def shape_of_text(s):
    n = len(s)
    if n == 0: return 'empty'
    if re.fullmatch(r'\d{13}', s): return '13 digits'
    if re.fullmatch(r'\d{10}', s): return '10 digits'
    if re.fullmatch(r'-?\d+', s): return '%d digits' % n
    if re.fullmatch(r'[0-9a-fA-F-]{32,36}', s): return 'id, %d' % n
    return '%d chars' % n


def formula(e, depth=0):
    """An expression in a line, with no value of the route in it: a text is its length, a program is the word."""
    if not isinstance(e, dict): return '?'
    op = e.get('op')
    f = lambda k: formula(e.get(k), depth + 1)
    if op == 'text': return 'text(%s)' % shape_of_text(e.get('is') or '')
    if op == 'slot': return 'slot(%s%s)' % (e.get('name'), ', optional' if e.get('optional') else '')
    if op == 'given': return 'given(%s)' % e.get('name')
    if op == 'cookie': return 'cookie(%s)' % e.get('name')
    if op == 'stored': return 'stored(%s %s)' % (e.get('area'), e.get('key'))
    if op == 'read':
        at = e.get('at') or {}
        where = at.get('pointer') or at.get('name') or ('text' if at.get('from') == 'text' else '')
        return 'read(%s %s %s)' % (e.get('step'), at.get('from'), where)
    if op == 'fresh': return 'fresh(%s)' % e.get('clock')
    if op == 'stamp': return 'stamp(%s)' % ' '.join(re.findall(r'\{[a-z0-9]+\}', e.get('form') or ''))
    if op == 'file': return 'file(%s %s)' % (e.get('slot'), e.get('fact'))
    if op == 'sent':
        part = e.get('part') or {}
        return 'sent(%s%s)' % (part.get('of'), (' ' + str(part['key'])) if part.get('key') else '')
    if op == 'nothing': return 'nothing' + ((' after ' + e['after']) if e.get('after') else '')
    if op == 'join':
        parts = [formula(p, depth + 1) for p in e.get('parts') or []]
        if len(parts) > 6: parts = parts[:5] + ['... %d more' % (len(parts) - 5)]
        return 'join(%s)' % ', '.join(parts)
    if op == 'slice': return 'slice(%s, %s+%s)' % (f('of'), e.get('from'), e.get('len'))
    if op == 'piece': return 'piece(%s, #%s)' % (f('of'), e.get('index'))
    if op == 'written': return 'written(%s, %s)' % (f('of'), e.get('how'))
    if op == 'wrapped': return 'wrapped(%s, %s)' % (f('of'), e.get('how'))
    if op == 'unwrapped': return 'unwrapped(%s, %s)' % (f('of'), e.get('how'))
    if op == 'swap': return 'swap(%s, was -> %s%s)' % (f('within'), f('now'), (', inside ' + e['inside']) if e.get('inside') else '')
    if op == 'hash': return '%s(%s)' % (e.get('algo'), f('of'))
    if op == 'hmac': return 'hmac-%s(%s, key %s)' % (e.get('algo'), f('of'), f('key'))
    if op == 'program': return 'program'
    return str(op)


def ops_of(e, out=None):
    out = [] if out is None else out
    if isinstance(e, dict) and 'op' in e:
        out.append(e)
        for v in e.values():
            if isinstance(v, dict): ops_of(v, out)
            elif isinstance(v, list):
                for i in v: ops_of(i, out)
    return out


def hole_words(hole):
    """A tree hole in a line: its ways, cheapest first, each with its rung."""
    ways = ['%s%s' % (formula(w.get('expr')), '' if not w.get('rung') else ' [rung %d]' % w['rung']) for w in hole.get('ways') or []]
    return ('  or  '.join(ways) or 'no way') + (' (open)' if hole.get('open') else '') + (' (written over the template)' if hole.get('over') else '')


def place_words(at):
    """A tree place (`{"in": "query", "key": "q"}`) the way the x-ray writes a place."""
    key = at.get('key')
    if isinstance(key, list): key = '/'.join(str(k) for k in key)
    return '%s:%s' % (at.get('in'), '' if key is None else key)


def general(reason):
    """A refusal's words with what it names of the route taken out: the kind of refusal."""
    r = re.sub(r'\bstep x\d+', 'a step', str(reason))
    r = re.sub(r'\bx\d+\b', 'a step', r)
    r = re.sub(r'\b(query|header|cookie|form|part|body|path) [^:,()]{1,120}:', r'\1 <key>:', r)
    return re.sub(r'\d+', 'N', r)[:170]


def x_from_body(body, kinds=None, meta=None):
    """A tree body as the x-ray's own reading: steps, holes, the source of each. `kinds`: place -> what the learner said
    the answer's place turned out to be."""
    meta, kinds = meta or {}, kinds or {}
    steps, findings = [], []
    index_of = {s['id']: i for i, s in enumerate(body.get('steps') or [])}
    answer = (body.get('answer') or {}).get('step')
    for n, s in enumerate(body.get('steps') or []):
        holes, fixed, cookies = [], 0, 0
        for h in s.get('holes') or []:
            at = place_words(h.get('at') or {})
            first = (h.get('ways') or [{}])[0]
            ops = ops_of(first.get('expr'))
            names = [o.get('op') for o in ops]
            hole = {'at': at, 'in': (h.get('at') or {}).get('in'), 'class': (kinds.get(at) or names[0] if names else 'none') if s['id'] == answer else (names[0] if names else 'none'),
                    'src': ('fixed',), 'comp': None, 'shape': None, 'findings': [], 'tree': hole_words(h)}
            find = lambda op: next((o for o in ops if o.get('op') == op), None)
            if find('slot') or find('given'):
                o = find('slot') or find('given')
                hole['src'] = ('caller', o.get('name'))
                if names[0] not in ('slot',): hole['comp'] = names[0]
            elif find('read'):
                o = find('read')
                at_o = o.get('at') or {}
                hole['src'] = ('step', index_of.get(o.get('step')), at_o.get('from'), at_o.get('pointer') or at_o.get('name') or '')
                if names[0] != 'read': hole['comp'] = names[0]
            elif find('fresh') or find('stamp'): hole['src'], hole['comp'] = ('clock',), 'made from the clock'
            elif find('hash') or find('hmac') or find('program') or find('sent'): hole['src'], hole['comp'] = ('request',), names[0]
            elif find('cookie'): hole['src'] = ('session', find('cookie').get('name'))
            elif names and names[0] == 'nothing' and first.get('rung', 0) >= 3: hole['src'] = ('page',)
            elif h.get('open'): hole['src'] = ('walk',)
            if h.get('open'):
                hole['findings'].append('open')
                hole['shape'] = formula(first.get('expr'))
                findings.append({'id': 'open', 'level': 'risk', 'step': n + 1, 'at': at, 'more': hole['shape']})
            if hole['src'][0] == 'page':
                hole['findings'].append('page-made')
                findings.append({'id': 'page-made', 'level': 'risk', 'step': n + 1, 'at': at, 'more': ''})
            if hole['src'][0] == 'session' and not hole['findings'] and hole['in'] == 'cookie': cookies += 1; continue
            if hole['src'][0] == 'fixed' and not hole['findings']: fixed += 1; continue
            holes.append(hole)
        url = s.get('url') or ''
        m = re.match(r'https?://([^/]+)(/[^?]*)?', url)
        steps.append({'n': n + 1, 'method': s.get('method'), 'host': m.group(1) if m else '', 'path': (m.group(2) or '/') if m else url, 'holes': holes, 'fixed': fixed, 'cookies': cookies,
                      'marks': ['needs-browser'] if s.get('page') else [], 'sets_cookie': False, 'on_load': False})
        if s.get('page'): findings.append({'id': 'needs-browser', 'level': 'risk', 'step': n + 1, 'at': None, 'more': ''})
    all_holes = [h for st in steps for h in st['holes']]
    return {'id': meta.get('id'), 'site': body.get('site'), 'what': meta.get('what') or '', 'method': None, 'steps': steps, 'inputs': [s['name'] for s in body.get('slots') or []], 'plain': not any(s.get('page') for s in body.get('steps') or []),
            'write': any(s.get('writes') for s in body.get('steps') or []), 'findings': findings, 'holes': len(all_holes),
            'strung': sum(1 for h in all_holes if h['src'][0] not in ('walk', 'fixed', 'page')), 'fixed': sum(st['fixed'] for st in steps), 'cookies': sum(st['cookies'] for st in steps),
            'calls': 0, 'passed': 0, 'by': 'rebuild'}


# ---------------------------------------------------------------------------------------------- the picture
BLAME_STYLE = '''
.bf{fill:var(--card);stroke:var(--line)}.bf.break{stroke:var(--brk);stroke-width:1.6}.bf.risk{stroke:var(--rsk)}.bt{font-size:12px;fill:var(--ink)}.bm{font-size:10.5px;fill:var(--mute)}
.bfn{fill:var(--band);stroke:var(--line)}.bfn.kind{stroke:var(--brk)}.bfn.gone{stroke:var(--brk);stroke-dasharray:4 3}.bfn.gap{stroke:var(--brk);fill:none;stroke-dasharray:5 4}.bfn.tree{stroke:var(--pc)}
.bl{fill:none;stroke-linecap:round;stroke-opacity:.62}.bl.wrote{stroke:var(--brk)}.bl.missed{stroke:var(--rsk);stroke-dasharray:6 4}.bl.seam{stroke:var(--dep)}.bl.rebuild{stroke:var(--pc)}
.bh{font-size:12.5px;font-weight:600;fill:var(--ink)}
'''
BLAME_LEGEND = ('<div class="leg"><span style="color:var(--brk)"><b>red</b>: the functions that write the kind the hole has; one of them wrote it, and a route does not record which</span>'
                '<span style="color:var(--rsk)"><b>dashed orange</b>: the reader that would have strung it, and did not claim it</span>'
                '<span style="color:var(--dep)"><b>blue</b>: the pass that decides this seam</span><span style="color:var(--pc)"><b>purple</b>: how the rebuild\'s tree says it, and who writes that there</span>'
                '<span style="color:var(--brk)">dashed red box: nothing in the engine does this yet, or a function the source no longer has</span></div>')


def draw_blame(rows, titles, levels, head='What this route shows'):
    """rows: [(finding id, places, blame row)], worst first. The findings stand in the middle; the running engine's
    functions are on the left and the rebuild's on the right, so no line crosses a column. Every function that writes
    one kind is one box: a route does not record which of them wrote a hole."""
    if not rows: return ''
    X, W, H, ROW = (10, 490, 930), (390, 350, 400), 34, 42
    left, right, lines = [], [], []
    left_at, right_at = {}, {}

    def box(side, key, top, sub, cls):
        book, items = (left_at, left) if side == 0 else (right_at, right)
        if key not in book:
            book[key] = len(items)
            items.append((top, sub, cls))
        return book[key]

    def fn_box(side, f):
        if 'gone' in f: return box(side, 'gone:' + f['gone'], f['gone'], 'not in the source now', 'gone')
        sub = 'line %d, %d lines' % (f['line'], f['lines']) + (', called from %d place(s)' % f['callers'] if side == 0 else '')
        return box(side, f['key'], '%s  %s' % (f['file'], f['name']), sub, '')

    for i, (fid, places, b) in enumerate(rows):
        by_kind = {}
        for f in b['wrote']:
            if 'gone' in f: lines.append((i, 0, fn_box(0, f), 'wrote', places))
            else: by_kind.setdefault(f.get('kind') or 'it', []).append(f)
        for kind, fs in by_kind.items():
            names = ', '.join(sorted({'%s %s' % (f['file'].split('/')[-1], f['name']) for f in fs}))
            lines.append((i, 0, box(0, 'kind:' + kind, '%s: written by %d function(s)' % (kind, len(fs)), names, 'kind'), 'wrote', places))
        by_kind = {}
        for f in b['missed']:
            if 'gone' in f or not f.get('kind'): lines.append((i, 0, fn_box(0, f), 'missed', places))
            else: by_kind.setdefault(f['kind'], []).append(f)
        for kind, fs in by_kind.items():
            if len(fs) <= 2:
                for f in fs: lines.append((i, 0, fn_box(0, f), 'missed', places))
                continue
            names = ', '.join(sorted({'%s %s' % (f['file'].split('/')[-1], f['name']) for f in fs}))
            lines.append((i, 0, box(0, 'kind:' + kind, '%s: written by %d function(s)' % (kind, len(fs)), names, 'kind'), 'missed', places))
        for f in b['seam'][:MOST_WRITERS]: lines.append((i, 0, fn_box(0, f), 'seam', places))
        if b['tree'] is None: lines.append((i, 1, box(1, 'gap:' + fid, 'the tree cannot say this yet', b.get('gap') or '', 'gap'), 'rebuild', places))
        elif b['tree']: lines.append((i, 1, box(1, 'tree:' + b['tree'], b['tree'], 'the expression that says it', 'tree'), 'rebuild', places))
        for f in b['rebuild'][:MOST_WRITERS]: lines.append((i, 1, fn_box(1, f), 'rebuild', places))
    tallest = max(len(rows), len(left), len(right))
    height = 30 + tallest * ROW + 8
    spread = (tallest * ROW) / float(len(rows))
    y_mid = lambda i: 30 + i * spread + (spread - ROW) / 2
    y_side = lambda n: 30 + n * ROW
    out = ['<text class="bh" x="%d" y="16">The running engine</text><text class="bh" x="%d" y="16">%s</text><text class="bh" x="%d" y="16">The rebuild (the tree)</text>' % (X[0], X[1], E(head), X[2])]
    most = max([p for _, p, _ in rows] + [1])
    for i, side, j, role, places in lines:
        y1, y2 = y_mid(i) + H / 2, y_side(j) + H / 2
        x1, x2 = (X[1], X[0] + W[0]) if side == 0 else (X[1] + W[1], X[2])
        bend = 36 if side == 1 else -36
        width = 1.1 + 2.4 * (places / float(most)) ** 0.5
        out.append('<path class="bl %s" stroke-width="%.1f" d="M%d,%.0f C%d,%.0f %d,%.0f %d,%.0f"/>' % (role, width, x1, y1, x1 + bend, y1, x2 - bend, y2, x2, y2))
    for i, (fid, places, _) in enumerate(rows):
        y = y_mid(i)
        out.append('<rect class="bf %s" x="%d" y="%.0f" width="%d" height="%d" rx="6"/>' % (levels[fid], X[1], y, W[1], H))
        out.append('<text class="bt" x="%d" y="%.0f">%s</text><text class="bm" x="%d" y="%.0f">%s · %s</text>' % (X[1] + 9, y + 14, E(clip(titles[fid], 54)), X[1] + 9, y + 28, levels[fid], places))
    for side, items in ((0, left), (1, right)):
        x, w = (X[0], W[0]) if side == 0 else (X[2], W[2])
        for n, (top, sub, cls) in enumerate(items):
            y = y_side(n)
            out.append('<rect class="bfn %s" x="%d" y="%.0f" width="%d" height="%d" rx="6"/>' % (cls, x, y, w, H))
            out.append('<text class="bt mono" x="%d" y="%.0f">%s</text><text class="bm" x="%d" y="%.0f">%s</text>' % (x + 9, y + 14, E(clip(top, 50)), x + 9, y + 28, E(clip(sub, 68))))
    return '<svg viewBox="0 0 %d %d" style="min-width:1180px" role="img" aria-label="Each finding and the engine code that decides it">%s</svg>' % (X[2] + W[2] + 10, height, '\n'.join(out))


def clip(text, most):
    return text if len(text) <= most else text[:most - 1] + '…'


def fn_cell(fs):
    cells = []
    for f in fs:
        if 'gone' in f: cells.append('<span style="color:var(--brk)">%s (not in the source now)</span>' % E(f['gone']))
        else: cells.append('<span class="mono">%s:%d %s</span>' % (E(f['file']), f['line'], E(f['name'])))
    return '<br>'.join(cells)


def why_table(rows, titles, levels):
    body = ''
    for fid, places, b in rows:
        tree = '<span style="color:var(--brk)">nothing yet</span>' if b['tree'] is None else '<span class="mono">%s</span>' % E(b['tree'])
        gap = ('<br><span class="dim">%s</span>' % E(b['gap'])) if b.get('gap') else ''
        body += '<tr><td><span class="lv lv-%s">%s</span></td><td>%s<br><span class="dim">%s</span></td><td>%s</td><td>%s</td><td>%s</td><td>%s%s</td><td>%s</td></tr>' % (
            levels[fid], levels[fid], E(titles[fid]), places, fn_cell(b['wrote']), fn_cell(b['missed']), fn_cell(b['seam']), tree, gap, fn_cell(b['rebuild']))
    return ('<table class="wt"><tr><th></th><th>finding</th><th>wrote it this way</th><th>would have strung it</th><th>decides the seam</th><th>as the tree says it</th><th>who writes that in the rebuild</th></tr>%s</table>' % body)


def text_lines(fid, b):
    """The code a finding points at, as lines for a terminal."""
    out = []
    for role, label in ROLES:
        fs = b[role][:MOST_WRITERS]
        if not fs: continue
        said = ', '.join(f['gone'] + ' (gone)' if 'gone' in f else '%s:%d %s' % (f['file'], f['line'], f['name']) for f in fs)
        out.append('        %-22s %s%s' % (label + ':', said, ' (+%d)' % (len(b[role]) - MOST_WRITERS) if len(b[role]) > MOST_WRITERS else ''))
    out.append('        %-22s %s' % ('the tree:', b['tree'] if b['tree'] is not None else 'cannot say it yet. ' + (b.get('gap') or '')))
    return out


def rank_functions(per_route):
    """per_route: [(finding counts {id: places}, blame {id: row})]. The engine's functions by the findings they answer for."""
    table = {}
    for counts, b in per_route:
        seen = set()
        for fid, places in counts.items():
            row = b.get(fid)
            if not row: continue
            for role, _ in ROLES:
                for f in row[role]:
                    if 'gone' in f: continue
                    key = (role == 'rebuild', f['key'])
                    t = table.setdefault(key, {'f': f, 'roles': set(), 'routes': 0, 'places': 0, 'findings': set()})
                    t['roles'].add(role)
                    t['findings'].add(fid)
                    t['places'] += places
                    if key not in seen:
                        t['routes'] += 1
                        seen.add(key)
    return sorted(table.items(), key=lambda kv: (-kv[1]['routes'], -kv[1]['places']))
