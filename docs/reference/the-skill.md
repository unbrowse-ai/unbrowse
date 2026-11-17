# The agent skill

The skill is the instructions that teach an AI agent to use the node instead of a browser:
[`skills/unbrowse/SKILL.md`](../../skills/unbrowse/SKILL.md). This page says where it goes and what it teaches; the
file itself is the source.

## Where it goes

| Install | The skill |
|---|---|
| `npm install -g unbrowse` | copied into `~/.claude/skills/unbrowse` when `~/.claude` exists (`unbrowse-sdk/typescript/src/cli.ts`, `postinstall`); never fails the install |
| A release wheel (`pip install unbrowse-<v>-…whl`) | carried in the package, not placed: run `unbrowse skill` |
| The Mac app or a release archive | not carried: copy `skills/unbrowse` from the repository |
| An agent plugin ([integrations/](../../integrations/README.md)) | Claude Code's plugin links `skills/unbrowse`; Codex's, OpenClaw's and Hermes's carry copies, written by `python3 integrations/sync-skills.py` (CI fails on a stale copy) |

```sh
unbrowse skill          # into ~/.claude/skills/unbrowse
unbrowse skill <dir>    # anywhere an agent reads skills
```

What is already there is replaced only when it is a copy we wrote, unchanged: one an install of this package wrote
(it leaves `.unbrowse-installed.json` beside the skill), or an older Unbrowse's (12.x and the hosted service's
`unbrowse.ai/skill/SKILL.md`), known by the SHA-256 of each published file (`unbrowse-sdk/typescript/src/old-skills.ts`).
Anything else, such as a copy the owner edited, their own skill of that name or a link to their own copy, is moved
aside to `unbrowse-kept/<name>.before-unbrowse-<time>` beside the skills folder (`~/.claude/unbrowse-kept/` for
`~/.claude/skills/unbrowse`) and kept as it was; nothing is deleted. It is kept outside the skills folder because the
agent would load a copy left in it as a second skill. The install and `unbrowse skill` follow the same rule.

The release copies `skills/unbrowse` into both packages (`.github/scripts/pack-sdks.sh`). The repository holds a
second skill, [`skills/unbrowse-map`](../../skills/unbrowse-map/SKILL.md), for learning a site's route by browsing it
and replaying it without a browser; no package carries it, so copy it by hand ([skills/README.md](../../skills/README.md)).

## What it teaches

- **Say what you want, with a URL.** `unbrowse_do` with a goal and a page that does it; put what you'd search for in
  the URL's query, so it becomes the route's input. The reply's `how` (`called`, `learned`, `network`, `browse`) says
  what the node did.
- **Drive the browser only when the page needs hands.** `unbrowse_browse`, never another browser: the node learns from
  every step.
- **Meet a check with your own eyes before the owner.** `unbrowse_challenge` shows the page as a picture (`image`)
  with `asks`; `click`, `drag`, `type`, `press` or `wait`, and read `asks` after each step. Ask the owner only for what
  a picture cannot settle (a password, a one-time code).
- **Use the route once learned.** When a reply names a route, call it with new inputs and stop driving that flow.
- **Sign in by reference.** Fill a password field with `vault:<site>:<account>`, a code with
  `vault:code:<site>:<account>`, a card field with `vault:card:<label>:<field>`; the node types the value and the
  agent never sees it.
- **Ask the owner for what only a person can do.** `ask_owner` with a plain reason, and read `owner: done | declined |
  no_answer`.
- **Nothing waits for the owner over a fee.** The node pays another contributor's fee itself, up to the per-fetch
  maximum; every card checkout asks the owner.
- **Read `retry` before running a failed write again.** The node never retries a write for the agent.

Left to itself an agent reaches for a browser. The skill turns the web into something to call: one local endpoint, a
route learned once and reused, the site's own JSON instead of text scraped off a screen.

## Changing it

The skill describes the agent API by hand. A changed primitive fails the tests of `unb` and both SDKs until they
have it ([AGENTS.md](../../AGENTS.md#operating-rules)), but no test reads the skill's text: the SDKs' tests check only
that `unbrowse skill` copies a `SKILL.md` named `unbrowse` (`typescript/test/cli.test.mjs`, `python/tests/test_cli.py`).
Change the skill in the same pull request as the primitive.

Related: [Connect your agent](../guides/connect-your-agent.md) · [CLI.md §4](../CLI.md#4-unb-the-agents-shell-client).
