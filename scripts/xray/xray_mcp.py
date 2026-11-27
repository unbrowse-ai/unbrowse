#!/usr/bin/env python3
"""The x-ray as an MCP server, for an agent working in this checkout: stdio, JSON-RPC, the standard library only.

Every tool calls `xray.sh` (or the modules beside it) exactly as a person does, so an agent reads what the live page
shows, against the engine as this checkout has it, and nothing is worked out a second time here. It asks no site and
prints no value of a route: the x-ray's own masking holds.

    python3 -I scripts/xray/xray_mcp.py          # attached by the repository's .mcp.json; see AGENTS.md for others
    python3 -I scripts/xray/xray_mcp.py --check  # the install, proven: prints XRAY_MCP_OK, or what is broken

The scratch node is `ub_dir` on each call, or UB_DIR in the server's environment.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
XRAY = os.path.join(HERE, 'xray.sh')
PROTOCOL = '2025-06-18'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    m = importlib.util.module_from_spec(spec)
    sys.path.insert(0, HERE)
    try:
        spec.loader.exec_module(m)
    finally:
        sys.path.remove(HERE)
    return m


def node_dir(args):
    d = args.get('ub_dir') or os.environ.get('UB_DIR') or ''
    if not d:
        raise ValueError('name the scratch node: ub_dir, or UB_DIR in the server\'s environment')
    if not os.path.isdir(d):
        raise ValueError('%s is not a folder' % d)
    return d


def xray(argv, env_extra=None, timeout=600):
    env = dict(os.environ, **(env_extra or {}))
    p = subprocess.run(['sh', XRAY, *argv], capture_output=True, text=True, env=env, timeout=timeout, cwd=ROOT)
    return p.returncode, p.stdout, p.stderr


def state(args):
    """The live page's state. A node log alone (a CI run's `qa-node-log-*` artifact, a log kept from a node that is gone)
    is read against an empty node folder made for this call, so a failure is read where it was recorded."""
    log, made = args.get('log'), None
    if log and not os.path.isfile(log):
        raise ValueError('%s is not a file' % log)
    if log and not (args.get('ub_dir') or os.environ.get('UB_DIR')):
        made = tempfile.mkdtemp(prefix='uxl')
        os.makedirs(os.path.join(made, 'home', 'node', 'routes'))
        args = dict(args, ub_dir=made)
    try:
        env = {'UB_DIR': node_dir(args)}
        if log:
            env['XRAY_LOG'] = log
        code, out, err = xray(['state'], env)
        if code != 0:
            raise RuntimeError('xray.sh state exited %d: %s' % (code, err.strip()[-600:]))
        return json.loads(out)
    finally:
        if made:
            shutil.rmtree(made, ignore_errors=True)


def pick(args):
    """Each learn of the node's log, newest last: what the door took and why, every candidate, the pick, the findings."""
    learns = state(args).get('pick')
    if learns is None:
        return {'pick': None, 'why': 'the node has no log to read (start it with scratch-node.sh, or name its log)'}
    if args.get('walk'):
        learns = [l for l in learns if l.get('walk') == args['walk']]
    last = int(args.get('last') or 3)
    keep = learns[-last:]
    if not args.get('lines'):
        for l in keep:
            l.pop('text', None)
    return {'learns': len(learns), 'shown': keep}


def routes(args):
    """Each route's findings and the code they point at, as `xray.sh --text` prints them."""
    env = {'UB_DIR': node_dir(args)}
    argv = ['--text'] + ([args['route']] if args.get('route') else [])
    code, out, err = xray(argv, env)
    return {'exit': code, 'text': out[-60000:], 'stderr': err.strip()[-2000:]}


def where(fn):
    """`file.rs::name` resolved in this checkout: each place a function of that name is defined."""
    file, _, name = fn.partition('::')
    base = os.path.basename(file)
    p = subprocess.run(['git', '-C', ROOT, 'grep', '-n', '-E', r'fn %s[<(]' % re.escape(name), '--', ':(glob)unbrowse-node/**/%s' % base],
                       capture_output=True, text=True)
    hits = [l.split(':', 2)[:2] for l in p.stdout.splitlines() if l.split(':', 1)[0].endswith('/' + file)]
    return {'fn': fn, 'at': ['%s:%s' % (f, n) for f, n in hits] or None}


def why(args):
    """A finding's meaning (the catalogue) and the engine's functions that decide it (WHY), each resolved to file:line."""
    fid = args.get('finding') or ''
    cat = module('route_xray', 'route-xray.py').CATALOGUE
    whys = module('xray_why', 'xray_why.py').WHY
    if fid not in cat:
        return {'unknown': fid, 'findings': sorted(cat)}
    level, title, more = cat[fid]
    w = whys.get(fid) or {}
    return {'finding': fid, 'level': level, 'title': title, 'more': more,
            'seam': [where(f) for f in w.get('seam') or [] if isinstance(f, str)],
            'tree': w.get('tree'), 'gap': w.get('gap'), 'rebuild': [r if isinstance(r, str) else list(r) for r in w.get('rebuild') or []]}


