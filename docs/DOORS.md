# Doors: what a wall is, and what the node does about it

A site's door is the check between its page and its calls. The node learns a route by walking the page in a real
browser, so the walk is the one place that meets the door honestly. What it meets is kept on the route, so a later
call that meets the same wall is told what it is instead of mistaking it for the site drifting.

## The model

```
Door {
  kind        Cloudflare | Akamai | Radware | DataDome | PerimeterX | OwnSigning | Unknown
  statuses    the statuses the wall answers with (403, 429, 503)
  credential  the cookie the wall issues when it lets a browser through
  ttl         its life, from the Set-Cookie line's Max-Age
  earn        Recompute | Browser | BrowserOrOwner
}
```

`kind` is read from what the wall *answered with* — its headers, the cookies it set, the page it served — never from
a host. `earn` follows from whether the credential is device-bound: a vendor's token is sampled from a real browser
and scored at the edge, so only a browser earns a fresh one. A site's own refusal (its scripts, its rule) carries no
vendor's mark: it is `Unknown`, and the replay's value provenance is what diagnoses it.

`ttl` matters: a credential is worth keeping until its line says it runs out, and sending it after that is a wasted
call. Cookie metadata beside the jar carries the `Max-Age`, and a call drops expired cookies the way a browser does.

## What each class means for a call

| Class | The credential is… | What earns a fresh one | What the node does |
|---|---|---|---|
| `Cloudflare` | `cf_clearance`, bound to the client that solved the challenge | a browser that clears the challenge | reuse while it lives; a browser mint when the edge refuses |
| `Akamai` | `_abck` / `bm_sz`, a sensor sample scored at the edge | a browser in the site's profile, headed if the site says | reuse while it lives; a browser mint when refused |
| `Radware` | `reese84`, the same shape | a browser in the site's profile | reuse while it lives; headed if a headless profile is refused |
| `DataDome`, `PerimeterX` | `datadome` / `_px3` | a browser in the site's profile | as above |
| `OwnSigning` | none: the site signs its own calls | the signing bridge (`Class::Script`) | the value's provenance says which producer is missing |
| `Unknown` | none found | the site's own page (recompute) | a browserless re-fetch, then report |

A refusal with `earn: Recompute` never opens a browser: the refresh is the whole of what there was to do. A refusal
with a device-bound credential opens one browser in the site's profile, takes the credential it issues, and retries
the same chain browserless — one visit per TTL, not one per call.

## Reading a failed call

`UNBROWSE_REPLAY_DEBUG=1` prints, per step, every field's location and where it came from:

```
[debug] step 2 GET https://site.example/api/search
[debug]   Header("x-csrf-token"): jar x-csrf-token
[debug]   Cookie("sid"): from exchange 0 at SetCookie { name: "sid" }
[debug]   Header("x-ctx-wclient-req"): script https://cdn.site.example/app.js
```

- a field with no producer (`constant` / `unconfirmed`) is the one to look at when the site refuses;
- a `Door` error names the class and the credential, so a 403 is a wall, not a bug;
- a `Failed` with no class is the site's own rule: the values, not the caller, are the problem.

## What is not here, on purpose

The engine does not synthesize a vendor's token, extract a site's key from its bundle, replay a sensor sample, or
emulate the browser a challenge is scoring. Those are the vendors' checks, bound to a real client by design; forging
them is a per-site arms race that is both against the sites' terms and, for a product sold to enterprises, a
procurement blocker. The honest path is the one above: earn the credential with the real browser the node already
drives, keep it as long as its line allows, and spend nothing else.

If you have written authorization for a site, that site's integration can be scoped separately; it is not a general
feature of the engine.
