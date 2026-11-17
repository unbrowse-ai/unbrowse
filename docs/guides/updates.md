# Updates and versions

A node installed from a release keeps itself current, releases reach nodes in stages, and the network can require a
minimum release. All of it is `unbrowse-node/app/src/update.rs`; how a release is cut and the metadata is signed is
[OPERATIONS.md §2](../OPERATIONS.md#2-cutting-a-release).

**Until npm takes the releases** ([OPERATIONS.md §10](../OPERATIONS.md#10-known-gaps)), no released node finds an
update there; each says `update: https://registry.npmjs.org/@unbrowse%2fupdates/latest: 404 Not Found`. Until then,
update by hand from the GitHub release.

## How a node updates

Only a build the release made updates itself (`UNBROWSE_RELEASE` at build time); a node built from source never does.
The owner can turn it off: **Settings**, **Keep up to date** (`auto_update`). Otherwise the node checks when it starts,
every six hours (`update::run`), and when the owner runs `unbrowse update`:

1. It reads the update metadata, `@unbrowse/updates`, from npm (`UNBROWSE_REGISTRY`, by default
   `https://registry.npmjs.org`), and checks it (below).
2. It works out its channel and the release that channel runs.
3. It downloads that release's package for this machine, checks its sha512 against the metadata, and unpacks it into
   `~/.unbrowse/versions/<version>`.
4. It restarts into it once no call is in flight, waiting an hour at most. It leaves the peer network first
   (`peers::leave`), so its peers hear it go and the new release is admitted afresh.

A node started from an older install runs the newest version unpacked there instead (`update::run_newest`).
`unbrowse restart` restarts the running node the same way, leaving the peer network first, into that newest version or
the same one.

## The metadata, and what it defeats

The metadata is shaped after TUF, The Update Framework: three roles, each its own keys and its own file.

| Role | Says | Signed by | Expires |
|---|---|---|---|
| root (`root/<N>.root.json`) | each role's keys, and how many must sign | enough keys of the root before it, and of its own | when the owner sets, a year by default |
| targets (`targets.json`) | each release a channel names, with each machine's package and its sha512; `stable` and `canary`; the canary share; a halt; `min_version` | the targets key | a year, re-signed at every change |
| timestamp (`timestamp.json`) | which targets file is current, by version and sha256 | the timestamp key | a week, re-signed every day |

A node keeps the newest root, timestamp and targets it has checked (`~/.unbrowse/versions/trust.json`). It refuses:

- **an expired timestamp or targets.** A mirror that keeps serving the metadata it had can hold a node back a week at
  most, and the node says so (`update: the update metadata's timestamp expired …`);
- **older metadata than it has checked**, however well signed: no rollback of the metadata;
- **an older release than it runs**: a channel moved back is never followed down;
- **anything not signed by enough of the keys the newest root names.** A root follows its predecessor only one version
  at a time, signed by enough keys of both, so a node follows a key rotation and a stolen key that is rotated out
  signs nothing more. What it signed before the rotation stops counting too.

The root a node trusts first is built in (`builtin_root`): Unbrowse's release key for every role, which it alone
signed with before the metadata. Root 2, made and signed offline by the owner, hands each role keys of its own.

Other guards: every read from the registry is bounded (`MAX_ANSWER`, `MAX_PACKAGE`, `MAX_UNPACKED`, `MAX_MANIFEST`,
`MAX_ROOTS`), and a package unpacks to files and folders only: a link, or a path that would land outside its folder,
is refused.

## Channels and staged rollouts

Canary runs one release at a time; stable keeps the release it ran until canary's is promoted, by hand or by the daily
refresh once it has run two days unhalted. A release made in those two days waits, the newest only, and takes canary
when the one before it goes to stable. A node runs:

- the channel its owner picked (`unbrowse update channel stable|canary`);
- else canary when a hash of its identity and the release falls within the canary share (`update::bucket`, 10% to
  start), else stable. The same node lands in the same place at every check of one release, a raised share only adds
  nodes, and the nodes on one release's canary aren't every release's. No server decides. A node whose key isn't
  open yet is on stable.

A halt in the targets stops every node fetching a release, on both channels, until it is lifted. Time halted doesn't
count towards the two days, and while halted the newest release takes canary at once, so a fix doesn't wait. A canary
node runs the newer of canary's and stable's releases.

## The network's minimum version

The targets carry `min_version`, from [`unbrowse-node/MIN_VERSION`](../../unbrowse-node/MIN_VERSION) (13.0.0 now), once
stable runs that version: a minimum above stable's release would leave most nodes off the network with nothing to
update to. Raising it is how a change older nodes can't mix with reaches all of them:

- a release node older than it stays off the peer network until it updates;
- peers tell each other their release over Identify (`unbrowse/<version>`), and a peer older than the minimum, or one
  that doesn't say, never counts (`crates/net/src/node.rs`, [NETWORK.md §2](../NETWORK.md#2-who-counts-admission)).

Moving from the single manifest older releases kept to the metadata never lowers it.

## Readiness

`GET /v1/health` says whether the node is alive and whether it is ready, each part apart: the payment network
(`chain`) and its contract (`settlement`), its root key (`keys`), the identity that key makes (`identity`), and the
peer network (`network`). The node joins the peer network, where it announces sites and serves bodies, only once
payments and its key are ready, so a node on a network where payments aren't open yet answers its owner and its
agents but serves nothing to other nodes.

## What the window shows

Settings, **Keep up to date**, says where updates stand (`update_status`): the version running and the latest on its
channel, a version ready to restart into, a check under way or the last check's error, a halted rollout, that a build
from source doesn't update itself, or that the node is older than the network takes.
