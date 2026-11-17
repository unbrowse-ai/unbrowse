# kept-manifest-pair-never-lowers-min-version

**Focus:** 8 Lifecycle Transitions (update), 3 Failure Recovery. **Confidence:** high. **Status:** confirmed defect by scratch probe (commit 91115204). Release builds only.

## Property

The `min_version` a node enforces (`update::min_version`, used for `below_minimum` and `Config.min_peer_version`)
never decreases across crashes, full disks and restarts: an older signed manifest never replaces a newer one.

## Claimed guarantee

`update.rs:358-359` (`keep`): "An older one, even signed, never takes its place: a registry (or someone answering for
it) that serves an old release can't lower the network's `min_version` here." The repo's test
`a_newer_release_is_fetched_checked_and_unpacked` (`update.rs:540-546`) checks this with a clean file pair.

## Code path

- `keep` (`update.rs:360-369`): `if kept_by(key, versions).is_some_and(|k| newer(&k.version, &m.version)) { return }`,
  then **two plain `std::fs::write`s**, `manifest.json` then `manifest.sig`.
- `kept_by` (`update.rs:143-147`): reads both and verifies. Any mismatch or error gives `None`.
- So once the pair doesn't verify, the guard `is_some_and(..)` is false, and the next manifest is kept whatever its
  version.
- A pair stops verifying when:
  - the node is killed after `File::create` truncates `manifest.json` and before its bytes land (`std::fs::write`
    is truncate then write);
  - it is killed between the two writes (new `manifest.json`, old `manifest.sig`);
  - a write fails part-way (ENOSPC on a filesystem that can't reuse the truncated block at once).
- An update `hand_over` (`update.rs:192-206`) is not a trigger here: `keep` runs on the update thread before any
  handover.

## Probe (scratch copy, not the repo)

`life-probe/unbrowse-node/app/src/update.rs`, test `probe_a_torn_kept_manifest_lets_an_older_release_lower_the_minimum`
(registry stub as in the repo's own test, test key):
1. `check` against 13.2.0 (min 13.1.0): kept min is 13.1.0.
2. `manifest.json` truncated to 0 bytes (the state a kill after the truncate leaves): `kept_by` gives `None`.
3. `check` against a signed older 13.1.5 (min 13.0.0):
   `minimum after the tear = None; after an older signed release = 13.0.0`.

On a 4 MiB HFS+ RAM disk filled to ENOSPC, `keep` of a newer manifest **succeeded**: the rewrite reused the truncated
block (`probe_a_full_disk`). So on that filesystem the full-disk trigger didn't tear the pair. The kill-mid-write
trigger stands.

## Related lifecycle facts checked (not defects)

- `versions/current` (`update.rs:354`, plain write): a tear leaves it empty or unparsable, so `waiting()` returns
  `None`, the platform package's binary runs, and the update check at start (`update.rs:372-376`) unpacks and names it
  again. That is a temporary downgrade, not an outage. The stage-1 lead "non-atomic `versions/current`" is real but
  benign.
- `check` never deletes the running version: `remove_dir_all(&dir)` removes `versions/<new>` only, after a full
  unpack into `<new>.partial` (`update.rs:345-354`). The deck incident ("the update deleted the old version and left an
  empty new one") doesn't match this code at 91115204. There is no `unbrowse update` command in `cli.ts` or `unb.rs`,
  though `api.rs:899` tells users to run it. The likely path is `npm install -g unbrowse` (README) on a full disk,
  which is npm's own reinstall. The launcher (`cli.ts:56-68`) never falls back to `~/.unbrowse/versions/<current>` when
  the platform package's binary is missing. Not validated: no logs.
- `program()` checks only `is_file()` (`update.rs:165-168`). A truncated binary fails `exec`, and `hand_over` logs and
  keeps running the old one (`update.rs:196-200`).

## Antithesis angle

Not in the six-container topology (`UNBROWSE_RELEASE` builds only, `update.rs:94-96`). Test with the unit-level update
harness the topology names (`update::check(reg, key, ...)` against a local registry), killing the process at random
points with node termination, or by a custom fault that SIGKILLs during `check`. Assert after each restart.

## Instrumentation (none exists)

- Harness, **missing**: `Always(min_version after restart >= max min_version ever kept)`.
- SUT, **missing**: in `keep`, `Unreachable("kept manifest replaced while the old pair didn't verify")` on the branch
  where `manifest.json` exists but `kept_by` is `None`. This is the state that disarms the guard.

## Open questions

- Was the deck incident on a build older than 91115204, or through npm? It decides whether a launcher-level property
  ("`unbrowse start` runs a node whenever a complete version is on disk") belongs in the catalog.
- On ext4 (the Antithesis containers), can a full disk tear `manifest.json`? Blocks freed by the truncate may not be
  reusable until the journal commits.
