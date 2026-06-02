# The Agent Internet Layer

Every web action an agent takes — browse, fetch, fill, resolve, execute — is a
single uniform op: a pointer-only, wallet-signed, witnessed receipt. Unbrowse
gathers the messy surface of the internet into one named, callable shape and
hands it to agents as three verbs.

This page documents that public surface — the ops an agent can call, the shape
of the receipt each one produces, and the trust promise underneath. It does not
document how those ops are scored, ranked, or value-populated; that is handled
by the aiko substrate and is out of scope (see [Out of scope](#out-of-scope)).

## The three verbs

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

## The two-tool-call contract

The canonical flow is **two calls, never one**:

1. **`read resolve --intent X --url Y`** returns a ranked shortlist of candidate
   endpoints, each with rich evidence — URL, score, sample values,
   requires/yields, schema, action kind.
2. **The agent's own LLM picks** the endpoint that matches the intent. Unbrowse
   filters out the wrong routes and surfaces the evidence on the rest; the
   picker is the calling agent, not Unbrowse.
3. **`act execute --endpoint <id>`** commits the chosen route.

Resolve gathers options; the agent judges; execute commits. Both `read resolve`
and `act execute` are pointer-only receipts. Auto-execute is opt-in
(`--execute`); by default resolve and execute stay separate decisions so the
picking judgment stays with the agent's reasoning, not a heuristic.

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

Public and open-sourceable: the three verbs, the 37 ops, the two-call contract,
the pointer-only / wallet-signed receipt shape, and the trust promise above.
This is the product surface, and an agent that learns Unbrowse does `fill`,
`fetch`, and `snap` in this uniform shape learns nothing it could not learn from
any browser tool.

Private, and named honestly: how routes are scored, ranked, populated, and
learned from. That work lives in the aiko substrate and never crosses Unbrowse's
public wire. The shape is open; the engine is not.
