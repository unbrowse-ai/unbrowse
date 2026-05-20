# Cloudflare Turnstile interactive port — wave-2 evidence

> Wave 2 of the "port Scrapling's interactive Cloudflare/Turnstile solver"
> investigation. The harness is `~/.claude/port-scrapling-s-interactive-
> cloudflare-turnstil/` (local-only, gitignored). This doc surfaces the
> ONE load-bearing finding from wave 2 into the tracked repo so future
> maintainers can find it without the harness.

## Wave-2 question

Does kuri's CDP `click` already accept raw `{x, y}` page coords, or
only a CSS selector / snapshot ref?

## Answer

**No.** Kuri exposes selector-only click. The CDP constant
`Input.dispatchMouseEvent` is declared in
`submodules/kuri/src/cdp/protocol.zig:111` but has zero callers
anywhere in the dispatch path.

## Evidence (re-runnable)

```
$ git -C submodules/kuri grep -n "Input.dispatchMouseEvent" src/
src/cdp/protocol.zig:111: pub const input_dispatch_mouse_event = "Input.dispatchMouseEvent";
src/test/integration.zig:684: (test assertion on the constant)
src/cdp/protocol.zig:172: (test assertion on the constant)

$ git -C submodules/kuri grep -n "mousePressed\|mouseReleased\|coords" src/
# 0 matches
```

## What kuri's click path actually does

- `submodules/kuri/src/server/router.zig:926` `handleAction` is the
  `/action` entry. For `kind == .click` it requires `ref` (snapshot id
  like `e0`/`e1`) — see L960-L963: "Missing ref parameter (e.g. e0,
  e1)". No coord branch exists.
- `ref` is resolved via the bridge's `snapshots` cache to a
  backend_node_id (L944-L952), which is resolved to an `objectId`.
- The actual click runs as
  `function() { this.scrollIntoViewIfNeeded(); this.click(); return 'clicked'; }`
  via `Runtime.callFunctionOn` (router.zig:1077). This is
  `HTMLElement.click()` — a synthetic PointerEvent with
  `isTrusted=false`.
- TS wrapper in `src/kuri/client.ts:1759-1762` is
  `click(tabId, ref, state)`; the underlying `action()` (L1746-L1756)
  posts `{ tab_id, action, ref, value? }` to `/action`. No coord
  parameter is exposed at any layer.

## Why this blocks the Turnstile port

Scrapling's algorithm (see `references/SCRAPLING-MECHANISM.md` in the
harness, deepwiki source_id `db740b47-bcc4-4c0e-a993-1e5693c86359`)
relies on `Input.dispatchMouseEvent` with `mousePressed`+`mouseReleased`
at random coords inside the iframe's bounding box. The whole point of
that path is that `HTMLElement.click()` does NOT clear Turnstile —
Cloudflare gates the widget on `event.isTrusted`, and synthetic
`this.click()` via `Runtime.callFunctionOn` yields `isTrusted=false`.

Same gate blocks any pure-TS workaround through `/evaluate` (JS in the
page) or `/drag` (same JS event dispatch shape). So "Option B" from
the wave-1 spec (pure-TS port using existing kuri primitives) is
empirically not viable.

## Wave 3 requires a kuri-side primitive

Wave 3 cannot ship until a coord-click primitive lands in kuri Zig.
Proposed surface (kept generic — no Cloudflare verdict in Zig):

- New endpoint `/click_coords?tab_id=X&x=N&y=N&button=left&delay_ms=N`
  in `submodules/kuri/src/server/router.zig` next to `handleAction`.
- Handler sends, via existing `client.send`:
  1. `Input.dispatchMouseEvent` `type=mousePressed`, `x`, `y`,
     `button="left"`, `clickCount=1`.
  2. (after `delay_ms` jitter) `Input.dispatchMouseEvent`
     `type=mouseReleased`, same coords.
- Optional `type=mouseMoved` before pressed.
- New TS wrapper `clickCoords(tabId, x, y, opts?)` in
  `src/kuri/client.ts` posting to `/click_coords`.
- Zig test that asserts the two `Input.dispatchMouseEvent` sends.

Once the kuri delta lands and is re-vendored, wave 3 implements
`classifyCloudflareInteractive` (pure) + `solveCloudflareInteractive`
(driver) in `src/execution/cf-interactive.ts`. Until then, wave 3 is
primitive-blocked — not a posture issue.

## Sub-question still open for wave 3

Chrome's CDP `Input.dispatchMouseEvent` takes viewport-level `x`/`y`,
not frame-relative. So the TS layer must compute the iframe bounding
box in viewport coords *before* calling `clickCoords`. The iframe-bbox
read still needs `Runtime.evaluate` with sub-frame
`executionContextId`. Track separately.

## Source IDs

- `code:submodules/kuri/src/cdp/protocol.zig#L108-L111`
- `code:submodules/kuri/src/server/router.zig#L926-L1000`
- `code:submodules/kuri/src/server/router.zig#L1077`
- `code:src/kuri/client.ts#L1746-L1762`
- `code:src/execution/cf-challenge.ts` (orthogonal bundle-replay path,
  unchanged by this port)
- `deepwiki:db740b47-bcc4-4c0e-a993-1e5693c86359` (Scrapling mechanism)
