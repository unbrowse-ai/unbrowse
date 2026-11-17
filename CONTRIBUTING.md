# Contributing

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit, with diagrams, and [AGENTS.md](AGENTS.md):
the pipeline, and the rules learned building it. When something breaks locally, start with
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Then
[CLAUDE.md](CLAUDE.md), which every change follows:

**Fixes are general, never written for one site.** A site that breaks is a case of a class. State the fix as a
property of the walk ("a call that sends the walked page's own address is reporting the page"), never as a host,
vendor or path. Site names belong only in tests, as fixtures, and the test is named for the property it checks. Before
you finish, check the fix against a site that isn't the one in front of you.

## Building and testing

Install the toolchain first — Rust, [Foundry](https://getfoundry.sh) (`anvil`), Zig 0.17.0, Bun 1.4.3 and Node 22, the
versions CI pins; the table in the root README's [Run from source](README.md#run-from-source) says which is for what.

Each part builds and tests on its own. CI runs the same commands ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

| Part | Test |
|---|---|
| Browser engine | `cargo test --manifest-path unbrowse-browser/core/Cargo.toml` |
| Browser CLI | `cargo test --manifest-path unbrowse-browser/cli/Cargo.toml` (see [FORK.md](unbrowse-browser/FORK.md) for tests that fail by design) |
| Browser dashboard | `cd unbrowse-browser/packages/dashboard && bun test src` |
| Node | `cd unbrowse-node && sh scripts/apply-tls-patch.sh && cargo test --workspace` (macOS, Linux, Windows) |
| Window | `cd unbrowse-node/window && zig build test` (Zig 0.17; native on macOS, Linux, Windows) |
| TypeScript SDK | `cd unbrowse-sdk/typescript && npm ci && npm test` |
| Python SDK | `cd unbrowse-sdk/python && python -m unittest discover -s tests` |
| Settlement | `cd unbrowse-settlement && forge test` (the contracts live in a private repository; maintainers only) |
| Telemetry worker | `cd unbrowse-telemetry && node --test test/*.test.mjs` |

## Writing code

The rules the rest of the code follows, so a change reads like the code around it.

- **Red to green.** A fix starts as a test that fails on `main` for the reason the bug does, named for the property it
  checks (`a_panic_holding_the_pages_never_takes_the_node_down`, never `test_fix_123`). The pull request names the
  test and says it failed before. If the cause can't be shown, say what was found rather than ship a guess.
- **Rules are pure functions.** Pull a decision out of the code that does I/O into a function a test can call with
  plain values (`chain::claim_due`, `chain::check_due`, `build_config::share_mode`). Settings and the environment
  come in as arguments, so a test never reads the machine it runs on. A rule that several programs share (the agent
  API, the reports' scrub) lives as data each of them is tested against (`agent-api.json`,
  `unbrowse-telemetry/schema.json`).
- **Nothing panics on what it was sent.** Anything from a site, a peer, the chain or a file returns an error that says
  what was wrong and what happens next. `expect` is for what the code itself guarantees, and its message says why
  (`expect("checked in v4_pool")`). Locks are taken with `sync::Locked` and `sync::Shared`, which a panic elsewhere
  can't poison, and a loop the node needs for as long as it runs goes through `sync::keep_running`, which starts it
  again after a panic.
- **One file, one part.** A file opens with a `//!` paragraph saying what it holds and why it's built that way. When
  a file holds several parts, split it along them, as `chain.rs` and `api.rs` are, the parent keeping what the parts
  share and `<name>/tests.rs` the tests. Moving code is a commit of its own, with no change in it.
- **Comments say why.** A doc comment says what the item does and the reason for any choice that isn't obvious: the
  incident, measurement or spec rule behind it (`spec §47.2`, `R6.14`, "Lightpanda reports whole seconds"). Don't
  narrate the code.
- **Commits say what changed for the person using it.** The subject is a sentence about behaviour ("A panic in one
  request no longer breaks every later request that shares its state"), not a file list. The body says why, gives
  the evidence (the failing test, the numbers before and after).
- **Keep the diff to the change.** Don't reformat code you didn't change (the code isn't run through `rustfmt`), don't
  bundle a refactor with a fix, and keep a pull request small enough to explain in one sentence, about 500 changed
  lines. Say in the description why a larger one couldn't be split.
- **Warnings are errors in CI.** `cargo clippy --workspace --all-targets -- -D warnings` runs on the node. Allow a lint
  where it's wrong for that code, at that item, with the reason beside it; one the whole node chooses against goes in
  `[workspace.lints.clippy]` in `unbrowse-node/Cargo.toml`, with its reason.

## Pull requests

- One change per pull request, with a test that fails without it.
- When the node's agent API changes, change both SDKs and both fake nodes in their tests together
  ([unbrowse-sdk/README.md](unbrowse-sdk/README.md)).
- `unbrowse-browser/` stays a thin patch over agent-browser so upstream rebases cleanly. List each change in
  [FORK.md](unbrowse-browser/FORK.md).
- Never commit a capture, HAR, jar or `.env`: walks carry live cookies and tokens. `.gitignore` keeps them out; check
  fixtures by hand.

## Papers and docs

The papers in [`papers/`](papers/README.md) describe a design, as PDF and, for most, Markdown beside it. They change
through pull requests like the code. Where a paper and the code differ, the code is what runs, and the docs in
[`docs/`](docs/README.md) describe the code: every "built" claim names the file and function that does it, and what
isn't built says so in a line. Write plainly: say what a thing does, read from its own behaviour, with no promise
of returns and no claim the code doesn't make good.

## Review and QA by Claude

Every pull request that isn't a draft gets two more checks, beside CI:

- **Claude review** ([claude-review.yml](.github/workflows/claude-review.yml)) reads the change for bugs and comments
  on the lines concerned. It reads code; it doesn't run it.
- **Claude QA** ([qa.yml](.github/workflows/qa.yml)) runs it. A node built from the pull request starts on a Mac, and
  Claude uses it as an agent would, through its MCP tools, working through
  [.github/qa/checklist.md](.github/qa/checklist.md). It learns and calls a route, browses a page that needs hands,
  signs in from the vault without seeing the password, and tries what the node must refuse. The report goes on the
  pull request, and a failing check fails the job. When a change adds something an agent can do, add a check for it.

Both need a Claude credential as a repository secret (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) and the Claude
GitHub App; `/install-github-app` in Claude Code sets up both. For a deeper review before a big merge, run
`/code-review ultra <PR#>` from Claude Code.

## Branches and releases

Three kinds of branch, each taking changes by squash-merged pull request alone, with CI passing:

| Branch | Holds | Takes | Releases ([release.yml](.github/workflows/release.yml)) |
|---|---|---|---|
| `staging` (the default) | day-to-day work | pull requests from `feat/…`, `fix/…` branches cut from it | every commit CI passes, as `X.Y.0-staging.N` on npm's `staging` tag |
| `release/X.Y` | a release candidate: no new features | `fix: …` pull requests, once it is cut from `staging` | every commit CI passes, as `X.Y.P-rc.N` on npm's `next` tag and on canary |
| `main` | shipped releases only, one commit each | a pull request from `release/X.Y` alone | a `vX.Y.Z` tag on it: npm's `latest`, the GitHub release, canary then stable |

Nothing is branched from `main` and nothing flows back from it.

- **Day to day.** Branch from `staging`, open a pull request into it, squash-merge it once CI passes.
- **Cutting a release.** When `staging` is ready, push `release/X.Y` from it (the next minor: `release/13.19` after
  `v13.18.x`). From then on it takes fixes alone.
- **A fix during a release.** Branch from `release/X.Y` and open a pull request back into it. Once it is merged,
  cherry-pick its commit onto `staging` in a pull request of its own, titled `fix: … (from release/X.Y)`. The release
  isn't done until every fix is back on `staging`, or the bug comes back in the next one.
- **Shipping.** Open a pull request from `release/X.Y` into `main` and squash-merge it; on a conflict the release
  branch's side wins, since `main` must be what was tested, and the diff is reviewed on the release branch, not there.
  Then tag the merge commit and push the tag: `git tag v13.19.0 origin/main && git push origin v13.19.0`. The tag is
  what releases, and the release refuses one whose tree isn't `release/X.Y`'s. Keep the release branch.
- **Fixing a shipped release.** Fix it on its `release/X.Y` as above, cherry-pick included, then ship it the same way,
  tagged `vX.Y.1` and up.

The version is semantic, and comes from the ref ([release-version.sh](.github/scripts/release-version.sh)): a release
branch is `release/MAJOR.MINOR`, its first tag `vMAJOR.MINOR.0` and its fixes the patches above. Raise the major in
the branch's name when a change breaks the agent API, the SDKs or what the node keeps on disk. The tag is the only
place the version changes: the build stamps it into the node, `Unbrowse.app` and both SDK packages, and the manifests
in the tree stay at `0.1.0`.

[main-source-guard.yml](.github/workflows/main-source-guard.yml) fails a pull request into `main` from anything but a
release branch, and one into a release branch not titled `fix:`. GitHub's plan for this repository can't make a check
required or protect a branch, so the person merging keeps these rules.

## Licence

Contributions are licensed under [Apache-2.0](LICENSE), as section 5 of the licence says, with no separate agreement.
