# @unbrowse/pollen-cli 🐝

**Bee-themed aliases for [unbrowse](https://www.npmjs.com/package/unbrowse).** Same route/action engine, louder names. Every bin is the full runtime — not a toy wrapper.

```bash
npm i -g @unbrowse/pollen-cli unbrowse@latest
hive setup
forage "top Hacker News stories" --url https://news.ycombinator.com
```

## The swarm (all bins → unbrowse)

| Bin | Vibe | Use when |
|-----|------|----------|
| `pollen` | collect routes from the web | default memey name in demos |
| `waggle` | dance the cache hit to the hive | showing a replay / indexed route |
| `buzz` | fast path — heard it before the browser | cache hits, sub-200ms brags |
| `forage` | find what the site hides behind the DOM | first capture on a new domain |
| `swarm` | many agents, one indexed hive | multi-agent / mesh setups |
| `nectar` | sweet cached API — drink the route | read-heavy agent loops |
| `hive` | home base | `hive setup`, onboarding |

## Flat CLI (same as unbrowse)

| You want | Command |
|---|---|
| One result | `forage "task" --url <url>` or `pollen "task" --url <url>` |
| Health | `hive health` / `pollen health` |
| Resolve (debug) | `pollen resolve --intent "..." --url "..."` |
| Auth | `pollen auth <login_url>` |

```bash
hive setup
forage "homemade food listings with prices" --url https://www.carousell.sg/
swarm "npm express weekly downloads" --url https://www.npmjs.com/package/express
pollen resolve --intent "top stories" --url https://news.ycombinator.com
buzz version
```

## Quiet mode

Install banner is loud on purpose. Shut it up:

```bash
UNBROWSE_BEE_QUIET=1 npm i -g @unbrowse/pollen-cli
```

## Under the hood

Each bin sets `UNBROWSE_BEE_MODE=1` and forwards to `unbrowse`. The hive is `unbrowse@11.x` — this package is marketing + ergonomics, not a fork.

Publish (repo root): `bun run publish:bee`.
