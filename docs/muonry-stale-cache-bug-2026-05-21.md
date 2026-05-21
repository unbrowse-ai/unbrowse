# muonry MCP daemon stale-cache bug (2026-05-21)

Observed against muonry binary at `/Users/lekt9/bin/muonry`
(Mach-O 64-bit arm64, 1.8MB, mtime 2026-05-12 13:30).

## Summary

`mcp__muonry__read` (and the equivalent pipe-mode `{"tool":"read"}`)
returns an in-process cached snapshot of a file when the file has been
modified by something OTHER than muonry between two reads in the same
daemon session. The default flags do not re-stat or invalidate the
cache.

The bypass flags `live: true` and `fresh: true` are wired correctly and
return the on-disk content. The bug is that they are NOT the default,
so any agent that does not know to set them will silently read stale
content.

This is a correctness failure, not a perf hint: the response carries no
`stale: true` marker, no `cached_at` timestamp, no warning. The agent
has no in-band signal that the bytes it read are 97 lines behind disk.

## Observed reproduction context

- Wave-3 corpus expansion (PR #656): the agent extending
  `harness/probes/corpus-gate.txt` from ~90 lines to 180+ lines via
  muonry edits saw later `mcp__muonry__read` calls return the original
  92-line snapshot. Manual `cat`/`wc` calls on the same file via Bash
  showed the live 180+ lines.
- Wave-4 corpus expansion (PR #657): same file, different absolute
  size, same symptom. The cached snapshot returned was different from
  wave-3's stale view, consistent with a per-session cache key.

In both cases the corpus file was being appended to outside the muonry
process (some appends came from peer agents, some from direct shell
writes). The muonry daemon's cached read was from an earlier point in
the session and was not invalidated when the file changed underneath
it.

## Falsifier

`scripts/muonry-cache-falsifier.sh` reproduces it deterministically in
one shot:

1. Boot a long-lived muonry pipe daemon.
2. Write 100 lines to a temp file.
3. Read the file via the daemon (priming).
4. Append 100 lines directly on disk (no muonry write call).
5. Read three more times:
   - default flags
   - `live: true`
   - `fresh: true`
6. Report newline counts for each.

### Observed output (2026-05-21)

```
disk_newlines_final=200
read1_default_newlines=103   (priming read; before append)
read2_default_newlines=103   (after append, no flags)
read3_live_newlines=200      (after append, live=true)
read4_fresh_newlines=203     (after append, fresh=true)

CONFIRMED stale-cache on default read: returned 103 newlines vs disk 200 (gap = 97)
```

(read1/read2 = 103 because the default `mode: full` response embeds a
3-line zigread banner before the 100 line bodies; read3 is raw 200 line
bodies; read4 includes a separate banner.)

The 97-line gap between `read2_default_newlines` and
`disk_newlines_final` is the bug, byte-for-byte the same shape as the
wave-3/wave-4 reports.

## Expected vs actual behaviour

| Read     | Expected newlines | Actual | Verdict |
|----------|-------------------|--------|---------|
| default  | 200 (disk)        | 100    | stale   |
| live     | 200 (disk)        | 200    | live    |
| fresh    | 200 (disk)        | 200    | live    |

Either of the following would fix it:

- Default behaviour stats the file before returning cached content, and
  invalidates when mtime or size differs.
- Default behaviour returns a `stale: true` indicator with a way for
  the caller to opt in to the in-memory copy. Silent staleness is the
  bug, regardless of which direction the default goes.

## Workaround agents are using today

- Pass `live: true` on every `mcp__muonry__read` call against a file
  that may be edited concurrently (corpus files, sprint ledgers,
  iteration logs, anything appended to by peer agents or shell jobs).
- Pass `fresh: true` when you want the cache entry itself replaced (not
  just bypassed for this one read).
- Where neither flag is reachable from the calling surface, agents are
  bypassing muonry entirely and going through `Bash` with `wc`, `awk`,
  or `sed`, which is what the wave-3 and wave-4 agents fell back to.

## Recommended fix (one-line summary, no implementation speculation)

Make the default read path either stat-validate the cache entry or
return a `stale: true` field. Either change makes the symptom
impossible without requiring every caller to remember a flag.

## Guard

`scripts/muonry-cache-falsifier.sh` is checked in. Run it whenever the
muonry binary updates:

```bash
bash scripts/muonry-cache-falsifier.sh
```

Exit 0 means the documented contract still holds (default = stale,
live = live, fresh = live). Exit 1 means either:

- `live` or `fresh` regressed and now return stale content (red alarm).
- The default flag now returns live content (good; retire the
  workaround in agent prompts).

Either branch is informative; the script logs which one fired.
