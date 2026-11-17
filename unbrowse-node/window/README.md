# Unbrowse window

The node's native window, in Zig on [nanoui](https://github.com/justrach/nanoui). It talks to the node on 127.0.0.1
with the owner's token, starts the node if nothing answers, and leaves it running when it closes: agents keep working
without the window.

Screens (`src/screens/`): first run (the terms and keeping the node off the network, before all else), overview, routes, the live walk, the browser (a site's page to click and type on when it
needs the owner, `hands.zig`), activity, access (agent keys), the vault (logins, card limits) and settings (the per-fetch maximum among them).

## Build and run

Zig 0.17. The window builds and runs on macOS, Linux (GTK 4) and Windows.

```bash
zig build run
zig build test
zig build app                                  # zig-out/Unbrowse.app: the window with its icon, for the Dock and Finder (-Dversion=1.2.3 stamps it)
```

`Unbrowse.app`'s icon, and the Dock icon the window sets when run bare, are drawn from the U-magnet by
`../app/icons/make.sh`.

## Licence

[Apache-2.0](../../LICENSE).
