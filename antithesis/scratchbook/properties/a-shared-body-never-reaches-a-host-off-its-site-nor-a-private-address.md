---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
focus: 11 (wildcard)
confidence: medium
---

# A fetched body runs on the caller's node; two different mechanisms must agree on where its session and its requests may go

## What led here

A shared route is the one case where a node executes code written by someone
else against a site using the caller's own cookies. Two independent mechanisms
decide what that execution may touch, and they are checked in different places
against different inputs:

1. **`share::bound`** (`share.rs:342-363`) — inspects each step's *declared
   fields* (`Class::Minted` / `Class::Input{secret}`), parses the step's URL
   **template** for a host, and refuses the route if a session-carrying step's
   host is not `same_site` as the route's site, or is built at call time
   (`{...}` in the authority).
2. **`client::with_session_cookies`** (`crates/learn/src/client.rs:426-448`) —
   at replay, attaches the caller's jar cookies only to requests whose **host
   equals the jar host** (the target host), per the tests at `client.rs:848-862`
   (a sibling host and another scheme get no cookies).
3. **`egress::check` / `hop_allowed`** (`crates/learn/src/egress.rs:39-91`) —
   in the resolver, refuses any hop (initial or redirect, up to
   `MAX_REDIRECTS`) whose public name resolves to a loopback/private/link-local/
   cloud-metadata address.

`bound` works on the template and the *declared* fields; cookie attachment works
on the *concrete* host at replay; egress works on the *resolved IP*. The
property is that these three, together, never let a fetched body send the
caller's session to a host off the route's registrable site, and never let the
body drive the caller's node at a private address.

## The wildcard angle

The content id binds the recipe bytes (`verify_body`), but it does **not** bind
the set of hosts the body will actually contact at run time: a step's host can
be a `{param}`/response-derived slot (`bound` refuses these *only if the step
carries a session value* — a slot step that carries none is allowed to go
"where the call takes it," `share.rs` doc + `recipe.rs` into_route). So a shared
body can legitimately direct the caller's node to make **public** requests to
hosts the contributor chooses, carrying no session. Egress blocks private
targets; `with_session_cookies` blocks cross-host cookies. The safety claim
rests entirely on those two lower guards holding for *every* step of a
contributor-authored graph and for the heal re-walk — not on `bound`, which by
design lets session-free steps roam.

If any of the three has a seam — a host the template parses differently from the
URL the client builds (userinfo `@`, case, trailing dot, IDN/punycode), a jar
host match that is looser than `same_site`, or a heal that re-walks a drifted
graph onto a new host (`client.rs:252-254` guards target origin, but setup steps
are rebuilt from a fresh sighting) — the caller's session or node reach escapes
the route's site.

## Instrumentation (vs existing-assertions.md: none)

- `Always`: on every outbound request a fetched route makes (including heal
  re-walk steps), if the request carries any caller cookie/credential, the
  request host is `same_site` as `route.site`. Today split across `bound`
  (template, pre-run) and `with_session_cookies` (concrete, at-run) with no
  single assertion tying them. Missing.
- `Unreachable`: a fetched route's outbound request resolves to a private/
  loopback/metadata address while `allow_private` is false. `egress::check`
  returns `Err` today; assert it is never bypassed on a fetched-route hop.
- `Sometimes(a fetched route made a request to a same-site host other than the
  target)` to prove the multi-host path is exercised.

## Open Questions

- Does `bound`'s template-host parse ever disagree with the host the client
  connects to for the same step (userinfo, trailing dot, punycode, uppercase)?
  If yes, `bound` can pass a step whose real host is off-site. `(partial:
  url::parse is used on both sides, but bound re-encodes braces and splits the
  authority by hand first — worth a differential fuzz)`
- On a heal, the setup steps are rebuilt from a fresh root sighting
  (`client.rs:~260 build(...)`); are those rebuilt steps re-checked by `bound`,
  or only the target origin by `heals_onto`? If `bound` runs once before the
  heal, a drifted graph's new setup host is never re-bounded. `(partial:
  share::bound is called in run_route before call_watched; the heal rebuild
  happens inside call_watched with no second bound call)`
- Is a shared body contacting arbitrary *public* hosts from the caller's IP an
  accepted capability (a proxy/laundering surface), or should session-free steps
  also be site-bound? `(needs human input)`
