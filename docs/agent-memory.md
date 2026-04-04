# Agent Memory

Deprecated. Durable agent memory now lives in [AGENTS.md](/Users/lekt9/.codex/worktrees/18ba/unbrowse/AGENTS.md).

- Long-running workflows: publish admitted roots plus DAG-linked readable/mutable steps as standalone callable endpoints, so later agents can resume or invoke a single step without replaying the whole flow.
- Exact-URL search resolves should auto-fallback to live capture when cached/marketplace skills do not expose the same explicit search binding (for example `?q=`); Lewis does not want `--force-capture` as the normal recovery path for obvious cache misses.
