# Skills

Agent skills for Unbrowse. Copy a folder into your agent's skills directory (for Claude Code, `~/.claude/skills/`).

| Skill | For |
|---|---|
| [`unbrowse`](unbrowse/SKILL.md) | Using websites through the node: `unbrowse_do`, driving the node's browser when a page needs hands, calling routes |
| [`unbrowse-map`](unbrowse-map/SKILL.md) | Learning a site's route by browsing it, then replaying it without a browser |
| [`verify-unbrowse`](verify-unbrowse/SKILL.md) | For contributors: proving a change to this repository works on a scratch node built from the checkout (`scripts/unbrowse-verify`, and a map of every feature to drive) |

The first two expect a running node and an agent key; `verify-unbrowse` builds and starts its own ([unbrowse-node/README.md](../unbrowse-node/README.md)).

## Licence

[Apache-2.0](../LICENSE).
