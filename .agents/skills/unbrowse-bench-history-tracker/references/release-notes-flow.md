# Release Notes Flow

The repo's release flow uses `release-it` with a `.release-notes.md` file written before each release.

## Where the bench block goes

Add a `## Bench` section to `.release-notes.md` between `## What's New` and `## Fixes`. The skill's `release-notes` command emits the markdown body for that section.

## Generation

```bash
bun run bench:history:release-notes --since <prev-tag-or-run-id>
```

Output looks like:

```markdown
### Bench coverage

- index_coverage: 46.5% (20/43) up from 37.8% (14/37)
- retrieve_coverage: 41.9% (18/43) up from 36.8% (14/38)
- anchor lane: 11/11 (regression-free)

### Newly passing probes

- 017_semantic-rank_https___stackoverflow_com_questions_231767
- 027_ssr-list_https___www_bing_com_search_q_AI+agents
- 055_hostile_https___www_espn_com_nba_scoreboard (suspicious - hostile lane)

### Notes

- Detail-intent rank clamp now covers questions, articles, posts, scores.
- HTML metadata fallback when DOM extraction returns empty.
```

The notes paragraph at the bottom comes from the comment field of every recorded run since `--since`.

## What lives where

| Surface | Owner | Purpose |
|---|---|---|
| `.bench-history/bench-gate-runs.jsonl` | this skill | append-only ledger |
| `.release-notes.md` | release author | release notes file consumed by release-it |
| `CHANGELOG.md` | release-it via conventional-changelog | per-version log written by release-it |

## Don'ts

- Do not write to `CHANGELOG.md` directly. release-it owns that file.
- Do not invent coverage numbers in the markdown body. They must come from gate.json sourced rows.
- Do not collapse multiple runs into one row. The ledger is per-run.
