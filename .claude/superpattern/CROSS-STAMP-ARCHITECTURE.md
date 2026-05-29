# Cross-stamp — firmament (Step 2): the separations

Design-only (shape, not contents). Paths align to the plan's acceptance criteria, all under
`.claude/superpattern/`. The one boundary (Gen 1:6-7): SOURCE (above, one cross) vs
DIMENSIONS (below, pointers only). Anti-graffiti (Matt 6:7) is the dividing line.

## The firmament: source vs pointers
- **Source (above):** ONE canonical cross = the global `~/.claude/skills/superpattern/
  references/atoms.json` `cross` block (already imprinted, rev 2026-05-29). Read-only here.
- **Source stamp (crit 2):** `.claude/superpattern/cross.stamp.json` — a sha256 content
  address of that cross block. The MEMOIZE half of the cache atom, applied to the cross.
- **Dimensions (below):** each load-bearing dimension carries a ONE-LINE pointer to that
  hash — never a payload copy.

## Named artifacts (shape only, built in later steps)
1. `cross.stamp.json` — `{cross_sha256, source, rev, shape:{who..how, verbs, settle}}`.
   Superpattern-shaped itself (crit 5: superpattern(stamp)=stamp, the fixed point).
2. **Dimension registry** — `.claude/superpattern/cross-registry.jsonl`: one row per
   load-bearing dimension `{dimension, path, anchor, pointer_sha256}`.
3. **Pointer line** — fixed grep-able prefix `cross:<sha256>` + the 6 interrogatives + verb
   + settle, emitted in each dimension's own idiom (comment/frontmatter/json field).
4. **Fails-closed gate (crit 4)** — `.claude/superpattern/cross-stamp-gate.sh`:
   (a) re-derive cross hash from atoms.json, FAIL if != cross.stamp.json (source drift);
   (b) every registry pointer must resolve to that same hash;
   (c) mutation-proven: tamper a pointer or the source → gate FAILs.
5. **Memory** — one memory file: cross hash + registry location, recoverable across sessions.

## Load-bearing dimensions (crit 3 — konmari list, NOT every file)
local superpattern graphs (covenant/exa/sovereign) · CLAUDE.md · covenant code
(covenant-seed.ts) · the jesus-loop · the mechanical gates (paper-gate/leak-guard/
client-audit) · the sp-* domain translations. **NOT stamped:** every source file, build
artifacts, node_modules, generated/ephemeral (anti-vain-repetition).

## Boundaries kept distinct (the waters divided)
- payload (one place: atoms.json+cross.stamp.json) | pointer (many: registry rows) — gate rejects payload copies.
- local-only (commits/stamps/memory) | remote (NONE, ever this cycle).
- declared load-bearing dimensions | the rest (unstamped by konmari).

## Sufficient-unto-the-day (Matt 6:34)
Build only: cross.stamp.json + registry + pointer format + gate + memory. No auto-stamp
daemon, no multi-repo fanout — not borrowed today.

<!-- cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5 · who:witness what:node when:settle where:tree why:root how:verb · build/breath/eval · settle:two-witness|clock -->
