# The challenge channel, measured (2026-10-19)

Artifacts: `challenge-hooks{,2,3,4,5,6}.js`, `fingerprint-noise.js`, samples in
`/tmp/orch2.js`; captures in `~/unbrowse/captures/` (fresh file per run —
the tracer appends per session name, so counts from mixed runs lie).

## What is known, in order of certainty

1. **The wire protocol** (`fo`, `ci`, flow): `$`-separated pairs of 16-byte
   blocks (24-char base64url), 49 static literals in the orchestrate. The
   serializer is function `e` at offset 166424 of the per-run orchestrate;
   the string decoders are `aj` (idx <= 718) and `du` (idx <= 1262). The
   `fo` payload for one session was 3191 bytes — the Stage-2 plaintext target.

2. **The `ci` channel**: images under
   `/cdn-cgi/challenge-platform/h/b/ci/<ray>/<ts>/<slug>`, `sec-fetch-dest:
   image`, referer the Turnstile widget's inner frame
   (`.../turnstile/f/.../normal`). Cadence ~130s; a burst follows an
   interactive-phase click.

3. **The unit** (measured): a `ci` PNG is `51x86` (or `1x71`), its IDAT is
   4477 bytes of which **5 are non-zero** (`01 78 11 87 ee`), and its tEXt
   carries a **4-byte seed** (`16 a3 97 4b`). Entropy 0.015 bits/byte. The
   PNG framing is cover; the payload is a handful of bytes.

   Consequence: the channel does **not** stream a 1262-entry string table
   (that would need thousands of fetches at this cadence). It is consistent
   with **periodic session-key/state rotation**: a 4-byte seed plus a 5-byte
   update per rotation.

4. **Trigger**: an OS-level click (CGEvent, `click3.js`) on the widget's
   checkbox fires the fetches within seconds — deterministic, no waiting for
   the 130s tick.

## Where the ladder stands

- Stage 1 (schema): format and seams known; the table itself lives with the
  orchestrate and the wire blocks, not in `ci`.
- Stage 2 (keys): target the rotation feed — the tEXt seed and the 5-byte
  update — against the 3191-byte `fo` pair already captured.
- Stage 3 (PoW): capture `WebAssembly.instantiate` in the widget frame
  (hooks are in place now that init-scripts reach OOPIFs).

## Instrumentation notes

- Init scripts must reach every browsing context: page, iframe, worker and
  "other" attach buckets, injected before `prepare_domains_pub` (the resume).
- The tracer skips image bodies in text mode; `is_challenge_channel` keeps
  the `ci` channel's bytes.
- Cross-origin frames exfil via `postMessage` to the top collector.

## Stage 2's unlock: a second CDP client (2026-10-19)

The fork launches Chrome with `--remote-debugging-port=0`; the ephemeral port
is discoverable and the endpoint answers:

```
lsof -nP -iTCP -sTCP:LISTEN -a -p <chrome-pid>   # -> 127.0.0.1:<port>
curl http://127.0.0.1:<port>/json/version        # -> Browser: Chrome/155…
```

So a debugger can attach alongside the daemon:

1. `GET /json/list` → the page target's `webSocketDebuggerUrl`
2. `Debugger.enable`; `Debugger.setBreakpointByUrl` on the orchestrate script
   (line 2, column ≈166424 — function `e`, the `fo` sender found from the
   stack trace)
3. On `Debugger.paused`, walk `callFrames[1].scopeChain` and
   `Runtime.getProperties` the caller's locals: that frame built the payload,
   so its scope holds the **plaintext fields** before the hand-rolled encoder
   ran. One pause gives the schema; repeated pauses give plaintext/ciphertext
   pairs.

Why the JS hooks cannot do this: the encoder is hand-rolled end to end — no
`btoa`, no `TextEncoder`, no `crypto.subtle`, no `JSON.stringify` at payload
scale, and the alphabet (`$`, `-`, `_`) is their own base64. Breakpoints read
the state the code itself holds, so none of that matters.

## Stage 1 complete: the vocabulary is reversed strings (2026-10-19)

Attach recipe verified end to end (`cdp_scope_dump.py`):

1. find the port (`lsof` on the Chrome pid), `GET /json/list`, pick the
   queue page target
