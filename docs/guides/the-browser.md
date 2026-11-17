# The browser add-on

The node runs without a browser. Search, calls of routes it holds or fetches from other nodes, `whoami`, `logins` and
every owner command need none, so an install brings none and downloads no Chrome. The browser arrives the first time
something needs it.

- [1. What needs the browser](#1-what-needs-the-browser)
- [2. Getting it](#2-getting-it)
- [3. browser_missing](#3-browser_missing)
- [4. Keeping a call off the browser](#4-keeping-a-call-off-the-browser)
- [5. Older nodes and older clients](#5-older-nodes-and-older-clients)

---

## 1. What needs the browser

The browser has two parts (`app/src/browsers.rs`):

| Part | What it is | What needs it |
|---|---|---|
| A Chromium | Chrome, Brave, Edge or another Chromium installed here, else Chrome for Testing the node downloaded | a walk: `do` with a `url` no route does yet, when a plain request for the page doesn't answer the goal; and a route healing its session |
| The browser program | `agent-browser`, the engine's CLI, which drives a page by hand | `browse`, and `do` when the page needs clicks or typing |

`unbrowse browser status` says which the node has. `whoami` tells agents `browser: present | missing | installing`
and `browser_fetch`, whether the node fetches it itself.

`UNBROWSE_SYSTEM_BROWSERS=0` keeps the node off the browsers installed on the machine: it uses only the Chrome for
Testing it downloaded. Use it for a node that must never drive its owner's own Chrome (a server, a sandbox, a test).

## 2. Getting it

| How | What happens |
|---|---|
| The node fetches it (`fetch_browser`, on by default) | The first goal that needs the browser waits while the node fetches what it lacks (up to 240 s), then goes on. Turn it off with `unbrowse browser fetch off` |
| A site refuses the headless browser | The walk asks again in a clean browser, then in one with a window, which passes doors a headless browser can't. On a server or in a test bank, `unbrowse browser headless on` (or `UNBROWSE_HEADLESS=1`) stops the window: such a walk answers `how: browse` or says why it can't |
| `unbrowse browser install` | The same, now, from a shell. A program the node has already (beside it, `UNBROWSE_BROWSER`, or installed before) is kept |
| `unbrowse browser install --from <path>` | The program at `<path>`, or the browser package's tarball there, instead of the release's: for a machine with no registry, or a build from source |
| `UNBROWSE_BROWSER=<path>` | The node drives that program, when it is there |

The browser program comes from the release the node is: `@unbrowse/browser-<machine>` on npm, at the node's own
version, checked against the release's signature before it is kept (`update::browser_tarball`: the package the update
metadata names, else the one the release's signed manifest names). It goes in `~/.unbrowse/addons/browser/`. When
there's no Chromium, the program then downloads Chrome for Testing into `~/.agent-browser/browsers`.

`unbrowse browser remove` takes away the program the node installed; `--chromium` takes Chrome for Testing too. A
program that came with the install, or that `UNBROWSE_BROWSER` names, stays, and so does a browser installed here.

An install from before the browser was an add-on keeps the browser it has: the program sits beside the node, and the
node finds it there first. When such an install updates into a release whose node no longer carries it, the update
fetches the new release's browser package into `addons/` (or, failing that, copies the one it had), so browsing works
after the restart.

## 3. browser_missing

A goal that needs the browser the node lacks is answered at once with HTTP 422, the status a browser that couldn't do
it has always had, and the node's own code:

```json
{
  "error": "this needs the node's browser: the node's browser isn't installed (neither its browser program nor a Chromium). To get it, run `unbrowse browser install` on the node's machine, or set UNBROWSE_BROWSER to the browser program",
  "code": "browser_missing",
  "browser": "missing",
  "missing": ["program", "chromium"],
  "install": "unbrowse browser install",
  "fetch": false
}
```

`browser` is `installing` while the node fetches it: try again in a minute. Over MCP the same object is the tool's
error text. The SDKs raise `BrowserMissingError` (an `UnprocessableEntityError`) with `missing`, `install`, `browser`
and `fetches`. Nothing hangs: with fetching off, or the call saying `if_present` or `never`, the answer comes back
before anything is launched.

## 4. Keeping a call off the browser

`do` takes `browser`: `auto` (the default, as before: the browser when the goal needs it, fetched first when the node
lacks it and its owner lets it), `if_present` (only a browser the node has already) or `never` (only a route, another
contributor's route or a plain request; a goal that needs more answers `browser_missing`). `never` keeps the call from
walking a page or opening one; a route the node holds may still heal its session by walking its page again when the
node has a Chromium.

## 5. Older nodes and older clients

The network is peer to peer and not every node or client updates at once. Each combination works:

| | New client | Old client |
|---|---|---|
| **New node** | `BrowserMissingError`; `capabilities()` reads `browser` | the 422 reads as `UnprocessableEntityError`, as a browser that couldn't do it always did, with the install hint in its message |
| **Old node** | `capabilities()` says `browser: "unknown"`; `browser: "never"` is refused by the client before it's sent, since the old node would read past it | as before |

None of this crosses between nodes: peers exchange routes and listings, never the browser, so a node without one serves
and fetches routes as any other does.
