# Signed route replay: running a site's own code instead of opening a browser

A walk learns a route as a graph of steps: each request's values are classified
(`Class` in `crates/learn/src/graph.rs`) as an `Input` the caller supplies, a
`Constant`, a `Derived` value read from an earlier response, a `Minted` session
value, or `Computed` — "made by the page's own code; only a browser can produce
it". A step with any `Computed` field sets `needs_browser`, and replay answers
`ReplayError::NeedsBrowser`; the client then runs that step in a real browser
(`BrowserMint::execute`) instead of plain HTTP.

That fallback is why anti-bot sites are slow: every call opens a page and lets
Chrome make the request. The fix is not to re-implement the site's protection by
hand. It is to keep the producer the walk already ran, and run it again at replay
time with the same inputs — a script step in the route's value graph.

## What the producers look like (measured)

From a captured Trip.com walk (`sg.trip.com/flights/showfarefirst`, 2026-11-07),
the signed call and the code that signs it:

```
POST /restapi/soa2/27015/FlightListSearchSSE
x-ctx-wclient-req: b7a77f7a43d23f0e78419e3d86a7daf9
w-payload-source:  1.0.9@102!GrqSwqhm6XkbO2tZ+XGn+64...
x-ctx-fvpc:        U2FsdGVkX18mNUD8echD6P5fap55+3ldMqkZy7uS2IJE...   (CryptoJS AES, "Salted__")
token:             1001-common-16XWQcYgDwXDwALI3HWdDyM0wmHwa7vnoJ45YU1WbmEB...
```

`crates/learn/examples/sign_probe.rs` prints the producer for any header from a
capture:

```
producer: https://ak-s-cw.tripcdn.com/modules/ibu/online-flight/common.8cb00a92ce.js @ 247440
var l=(0,b.md5)("".concat(u,";").concat(e.method,";").concat(n,";")
  .concat(i.GUID||"",";").concat(i.UBT_VID||"",";").concat(i.DUID||"",";").concat(i._RF1||""));
e.headers["x-ctx-wclient-req"]=l
```

`u` is `pathname+search`, `i` is the page's UBT identity store
(`(0,y.U)()`), and `n` is a caller-supplied value. Siblings in the same bundle:

```
w-payload-source  = window.c_sign.toString(md5(request body))     // the cSign module's toString
x-ctx-fvpc        = window.FVPC                                    // set by the fingerprint script
x-ctx-ubt-vid     = window.UBT_API.push({type:"get",data:{name:"batHeader",sync:true}})
```

So one call's signature headers depend on four things: the request (URL, method,
body), the page's identity globals (GUID, UBT_VID, DUID, _RF1), the site-issued
`token`, and the vendor module (`c_sign`, FVPC). That is the dependency graph the
replay has to keep — not a set of headers to copy.

## The shape of the fix

1. **Capture the producer, not the value.** While walking, record for every
   `Computed` field: the script that writes it (URL + byte offset, as
   `sign_probe` finds), and the globals it reads (identity headers, `window.FVPC`,
   the loaded vendor module's URL). The walk already keeps the script bodies in
   its capture; a small prelude (`Page.addScriptToEvaluateOnNewDocument`) can
   snapshot the identity store and `window` keys the producers close over.

2. **A new class: `Class::Script { producer, needs }`.**
   - `producer`: script URL + offset + the call's entry (the function that writes
     the header), or a captured vendor module.
   - `needs`: the values the producer reads, each already a graph value — the
     request body (`Input`), the token (`Derived`), the identity ids
     (`Minted`/`Constant`).
   `needs_browser` becomes `needs_script` (`Script`), and the route stays a plain
   HTTP route with one extra evaluation.