2. `Debugger.enable`, `setBreakpointByUrl` on `.*orchestrate/chl_page.*`
   line 2 column ~166424 (function `e`, the fo sender)
3. navigate through the front door until the challenge re-runs (retry: the
   challenge does not re-issue on every navigation)
4. on `Debugger.paused`, walk `callFrames[i].scopeChain` with
   `Runtime.getProperties`; arrays >20 elements are the string tables

**The obfuscation is trivial: every string is stored reversed.**

```
'thgieh' -> height      'emarfi' -> iframe     'kcilc' -> click
'nioj'   -> join        'tnemucod' -> document 'tpo_lhc_fc_' -> _cf_chl_opt
'evitcaretni' -> interactive   'deganam' -> managed
```

Two tables per build (this build: 1452 + 1442 entries; earlier builds
1633/1621 and 1386/1376 — they rotate). Decoded and saved as
`challenge-vocabulary.json` (2894 entries; 1408 identifier-like, including
real JS/DOM names and the per-build `_cf_chl_opt` keys such as cFPWv, cRay,
cITimeS, cUPMDTk).

Also read live at the breakpoint: the turnstile sitekey (`d2d3316b729e`),
a session UUID, and a 64-char token with the wire's `$` suffix — the same
`$`-format as the payload segments, i.e. the token is itself a field.

Next: with plaintext names in hand, the payload object (`qP`/`dE` in the
paused frame) reads as named fields; Stage 2 (keys) becomes ordinary
reversing against the 3191-byte fo pair.

## The browserless gap, measured (2026-10-19)

The in-process mint works: `agent_browser_core::session::mint()` returns 233
cookies in ~8 s with no CLI and no daemon (Carousell, live). But the
browserless call still meets the interstitial, and the reason is now measured
rather than guessed.

Ground truth: load `https://tls.peet.ws/api/all` **in the minting browser** and
read its own fingerprint. For this machine's Chrome 155:

    ja4   t13d1518h2_8daaf6152771_4980c97edce0     (18 extensions)
    ja3   7719f2a5b08a6c5955a49f420b3d7388

Our ChromeFetch (wreq, Chrome-149 profile):

    ja4   t13d1516h2_8daaf6152771_d8a2da3f94cd     (16 extensions)

The cipher hash matches exactly (`8daaf6152771`), the extension count and its
hash do not: 18 vs 16. A clearance is bound to the client that earned it, so a
two-extension difference is enough to fail validation.

Next: align the client's extension list to the browser's — either a newer wreq
emulation profile (155) or an explicit extension list matching the 18 the
browser sends, in order. The verifier is the same page: the two JA4 strings
must match character for character, then the clearance should validate and the
Carousell call should answer.

Also measured, same session: the IP the door sees, the HTTP version (h2), and
the UA — all available from the browser itself, which makes this environment's
ground truth cheap to re-check whenever the browser updates.

## The two extensions, named (2026-10-19, continued)

Extension lists, both sides, same instrument (tls.peet.ws):

- browser (Chrome 155): 20 entries, 2 GREASE → **18 counted**
- our client: 18 entries, 2 GREASE → **16 counted**

The diff is exactly two, and both are Chrome's transition-era extensions:

| extension | ours | browser |
|---|---|---|
| `application_settings` new codepoint (17613) | ✓ | ✓ |
| `application_settings` old codepoint (51764, 0xCA34) | ✗ | ✓ |
| unknown 4832 (0x12E0) | ✗ | ✓ |

wreq exposes `alps_use_new_codepoint`, `alps_protocols` and `enable_ech_grease`
and we set all three (verified in the built emulation), which brought the
client from 16 to its current set — but the old ALPS codepoint and 4832 are
not emitted by the profile's TLS layer, so the JA4 stays
`t13d1516h2_8daaf6152771_d8a2da3f94cd` against the browser's
`t13d1518h2_8daaf6152771_4980c97edce0`.

