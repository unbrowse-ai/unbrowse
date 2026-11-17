#!/usr/bin/env python3
"""Extract the challenge's string table straight from an orchestrate build.

The table ships as `~`-separated runs of reversed strings, split across
fragments in the source. Reassemble in source order, reverse each entry, and
the build's whole vocabulary is readable without running anything.

Verifier against the captured wire format: the table holds the 49 static
$-pairs' names and every DOM/API word the code uses (document, body,
querySelector, iframe, contentWindow, parentNode, ...).

Usage: table-extract.py <orchestrate.js> [index...]
Indices print with offsets 0..9 scanned, since each build's decoder subtracts
its own base.
"""
import re
import sys

src = open(sys.argv[1]).read()
frags = sorted(
    (m.start(), m.group(0))
    for m in re.finditer(r'[A-Za-z0-9_$~=\-\+/\.]{150,}', src)
    if m.group(0).count('~') > 20
)
joined = []
for _, frag in frags:
    joined.extend(frag.split('~'))
decoded = [w[::-1] for w in joined]
print(f'table entries: {len(decoded)} from {len(frags)} fragments', file=sys.stderr)

want = ['document', 'body', 'querySelector', 'iframe', 'img', 'parentNode',
        'contentWindow', 'contentDocument', 'createElement', 'documentElement']
for w in want:
    pos = [i for i, x in enumerate(decoded) if x == w]
    if pos:
        print(f'{w:18}: {pos[:6]}', file=sys.stderr)

for arg in sys.argv[2:]:
    i = int(arg)
    for off in range(0, 10):
        if 0 <= i - off < len(decoded):
            print(f'idx {i} off {off}: {decoded[i - off]!r}')
