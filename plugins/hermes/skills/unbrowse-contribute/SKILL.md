---
name: unbrowse-contribute
description: Use whenever Unbrowse itself misbehaves - the unbrowse CLI, SDK, stdio MCP proxy or an agent plugin crashes, prints "looks like an Unbrowse bug", exits with the wrong code, ignores a documented flag, or its docs and skill describe something that does not happen; or the hosted service answers 5xx or returns a wrong or empty result for a site it lists. Reproduces it, checks for an existing issue or PR, and opens a fix PR to github.com/unbrowse-ai/unbrowse (or an issue for the hosted side), with the person's OK. Also use for "report this to Unbrowse", "file a bug", "send the fix upstream".
---

# Fix Unbrowse when it breaks

Unbrowse's client is open source. When it breaks in your hands, you hold the best bug report anyone
will ever write: the exact command, the exact output and the code one `gh` away. Turn it into a fix
the maintainers can merge, then carry on with the person's task.

## 1. Is it Unbrowse's fault?

Not bugs (follow the `unbrowse` skill instead):

- Exit `2` input required, `3` sign-in or site login needed, `4` not verified.
- `no_capability`, a quota or credit error, `model_unavailable` on an index job.
- The site's own 4xx, a CAPTCHA, or an input you got wrong.

Bugs:

- The CLI prints "This looks like a bug in Unbrowse", a stack trace or a `TypeError`.
- An HTTP 5xx from `https://unbrowse.ai`, repeatable after one retry.
- A documented command, flag, exit code or output field that does not behave as the docs say
  (`unbrowse help`, `docs/cli.md`, the `unbrowse` skill).
- A plugin hook that blocks a call it should allow, or lets through one it should redirect.
- A verified result that is wrong for a site Unbrowse lists (`unbrowse site <host>`).

## 2. Write the report

```sh
unbrowse bug "expected X, got Y"          # markdown: version, OS, Node, the last failure (secrets masked)
unbrowse bug --json "expected X, got Y"   # the same as JSON
```

The CLI keeps its last unexpected failure, redacted, in its config folder; `unbrowse bug` reads it.
Add the shortest command that reproduces the problem. Never paste a token, cookie, password,
customer data or a captured page body; replace them with `<redacted>`.

## 3. Check it is new

```sh
gh issue list -R unbrowse-ai/unbrowse --state all --search "<two or three words from the error>"
gh pr list -R unbrowse-ai/unbrowse --state all --search "<same words>"
```

Already reported: add your reproduction as a comment only if it adds something (another version or
OS, a shorter repro). Do not open a duplicate.

## 4. Ask once

Opening an issue or PR publishes under the person's GitHub account, so ask before the first one in a
session, in one line:

> Unbrowse's CLI has a bug: `<one line>`. I can reproduce it and have a fix with a test. Open a PR to
> unbrowse-ai/unbrowse from your GitHub account?

Skip the question only when the person already said yes in this session, or `UNBROWSE_AUTO_PR=1` is
set. If they say no, or `gh auth status` fails, hand them the report and
https://github.com/unbrowse-ai/unbrowse/issues/new, then carry on.

## 5. Client bug: open a fix PR

The CLI, SDK, MCP proxy, plugins and docs live in the public repo. Work in a temporary folder, never
inside the person's project:

```sh
cd "$(mktemp -d)"
gh repo fork unbrowse-ai/unbrowse --clone -- --depth 50
cd unbrowse && git switch -c fix/<short-name>
bun install
```

1. Read `AGENTS.md`, then the nearest `MODULE.md`.
2. Write the failing test first, next to the code: `packages/cli/tests/`, `packages/sdk/tests/`,
   or `tests/plugins.test.ts` for hooks and plugins. Run it and watch it fail.
3. Fix the cause, not the symptom. Keep the change to the one bug.
4. Prove it. All of these must pass, and the PR quotes the markers:

   ```sh
   bun test ./packages ./tests
   bun run typecheck
   bun run check:plugins     # PLUGIN_SKILLS_OK
   bun run check:public      # PUBLIC_SURFACE_OK
   ```

5. Commit with a Conventional Commit (`fix(cli): …`, `fix(plugins): …`, `docs: …`), push to the
   fork and open the PR:

   ```sh
   gh pr create -R unbrowse-ai/unbrowse --title "fix(cli): <what now works>" --body-file pr.md
   ```

   `pr.md` follows `.github/pull_request_template.md`: the person's problem, the repro command and
   its output before the fix, the cause, the change, the new test and the markers above.

Do not edit upstream-owned files (`skill/SKILL.md`, `skill/references/tools.json`,
`packages/sdk/src/mcp-install.ts`, `docs/public-surface.json`): `check:public` rejects it. A bug
there is an issue, not a PR.

## 6. Hosted bug: open an issue

The server is not in this repo. Open an issue with the report, the `runId` or index `jobId`, the
time (UTC) and the shortest repro:

```sh
gh issue create -R unbrowse-ai/unbrowse --title "hosted: <what failed>" --body-file report.md
```

## 7. Then

Tell the person in one line, with the link. Go back to their task: use the workaround you found,
or say plainly what is blocked. One bug per issue or PR. Never more than one PR per bug.