3. **Evaluate in a sandbox, in dependency order.** The graph already orders steps
   by dependency; script fields add one node before the request. Two runtimes,
   behind one trait:
   - **Extracted producers** (Trip.com's `x-ctx-wclient-req`: an MD5 over a
     template) run in an embedded JS engine or, where the producer is simple
     enough, in Rust — no DOM needed.
   - **Whole-bundle producers** (`window.c_sign`, Radware's `_abck` sensor) run
     the captured scripts in a DOM-shimmed runtime (quickjs + shims, or a warm
     hidden tab over CDP) that intercepts `fetch`/`XHR`, so the page's own code
     produces the headers for the request being replayed.

4. **Verify, and fall back.** After a script-signed call, the site's status is the
   proof: 200 means the producer reproduced what the walk had. A 4xx/challenge
   marks the producer stale, the route heals by re-walking (`needs_browser` again
   for that step), and the eval bank records the slow path rather than hiding it.

## Feasibility, per site (measured or read from the bundles)

| Site | What signs the call | Path |
|---|---|---|
| Trip.com | `x-ctx-wclient-req` MD5 template; `w-payload-source` via the `cSign` module; `x-ctx-fvpc` a per-session AES blob; `token` from `getConfiguration` | Extracted producer for the MD5; sandboxed `cSign` for the payload; `FVPC`/`token` captured per session |
| eBay | Radware bot manager (`_abck`/`bm_sz` cookies, sensor payload) | Whole-bundle replay in a DOM-shimmed sandbox; fragile, time- and interaction-bound |
| OpenTable | Bot-management challenge cookie on the results call | Same class as eBay; check which vendor before building |
| Amazon | No request signature; the answer is page state (`rhfHandlerParams`) | Already handled by page-state learning, not signing |

## Phases

1. **Evidence and tooling (done).** `sign_probe` reads a capture and prints
   the producer, its code and the values it signed. A live capture is the input to
   every later step.
2. **A producer for one header, end to end.** Trip.com `x-ctx-wclient-req`:
   extract the template, fill it from the route's values and captured identities,
   assert an exact hash match against the walk, then a live 403 → 200.
3. **`Class::Script` in the graph (done).** `signing::discover` runs at route
   build: every `Computed` header a walked script names becomes
   `Class::Script { producer: { script, at } }`, the step stops needing a browser,
   and replay asks `Fetch::sign_request` once the request stands. A transport with
   no bridge answers `None` and the step goes to the browser exactly as before, so
   no route changes behaviour until a bridge exists. Steps, recipes and sharing
   treat a script value as the page's (a shared route says "browser-made").
4. **The bridge runtime (done).** Two runtimes behind one seam, chosen by the
   bundle, never by the site:
   - **`crates/learn/src/sandbox.rs`** boots the captured scripts in a Node sandbox
     with shimmed `window`, `document`, storage, timers, `fetch` and `XHR`, and reads
     back the request the page's code made. `SIGNING_PROGRAM` names the runtime
     (default: `node` on the path); a machine without one, or with one whose permission
     model can't deny a page's code child processes and the network (Node before 25),
     answers `None` and the step goes to the browser as before. It answers the page's **whole request** (URL,
     headers, body), because a signature is bound to the body the page made it for.
     The page's code is the site's, and adversarial: it runs **confined**, each layer
     denying on its own. The child process runs under the runtime's permission model
     (no file past the run's own folder, no write, no process, no worker), under the
     OS sandbox (a deny-by-default profile on macOS; on Linux a landlock ruleset for
     files and a seccomp filter refusing every socket and every new process), with an
     empty environment, a fresh private folder (0700, files 0600, removed after the
     run), and wall-time, CPU and memory limits the node enforces by killing it. Each
     layer is shown to deny by itself before any page code runs: the probe tries a
     file outside the run, the owner's home, a write anywhere, a process, a TCP, Unix
     and (Linux) abstract socket, and on macOS a mach service lookup, under the OS
     layer with the runtime's model off and under the runtime's model with the OS
     layer off. A platform where a layer can't be shown to hold alone (Windows has no
     OS layer) runs no page code: the step goes to the browser. Inside it the page's realm holds no object of the runtime's
     (the shim and the platform it offers are made in that realm), so no
     constructor, error or stack frame leads back to the process. Its only way out
     is a line to the node, which fetches for it only the page's own site, over
     HTTPS, at a public address checked where it connects; never the owner's
     machine or network. For a route that came from another node it fetches only
     an origin the route's graph names, every redirect hop included, as each step
     of the call is held (`client::Runner::page_asks`): another host of the same
     site may be someone else's, and the page's script may hold owner material. There is no real-DOM mode: a DOM module is the runtime's
     own code, and every object of it leads back to the process.
   - **`BrowserMint::signed_page`** is the warm-page bridge for bundles that render
     through a real DOM (a framework app makes no calls in a shim): the page is
     opened in the browser the node already has for the site, at the route's page
     with the caller's values in its address, and its network log is read back as
     those same `Signed` requests. One page load per call, not per step.
   The runner tries the sandbox first, then the page, caches by `METHOD path`, and
   applies what the page sent. Measured: Trip.com's route, learned from one walk,
   answers `ok` through plain HTTP for several city/date pairs (79, 74 and 49
   itineraries), with `x-ctx-wclient-req`, `w-payload-source`, `x-ctx-fvpc` and
   `token` coming from the page's own call.

   Two rules make that work generally:
   - A header the page set **replaces** the route's value of the same name; a stale
     value left in front of a signature is a signature the site reads as wrong.
   - A call the page does not make, whose answer **nothing later needs**, is skipped
     (`Graph::feeds_later`): the route goes on as a browser that never made that call
     would. A call a later step reads from is not optional, and still walls.

5. **Eval coverage.** The bank's `trip.com` case (SSE + signed call) must pass as a
   `called` route; a regression here means the producer went stale and the route
   should heal instead of silently falling back.

## Risks to design around

- **Fragility.** A producer is a copy of the site's own code; it rotates. The route
  must heal (re-walk) on rejection, or a stale producer is worse than the browser
  fallback.
- **Terms and law.** These are anti-bot controls. Keep replay to public, read-only
  data at human rates; never use it for signed-in or paid content, and make it
  per-site opt-in. Some jurisdictions and site terms treat circumvention as a
  violation regardless of intent.
- **Cost.** A sandboxed bundle costs milliseconds-to-seconds and memory per site;
  keep runtimes pooled and per-site, and never pay it for sites with no signature.
- **TLS binding.** Some vendors bind the payload to the TLS/JA4 the browser
  presented. The engine's transport already presents the browser's handshake
  (`ChromeFetch`); a producer learned under one transport is only valid under the
  same one.
