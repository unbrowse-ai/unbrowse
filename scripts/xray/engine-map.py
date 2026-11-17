#!/usr/bin/env python3
"""Reads the engine's source and writes who decides what a value is: for each kind a value can be, the functions that
write it and the functions that branch on it, each with its file and line, who calls it, and how long it is.

  engine-map.py <name>=<tree> [<name>=<tree> ...] > engine-map.json

<tree> is a checkout or an export holding unbrowse-node/ (xray.sh exports the branches). <name> is what the x-ray calls
it: `running` for the engine that learns routes today, `rebuild` for the tree. Three families of kind are read:

  Class::X   the running engine's flat kinds (crates/learn/src/graph.rs)
  Kind::X    what the rebuild's learner says a place turned out to be (crates/learn/src/lab/synth.rs)
  Expr::X    the rebuild's expressions (crates/route/src/expr.rs)
  Held       the running engine's record of a caller's word inside a longer value

Everything is read from the source text with comments, strings and test modules left out; nothing is kept from memory,
so a function that was renamed or removed is simply not found, and the x-ray says so beside the finding that named it.
A kind is "written" where the source builds a value of it and "read" where it matches on one; the split is made from
the text around each mention (a mention before `=>`, after `if let`, inside `matches!`, or compared with `==` is a
read), so a count is close, not exact.
"""
import json, os, re, sys

RAW = re.compile(r'b?r(#*)"')
CHAR = re.compile(r"'(\\.[^']*|[^'\\])'")


def code_only(s):
    """The source with comments and the insides of strings and char literals blanked, positions kept."""
    out, i, n = [], 0, len(s)
    blank = lambda t: ''.join(c if c == '\n' else ' ' for c in t)
    while i < n:
        c = s[i]
        if s.startswith('//', i):
            j = s.find('\n', i)
            j = n if j < 0 else j
            out.append(' ' * (j - i)); i = j; continue
        if s.startswith('/*', i):
            depth, j = 1, i + 2
            while j < n and depth:
                if s.startswith('/*', j): depth += 1; j += 2
                elif s.startswith('*/', j): depth -= 1; j += 2
                else: j += 1
            out.append(blank(s[i:j])); i = j; continue
        if c in 'br' and (i == 0 or not (s[i - 1].isalnum() or s[i - 1] == '_')):
            m = RAW.match(s, i)
            if m:
                end = '"' + m.group(1)
                j = s.find(end, m.end())
                j = n if j < 0 else j + len(end)
                out.append(blank(s[i:j])); i = j; continue
        if c == '"':
            j = i + 1
            while j < n:
                if s[j] == '\\': j += 2; continue
                if s[j] == '"': j += 1; break
                j += 1
            out.append('"' + blank(s[i + 1:j - 1]) + '"' if j - i >= 2 else s[i:j]); i = j; continue
        if c == "'":
            m = CHAR.match(s, i)
            if m:
                out.append(' ' * (m.end() - i)); i = m.end(); continue
        out.append(c); i += 1
    return ''.join(out)


def close_of(code, open_at, pair='{}'):
    depth = 0
    for j in range(open_at, len(code)):
        ch = code[j]
        if ch == pair[0]: depth += 1
        elif ch == pair[1]:
            depth -= 1
            if depth == 0: return j
    return len(code) - 1


TEST_MOD = re.compile(r'#\[cfg\(test\)\]\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+\w+\s*\{')


def without_tests(code):
    out, at = [], 0
    for m in TEST_MOD.finditer(code):
        if m.start() < at: continue
        end = close_of(code, m.end() - 1)
        out.append(code[at:m.start()])
        out.append(''.join(c if c == '\n' else ' ' for c in code[m.start():end + 1]))
        at = end + 1
    out.append(code[at:])
    return ''.join(out)


FN = re.compile(r'\bfn\s+([A-Za-z_][A-Za-z0-9_]*)')


def functions(code):
    found = []
    for m in FN.finditer(code):
        depth, j, body = 0, m.end(), None
        while j < len(code):
            ch = code[j]
            if ch in '([': depth += 1
            elif ch in ')]': depth -= 1
            elif ch == '{' and depth == 0: body = j; break
            elif ch == ';' and depth == 0: break
            j += 1
        if body is None: continue
        found.append({'name': m.group(1), 'start': m.start(), 'body': body, 'end': close_of(code, body)})
    return found


FAMILIES = ('Class', 'Kind', 'Expr')
MENTION = re.compile(r'\b(Class|Kind|Expr)::([A-Z][A-Za-z0-9]*)\b')
HELD = re.compile(r'\bHeld\s*\{')
CALL = re.compile(r'\b([a-z_][a-z0-9_]*)\s*\(')
# A name too common to trace to one function of ours by its name alone.
COMMON = set('new default get len iter map filter find any all push insert contains clone into from parse ok err next last first count collect extend join split '
             'trim lines keys values remove sort cmp eq hash fmt write read send set path url host name value text body status method then call run start stop step '
             'steps fields field inputs input kind id index at of with by to on open close'.split())