Next: emit those two (a patched btls profile, or a client that composes the
ClientHello directly), then re-check both the JA4 string and the Carousell
call — the verifier is already in the loop (`tls_probe` prints our list beside
the browser's).

## The knob space, exhausted (2026-10-19)

wreq-util's newest release (3.0.0-rc.14) ships profiles up to Chrome 149 — no
155. Its TlsOptions exposes exactly: alpn_protocols, alps_protocols,
alps_use_new_codepoint, session_ticket, min/max_tls_version, pre_shared_key,
enable_ech_grease, permute_extensions. All of them are now set and verified in
the built emulation, and the extension COUNT does not move: 18 entries / 16
counted in both ALPS-codepoint modes (the flag only swaps which codepoint is
sent, changing the JA4's second hash: d8a2da3f94cd vs 02713d6af862).

So the browser's extra two — 51764 (0xCA34) and 4832 (0x12E0), both labelled
"Unknown extension" by the fingerprint page — are not reachable through this
client's TLS layer. Emitting them means either patching btls (BoringSSL) or
composing the ClientHello in a client we own.

Practical reading: until that lands, challenge-walled sites are served by the
in-process mint (the browser, which already passes) and the browserless path
carries everything else. The door is not closed to us — it is closed to a
ClientHello that is two extensions short of the one that earned the clearance.

## The sweep: what unbrowses today (2026-10-19)

Same harness, five sites, mint once per host then call browserlessly:

| site | mint | browserless call |
|---|---|---|
| en.wikipedia.org | 7 cookies | 200, 2.33 MB |
| news.ycombinator.com | 0 cookies (sets none) | 200, 34 KB |
| www.carousell.sg/toys/q/ | 233 cookies | 200, 1.49 MB |
| www.skyscanner.net | 13 cookies | 405 — AWS WAF challenge page |
| www.uniqlo.com/sg/en/ | 2 cookies | 403 — Akamai 'Access Denied' |

Reading it: sites without a door need no mint at all; a site with a door the
browser passed (Carousell, Cloudflare) answers browserlessly once the jar and
the request shape are right; and the refusals are the vendors' own pages.

**Two kinds of gate, and only one is nameable from the walk:**

- host-based gates — PerimeterX, AWS WAF, Cloudflare, Queue-it — appear in the
  walk as their own hosts, so `walk::is_gatekeeper` names them before any
  attempt (Skyscanner showed js/ift.px-cloud.net and the awswaf captcha);
- edge-based gates — Akamai's, as at Uniqlo — never appear as a host: the
  refusal arrives from the site's own URL as a plain 403 with
  `Server: AkamaiGHost`. Nothing in the walk distinguishes it from a normal
  response except the status and the body's wording.

So a general rule for the harness: the walk names what it can, the status and
body name the rest, and a 403 from the site's own host with a tiny body is an
edge gate rather than a site refusal.

Also fixed from this sweep: the mint's target race (Chrome replaces its
initial about:blank target, so list-and-attach with retries) and the
empty-session false negative (a walk with no cookies is still a walk).

## The wider sweep: 11 of 11 browserless (2026-10-20)

Same harness API (`Site::fetch`), after the TLS patch that emits Chrome's two
extra extensions:

| site | status | bytes | from | gates named |
|---|---|---|---|---|
| en.wikipedia.org | 200 | 2.33 MB | browserless | — |
| news.ycombinator.com | 200 | 34 KB | browserless | — |
| carousell.sg/toys/q/ | 200 | 1.49 MB | browserless | cloudflare, cloudfront |
| skyscanner.net | 200 | — | browserless | perimeterx (js/ift/client) |
| uniqlo.com/sg | 200 | 1.87 MB | browserless | queue-it, akamai |
| stackoverflow.com/questions | 200 | 215 KB | browserless | challenges.cloudflare.com |
| github.com/rust-lang/rust | 200 | 365 KB | browserless | — |
| reddit.com/r/programming/ | 200 | 527 KB | browserless | — |
| lazada.sg | 200 | 471 KB | browserless | — |
| bbc.com/news | 200 | 374 KB | browserless | — |
| booking.com | 200 | 475 KB | browserless | awswaf (edge.sdk) |

No fallback was needed for any of them: every call was answered by the
browserless path. Cost is dominated by the walk (7 to 13 seconds per site,
one browser visit each); the calls themselves are milliseconds.

The pattern that got here, in order of how often it mattered:

1. request shape (the walk's own headers over browser-shaped defaults);
2. session (the mint's jar);
3. handshake (the patched two extensions — this is what turned 405s into
   200s on the sites whose WAF judged the ClientHello);
4. identity negotiation (our agent first, the browser's when refused);
5. waiting for the door in the walk rather than a fixed time;
6. the walk as the fallback, when a site refuses the browser itself.