def diff(args):
    """What changed between two homes or scratch nodes; `new_break` is true when the second has a break the first had not."""
    code, out, err = xray(['diff', args['before'], args['after']])
    return {'new_break': code == 1, 'exit': code, 'text': out[-60000:], 'stderr': err.strip()[-2000:]}


LIVE = {}


def live(args):
    """The live page for a person: started once per node, its address returned."""
    d = node_dir(args)
    p = LIVE.get(d)
    if p and p[0].poll() is None:
        return {'url': p[1], 'already': True}
    port = str(args.get('port') or 7317)
    proc = subprocess.Popen(['sh', XRAY, 'serve'], env=dict(os.environ, UB_DIR=d, XRAY_PORT=port), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, cwd=ROOT)
    for line in proc.stdout:
        m = re.search(r'http://127\.0\.0\.1:\d+/?', line)
        if m:
            LIVE[d] = (proc, m.group(0))
            return {'url': m.group(0)}
    return {'url': None, 'exit': proc.wait()}


NODE = {'ub_dir': {'type': 'string', 'description': 'The scratch node folder (scratch-node.sh <folder>); defaults to UB_DIR.'}}
TOOLS = {
    'xray_pick': (pick, 'Why a learn kept what it kept, or nothing: each learn of the node\'s log with the calls its door took and why, '
                        'every candidate with its score and why it was held back, the pick and its reasons, and the findings. '
                        'Read this first when a learn kept no route or the wrong one.',
                  dict(NODE, last={'type': 'integer', 'description': 'How many of the latest learns (default 3).'},
                       walk={'type': 'string', 'description': 'Only this walk id.'},
                       lines={'type': 'boolean', 'description': 'Also every log line of each learn.'},
                       log={'type': 'string', 'description': 'A node log to read: alone (no ub_dir) for a log from a CI run\'s '
                                                             'qa-node-log-* artifact or a node that is gone.'})),
    'xray_routes': (routes, 'Each route the node keeps: its findings and the engine code they point at (xray.sh --text).',
                    dict(NODE, route={'type': 'string', 'description': 'One route file or id; default all.'})),
    'xray_why': (why, 'What a finding means and the engine functions that write or decide it, resolved to file:line in this '
                      'checkout. Read those functions before naming a cause.',
                 {'finding': {'type': 'string', 'description': 'A finding id, e.g. door-took-the-walk.'}}),
    'xray_diff': (diff, 'What changed between two homes or scratch nodes (before and after a change). new_break is true when the '
                        'second has a break the first had not; paste the text in a handback.',
                  {'before': {'type': 'string'}, 'after': {'type': 'string'}}),
    'xray_live': (live, 'Start the live x-ray page for a scratch node and return its address, for a person to open.',
                  dict(NODE, port={'type': 'integer'})),
}
REQUIRED = {'xray_why': ['finding'], 'xray_diff': ['before', 'after']}


def handle(msg):
    method, mid = msg.get('method'), msg.get('id')
    if method == 'initialize':
        return {'protocolVersion': (msg.get('params') or {}).get('protocolVersion') or PROTOCOL, 'capabilities': {'tools': {}},
                'serverInfo': {'name': 'unbrowse-xray', 'version': '1'}}
    if method == 'tools/list':
        return {'tools': [{'name': n, 'description': d, 'inputSchema': {'type': 'object', 'properties': props, 'required': REQUIRED.get(n, [])}}
                          for n, (_, d, props) in TOOLS.items()]}
    if method == 'tools/call':
        params = msg.get('params') or {}
        entry = TOOLS.get(params.get('name'))
        if not entry:
            raise LookupError('no tool %s' % params.get('name'))
        try:
            got = entry[0](params.get('arguments') or {})
            return {'content': [{'type': 'text', 'text': json.dumps(got, indent=1, ensure_ascii=False)}]}
        except Exception as e:  # the tool's own failure is the answer, said as one
            return {'content': [{'type': 'text', 'text': '%s: %s' % (type(e).__name__, e)}], 'isError': True}
    if method == 'ping':
        return {}
    if mid is None:
        return None
    raise LookupError('no method %s' % method)


def check():
    """The install, proven: the handshake, the tools, and one finding resolved against this checkout's engine."""
    handle({'method': 'initialize', 'id': 1, 'params': {}})
    names = [t['name'] for t in handle({'method': 'tools/list', 'id': 2})['tools']]
    got = why({'finding': 'door-took-the-walk'})
    unresolved = [s['fn'] for s in got['seam'] if not s['at']]
    if unresolved:
        print('XRAY_MCP_BROKEN: WHY names functions this checkout lacks: %s' % ', '.join(unresolved))
        return 1
    print('XRAY_MCP_OK %d tools (%s); findings resolve against %s' % (len(names), ', '.join(names), ROOT))
    return 0


def main():
    if '--check' in sys.argv[1:]:
        sys.exit(check())
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        try:
            result = handle(msg)
            reply = None if msg.get('id') is None else {'jsonrpc': '2.0', 'id': msg['id'], 'result': result}
        except LookupError as e:
            reply = {'jsonrpc': '2.0', 'id': msg.get('id'), 'error': {'code': -32601, 'message': str(e)}}
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + '\n')
            sys.stdout.flush()
    for proc, _ in LIVE.values():
        proc.terminate()


if __name__ == '__main__':
    main()