def is_read(code, start, end):
    """Whether the mention of a kind at code[start:end] is a pattern (a branch on it) and not a value being built."""
    j = end
    while j < len(code) and code[j] in ' \n\t': j += 1
    if j < len(code) and code[j] in '{(':
        j = close_of(code, j, '{}' if code[j] == '{' else '()') + 1
    while j < len(code) and code[j] in ' \n\t)': j += 1
    after = code[j:j + 4]
    if after.startswith('=>') or (after.startswith('|') and not after.startswith('||')) or re.match(r'if\b', after): return True
    if after.startswith('==') or after.startswith('!='): return True
    k = start
    while k > 0 and code[k - 1] not in ';{}': k -= 1
    before = code[k:start]
    if '=>' in before: before = before.rsplit('=>', 1)[1]
    if re.search(r'\b(if|while)\s+let\s+[^=]*$', before) or re.search(r'\blet\s+[^=]*$', before): return True
    if re.search(r'matches!\s*\([^;]*,[^;]*$', before): return True
    stripped = before.rstrip()
    if stripped.endswith('|') and not stripped.endswith('||'): return True
    if stripped.endswith('==') or stripped.endswith('!='): return True
    return False


def read_tree(root):
    base = os.path.join(root, 'unbrowse-node')
    files = []
    for folder in ('crates/learn/src', 'crates/route/src', 'app/src'):
        for d, _, names in os.walk(os.path.join(base, folder)):
            for n in sorted(names):
                rel = os.path.relpath(os.path.join(d, n), base)
                if n.endswith('.rs') and '/tests/' not in rel and not rel.endswith('/tests.rs') and '/bin/' not in rel and not rel.endswith('lab/corpus.rs'):
                    files.append(rel)
    fns, writes, reads, by_name, texts = {}, {}, {}, {}, {}
    for rel in files:
        with open(os.path.join(base, rel), encoding='utf-8', errors='replace') as fh: src = fh.read()
        code = without_tests(code_only(src))
        found = functions(code)
        line_of = lambda at: code.count('\n', 0, at) + 1

        def owner(at):
            inside = [f for f in found if f['body'] <= at <= f['end']]
            return max(inside, key=lambda f: f['start']) if inside else None

        for f in found:
            key = '%s::%s' % (rel, f['name'])
            if key in fns: key = '%s@%d' % (key, line_of(f['start']))
            f['key'] = key
            inner = [g for g in found if g is not f and g['start'] > f['body'] and g['end'] <= f['end']]
            own = list(code[f['body']:f['end'] + 1])
            for g in inner:
                for k in range(g['start'] - f['body'], g['end'] + 1 - f['body']):
                    if own[k] != '\n': own[k] = ' '
            texts[key] = ''.join(own)
            fns[key] = {'file': rel, 'name': f['name'], 'line': line_of(f['start']), 'lines': code.count('\n', f['start'], f['end']) + 1, 'callers': [], 'writes': [], 'reads': []}
            by_name.setdefault(f['name'], []).append(key)
        mentions = [(m.start(), m.end(), '%s::%s' % (m.group(1), m.group(2))) for m in MENTION.finditer(code)]
        # `Held` is the learner's record only where the file is the graph's own or brings it in from there.
        holds = rel.endswith('learn/src/graph.rs') or re.search(r'\buse\b[^;]*\bHeld\b', code) or 'graph::Held' in code
        for m in HELD.finditer(code if holds else ''):
            before = code[max(0, m.start() - 12):m.start()]
            if re.search(r'(struct|impl|for|->|:|&)\s*$', before): continue
            mentions.append((m.start(), m.start() + 4, 'Held'))
        for start, end, kind in mentions:
            f = owner(start)
            if not f: continue
            read = kind != 'Held' and is_read(code, start, end)
            book = reads if read else writes
            book.setdefault(kind, []).append({'fn': f['key'], 'line': line_of(start)})
            row = fns[f['key']]['reads' if read else 'writes']
            if kind not in row: row.append(kind)
    # Who calls whom, by name: a call is traced where one function of ours has the name, or the caller's own file does.
    for key, text in texts.items():
        rel = fns[key]['file']
        for m in CALL.finditer(text):
            name = m.group(1)
            cands = by_name.get(name)
            if not cands or name in COMMON: continue
            same = [c for c in cands if fns[c]['file'] == rel]
            to = same[0] if same else (cands[0] if len(cands) == 1 else None)
            if to and to != key and key not in fns[to]['callers']: fns[to]['callers'].append(key)
    return {'fns': fns, 'writes': writes, 'reads': reads, 'files': len(files)}


def main():
    out = {}
    for arg in sys.argv[1:]:
        name, _, root = arg.partition('=')
        if not root or not os.path.isdir(os.path.join(root, 'unbrowse-node')):
            sys.exit('engine-map.py: %s is no tree holding unbrowse-node/' % arg)
        out[name] = read_tree(root)
        tip = os.path.join(root, 'TIP')
        out[name]['tip'] = open(tip).read().strip() if os.path.exists(tip) else ''
    if not out: sys.exit(__doc__)
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
