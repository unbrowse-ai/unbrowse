# Unbrowse window

The node's native window, in Zig on [nanoui](https://github.com/justrach/nanoui). It talks to the node on 127.0.0.1
with the owner's token, starts the node if nothing answers, and leaves it running when it closes: agents keep working
without the window.

Screens (`src/screens/`): first run (the terms and keeping the node off the network, before all else), sign-in (on a new node, after the terms; skippable), overview, routes, the live walk, the browser (a site's page to click and type on when it
needs the owner, `hands.zig`), activity, access (agent keys), the vault (logins, card limits) and settings (the per-fetch maximum among them).

## The node's types

`src/wire.zig` is generated from the node's API (`unbrowse-sdk/codegen/generate.py`, from `unbrowse-node/agent-api.json`):
every record, every owner command and what it answers. Never edit it by hand. `src/types.zig` holds the window's
views: a record a screen reads whole is the node's own (`pub const Activity = wire.Activity`), and one the window reads
part of, or shows with its own defaults before the node answers, is a view of it. `zig build test` holds every view,
and every resource the window caches (`Res`), to what the node sends, and fails naming the field where they part. So
a change to the node's API shows up here as a build error, not as a screen that reads nothing.

## Build and run

Zig 0.17. The window builds and runs on macOS, Linux (GTK 4) and Windows.

```bash
zig build run
zig build test
zig build app                                  # zig-out/Unbrowse.app: the window with its icon, for the Dock and Finder (-Dversion=1.2.3 stamps it)
zig build test-bin                             # zig-out/bin/window-tests, built by LLVM and not run: for kcov
```

Line coverage is reported apart, never gating (`coverage.yml`, job `window`): the tests from `test-bin`, run under
kcov, counting `src/` without `tests.zig`.

`Unbrowse.app`'s icon, and the Dock icon the window sets when run bare, are drawn from the U-magnet by
`../app/icons/make.sh`.

## Licence

[Apache-2.0](../../LICENSE).
