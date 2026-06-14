# The Agent Internet Layer

Every web action an agent takes is one contract-shaped request. The agent supplies
only the holes it can honestly fill — intent, optional approval, wallet proof, local
capability results, and typed pointers — and Unbrowse decides the cheapest capable
layer that can settle the witness. That descent may reuse a route, execute a captured
endpoint, call a standard adapter, open a browser with local cookies, inspect HAR,
capture a new route, and index it for the next caller.

That boundary protects both sides. A company can expose a useful contract without
handing users its internal API map, HAR contents, auth headers, or route-scoring logic.
A user can authorize a request without sending raw credentials or PII to the graph. Secret
values stay local behind zk-bound / pointer-only holes; the wire carries typed pointers,
wallet-bound proofs, approvals, and receipts.

This page documents the public boundary: the hole/contract an agent calls, the
compatibility ops exposed underneath it, the receipt shape, and the trust promise.
It does not document how routes are scored, ranked, or value-populated; that is
handled by the aiko substrate and is out of scope (see [Out of scope](#out-of-scope)).

## The Current Surface: One Hole

The formal bridge is machine-readable:

```bash
unbrowse contract surface
```

The bridge exposes five client-fillable holes:

| Hole | Filled by | Carries secret? |
|---|---|---|
| `intent` | LLM | No |
| `wallet_proof` | wallet/session identity | No |
| `approval` | human | No |
| `local_capability_result` | local dispatcher | No |
| `typed_pointer` | server pointer | No |

In CLI or SDK code, the current surface is one typed hole. The CLI says `get`
for read/search tasks; the SDK method remains `fill` because it fills the typed hole:

```bash
unbrowse "top stories with point counts"
unbrowse "top stories with point counts" --url "https://news.ycombinator.com"
```

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const result = await hole.fill({
  intent: "get the top Hacker News stories with points",
  url: "https://news.ycombinator.com",
});
```

The caller does not choose between `resolve`, `execute`, `go`, `snap`, `fetch`, HAR, or
cookies. Those are internal/compatibility steps in the descent.

## The three verbs

The three-verb surface is the compatibility decomposition of the same hole contract.
It remains useful for debugging, route inspection, and lower-level hosts, but it is
not the preferred agent-facing surface for new integrations.

Every Unbrowse primitive collapses onto one of three verbs:

| Verb | What it is | Op class |
|---|---|---|
| `build` | **Declare** what you'll reuse — a skill, a fill-template, a value-source. | `build` |
| `act` | **Act** on the internet — navigate, fill, click, type, submit, execute, fetch. | `actuate` |
| `read` | **Observe** state — snapshot, resolve, read text, status, version, earnings. | `observe` |

A subcommand is an `<verb> <action>` pair (`act go`, `read snap`,
`build skill`). The dispatch key is the `op_kind` string — `act:navigate`,
`read:snap`, `build:skill` — which is exactly what surfaces in op responses and
`--help`. Generic, human-readable ops; nothing more.

## The 37 ops

These are the documented public internet layer. Each op produces a pointer-only
receipt (see [Receipt shape](#the-receipt-shape)).

### build (3) — declare what you'll reuse

| op_kind | What it does |
|---|---|
| `build:skill` | Register a captured skill manifest (a sequence of endpoints + selectors). |
| `build:template` | Declare a reusable fill/exec template binding selectors to value pointers. |
| `build:value-source` | Register a vault item (one-time write to keychain/password manager); local-only. |

### act (15) — act on the internet

| op_kind | What it does |
|---|---|
| `act:navigate` | Navigate the current session to a URL. |
| `act:fill` | Dereference a value pointer and insert text into a selector. |
| `act:fill_form` | End-to-end form fill: snap the form, enumerate fields, populate each slot. |
| `act:type` | Dereference a value pointer and dispatch per-character key events. |
| `act:click` | Press + release a mouse event on a selector. |
| `act:press` | Dispatch a single key event (with modifiers). |
| `act:select` | Set a `<select>` element's value. |
| `act:scroll` | Scroll the page or a selector by `(dx, dy)` pixels. |
| `act:submit` | Submit a form (optionally targeted by selector). |
| `act:execute` | Replay a captured endpoint with pointer-resolved headers + body. |
| `act:auth_capture` | Run an interactive auth flow; on completion, write a credential pointer to the vault. |
| `act:proxy_rotate` | Rotate the residential proxy session. |
| `act:close` | Close the current browse session and drain the capture pipeline. |
| `act:session_park` | Park a session — teardown plus persist a pointer chain for later restore. |
| `act:session_restore` | Restore a parked session — wallet-signed challenge, then re-attach. |

### read (19) — observe state

| op_kind | What it does |
|---|---|
| `read:snap` | Accessibility tree of the current page. |
| `read:resolve` | Ranked endpoint shortlist for an intent (route cache + marketplace). |
| `read:status` | Current session + server health snapshot. |
| `read:version` | CLI version, build SHA, wallet pubkey, and signed release manifest. |
| `read:trace` | Read the stateless decision trace for a session (internet-ladder view; see note). |
| `read:markdown` | Readable-markdown view of the current page. |
| `read:screenshot` | PNG capture of the current page. |
| `read:text` | Stripped page text or selector-scoped inner text. |
| `read:cookies` | Cookie listing for a domain — names, domains, expiry only; never values. |
| `read:stats` | Marketplace + earnings stats summary. |
| `read:skills` | List captured skills. |
| `read:skill` | Detail one captured skill by id. |
| `read:sessions` | List active browse sessions. |
| `read:earnings` | x402 earnings summary for the current agent. |
| `read:settings` | Current local config + capture-pipeline settings. |
| `read:feedback` | Submit feedback on the last execute (commitment-only). |
| `read:reflect` | Reflect on the user-facing outcome of the current task (outcome-only signal). |
| `read:auth_inventory` | Per-domain inventory of what the user can already authenticate against — local browser cookie metadata, history hostnames, bookmarks. |
| `read:spec_discover` | Probe spec-publishing endpoints (OpenAPI/Swagger/sitemap/robots/GraphQL) for a target site before capture. |

> **Note on `read:trace`.** The public trace surfaces only the internet-op
> ladder (`server_fetch`, `browser`, `recipe_replay`, and similar steps). Any
> scoring rationale is redacted — the trace is the agent's own decision log, not
> a window into how routes are ranked.

## Compatibility: the two-tool-call decomposition

When a host cannot call the hole directly, it can decompose the same decision into
two compatibility calls:

1. **`read resolve --intent X --url Y`** returns a ranked shortlist of candidate
   endpoints, each with rich evidence — URL, score, sample values,
   requires/yields, schema, action kind.
2. **The agent's own LLM picks** the endpoint that matches the intent. Unbrowse
   filters out the wrong routes and surfaces the evidence on the rest; the
   picker is the calling agent, not Unbrowse.
3. **`act execute --endpoint <id>`** commits the chosen route.

Resolve gathers options; the agent judges; execute commits. Both `read resolve`
and `act execute` are pointer-only receipts. This is no longer the preferred
surface for new integrations; it is the route-inspection view under the one-hole
contract.

## The receipt shape

Each op produces a **pointer-only, wallet-signed receipt**. A receipt
**contains**:

- **`op_kind`** — the generic op identifier (`act:navigate`, `read:snap`, …).
- **opaque pointers** — a URL, a `value:ptr`, a `sha256:` content address. The
  receipt points *at* values; it never carries the value itself.
- **a wallet signature** — `{ identity, signature, signatureScheme }`. The op is
  signed by your key, so the act is attributable and tamper-evident.
- **a receipt pointer** — `sha256:<hex>`, the opaque address of the
  wallet-signed ledger row this op produced.

A receipt deliberately **does NOT contain**:

- the secret **value** behind any pointer (credentials, tokens, fill contents);
- the **mechanism** that produced or selected the result;
- any **score, ranking, or weighting** used to choose among candidates.

Pointer-only is load-bearing. `act fill` dereferences a `value:ptr`
**locally** and types the result into the page — the secret value never crosses
the wire. The promise: *we never see your secret values.*

### Receipt evolution: signed today, stronger schemes next

Today the wallet's Ed25519 key signs over `(pointer, nonce, url, selector, iat)`.
The signature proves *your* wallet authorized the act, and the receipt's
pointer-only invariant — no secret value ever crosses the wire — holds.

Stronger authorization and provenance schemes are an active research direction;
specifics will be detailed in a forthcoming whitepaper. They are designed to slot
in behind the same receipt interface and audit surface, so callers write against
one interface. Any such strengthening targets the *authorization* claim — it is
**not** what protects your secret values. That protection is the pointer-only
flow, and it is true from day one.

## Out of scope

How ops are scored, ranked, and value-populated is handled by the aiko substrate
and is not part of this public API. Unbrowse emits an opaque op and a
wallet-signed receipt pointer; the aiko substrate decides which routes are worth
returning and resolves the pointers it is authorized to. That selection,
population, and learning layer is intentionally private — it is the moat — and
nothing in this document exposes it.

## Security and trust

- **Pointer-only on the wire.** Receipts carry opaque pointers, never secret
  values. Credentials, tokens, and fill contents are dereferenced locally and
  never transmitted.
- **Wallet-bound.** Every op is signed by your key. You authorize an act by
  signing it; an op without your signature is not your op. Today that signature
  is a plain Ed25519 signature; stronger authorization schemes are an active
  research direction (see
  [Receipt evolution](#receipt-evolution-signed-today-stronger-schemes-next)).
- **Credentials surface only on authorization.** Secret values are resolved
  locally only when your wallet authorizes the dereference, then zeroed. The
  value is never an input to the signature or the proof — protecting your secret
  values is the pointer-only flow, true from day one and independent of the
  signature stage.
- **Metadata-only reads.** `read:cookies` returns cookie names, domains, and
  expiry — never values. `read:auth_inventory` reads local browser metadata only.

## What's public, honestly

Public and open-sourceable: the hole contract, its five client-fillable holes, the
compatibility verbs/ops, the pointer-only / wallet-signed receipt shape, and the
trust promise above. This is the product surface, and an agent that learns Unbrowse
as a `fill`-style capability learns nothing it could not learn from any browser tool.

Private, and named honestly: how routes are scored, ranked, populated, and
learned from. That work lives in the aiko substrate and never crosses Unbrowse's
public wire. The shape is open; the engine is not.
