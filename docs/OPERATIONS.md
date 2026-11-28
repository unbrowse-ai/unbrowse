# Operations

The operator's runbook: how a release is built and cut, how a network's contracts are deployed and recorded, how the
landing site is set up, what CI runs, how to keep a node running as a service, which wallets to
fund, and what to check before going live. Written for whoever runs the Unbrowse network, not for a node's owner
(the owner's path is [MONEY.md](MONEY.md) §5 and the node's [README](../unbrowse-node/README.md)).

Every command here names what it reads and writes. Facts about GitHub's and Cloudflare's live state were read on
30 October 2026 with read-only calls (`gh api`, `gh run list`, `npm view`), and are marked as such.

- [1. Build-time flags](#1-build-time-flags)
- [2. Cutting a release](#2-cutting-a-release)
- [3. Deploying a network's contracts](#3-deploying-a-networks-contracts)
- [4. No sponsor](#4-no-sponsor)
- [5. The landing site](#5-the-landing-site)
- [6. CI](#6-ci)
- [7. Running a node as a service](#7-running-a-node-as-a-service)
- [8. The wallets to fund](#8-the-wallets-to-fund)
- [9. Go-live checklists](#9-go-live-checklists)
- [10. Known gaps](#10-known-gaps)

---

## 1. Build-time flags

A fresh install's defaults are fixed when the node is built ([`build_config.rs`](../unbrowse-node/app/src/build_config.rs)).
A plain `cargo build` sets none of them. Each is a default only: a `settings.json` the owner already has keeps what it
says, and the run-time variables still win. A value the node couldn't take fails the build (`const` asserts), so a
release never ships a default it would refuse. An empty value is unset, so a repository variable nobody set changes
nothing.

| Flag | Fresh install's | Unset | Accepted values | Run-time override |
|---|---|---|---|---|
| `UNBROWSE_DEFAULT_CHAIN` | chain | `devnet` | `devnet`, `arc-testnet`, `arc-mainnet` | `UNBROWSE_CHAIN`, or `unbrowse-node chain <name>` |
| `UNBROWSE_SITE` | site for sign-in, relay and node log | none: `https://unbrowse.ai`, then `https://unbrowse.si` | `https://host[:port]`, no path; `http://` only for 127.0.0.1 or localhost | `UNBROWSE_SITE`, tried first (`link::sites`) |
| `UNBROWSE_SHARE_DEFAULT` | `share_routes` | `used` | `used`, `all`, `off` | Settings, or `unbrowse-node share used\|all\|off` |
| `UNBROWSE_RELEASE` | self-update and the network minimum version | off | set (`release.yml` sets `1`) | none; the `auto_update` setting turns updating off |

`UNBROWSE_RELEASE` is read in [`update.rs`](../unbrowse-node/app/src/update.rs) (`option_env!`): only a build with it
updates itself and holds itself off the network when it is older than the kept `min_version`. The network files
(`unbrowse-node/app/networks/*.json`) are embedded at build time too (`include_str!` in
[`arc.rs`](../unbrowse-node/app/src/arc.rs)).

Cargo features, all off by default (`unbrowse-node/app/Cargo.toml`):

| Feature | What it adds |
|---|---|
| `antithesis` | the Antithesis SDK's assertions ([TESTING.md](TESTING.md)); without it every `sut_*!` macro expands to nothing |
| `antithesis-coverage` | `antithesis` plus coverage instrumentation, for the harness's image only |

### The release repository variables

`release.yml` reads build variables from the repository running it (`programs` job, `env`). Configure these in
`unbrowse-ai/unbrowse` for published artifacts. Core's repository variables apply to its own build runs.

```yaml
UNBROWSE_DEFAULT_CHAIN: ${{ vars.UNBROWSE_DEFAULT_CHAIN || 'arc-testnet' }}
UNBROWSE_SITE: ${{ vars.UNBROWSE_SITE }}
UNBROWSE_SHARE_DEFAULT: ${{ vars.UNBROWSE_SHARE_DEFAULT }}
```

and reads one more, `MACOS_NOTARIZED` (`true` changes the release notes' Mac text).

| Variable | Core setting on 30 October 2026 | Public release setting |
|---|---|---|
| `UNBROWSE_SITE` | the landing Worker's `workers.dev` address | the landing site, until it serves at unbrowse.ai (§5) |
| `UNBROWSE_DEFAULT_CHAIN` | unset: releases now start on `arc-testnet`, the workflow's fallback | unset or `arc-testnet` for the testnet launch, `arc-mainnet` for mainnet |
| `UNBROWSE_SHARE_DEFAULT` | unset, so `used` | `used` unless decided otherwise |

```sh
gh variable set UNBROWSE_DEFAULT_CHAIN --repo unbrowse-ai/unbrowse --body arc-testnet
gh variable set UNBROWSE_SITE --repo unbrowse-ai/unbrowse --body "https://unbrowse-landing.<account>.workers.dev"
gh variable list --repo unbrowse-ai/unbrowse
```

The example selects testnet. For a mainnet release, set `UNBROWSE_DEFAULT_CHAIN` to `arc-mainnet` and confirm
the public repository's site and signing environment before tagging.

`UNBROWSE_SITE` matters while unbrowse.ai is still the centralised app: a node built without it tries
`https://unbrowse.ai/link/` first, which isn't this site's page.

Secrets the release reads: `UNBROWSE_RELEASE_KEY` (the Ed25519 key that signs the update manifest older nodes read,
and every role of the built-in update root; its public half is `RELEASE_KEY` in `update.rs`), `UNBROWSE_TARGETS_KEY`
and `UNBROWSE_TIMESTAMP_KEY` (the update metadata's targets and timestamp keys once root 2 names them; until then
unset, and the release key signs both, §2), and for a notarised Mac app `MACOS_CERTIFICATE`, `MACOS_CERTIFICATE_PASSWORD`,
`APPLE_TEAM_ID`, and an App Store Connect team key to notarise with: `APPLE_API_KEY` (the `.p8`, as text or base64),
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. `APPLE_ID` with an app-specific `APPLE_APP_PASSWORD` still works in its
place. On the owner's Mac, `NOTARY_PROFILE` names a profile `xcrun notarytool store-credentials` keeps in the keychain.

---

## 2. Cutting a release

[`release.yml`](../.github/workflows/release.yml) publishes from the approved tree in `unbrowse-ai/unbrowse`.
Core keeps signed and verified build artifacts in Actions. The public repo publishes three kinds of refs (see
[CONTRIBUTING.md](../CONTRIBUTING.md), "Branches and releases"):

| Ref | When | Version | Goes to |
|---|---|---|---|
| `staging` | after CI passes on a push | `X.Y.0-staging.N`, X.Y one minor above the newest release branch or tag | npm's `staging` tag, nothing else: no node updates to it |
| `release/X.Y` | after CI passes on a push | `X.Y.P-rc.N`, P one above the highest `vX.Y.p` tag (0 before the first) | npm's `next` tag, and canary (below) |
| `vX.Y.Z` tag | when the tag is pushed | `X.Y.Z` | npm's `latest`, the GitHub release, and canary, then stable |

N is the release run's number ([`.github/scripts/release-version.sh`](../.github/scripts/release-version.sh)), so every
run has a version npm hasn't seen. A tag releases only from a commit on `main` whose tree is `release/X.Y`'s, so what
ships is what pre-production ran. No release is below 13.0.0, because npm already has `unbrowse@12.5.0`. A prerelease's
programs (the dmgs among them) are its run's artifacts; only a tag makes a GitHub release.

To ship from the public release repository:

1. Verify the public release repository's variables and `release` environment against the intended network (§1).
2. Raise [`unbrowse-node/MIN_VERSION`](../unbrowse-node/MIN_VERSION) (now `13.0.0`) in a change on the release branch if
   older nodes must leave the network: it goes into the signed manifest and, once stable runs that version, into the
   update targets as `min_version` (below).
3. After promotion approval, merge the public mirror's sync pull request (`public-sync.yml`, below) holding the
   approved core tree. In a checkout of `unbrowse-ai/unbrowse`, squash-merge the
   `release/X.Y` pull request into `main`, then tag its commit and push the tag:

   ```sh
   git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

4. Watch it (`gh run watch`), then check the release page and `npm view unbrowse version`.

**The promotion gate (UNB-208).** A tag publishes only when the tree it ships has 98% line coverage or more in each of
`unbrowse-node`, `unbrowse-node/crates/browser`, `unbrowse-browser/cli` and both SDKs, and its whole task bank lost no task the
last promoted build had right, holds no confident wrong answer, and passes at least as many tasks as that build did
(`test-banks/gate/promoted.json`, the floor). release.yml's `version` job runs it before anything is built
(`.github/scripts/promotion-gate.sh`), reading the artifacts CI kept for that tree when the release branch was pushed:
`coverage-summary-<tree>` (coverage.yml), `gate-bank-full-<tree>` (gate-bank.yml, the whole bank, a few hours on
macOS) and `gate-1k-<tree>` (gate-1k.yml, the top 1,000 sites, below). A pull request into `main` shows the same verdict (promotion-gate.yml). When it refuses it names each rule
unmet; nothing ships until the release branch meets them. A changed task verdict is re-read by hand, one site at a
time, and recorded in `test-banks/gate/rereads.json` before it is called a regression or cleared. After a release goes
out, record its bank run as the new floor in a pull request: `python3 .github/scripts/promotion_gate.py record
--bank-results results.jsonl --build vX.Y.Z --out test-banks/gate/promoted.json`. Exclusions from the coverage count
are in `docs/COVERAGE-EXCLUSIONS.md`, each approved by Lewis.

**The top 1,000 sites (UNB-307).** Lewis, 25 Nov 2026: main releases are gated on the top 1,000 Tranco sites, the
slice's logic over `test-banks/popular-sites/top-1000.json`, cold and warm: 2,000 tasks, made from the list by
`run_gate.py`'s one rule (`bench_tasks`). Every push to a release branch runs it (`gate-1k.yml`, which calls gate-bank.yml
with scope `top1k`, 25 shards side by side), all on one pinned kind of runner (`vars.GATE_1K_RUNNER`, else
`macos-15`). Each shard then runs once more, on fresh nodes, every task whose verdict measured
nothing (infra, error) or is not the floor's, with its twin; the second verdict is the one counted. The last job
reads every shard together and keeps `gate-1k-<tree>` (results, `meta.json`: where it ran and which shards; `rereads.json`;
the verdict), which promotion-gate.sh reads beside the other two. The rule is Lewis's, rates not every task: it refuses
when fewer tasks are right than on the floor, or the confidently wrong rate (over every answer the judge read) is above
the floor's, and it refuses as not measured a task with no result (a shard that did not run), one still infra or error
after its run again, a changed verdict never run again, a run on another kind of runner than the floor's, or no floor.
A site that blocked the task is counted apart, never a pass. A task right on the floor and not right on both runs does
not refuse by itself; it is listed in `rereads.json`, to be re-read by hand, one site at a time.

The floor, `test-banks/gate/promoted-1k.json`, is a run on the last promoted build, on the same kind of runner: by hand,
`gh workflow run gate-bank.yml --ref staging -f scope=top1k -f shards=25 -f node_ref=vX.Y.Z` (the bench from staging,
the node from the tag; its artifact is `gate-1k-<tree>-node-vX.Y.Z`, so it never stands for a tree), then
`python3 .github/scripts/promotion_gate.py record-1k --top1k-results results.jsonl --top1k-meta meta.json --build vX.Y.Z
--out test-banks/gate/promoted-1k.json` in a pull request. Until one is recorded every release is refused ("no floor
recorded"). After a release goes out, its own `gate-1k-<tree>` is recorded the same way as the next floor. Other hand
runs: `-f sites=20` for the first 20 sites, `-f only=3` for one shard, `-f resume_run=<run id>` to keep what an earlier
run of the same tree finished; any of them leaves tasks without a result, so its verdict refuses as not measured and
its score still reads. `gate-1k.yml` itself starts by hand only once it is on main (workflow_dispatch reads the default
branch's files); gate-bank.yml is there already. Cost, from the 20-site pilot (run 45550694686): $0.166 a task with its
judge, so about $330 a run of 2,000 before reruns (extrapolated, not measured at 2,000).

To publish an already approved public release branch again (a new run and a new prerelease number), dispatch the
workflow in the public repository with `gh workflow run release.yml --repo unbrowse-ai/unbrowse --ref release/X.Y`.

A pull request that changes the release workflow or its scripts gets a dry run: everything is built and packed, and
nothing is published.

To prove the keys sign in a repository or environment before anything ships there (a move, a new key), run it by hand
with `dry_run`: every job up to the publish runs with the keys, npm lacking a package is a warning, and nothing goes to
npm or a GitHub release: `gh workflow run release.yml --repo unbrowse-ai/unbrowse --ref staging -f dry_run=true`.

The public repository `unbrowse-ai/unbrowse` gets an approved core tree as one squashed commit per sync, through a pull request,
without the paths in `.github/public-tree-exclude`. `public-sync.yml` proposes it on every push to staging (or by
hand, `gh workflow run public-sync.yml --ref staging`), and merging that pull request is the approval:
`.github/scripts/public_tree.py check` refuses a tree that names a client, a home folder or the owner's account (the
patterns are in `.github/public-tree-forbidden`, which is itself left out), or links to a path it leaves out, and `sync` replaces the public tree with core's on the public branch
`sync/core-staging`, leaving the public repository's own files (`.github/public-tree-keep`: `CHANGELOG.md`,
`.github/promotion-waivers`) alone. One pull request from that branch into public staging is opened, then updated by
each later push; its body lists the files it removes and any change made on the public repository that it replaces
(bring that to core first). The token is `PUBLIC_SYNC_TOKEN` in core's `public-sync` environment: a fine-grained token
on `unbrowse-ai/unbrowse` alone with Contents, Pull requests and Workflows read and write. Without it the run is red
and says so.

What the tree leaves out: `unbrowse-settlement/` (the contracts' sources, tests and deploy scripts stay private, in
`unbrowse-ai/unbrowse-settlement` and here), and the internal ledgers and the agents' and CI's process docs
(`docs/REQUIREMENTS.md`, `REBUILD.md`, `ROADMAP.md`, `SPEC-STATUS.md`, `spec-status/`, `CI-AGENTS.md`, `HARNESS.md`,
`PERFORMANCE.md`; Lewis, 27 November 2026). A doc public CI reads stays public (`OPERATIONS.md`, `GENERALITY.md`,
`COVERAGE-EXCLUSIONS.md`). Leaving out another path is one line in the list; a public page that links to it loses the
link in the same change, or the check refuses the sync. The node's compiled contracts
(`unbrowse-node/app/contracts/`) stay in the public tree, since the node deploys and checks deployments from them.
The contracts' CI jobs run only in unbrowse-core, and `papers/params_check.py` reports their sites as PRIVATE where
the folder is absent.

Core builds, signs and verifies release packages in its own Actions artifacts. The public repository builds the
approved mirror tree again and is the npm trusted publisher. Its existing branch, installer, and production promotion
checks still govern publication. npm can attest a public repository, so the public workflow keeps `--provenance`.
When CI passes on public `staging` or a public release branch, a job with workflow-dispatch permission starts the
release on that branch with the checked commit SHA. GitHub evaluates the signing environment against that branch.
The release stops before checkout if its GitHub event SHA differs from the checked commit. npm uses the event SHA
for the provenance attestation, so the checkout and attestation name the same source.

| Job | Runner | Does |
|---|---|---|
| `version` | `sengi-basic-2-ubuntu-2404` | the ref's version and channel, and that npm has every package a release publishes and not yet this version (`npm-preflight.mjs`), so a missing package or a spent version stops the run before anything is built |
| `programs` | darwin-arm64 `macos-15` (there is no Intel Mac build since 22 November 2026, UNB-224); linux-x64 `sengi-premium-4-ubuntu-2404`; linux-arm64 `ubuntu-22.04-arm`; win32-x64 `windows-2025` | `UNBROWSE_RELEASE=1 cargo build --release --locked --bin unbrowse-node --bin unb`, the UI (`bun run build`), the window (`zig build`), the Mac app and dmg, a smoke test |
| `sdks` | `sengi-basic-2-ubuntu-2404` | signs `manifest.json` (checked against `update.rs`'s key), packs the npm packages and Python wheels (a prerelease's in PEP 440's form, `13.19.0rc7`, `13.20.0.dev9`), and but for staging writes and signs the update metadata (`updates.mjs release`), checked against the root nodes trust |
| `installers` | `sengi-basic-2-ubuntu-2404` | a production release's, and a dry run's: the Windows setup and the Linux packages, packed from the archives `programs` made (`package-windows-installer.sh`, `package-linux-deb.sh`), and each file's hash recorded |
| `installer-device-test` | a fresh Mac, Windows machine and Ubuntu (`installers-device-test.yml`) | each installer installed and opened as a person does, the node it starts answering MCP (`DEVICE_TEST_OK`); npm publishes nothing until all three pass |
| `verify-packages` | `ubuntu-24.04` | verifies the uploaded archives against their signed inventory for core builds and rehearsals |
| `npm` | `ubuntu-24.04` (trusted publishing needs GitHub's own runners), environment `release` | in `unbrowse-ai/unbrowse`, verifies and publishes each `@unbrowse/<platform>`, then `unbrowse`, under the ref's dist-tag, then `@unbrowse/updates` (`npm-publish.sh`); a version npm has with the same bytes is skipped, and one it has with other bytes fails the run |
| `release` | `sengi-basic-2-ubuntu-2404` | a tag's alone, last, once npm has everything: `gh release create v$VERSION --verify-tag --latest`, with `SHA256SUMS` and every installer at a name that stays (`releases/latest/download/{Unbrowse-macos-arm64.dmg,Unbrowse-windows-x64-setup.exe,unbrowse_amd64.deb,unbrowse_arm64.deb}`) |

**One release is the whole download page.** A production release carries the Mac disk image, the Windows setup and the
Linux packages, and the site, the README and the SDKs link the names that stay (`releases/latest/download/…`), so a
download link never names a build that stops being the newest one. There is no second, installer-only family of
releases to keep in step with it, and no draft to publish by hand: a branch that needs the installers proven before a
tag runs `release.yml` with `dry_run` on the public release branch (`gh workflow run release.yml --repo
unbrowse-ai/unbrowse --ref release/X.Y -f dry_run=true`). It packs them, installs all three on fresh machines,
and publishes nothing.

**Every published file is the one its job made.** The job that makes a file records its SHA-256 as a job output, which
no later job can change (`artifact-hashes.py record-files`): `platforms` records each program archive, disk image and
browser program before `sdks` runs any third-party build code, `installers` records the Windows setup and the Linux
packages, `sdks` records every file it hands on (the sdist and the manifest too), and `pack-updates` records
`@unbrowse/updates`. `npm` and `release` publish a folder only when its files are exactly those, byte for byte
(`verify-files`); an artifact replaced in between, or a file nobody recorded, stops the run. Packages are also checked
against the release-signed inventory (`verify-artifact-manifest.mjs`), and the Python build tools are installed from
hashes (`.github/scripts/requirements-release.txt`, `pip --require-hashes`).

**When a run stops part way.** The GitHub release is the last thing a run makes, so it never names a release npm
doesn't have, and the run is red.

| It stopped | What is left | Recover |
|---|---|---|
| before `npm` | nothing | rerun it, or let the next push release |
| in `npm`, some packages published | those packages | rerun the failed jobs: the same bytes, so it finishes. A new run of a branch takes a new number; a tag's version is spent once npm holds part of it, so tag the next patch |
| in `release`, after `npm` | everything on npm, nodes can take it, no GitHub release | rerun the failed jobs |

**When `@unbrowse/updates` was taken.** Its version is the timestamp npm had plus one, so a release that fails after
signing and a refresh that follows sign the same number. A rerun of the release's `npm` job then says `npm has
@unbrowse/updates@… with other bytes`, where it used to go green with the release dropped from the metadata. Rerun the
`Sign the update metadata` job instead (`gh run rerun <run> --job <job>`, or Re-run on the run's page, which reruns what
depends on it): it signs on top of what npm has now.

**How a release reaches nodes.** Through the update metadata in `@unbrowse/updates` on npm, shaped after TUF
([`update.rs`](../unbrowse-node/app/src/update.rs), [`updates.mjs`](../.github/scripts/updates.mjs)):

| File | Says | Signed by | Lasts |
|---|---|---|---|
| `root/<N>.root.json` | the keys of each role and how many must sign | enough keys of root N-1 and of its own; offline | a year, or what the owner sets |
| `targets.json` | each release a channel names or will (its packages and their sha512), the channels `stable` and `canary`, the canary share, a halt, `min_version` | the targets key | a year, signed again at every change |
| `timestamp.json` | the targets current now, by version and sha256 | the timestamp key | a week, signed again daily |

A released node reads `{UNBROWSE_REGISTRY or https://registry.npmjs.org}/@unbrowse%2fupdates/latest` at start, every 6
hours and on `unbrowse update`. It follows the roots one version at a time from the one it trusts (built in: the
release key for every role, so root 2 is the owner's first), refuses a timestamp or targets that expired, that the
role's keys didn't sign, or that are older than ones it checked (`versions/trust.json`), then fetches the release its
channel runs, checks its sha512 against the targets, unpacks it under `~/.unbrowse/versions/<version>`, and restarts
into it once nothing is in flight. It never moves to an older release. A node older than `min_version` stays off the
peer network.

**Channels and the rollout.** A node runs the channel its owner picks (`unbrowse update channel stable|canary|auto`),
else canary when a hash of its identity and the release falls within the canary share (10% to start), so the same nodes
stay on one release's canary at every check and no server decides.

Canary runs one release at a time. [`updates.yml`](../.github/workflows/updates.yml) runs daily from `staging`: a fresh
timestamp, and once canary's release has run two days unhalted it goes to stable. A release made while canary soaks
doesn't restart that clock: it waits (`waiting` in the targets, the newest only), takes canary when stable takes the
one before it, and starts a clock of its own. So stable moves at most every two days, the releases between are
skipped, and whatever reaches stable ran on canary for two unhalted days.

A release candidate (`X.Y.P-rc.N`) is pre-production: it runs on canary but never reaches stable, by the daily refresh
or by `promote`. A candidate made before stable's first release (13.0.0-rc.N ahead of 13.0.0) publishes no
`@unbrowse/updates` at all: it reaches npm's `next` tag alone, and its nodes read no channel until the release. It holds canary only until something newer comes, which takes canary at once, since its clock counts
toward nothing. A tagged release queues behind the releases ahead of it alone, never behind a candidate, and a
candidate never takes a release's place in `waiting`: one made while a release waits is dropped, and the next
candidate after it goes out. Replaying the first 52 tags
(`.github/scripts/test/fixtures/release-tags.txt`) that way gives four promotions in nine days, where restarting the
clock gave none. By hand:

```sh
gh workflow run updates.yml --repo unbrowse-ai/unbrowse-core --ref main -f action=halt -f value="13.6.0 loses calls"
gh workflow run updates.yml --repo unbrowse-ai/unbrowse-core --ref main -f action=resume
gh workflow run updates.yml --repo unbrowse-ai/unbrowse-core --ref main -f action=promote -f value=13.6.0
gh workflow run updates.yml --repo unbrowse-ai/unbrowse-core --ref main -f action=share -f value=50
```

A halt stops every node fetching a release, on both channels, until it is lifted, and it stops the two-day clock: the
time halted doesn't count, so a release halted after an hour has an hour run when it is resumed. While halted, the
newest release takes canary at once (one waiting when the halt came, or one made during it) with its clock at zero,
and the release it replaces never reaches stable: that is how a fix goes out. To put a waiting release on canary
when nothing is wrong, halt and resume: `promote` takes only what canary runs. `npm install -g unbrowse` always
installs the newest release: the rollout governs nodes updating themselves.
The `unbrowse` package still carries the single signed manifest (`manifest.json`, `manifest.sig`), so nodes from before
the metadata update into one that reads it.

**`min_version` follows stable.** The minimum holds for every node, and most run stable, so a minimum above stable's
release would hold them off the network with nothing to update to. A release's `MIN_VERSION` above what stable runs
waits in the targets (`min_wanted`) and applies when stable reaches it, by the daily refresh or by `promote`. Until
then nodes on canary still meet older nodes.

A halt runs at once, in a queue of its own: every other change waits for a release to finish, and GitHub keeps only the
newest pending run of a queue, so a halt behind a release could be replaced by the next merge. If a release is publishing
at that moment, each signed the same metadata version and npm takes one. When the release loses, its `npm` job fails
with `other bytes`: rerun its `Sign the update metadata` job, and it signs on top of the halt. When the halt loses, its
run goes red with the same message: run it again straight away.

**Rotating the root.** Root keys never touch CI. The node checks each successor root itself: threshold at least two,
finite expiry, and root keys disjoint from targets/timestamp and the online release key. Until the owner ceremony is
complete, the built-in root is still the single online release key for every role. A thief can sign targets and
timestamp directly, or mint a conforming root 2 using two attacker root keys, separate target/timestamp keys and a
finite expiry. Nodes that install that root accept the attack. A later binary with offline keys discards that old
root because it replays the chain from its built-in root. After transition, only the offline root threshold can
rotate roles, and targets require a separate 2-of-N threshold; the timestamp role is separate. Compromise of the
release key alone can no longer publish targets or rotate trust. The empty-key exception expires at 2026-12-15 UTC:
release builds warn before then and fail on or after that date (or when the exception is `None`). Node status reports
`update root is a single online key` while that exception is active. After root 2 is built in or held, browser binaries
and minimum-version policy must come from targets-signed metadata; an online-key legacy manifest cannot restore
browser download authority or raise the minimum when metadata is missing, expired, rolled back or unavailable.

**Owner ceremony before the transition release.** Generate root, targets and timestamp Ed25519 keys on separate
offline devices or key stores. Root and targets need at least two distinct public keys; timestamp needs one. Keep all
private keys and backups offline and outside the repository. Do not invent keys.

**Order matters:** first merge and ship the release tooling that contains `co-sign` to `main`. The `targets-cosign`
workflow checks out `main`, so switching the targets role to 2-of-N before that code is on `main` makes co-signed
changes fail closed. `root-check` rejects a targets threshold of 2 or more unless the trusted `main` checkout contains
the co-sign command.

```sh
umask 077
checkout=$PWD
keydir="$HOME/unbrowse-release-keys"
mkdir -p "$keydir"
cd "$keydir"
for key in root-a root-b root-c targets-a targets-b timestamp; do
  openssl genpkey -algorithm ed25519 -out "$key.pem"
  openssl pkey -in "$key.pem" -pubout -outform DER > "$key.pub.der"
  tail -c 32 "$key.pub.der" | od -An -vtx1 | tr -d ' \n' > "$key.hex"
done
cd "$checkout"
```

Read the `.hex` ids. First, while the checkout still has empty offline key constants, create root 2 using these role
thresholds and sign it with the current release private key plus two root keys. `release.pem` is the current root-1 private key, held
offline by its owner; GitHub cannot reveal a stored secret. If the owner does not have that key offline, recover it from
its original key holder before starting the ceremony. The new root file needs root 1's signature and signatures from two
of its new root keys:

```sh
node .github/scripts/updates.mjs root-rotate unbrowse-node/updates/root/2.root.json \
  --root "$(cat "$keydir/root-a.hex"),$(cat "$keydir/root-b.hex"),$(cat "$keydir/root-c.hex"):2" \
  --targets "$(cat "$keydir/targets-a.hex"),$(cat "$keydir/targets-b.hex"):2" \
  --timestamp "$(cat "$keydir/timestamp.hex"):1" --days 365
node .github/scripts/updates.mjs root-sign unbrowse-node/updates/root/2.root.json "$keydir/release.pem"
node .github/scripts/updates.mjs root-sign unbrowse-node/updates/root/2.root.json "$keydir/root-a.pem"
node .github/scripts/updates.mjs root-sign unbrowse-node/updates/root/2.root.json "$keydir/root-b.pem"
```

Review the root JSON and signatures offline. Then fill the three `OFFLINE_*_KEYS` constants with the matching public
ids and run the release build/tests: its built-in root is now version 2, so it discards any online-signed root 2 from
trust.json and skips that stale entry when replaying a later offline-signed root 3. It rewrites `trust.json` to the
verified chain as metadata is kept, without stale entries or duplicates. Commit root 2 and the public constants
together; old binaries can follow root 2, while new binaries start at that root directly. Do not commit private keys,
public DER intermediates or temporary files. Put `UNBROWSE_TARGETS_KEY` and `UNBROWSE_TIMESTAMP_KEY` (PEM values) in
the protected `release` environment. **Do not put `UNBROWSE_TARGETS_KEY_2` in that same environment.** Keep that
second targets key offline for a human co-signature, or put it in the separately protected `targets-cosign` environment
with a different reviewer set. Both the daily update workflow and release workflow now upload the first signature as
data; when targets change, the co-sign job independently fetches the currently published signed update metadata,
recomputes the requested change, verifies the target payload and role signatures, then adds the second signature and
re-signs the timestamp. For releases it also verifies the release-signed manifest, each platform package integrity, and
the signed artifact inventory against the downloaded package hashes. It runs the verifier from protected `main`, not the
first signing job's ref. Timestamp-only refreshes skip the co-sign job and need only the timestamp key. Put
`UNBROWSE_TARGETS_KEY_2` and `UNBROWSE_TIMESTAMP_KEY` in `targets-cosign`; never put the second key in `release`.
The repository cannot tell which environment supplied a GitHub secret; the tool rejects duplicate private key material
but cannot detect two different keys stored under one environment. Before the transition, create `targets-cosign`,
require a different reviewer set, add the two secrets there, and verify both workflows' co-sign jobs can publish a
changed target package. The `targets-cosign` environment reviewer approves the target change shown in the run summary.
Before signing, the job has checked that the current published package's timestamp and target hash are valid; that the
first target signature is valid and distinct; and that the proposed target payload exactly matches a recomputation from
the requested action. For a release, it has also checked the manifest signature and package integrity values against the
signed artifact inventory and actual package bytes. Review the human-readable target diff before approving. The release
workflow's co-signer uses the verifier on protected `main`, so merge this verifier to `main` before activating a 2-of-N
targets role. Until that verifier is on `main`, any change needing a second targets signature fails closed. `root-check`
also runs in PR CI and before update metadata signing.

`UNBROWSE_RELEASE_KEY` has a lasting CI role: it is the build-attestation key. The `release` environment uses it to
sign `manifest.sig` and `release-artifacts.json`, and the co-signer verifies those signatures and package hashes for
each release. Keep it in the protected `release` environment after legacy nodes stop needing `manifest.sig`; do not put
it in node trust after the offline-root transition, or use it for targets or timestamp signatures. The built-in offline
root must name only the offline root, targets and timestamp keys. Removing the attestation key requires first changing
the manifest and artifact-inventory signing and verification to a replacement key, then migrating the release
environment and verifier together. Remove repository-level secret copies after the environment secrets are configured.
The node cannot tell whether GitHub has environment reviewers or whether a secret is repository-scoped: those settings
are outside the repository.

**Co-signer independence depends on GitHub settings.** If the repository's plan does not provide branch protection and
environment reviewers/secrets for private repositories, the co-signature's independence rests only on the security of
every account and token with write access. In that case, keep `UNBROWSE_TARGETS_KEY_2` offline and run the co-signer by
hand from a clean checkout of `main`. The command fetches current published metadata itself; keep the partial output
and release inputs as data, and inspect the targets summary before signing:

```sh
cd /path/to/unbrowse-core
git checkout main
test -z "$(git status --porcelain)"
UNBROWSE_TARGETS_KEY_2="$(cat "$KEYDIR/targets-b.pem")" \
UNBROWSE_TIMESTAMP_KEY="$(cat "$KEYDIR/timestamp.pem")" \
node .github/scripts/updates.mjs co-sign "$PARTIAL_DIR" --action "$ACTION" --value "$VALUE" --out "$OUTPUT_DIR"
```

For a release, use the release inputs instead of `--value`:

```sh
UNBROWSE_TARGETS_KEY_2="$(cat "$KEYDIR/targets-b.pem")" \
UNBROWSE_TIMESTAMP_KEY="$(cat "$KEYDIR/timestamp.pem")" \
node .github/scripts/updates.mjs co-sign "$PARTIAL_DIR" --action release --release-version "$VERSION" \
  --manifest-dir "$DIST_DIR" --inventory-dir "$INVENTORY_DIR" --out "$OUTPUT_DIR"
```

**GitHub-side checklist (owner action).** In Settings → Environments → `release`, require named reviewers and restrict
deployments to the intended branch and tag allowlist (`staging`, `release/*`, and reviewed `v*` tags). Move release,
targets, timestamp and Apple signing/notarization secrets from repository secrets to `release` environment secrets, then
delete the repository copies. Protect `main`, `staging` and `release/*` with pull-request-only changes, required CI and
CODEOWNERS review for workflow/release files, no force pushes, and the repository's rule that only release branches merge
to `main`. These GitHub settings cannot be enforced by checked-in workflow files.

Before a root expires, sign and publish its successor; once the active root expires, nodes fail closed until a valid
successor is published. From 30 days before expiry, the daily `root` job reports that a rotation is due. The built-in
root never expires.
---

## 3. Deploying a network's contracts

A live network's contracts are deployed once, by hand, by one node's key: `unbrowse-node chain deploy`
(`chain_deploy` in [`main.rs`](../unbrowse-node/app/src/main.rs), `chain::deploy_shared` and `chain::deploy_as` in
[`chain/`](../unbrowse-node/app/src/chain/)). The compiled contract ABIs used by the node are in [`unbrowse-node/app/contracts/`](../unbrowse-node/app/contracts) (the Solidity sources live in the separate settlement contracts repository).

### Network files

Each network has a file, shipped in the build ([`unbrowse-node/app/networks/`](../unbrowse-node/app/networks)) and
read instead from `~/.unbrowse/networks/<name>.json` when that exists (`chain::network_file`).

| Field | arc-testnet | arc-mainnet |
|---|---|---|
| `chain_id` | 5042002 | 5042 |
| `registry_from` (the block ERC-8004 registrations are read from) | 69,700,000 | 28,500,000 |
| `deployment` | the route-coin set, deployed 18 November 2026 from block 72,792,533 (Settlement `0x2043…1ca5`, test UNB `0x577e…c9d0`, stand-in pool `0xb680…5b13` seeded with 5 USDC and 370,000 UNB); the one before route coins (Settlement `0xdb93…272f`) is no longer read | deployed 23 November 2026 in blocks 32,740,267 to 32,740,301 (Settlement `0xfcfd…8d4d` on UNB's v4 pool through the adapter `0xeeac…85db`); every address and deploy transaction is in [Arc mainnet's deployment](#arc-mainnets-deployment) |
| `existing.usdc` | Arc's USDC, `0x3600…0000` | Arc's USDC, `0x3600…0000` |
| `existing.unb` | `null`: the deploy makes a test UNB | UNB `0x1232…AE2C`, as the deploy wrote it (named on the deploying machine with `UNBROWSE_ARC_MAINNET_UNB`) |
| `existing.pool` | `null`: the deploy makes a stand-in pool | `null`: UNB trades in a v4 pool, which has no address of its own |

Until `deployment` is filled, a node on that network runs its identity and the peer network, and Settlement calls
say it isn't deployed. A node also refuses a deployment whose code on the chain isn't its own ("update the node",
`chain/conform.rs`): it reads every contract from the Settlement the file names, so the file and the release that
carries it must match. Before a release, `cargo test -p unbrowse-node-app shipped_networks -- --ignored` says whether
they do.

### The command

```
unbrowse-node chain deploy [--pool <usdc> <unb>]
```

Nothing is named on the command line but the pool's seed: every number the contracts hold is the spec's, fixed for the
deployment's life.

One value is read from the network's file: `epoch_blocks`, one epoch in the chain's blocks
(R1.28). It is the chain's own pace, so it has no default either: measure it and set it in the network's file first,
or the deploy refuses. Measure it over a week of the chain's blocks, as a day's share of them
(`arc::tests::a_networks_epoch_blocks_are_a_day_of_its_blocks`, which reads the last week), and round it: a small drift
from a day is accepted, since nothing on chain corrects for it. The owner's numbers:

| Network | `epoch_blocks` | From |
|---|---|---|
| arc-testnet | 170,000 | about 0.507 s a block, measured 1 to 6 November 2026 (issue #199) |
| arc-mainnet | 170,400 | 170,448 blocks a day, measured over the 1.2 million blocks to 32,653,608 (16 to 23 November 2026) |

Nothing can change it afterwards, and a node refuses a deployment whose `epochBlocks()` isn't the file's. If the chain's block time later moves, every epoch moves with it:
blocks made faster shorten the escrow wait and the withdrawal and claim windows in proportion, until a new deployment.

It runs on the live chain the node is set to (`UNBROWSE_CHAIN`, else the `chain` setting; the RPC from `arc.rs` unless
`UNBROWSE_RPC` names another), signed by the node's own root key. The curves' fee recipient (who the 1% trade fee of every route coin accrues to,
with no other power: the pool, the DNSSEC trust anchors, the escrow wait and every route-coin number are fixed by the
deploy) is the address `UNBROWSE_<NETWORK>_FEE_RECIPIENT` names, or `existing.fee_recipient` in the owner's network
file, else that key. **It can never be changed**, and the key is a node's, online, so on mainnet it must be named: use
a multisig. No address takes a share of fees, and no canary operator is disclosed, so a node counts no canary sets. It
needs no running node. It refuses:

- on the devnet;
- while the node is running on this machine, or while the key has a write still pending: anything else writing with
  the key would take the nonce Settlement is to go at (`chain::key_is_quiet`);
- when the RPC's chain id isn't the network's (`check_rpc`);
- when the network file already names a Settlement with code on chain ("a second deployment would split the network");
- when the key holds less gas than 45,000,000 at twice the gas price (`DEPLOY_GAS` in `chain/gas.rs`: 2.25 USDC at
  25 gwei; the mainnet deploy then spent 0.47 USDC);
- when a contract the file names has no code, a named pool's tokens differ from the named ones, or a named UNB isn't
  18 decimals;
- when a stand-in pool would sit beside a token the network names and no `--pool` seed is given;
- when the key doesn't hold a seed of a token the network names. Nothing is sent before these checks.

**`--pool <usdc> <unb>`** seeds the stand-in pool with that much of each, in whole tokens, both above zero. The ratio
is the pool's opening price: `usdc ÷ unb` USDC a UNB. A test token's seed is minted; a seed of the network's own
token comes from the deployer's balance. Arc testnet names Arc's USDC, so it needs `--pool`, and the USDC comes from the
deployer's wallet. On mainnet no pool is seeded: the deploy builds on UNB's existing pool (below).

It deploys, in order: the test USDC and test UNB if the file names none, the stand-in `UnbPool` (minting, approving
and seeding it), the domain proofs (`Domains`, which makes the DNSSEC verifier on the root's anchors and holds the
escrow wait), the four route-coin contracts (`RouteCoins`, `CoinStakes`, `CoinFetch`, `CoinBounties`) and
`LeanSettlement`. Each of the first five names the address the key's contract after them will have, and each
constructor refuses a neighbour that names another. Just before Settlement is sent it checks the key's next contract is still that address, and stops if another
write took it (`chain::settlement_lands`). The escrow wait (`escrow_wait` in the network file, else
`UNBROWSE_ESCROW_WAIT`, else 14 epochs) is how long a DNSSEC-proven domain's shares are held before they are paid.

A deploy that stops partway (the RPC gone, the gas run out) picks up where it stopped when run again with the same
flags and variables. Each contract it makes is written to `~/.unbrowse/networks/<net>.deploying.json` as it goes, and a
rerun uses each one still on the chain, the pool's seed included, so nothing is paid for twice. The domain proofs
and the coin contracts are kept only while the key still makes the Settlement they name; otherwise they are made
again. A rerun with other values is refused until that file is moved aside. The file is removed
once the deployment is recorded. Then it prints:

```
deploying Settlement, and the tokens and pool the network's file doesn't name, on <net> (<rpc>) as <address>: its gas is paid from that address
deployed on <net>: Settlement 0x…, USDC 0x… (6 decimals), UNB 0x…, pool 0x…, in block N
wrote ~/.unbrowse/networks/<net>.json: this node uses it from its next start
for every node on <net>, put this in unbrowse-node/app/networks/<net>.json:
{ …the whole network file… }
```

### Arc testnet

```sh
unbrowse-node wallet address          # the deployer: fund it with testnet USDC from https://faucet.circle.com
unbrowse-node chain arc-testnet       # or run the next line with UNBROWSE_CHAIN=arc-testnet
unbrowse-node chain deploy --pool 1000 1000
```

The deployer needs the gas (2.25 USDC at 25 gwei to pass the check above) plus the pool's USDC seed. The test UNB is minted for the seed, and
the deployer owns its faucet.

### Arc mainnet

The repository names no UNB or pool for mainnet, on purpose. A mainnet deploy builds on UNB's live token and its
existing public pool, and refuses to deploy its own, to seed a pool, or to stand up a test USDC
(`chain::mainnet_guard`, spec §75.4). Name the pool on the deploying machine, never in the repository:
`UNBROWSE_ARC_MAINNET_POOL` (and `UNBROWSE_ARC_MAINNET_UNB`, else UNB is read from the pool), or `existing` in
`~/.unbrowse/networks/arc-mainnet.json`. Generally `UNBROWSE_<NETWORK>_<USDC|UNB|POOL>` overrides
`existing.<usdc|unb|pool>` (`chain::network_file`). The deploy refuses while the shipped `arc-mainnet.json` names
either.

UNB trades in a Uniswap v4 pool, which has no address of its own: it is a key inside one PoolManager. For that pool,
name UNB and the pool's key instead of `_POOL`. The deploy reads the key from the manager before sending anything,
deploys the adapter `V4UnbPool` over it (`unbrowse-settlement/src/lean/V4UnbPool.sol`), and builds Settlement on the
adapter. All six `_V4_*` variables are needed, or none:

```sh
export UNBROWSE_ARC_MAINNET_UNB=<UNB on Arc mainnet>
export UNBROWSE_ARC_MAINNET_V4_MANAGER=<the v4 PoolManager>
export UNBROWSE_ARC_MAINNET_V4_HOOK=<the pool key's hook>
export UNBROWSE_ARC_MAINNET_V4_FEE=0x800000          # the key's fee: 0x800000 when the hook sets it
export UNBROWSE_ARC_MAINNET_V4_TICK_SPACING=<the key's tick spacing>
export UNBROWSE_ARC_MAINNET_V4_BUY_FEE_BPS=<what the hook takes of a buy's USDC, rounded up, in basis points>
export UNBROWSE_ARC_MAINNET_V4_LP_FEE=<the LP fee a buy swaps at, in pips>
unbrowse-node chain arc-mainnet
unbrowse-node chain deploy
```

The adapter's quotes step v4's swap math over the pool's ticks as a view, and are checked to the unit against real
buys on a fork of Arc mainnet (`V4UnbPool.t.sol`, and `a_mainnet_deploy_builds_settlement_on_unbs_v4_pool`, both
reading these variables and `UNBROWSE_ARC_MAINNET_RPC`). The hook's buy fee and the LP fee are fixed in the adapter
at deploy. If the hook later charges more, a buy pays under its quote and Settlement's minimum out refuses it: the
claim goes on without the swap and no USDC is lost, but no swap goes through until a new deployment. Check both
against a buy on a fork right before deploying. For a pool that already speaks `IUnbPool`, name it with
`UNBROWSE_ARC_MAINNET_POOL` instead.

The deployer needs real USDC for the gas. Nothing is minted or seeded.

#### Arc mainnet's deployment

Deployed 23 November 2026 (about 14:00 UTC) by `0x9879A80c063eC4D0CEadA3225f865867b8462bEf` with the node built
from staging `47a2c8a1` (its `unbrowse-settlement/` is the same as staging `c1262e86`), after a rehearsal on a fork
of Arc mainnet with the same key and values. Values: UNB `0x12329F0D6E930CB6266B91E4A94a9b990E00AE2C`, v4 PoolManager
`0x8366a39CC670B4001A1121B8F6A443A643e40951`, hook `0x05e803544851e2c9aB0157360173B047EB5820CC`, fee `0x800000`, tick
spacing 200, buy fee 500 bps (the hook's 400 plus its base 100, read from the hook that day), LP fee 0, fee recipient
the Safe `0x9F3b4e0bc5fA502F107b0274010f8BC998218E8c`, `epoch_blocks` 170,400, escrow wait 14 epochs. Seven
transactions, all succeeded, 0.4697 USDC of gas in all:

| Nonce | Contract | Address | Deploy transaction | Block |
|---|---|---|---|---|
| 0 | `V4UnbPool` (the adapter over UNB's v4 pool; `pool` in the file) | `0xeeac1d470b2ca72c7c5eeb539e03129bf98685db` | `0x5d60716e3751a0a579c200d0440c9dd5d71ea8a091f1c0a488e167db9d91ae8d` | 32,740,267 |
| 1 | `Domains` (domain proofs) | `0x21d9788308222107aa35996a5e99f837a13ad39e` | `0x7fcd3c30074fe39f3de4a1b19a53bb8705331693ba54f8459fc09b31f64e9e02` | 32,740,274 |
| 1 | DNSSEC verifier, made by `Domains`' constructor | `0xbd372b9c952fded4076e76003455ed9dc691901e` | the same as nonce 1 | 32,740,274 |
| 2 | `RouteCoins` | `0xdb4573b4e0a046da2476cbd13fdd235218514b3c` | `0x4abb501aa49494510481932a953bf7f815c205c442a233f743989edbac5dcc4b` | 32,740,280 |
| 2 | route-coin implementation, made by `RouteCoins`' constructor | `0x75b87ec8feb7d13feda95fc21f6f15b8429daec9` | the same as nonce 2 | 32,740,280 |
| 3 | `CoinStakes` | `0x96a66af09501be6fe3cd609e02237864a8b2d6ce` | `0x8cec17d9e68c546bbf3286994aa1be31a0dfc07d1bd52ba5a7328af7df850950` | 32,740,285 |
| 4 | `CoinFetch` | `0x401a3c751a930183e4a05f8fdd8bfb8169131c73` | `0xd69580bd2a4532784a259de7dc571f4877f6e57c52ffe7eb21fb6512c00bf2f4` | 32,740,290 |
| 5 | `CoinBounties` | `0x464d60e167c4f6cf39476958e2ec4ccfb3d1bb7b` | `0x222d8f87355113174050f1c9c810bc06ce5d6c347acf64fab49f0f099950e9a1` | 32,740,295 |
| 6 | `LeanSettlement` | `0xfcfd324306e96168d3d1273715580360166b8d4d` | `0x36b3015d7069f87cfba4f4f537be312cd10f681c4eb32a995613b7991bbe0037` | 32,740,301 |

The deployment is in [`arc-mainnet.json`](../unbrowse-node/app/networks/arc-mainnet.json); nodes on mainnet use it
from the first release that carries that file (§9).

There is no account contract to deploy (spec §76). Settlement, the coin contracts and the domain proofs name each other
in their constructors, so their addresses follow the deployer's nonce, not Arc's CREATE2 factory. The network file's
deployment records the domain proofs' address (`domains`); a node reads it, and the escrow wait, from Settlement
(`chain::usable`).

### What to copy where afterwards

1. **The network file, in unbrowse-core.** Put the printed JSON in `unbrowse-node/app/networks/<net>.json` (the same as
   the deployer's `~/.unbrowse/networks/<net>.json`), commit it, and release (§2). Every node takes the deployment from
   the release; until then only the deployer's node has it. The landing site needs nothing from the deploy.

### Rehearsing it locally

Both deploys were rehearsed on 30 October 2026 on local Anvil only, the way the Antithesis harness's chain does it
([`antithesis/chain/entrypoint.sh`](../antithesis/chain/entrypoint.sh)): Anvil with the network's chain id and Arc's
20 gwei base fee, the 6-decimal test USDC's code and storage copied to `0x3600…0000` (and, for mainnet, the test UNB's
to a UNB address named in the deployer's network file), the deployer funded from those faucets, and the deployer's key in a scratch
`UNBROWSE_HOME`:

```sh
anvil --port 8611 --chain-id 5042002 --base-fee 20000000000
# … stand-in USDC at 0x3600…0000, minted to the deployer …
UNBROWSE_HOME=<scratch> UNBROWSE_CHAIN=arc-testnet UNBROWSE_RPC=http://127.0.0.1:8611 unbrowse-node chain deploy --pool 1000 1000
```

What it showed: with no `--pool` the deploy is refused before anything is sent; a seed above the deployer's balance is
refused naming both amounts ("… holds 5000 USDC and the pool's seed is 9000", and on mainnet "… holds 2000 UNB and
the pool's seed is 5000"); a second deploy is refused ("a second deployment would split the network"); on testnet a
test UNB is deployed; on mainnet none is, and the pool's UNB seed left the deployer's balance. A debug build keeps the
root key at `<home>/devnet/root.key`, a release build in the system keystore (or `<home>/root.key` on headless
Linux).

### Domain proofs

A domain is proven by DNSSEC only (R4.14, [NETWORK.md §16](NETWORK.md#16-domain-proofs)): a TXT record `wallet=0x…` at
`_unbrowse.<domain>` in a signed zone, submitted with `Domains.claimEscrow`. A domain without DNSSEC can't be proven;
its site share waits in escrow until it has DNSSEC and a proof is submitted. `unbrowse-node domain status <domain>`
shows where a domain stands. A node has no domain duty to turn on.

---

## 4. Unbrowse pays its members' gas

Unbrowse gasses the nodes of owners signed in with Privy (Lewis, 18 November 2026: "the whole point is to make it
frictionless, so that we gas our users"; this replaces spec §76's "no sponsor"). The RPC gateway (`unbrowse-rpc`,
`rpc.unbrowse.ai`) does it: the first time a member node reads a network there holding less than 0.05 USDC, it is sent
0.10 USDC from the gas wallet, once a node a network, at most 20 USDC a network a day (`unbrowse-rpc/src/drip.js`). On
Arc the gas is USDC, so that pays the identity's registration (about 0.025) and many writes after. The sign-in page asks
the owner for nothing. A node that isn't a member (its owner never signed in) still pays its own gas.

The gas wallet is the `GAS_KEY` secret of each gateway Worker, made in the operator's keychain (`unbrowse-gas` / `arc`);
fund it on each network and watch its balance (§8). Arc testnet's was first funded on 18 November 2026 (3 USDC).

---

## 5. The landing site

The site (unbrowse-landing) is a Cloudflare Worker with static assets, served at
its `workers.dev` address (`workers_dev: true`, and no `routes`). unbrowse.ai is still the
centralised app, another worker, so this site takes no route there, and a test checks it (`test/worker.test.mjs`).
Deploy with `npm run deploy` (build, then `wrangler deploy`). The worker answers `/link/`'s relay, `/t` and `/e`; its
README has each. It pays no one.

**When it becomes unbrowse.ai.**

1. Add routes on the unbrowse.ai zone to `wrangler.jsonc` for `/link` and `/link/*`, `/relay/*`, `/t` and
   `/e` (`/e` is missing from the comment in `wrangler.jsonc`, but the pages post to it), or the
   whole zone if every page moves.
2. Change the test that asserts no routes.
3. Update the canonical, `og:url` and `og:image` URLs in `index.html`, and `public/robots.txt` and
   `public/sitemap.xml`.
4. Set `UNBROWSE_SITE` to `https://unbrowse.ai`, or unset it (the node then tries unbrowse.ai first), and release.

**Wrangler doesn't detach dropped routes.** A route removed from `wrangler.jsonc` stays attached to the worker after
`wrangler deploy`. Delete it through the Cloudflare API (or the dashboard). The landing's earlier unbrowse.ai routes
were removed this way on 30 October 2026, and a deploy from a branch that still listed them put them back, so check
after every deploy from an older branch:

```sh
T=<a Cloudflare API token with Workers Routes edit on the zone>
Z=$(curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/zones?name=unbrowse.ai" | jq -r '.result[0].id')
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/zones/$Z/workers/routes" \
  | jq '.result[] | select(.script == "unbrowse-landing")'
curl -s -X DELETE -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/zones/$Z/workers/routes/<route id>"
```

Leave the centralised app's own routes on the zone alone.

---

## 6. CI

Every workflow is in [`.github/workflows/`](../.github/workflows). Linux x64 jobs run on Sengi; macOS, Windows and
Linux arm64 jobs on GitHub's own machines (`macos-15`, `windows-2025`, `ubuntu-22.04-arm`), and npm publishing on
GitHub's `ubuntu-24.04`. The agent jobs (a model, a simulated user or the task bank: Claude QA, the MCP check, skill
triggers, the gate bank and its slice, Bank, Code review, PR Steward, SDK polish) may run on Lewis's own runners instead: see
**Agent jobs on Lewis's runners** below.

| Workflow | Trigger | Jobs and runners |
|---|---|---|
| `ci.yml` (CI) | push to `main`, `staging` or `release/**`, pull requests, by hand | the small jobs (`scope`, `papers`, `sdk-python` 3.9 and 3.13, the route-coin spec) on `sengi-basic-2-ubuntu-2404`; `sdk-typescript` and `short` on `sengi-premium-2-ubuntu-2404`; `engine` on `sengi-premium-4-ubuntu-2404`; `settlement` on `sengi-premium-8-ubuntu-2404`; `node`, `lint` and `window` on `macos-15`; `elsewhere` on `sengi-premium-4-ubuntu-2404` and `windows-2025` |
| `release.yml` (Release) | CI passing on a push to `staging` or `release/**`, a pushed `vX.Y.Z` tag, by hand | §2 |
| `main-source-guard.yml` | pull requests into `main` or `release/**` | fails one into `main` from anything but `release/*`, and one into a release branch not titled `fix:` |
| `coverage.yml` (Coverage) | pull requests into `staging`, `release/**` or `main`; pushes to `staging` and `release/**`; by hand | line coverage per part: `rust-node` on `sengi-premium-8-ubuntu-2404`, `rust-browser` on `sengi-premium-4-ubuntu-2404`, the SDKs and the contracts (reported apart) on `sengi-premium-2-ubuntu-2404` and `sengi-basic-2-ubuntu-2404`; posts one comment on a pull request and never blocks it; keeps `coverage-summary-<tree>` for the promotion gate |
| `gate-bank.yml` (Gate bank) | called by QA (qa.yml) on every push to `staging` and `main` (the six-task slice, in QA's report; not again for a push to staging whose tree already passed it on its pull request), nightly on staging and every push to `release/**` (the whole bank), by hand (also `top1k`: the top 1,000 sites, cold and warm, in shards, UNB-307; `gate-1k.yml` calls it so on every push to `release/**`) | the task gate's bank through a scratch node's MCP, a model as client and judge, on `macos-15` (the slice on Lewis's Mac only, below); no pull request starts it (it holds a model credential); keeps `gate-bank-<scope>-<tree>` (`top1k`: one per shard, `-<i>of<n>`, each with its tasks run again; then the release gate on every shard together, `gate-1k-<tree>`) |
| `gate-1k.yml` (Gate 1k) | every push to `release/**`; by hand once on main | the release gate on the top 1,000 sites (UNB-307, §2): calls gate-bank.yml with scope `top1k`, 25 shards on `macos-15` (`vars.GATE_1K_RUNNER`); keeps `gate-1k-<tree>`, which promotion-gate.sh reads; no pull request starts it |
| `promotion-gate.yml` (Promotion gate) | pull requests, pushes to `staging` and `release/**` | the gate's own tests and its refusal of staging as measured on 17 Nov 2026; on a pull request into `main`, the gate's verdict on the release branch's tree |
| `qa.yml` | nightly on staging, by hand | an agent runs `.github/qa/checklist.md` against a built node on `macos-15`; skips without a Claude secret |
| `pr-signal.yml` (PR signal, no credential) | every pull request event | one hosted job that says the pull request moved, so the agents that hold a key can start; no secret, no permission |
| `opencode-review.yml` (Code review) | after `pr-signal`, by hand | placed (below); reviews the change, posts the findings inline, writes the `Code review` check; holds `OPENCODE_API_KEY` in the `opencode-review` environment |
| `opencode-steward.yml` (PR Steward) | after CI, Coverage, the PR check or Code review, or by hand | placed (below); fixes what failed or what was found, one commit on the branch; holds `OPENCODE_API_KEY` in the `opencode-steward` environment |
| `opencode-approvals.yml` (Claude Approvals) | every pull request event, every review, after Code review, by hand | reads `.claude/approvals.yml` and writes the `Claude Approvals` check; no secret. `docs/CI-AGENTS.md` (in unbrowse-core) |
| `pr-closed.yml` | a pull request closes or merges | cancels that pull request's runs still waiting or running |
| `public-sync.yml` (Public sync) | every push to `staging`, by hand | checks the public tree and opens or updates the sync pull request into `unbrowse-ai/unbrowse` staging (above); holds `PUBLIC_SYNC_TOKEN` in the `public-sync` environment; runs only in unbrowse-core |

**Agent jobs on Lewis's runners (UNB-166).** From 20 to 21 Nov 2026 every job ran on the local pool (four slots on
the Steam Machine, one MacBook). It was asked for about twice what it could do, and 0 of 43 pull requests into staging
went green. Now each workflow with agent jobs starts with a `place` job on Sengi
(`.github/scripts/place_jobs.py`). It sends an agent job to one of Lewis's runners while one is free, and otherwise to
a hosted machine that starts at once (Sengi for Linux, GitHub's `macos-15` for macOS), and the run's summary says why.
The Mac pool is the repository variable `MAC_RUNNER` (unset means no Mac pool; in unbrowse-core it is
`["self-hosted", "macOS", "ARM64", "lewis-mbp"]` since 28 Nov 2026, and the public repository, which cannot reach
that runner, leaves it unset). The Linux pool is `LINUX_POOL` (default `["self-hosted", "linux", "x64"]`).
With the repository secret `RUNNER_READ_TOKEN` (a fine-grained token, Administration: read on this repository) the
placement reads whether each runner is online and idle. Without it, a runner counts as asleep once a job has waited
2 minutes for it while nothing runs on it. Pull request workflows never get that token, because in them only the
model's jobs hold a secret.

**The gate bank's slice runs only on Lewis's Mac.** Lewis, 28 Nov 2026: "run slices only on my Mac". On a hosted Mac (a
data centre's address) Ticketmaster and Carousell refuse the slice's tasks and its gate says `PROMOTION_REFUSED`, so a
pull request's agent checks went red for reasons not in its code (PR #945, run 46116646462); on lewis-mbp, from a home
connection, the same slice passes (run 46117099629). So the place job asks for the slice as `slice=mac-only` (in
pr-agent-checks.yml and qa.yml; gate-bank.yml asks `bank=mac-only` for scope slice and ignores the `runs_on` a caller
hands it), and `place_jobs.py` gives it `OWN_MAC` (`vars.MAC_RUNNER`) every time: free, busy, asleep or unreadable.
There is no hosted fallback, and no probe that sends it elsewhere. When the Mac is busy the job waits in GitHub's queue
for it (up to GitHub's 24 hours for a queued job; `timeout-minutes` counts only once it starts). A slice that waits holds
its pull request's `PR agent checks` open. That is the trade-off: slices queue for one machine, and slicing is slower
and stays strict. The slice takes the Mac's free slot before the Claude QA shards, so they go to hosted Macs at once
rather than queue beside it. With no self-hosted `MAC_RUNNER` (the public repository), or on a fork's pull request, the
place step fails and says why. It does not fall back. The whole bank, top1k and every other agent job are placed as
above.

What each CI job tests is in [TESTING.md](TESTING.md).

**Blacksmith.** CI moved to Blacksmith on 28 October 2026 (`c30bea4a`). On 30 October the Windows builds and Claude
Code moved too, after GitHub's October bill went $63 over the included minutes (`1feff34c`, #62). On 22 November
(UNB-224) every release, update and installer job moved to Blacksmith too, and the Intel Mac build was dropped. Only
the npm publishing jobs stay on GitHub's runners (`ubuntu-24.04`): npm's trusted publishing works from cloud-hosted
runners only.

**Sengi, and no Blacksmith.** On 27 November 2026 (Lewis: "switch from blacksmith to sengi on unb core n public")
every Linux x64 job moved to Sengi (#1020). Blacksmith had stopped starting jobs at all that day (110 runs queued in
core, none running, while its status page said it was up). On 28 November ("remove blacksmith") what Sengi has no
machine for moved to GitHub's own: macOS to `macos-15`, Windows to `windows-2025`, Linux arm64 to `ubuntu-22.04-arm`.
An agent job goes to Lewis's Mac first (`MAC_RUNNER`) and to `macos-15` when it is busy or asleep, except the gate
bank's slice, which runs on the Mac only and waits for it (above). Release builds, the
installer tests and the credential-free PR check never run on the Mac (UNB-166), so they are always on `macos-15`. In
the private unbrowse-core a hosted macOS minute counts ten times against the free plan's included minutes.

**The startup failures.** On 30 October 2026, between 05:30 and 12:13 UTC, 88 runs ended `startup_failure`: every push
and pull request, on every branch, each with no jobs. The workflow files weren't the cause: a CI run dispatched by
hand on the same commit passed at 12:29, and so did a full CI run on `main` at 12:43. They began before the Windows
runner move was pushed (08:43), so that wasn't the cause either. Billing was ruled out (a $100 budget, no hard stop,
about $63 used). An organisation Actions setting was suspected, and the failures stopped after the owner changed
settings on the organisation; the exact cause was never established. Actions permissions now read `enabled: true`,
`allowed_actions: all` (read 30 Oct 2026). If it happens again: check the organisation's Actions policy and spending
limit first, then dispatch CI by hand on the same commit to separate the workflow from the platform.

---

## 7. Running a node as a service

On a machine that should keep a node up (a Linux box or a home server), run it as a systemd **user** service. The
repo ships no unit. This one runs a release unpacked under `~/.local/opt/unbrowse-core/<version>`, with a `current`
symlink to the one in use.

```ini
# ~/.config/systemd/user/unbrowse-node.service
[Unit]
Description=Unbrowse node (unbrowse-core release, 127.0.0.1:7788)

[Service]
ExecStart=%h/.local/opt/unbrowse-core/current/unbrowse-node
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now unbrowse-node
loginctl enable-linger "$USER"        # keep it running when nobody is logged in
systemctl --user status unbrowse-node
```

- **One node only.** A second node (a supervisor restarting while one serves, a node started by hand beside the
  service) leaves `owner.token` naming the wrong process and the window locked out
  ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)). With the service running, use the window and CLI against it; don't start
  another. The window starts a node only when it found none running: a node it found (the service's) is never
  replaced by one of its own when it goes away, so `systemctl --user restart unbrowse-node` brings the service's back.
  Windows before this rule did start one, and it held port 7788 while the service crash-looped.
- **Agents.** Run them as the OS user `unbrowse-agent`, not as the node's user: `unbrowse-node agent-user install`
  ([guides/agents-os-user.md](guides/agents-os-user.md)). A same-user agent can read `owner.token` and a file-kept
  `root.key`.
- **The key.** On headless Linux the root key is the file `~/.unbrowse/root.key` (or when that file exists), not the
  system keystore (`main.rs`, `root_store`). A node made from seed words keeps them beside it in
  `~/.unbrowse/root.key.seed`, readable by you alone. Back up the recovery phrase (12 seed words, which open the wallet
  in any wallet app, or an older node's 24 words), or export an encrypted backup of the key (`unbrowse-node wallet export <file>`, passphrase on stdin), which also opens in any wallet that imports a keystore file.
- **Logs.** The node writes only to standard error, so under systemd it is the journal:
  `journalctl --user -u unbrowse-node -f`. There is no log file.
- **Data and disk.** Everything is in `~/.unbrowse` (`UNBROWSE_HOME` moves it): settings, routes, the vault, the
  activity log, receipts, the devnet's chain, browser profiles, jars, kept bodies, and `versions/`
  (updates). On one long-running Linux node it was 65 MB (browser profiles 34 MB, browse records 30 MB), and the
  releases under `~/.local/opt` 2.0 GB. What fills a small disk is a source build's `target/` (26 GB there), not the node.
  `storage_gb` (default 4) bounds the route bodies the node keeps (`~/.unbrowse/bodies` and the routes made from
  fetched ones: the least recently used unpinned go first, its own and those used within a week never) and how many
  other nodes' routes it holds (one per 64 KB). It doesn't bound the rest of the data directory.
- **File versions.** Every file the node writes under `~/.unbrowse` (and its ad in `~/.unbrowse-network`) carries
  its format's version, `"v": n`: as a field beside the others in a file of named fields (`settings.json`), or as
  `{"v": n, "items": ...}` around a list or a jar. A file read forward from an older version keeps its old bytes
  beside it as `<name>.v<old>` (below). The formats, one entry a file, are `ALL` in
  `unbrowse-node/crates/files/src/lib.rs`; each is version 1 today. A node reads a file an older node wrote and moves it
  forward the next time it saves it. Left out, because their contents fix their form: route bodies (their bytes are
  their name), copies of answers (`answers/`), and one-value text files (`owner.token`, key files,
  `versions/current`, `passkeys.notice`).
- **A file a newer node wrote.** Run an older release after a newer one and the older node refuses each file whose
  format is newer than it knows. It says so on standard error, once a file: `… was written by a newer Unbrowse node
  (its format is version 2; this node reads up to version 1). It is left as it is and never written over`. Then:
  - `settings.json`: the node doesn't start. Running on the defaults could turn back on what you turned off.
  - Agent keys, receipts, what the node is owed and the lines it watches: whatever needs them fails with that message
    (no agent gets in, no fetch is paid), so nothing is numbered, signed or claimed over them.
  - Anything else (routes, held routes, the vault's index, jars, the peer table, pricing, telemetry and reports): the
    node goes on as if the file weren't there, and every write to it fails. Telemetry and bug reports read as off.

  Nothing is lost: update to the newer release again and it reads them all. To go on with the older release, move the
  one file aside (`mv ~/.unbrowse/held.json ~/held.json.newer`) and the node starts that file afresh. Don't move
  `agents.json`, `receipts/` or `owed.json` aside: your agents' keys and the lines you are owed are in them.
  A release from before file versions knows none of this. A file of named fields it still reads (it skips `v`), but a
  wrapped one it can't: `agents.json`, `receipts/` and `owed.json` stop it with an error, and the other lists
  (`vault.json`, `cards.json`, `held.json`, jars and the rest) read as empty and are written over the next time it
  saves them. Don't go back past the release that brought file versions.

  If you did, it is recoverable. Before a node reads a file forward from an older version, it keeps the file's bytes
  as they were beside it, as `<name>.v<old>`: `vault.json.v0`, `jars/<host>.json.v0`, `receipts/1-3.json.v0`. The copy
  is written once, whole, with the file's own permissions (0600 for the vault, cards, passkeys and jars), and never
  written over or read by the node. To restore a file an older build emptied:
  1. Stop the node (quit the app, or `systemctl --user stop unbrowse-node`).
  2. Copy the kept bytes back: `cp -p ~/.unbrowse/vault.json.v0 ~/.unbrowse/vault.json`, and the same for each file
     that read as empty (`cards.json`, `passkeys.json`, `held.json`, `vault.sealed.json`, `vault.sealed.keychain.json`, jars).
  3. Start the node of this release or later. It reads the file forward again; its copy stays as it was.

  The copy is what the file held the first time a node read it forward; anything added under the newer release since
  isn't in it. The activity log is only ever appended to, so it has no copy and needs none.
- **Updates.** A release build updates itself when npm serves it (§2), but that path is broken today (§10). Until it
  works, update by hand from the GitHub release: download `unbrowse-<version>-linux-<arch>.tar.gz` and `SHA256SUMS`,
  check the sum, unpack beside the others, point `current` at it, and `systemctl --user restart unbrowse-node`.
- **The port.** The node listens on 127.0.0.1:7788. If it is taken, the unit restarts in a loop; see
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

### Building the source on SteamOS

SteamOS ships no C headers and no clang, and `cc` there is a wrapper around `zig cc`. The BoringSSL build
(`btls-sys`, pulled by wreq for the Chrome-shaped transport) runs bindgen, which needs both a libclang and the C
headers. With zig at `~/.local/opt/zig-0.16.0`:

```sh
Z=$HOME/.local/opt/zig-0.16.0/lib
export LIBCLANG_PATH=$HOME/work/libclang/libclang-18.1.1.data/platlib/clang/native   # `libclang` wheel, unpacked
export BINDGEN_EXTRA_CLANG_ARGS="-isystem $Z/include \
  -isystem $Z/libc/include/x86-linux-gnu -isystem $Z/libc/include/generic-glibc \
  -isystem $Z/libc/include/x86-linux-any -isystem $Z/libc/include/any-linux-any"
```

- The `libclang` Python wheel (`pip download libclang`, or the wheel from PyPI unpacked with `unzip`) is enough: it
  carries `libclang.so`, and no root is needed. SteamOS's read-only rootfs has no `clang` to install into.
- Zig names the x86_64 glibc include dir `x86-linux-gnu` (not `x86_64-...`). `zig cc -target x86_64-linux-gnu -E
  -v -x c /dev/null` prints the exact list to pass; using only `generic-glibc` fails on `bits/wordsize.h`.
- `unbrowse-learn`'s integration tests (`learn_shop`) need the browser program built beside the node
  (`unbrowse-browser/cli`, `target/debug/agent-browser`) or `UNBROWSE_BROWSER` pointing at one. The unit tests
  (`--lib`) and the app's tests do not.
- A source build's `target/` is the disk eater (26 GB in one SteamOS build); the node's own data is tens of MB.

---

## 8. The wallets to fund

| Role | Key | Fund it with | Why |
|---|---|---|---|
| Gas wallet | `GAS_KEY` of the `unbrowse-rpc` Workers (keychain `unbrowse-gas` / `arc`, `0x60a3…7e05`) | USDC on each network: 0.10 a new member node, at most 20 a day | Unbrowse pays its members' gas (§4); it holds nothing else and has no power on chain |
| Deployer | the root key of the node that runs `chain deploy` | gas (the deploy checks for 2.25 USDC at 25 gwei before it starts, and uses less), plus the `--pool` seed: Arc USDC on testnet; Arc USDC and Unbrowse's UNB on mainnet | the deploy and the pool. It has no power afterwards: the pool, the DNSSEC trust anchors, the escrow wait and every route-coin number are fixed at deployment, and no function is its alone (R10.3, R1.10) |
| The curves' fee recipient | `UNBROWSE_<NETWORK>_FEE_RECIPIENT`, else the deployer; must be named on mainnet (§3) | nothing | the 1% trade fee of every route coin accrues to it, for good, and it has no other power. Nobody takes a share of fetch fees |
| Each node's key | the node's root key | nothing while local. Signed in on a live chain: a few cents of USDC once for its identity, from its owner (the sign-in page offers the transfer), and its deposit when its agents pay others | its writes, deposits and fees |
| Agent keys | derived from the root key | nothing | they sign vouchers, off chain |
| Owner wallet | Privy's or the owner's own | nothing | it signs the link, and receives withdrawals |
| Release key | `UNBROWSE_RELEASE_KEY` | not a wallet | signs the update manifest older nodes read, and is root 1 of the update metadata |
| Update root keys | offline, never in CI | not a wallet | sign each new update root (§2) |
| Targets and timestamp keys | `UNBROWSE_TARGETS_KEY`, `UNBROWSE_TIMESTAMP_KEY` | not a wallet | sign the update targets and timestamp, once root 2 names them |

On Arc testnet, USDC is free from https://faucet.circle.com. What every write costs is in [MONEY.md](MONEY.md) §2.

---

## 9. Go-live checklists

### Arc testnet

1. Fund the deployer's key with testnet USDC (gas and the pool's USDC seed).
2. `unbrowse-node chain arc-testnet`, then `unbrowse-node chain deploy --pool <usdc> <unb>` (§3).
3. Put the printed file in `unbrowse-node/app/networks/arc-testnet.json`; commit through a pull request.
4. Landing: `npm run deploy`; nothing on it names the deployment.
5. In `unbrowse-ai/unbrowse`, verify that `UNBROWSE_SITE` names the landing URL and `UNBROWSE_DEFAULT_CHAIN`
   is unset or `arc-testnet` for this testnet release (§1).
6. Release (§2). Check npm took it (§10).
7. On a fresh machine: install, learn and call a route with no account, then `unbrowse-node sign-in`, send the node
   the few cents `unbrowse-node wallet` asks for, and see the identity register and a route list.

### Arc mainnet

1. Fix npm publishing first (§10), so a mainnet node can be updated.
2. Fund the deployer with real USDC for the gas.
3. Set `UNBROWSE_ARC_MAINNET_UNB` and the `UNBROWSE_ARC_MAINNET_V4_*` variables to UNB's v4 pool on the deploying
   machine (§3), and `UNBROWSE_ARC_MAINNET_FEE_RECIPIENT` to the multisig the curves' trade fee accrues to, set `epoch_blocks` in the network's file to a day of mainnet's blocks, measured over the week before (§3; a small drift is accepted), check them with the fork tests, then `unbrowse-node chain arc-mainnet` and `unbrowse-node chain deploy`. The deploy refuses to deploy its own UNB,
   pool or USDC, to seed a pool, or to go without a named fee recipient (`chain::mainnet_guard`, §3).
4. Put the printed file in `unbrowse-node/app/networks/arc-mainnet.json`.
5. Landing: nothing to change for the deploy.
6. Repository variables: `UNBROWSE_DEFAULT_CHAIN=arc-mainnet`. Raise `MIN_VERSION` if testnet-era nodes must leave.
   A node a testnet release set up saved `arc-testnet` as its chain without its owner picking it (`chain_chosen`
   false): on its first start on the mainnet release it asks its owner, in the window's dialog, to move, and moves and
   restarts only on their yes (`chain::offer_chain`). A no or a headless node stays, and its log names `unbrowse-node
   chain arc-mainnet`.
7. Release, and check as for testnet.

---

## 10. Known gaps

Read from the live services on 30 October 2026.

- **npm doesn't take the releases yet.** Every publish of 13.x (v13.3.1 to v13.4.5) failed with `404 Not Found - PUT
  …/@unbrowse%2fdarwin-arm64`, so npm still serves `unbrowse@12.5.0`. Why, from the runs' logs and the registry:
  - npm has no `@unbrowse/darwin-arm64`, or any platform package. A trusted publisher is set in a package's settings on
    npmjs.com, so a package npm doesn't have can't have one, and its OIDC exchange fails. npm then publishes with the
    `.npmrc` token `setup-node`'s `registry-url` wrote, a placeholder, and the registry answers 404. The `@unbrowse` org
    itself exists.
  - `unbrowse@12.5.0` was published by trusted publishing from `unbrowse-ai/unbrowse`'s `release.yml`. That public
    workflow remains the publisher so npm can generate provenance.
  - The packages carried no `repository`, which trusted publishing needs to match the workflow's repository.

  The workflow now sets `repository` from the repository it runs in, drops `registry-url` so a failed exchange says it
  couldn't authenticate, and says in one message, before anything is built or tagged, every package npm doesn't have
  (`npm-preflight.mjs`, in the `version` job). **So no release runs past `version`, and no tag or GitHub release is made,
  until these are done.** Read on 6 November 2026, npm has `unbrowse` and none of the other eleven. What the owner does,
  once, as a member of the npm org `unbrowse`:
  1. Publish each of `@unbrowse/darwin-arm64`, `@unbrowse/linux-x64`, `@unbrowse/linux-arm64`,
     `@unbrowse/win32-x64`, their browser add-ons `@unbrowse/browser-darwin-arm64`,
     `@unbrowse/browser-linux-x64`, `@unbrowse/browser-linux-arm64`, `@unbrowse/browser-win32-x64`, and
     `@unbrowse/updates` once by hand (`npm publish --access public` of a placeholder `0.0.0` with only a
     `package.json`; nodes read exact versions, and `@unbrowse/updates`' first real version is `1.0.1`).
     `node .github/scripts/npm-preflight.mjs` says what is left.
  2. On npmjs.com, give each of those and `unbrowse` a trusted publisher: GitHub Actions, organization `unbrowse-ai`,
     repository `unbrowse`, workflow `release.yml`, environment `release`. The daily update maintenance workflow
     has its own trusted publisher configuration for `@unbrowse/updates`. A new publisher must publish within two days or it expires.
  3. Run the Release workflow by hand, or let the next release run. A trusted publisher can't be read from outside, so
     one left out shows only when `npm-publish.sh` is refused.
- **GitHub settings are external to this repository.** The workflows place signing and publishing jobs in the `release`
  environment and restrict release refs in code, but cannot require reviewers, constrain environment branches/tags,
  move secrets, or configure branch protection. Confirm the live settings with the owner checklist above. The previous
  audit observed `UNBROWSE_RELEASE_KEY` as a repository secret; checked-in code cannot confirm whether it has since
  moved to the environment.
- **Require the action-pin check in branch protection.** `.github/workflows/ci.yml` runs
  `python3 .github/scripts/check-pinned-actions.py --verify-upstream`, checking composite actions, sub-paths, and that
  each SHA is reachable from an upstream branch or tag. Configure the CI status check as required for protected
  branches in GitHub settings; a workflow cannot make its own check required.
- **Package provenance.** The release workflow publishes npm tarballs with `--provenance`. In npm package settings,
  enable trusted publishing for `unbrowse-ai/unbrowse`, workflow `release.yml`, environment
  `release`, and keep `--provenance` enabled. Browser downloads by the node are authenticated through the signed
  targets metadata and npm tarball integrity; npm postinstall no longer downloads a GitHub release binary. There is
  no PyPI publication job: wheels are attached to the GitHub release only. Before adding one, create a PyPI Trusted
  Publisher with owner `unbrowse-ai`, repository `unbrowse`, workflow `release.yml`, environment `release`, and
  grant that job `id-token: write`; do not add a PyPI registry token.
- **v13.4.2 was never published.** Its run built every platform, then `gh release create` got HTTP 500; the latest
  release is v13.4.1.
- **Root 2 still needs the owner ceremony.** Until root 2 (§2) is signed offline, committed and published, metadata
  tooling can use the release key for the initial root's online roles. After root 2 is active, it refuses that fallback.
  Root and targets each use 2-of-N Ed25519 keys, with separate keys for every role; root keys stay offline and never
  enter CI. Keep one targets key off CI or in a separately protected environment with independent reviewers; the
  current workflow cannot tell whether two GitHub secrets share one environment, so the owner must add the co-signing
  step before transition. The timestamp key is separate, valid for 7 days, and signed daily by `updates.yml`. The
  release key stops signing metadata roles after root 2;
  it remains for the legacy
  `manifest.sig` older nodes read. A stolen targets or timestamp key is revoked by signing root 3 offline; a stolen
  release key can then no longer move a node that has read root 2.
