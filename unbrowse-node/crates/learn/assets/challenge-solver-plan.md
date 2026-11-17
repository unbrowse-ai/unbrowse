# The computational solver: recompute, don't reverse

The cipher is obfuscated but deterministic JS. So the solver executes the
challenge's own encoder in our sandbox against our own identity — Tier A/B
from the design: the browser becomes a calibrator (once), the solver does
every subsequent door.

## Architecture

```
1. fetch      orchestrate/chl_page + ci chunks + challenge config  (ChromeFetch)
2. sandbox    Node/V8: load the orchestrate with an environment shim that
              answers every probe with OUR identity (see solver-env.js)
3. intercept  XMLHttpRequest shim: the encoder calls send(blob) — we keep
              the blob instead of sending it
4. post       fo/flow blobs over ChromeFetch (JA4 transport, honest UA)
5. harvest    clearance/acceptance into the jar; RouteClient proceeds
```

## The shim's contract (mined from the vocabulary + live state)

The encoder probes (decoded vocabulary, 2871 words; the live frame showed
RTCPeerConnection+SDP collection and the type map `tL`):

- navigator: userAgent, platform, languages, plugins, mimeTypes,
  cookieEnabled, hardwareConcurrency, deviceMemory, webdriver (undefined),
  getBattery, maxTouchPoints
- document: createElement/createElementNS, cookie, referrer, visibilityState,
  querySelector(All), documentElement, fonts (measureText via canvas)
- canvas 2d + WebGL: toDataURL, getImageData, getParameter
  (UNMASKED_VENDOR/RENDERER), extensions
- WebRTC: RTCPeerConnection, createDataChannel, createOffer, localDescription,
  the SDP string (the live frame held 'v=0 ... IP4 127.0.0.1')
- timing: performance.now, Date, PerformanceObserver
- crypto: getRandomValues, randomUUID
- storage: localStorage/sessionStorage (try/catch shapes)
- network (shimmed to capture): XMLHttpRequest.open/send/setRequestHeader,
  fetch, Worker

Identity values come from `fingerprint-noise.js`'s data set (a coherent
machine: M-series Mac, stable canvas hash, stable WebGL renderer) — stable
per identity, as a real machine is.

## What is already solved (this session)

- format: `$`-separated pairs of 16-byte blocks (49 static literals; the
  runtime `qrht8` array holds them per build)
- vocabulary: reversed strings, decoded (`challenge-vocabulary.json`)
- key material: cH, cN, cITimeS, cFPWv, cUPMDTk readable at the breakpoint
- the channel: `ci` = 5-byte key rotation, trigger = one OS click
- capture: dumper yields static blocks + wire blob + named session state
  in one pause (`cdp_scope_dump.py`)

## Where the sandbox stands

`solver-run.js <challenge.html> <orchestrate.js>` runs the challenge's own
encoder in Node against `solver-env.js`. The two files must come from the
**same challenge response** — the orchestrate is per-request (`?ray=`), and a
cross-session pairing changes what the VM does. The runner finds the shared
`typeof x !== <type>` cast in whatever build it is handed (the minifier
renames it every fetch) and records the value it refuses, so a failure names
itself.

Measured: the orchestrate evaluates and runs deep into the encoder — 31k
decoded names past every integrity gate — with the shim answering for one
coherent identity.

What the shim now covers beyond the skeleton: a self-healing fallback (any
unknown member answers as a callable chain, so a three-deep namespace call
cannot blow up), a real event registry that fires `DOMContentLoaded`, `load`
and a user gesture (the flow waits for a click before it runs the encoder),
browser-accurate URL resolution on anchors and images (the integrity check
reads `host`/`protocol`/`pathname` back off an anchor), capture on `fetch`
and `sendBeacon` as well as XHR, an indexable `PluginArray`/`MimeTypeArray`,
and the viewport surface (`screen`, `history`, `visualViewport`,
`innerWidth`/`devicePixelRatio`/…).

## The remaining work

1. **One register stays empty.** The encoder does `receiver['toString']` where
   `receiver` comes from a VM register that is `undefined` in our environment
   and an object (or `0`) in a browser. Its fallback — "no receiver, use the
   bare name" — then hands the type cast the string `toString`, which is not a
   function, and the run stops there. The read site and fallback are pinned:
   the register file is 256 slots, the hole is slot 24, and the fallback is
   `receiver === undefined ? name : receiver[name]`. What is missing is the
   earlier op that should have written that slot — a shim member whose value
   the browser has and we do not.
2. Once it runs clean, verify the emitted `fo` blob's segments match the
   captured format (the cheap verifier).
3. Wire `Bypass::Computed` in `solver.rs` to the sandbox.
4. Verify against the live door: clearance lands, Carousell answers
   browserlessly.

Each step has a cheap verifier; step 2's format check is the gate.
