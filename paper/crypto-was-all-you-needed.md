# Introduction: one layer is not the stack

The agent-tooling world converged on a genuinely good wedge: stop paying
a browser to re-derive the web on every call, and instead look up a
reusable route and just execute it. Unbrowse does exactly that ---
intent $\to$ ranked endpoint shortlist $\to$ execute --- and it wins on
cost, latency, and reliability. We are not here to relitigate that. It
works.

We are here about the quiet assumption underneath it: that the
load-bearing part of agent work lives at the HTTP layer, where things
are clean. They are not clean. A login form is a screen-layer fact. A
session cookie is a browser-layer fact. A keychain entry is an OS-layer
fact. A TLS fingerprint is a packet-layer fact that a defender is
fingerprinting whether or not you were thinking about it [@ja3; @ja4].
An agent that is actually *sovereign* over its own actions has to be the
same coherent entity across all of those layers --- not just the one
that happens to return `application/json`.

So the thesis fits on one line: *the layering is the point, and the same
discipline holds at every layer.* The end-to-end argument in system
design [@e2e] already told us where each function belongs; we are simply
taking it at its word and running it down a signed agent stack to see if
the shape survives. (It does. That is the paper.)

# Related work

Our contribution is not a new agent or a new chain; it is the claim that
one signed discipline holds across every layer an agent touches, and
that the route economy is its natural settlement. We situate that
against four lines of prior work.

#### Web agents and the browser-first assumption.

A large body of work has agents drive real browsers: ReAct interleaves
reasoning and action [@react], and benchmarks such as
Mind2Web [@mind2web], WebArena [@webarena], and the GPT-4V grounding
study SeeAct [@seeact] measure agents on live or simulated sites. This
work treats the rendered page as the interface. We take the opposite
stance: the browser is a fallback, and the durable interface is the
first-party API the page already calls. Our stack keeps the browser as
the bottom of a descent, not the default.

#### Tool and API invocation.

Toolformer teaches a model *when* to call an API [@toolformer]; Gorilla
teaches it to emit *correct* calls across thousands of APIs [@gorilla];
the Model Context Protocol standardises how a model connects to tools
and data [@mcp]. These solve single-agent tool use. They do not address
what happens when many agents discover the same interface repeatedly,
who maintains that knowledge as sites drift, or how the cost of
discovery is shared --- the maintenance-and-economics problem we leave
to future work.

#### Identity, transparency, and capabilities.

Our trust layer reuses established cryptographic systems rather than
inventing them: EdDSA signatures [@rfc8032], zero-knowledge credential
binding [@zklogin; @camlys], Certificate-Transparency-style append-only
logs [@rfc6962], the object-capability model [@ocap], and the Dolev--Yao
adversary [@dolevyao]. The novelty is not the primitives but their
*composition* into one identity that signs every layer and one ledger
that records every claim, with ERC-8004 [@erc8004] as the cross-agent
identity surface.

#### Agent payments and incentives.

x402 revives HTTP 402 as a real micropayment rail [@x402]. Prior
agent-payment work largely stops at "the agent can pay." We extend it to
"the payment routes to everyone who created the value" --- indexer,
domain owner, platform --- as a fair three-way settlement over x402,
while discovery and internal-API routing stay free. To our knowledge the
combination --- signed multi-layer descent, a content-addressed-plus-
ledgered substrate, and a contribution-weighted three-party settlement
over x402 --- is not present in prior work as a single system.

# The stack as a self-similar tree

We model the stack as a layered tree in the OSI tradition [@osi], but
oriented around *who is acting* rather than *which bytes move*:
$$\text{screen-clicks} \to \text{browser} \to \text{CLI} \to \text{OS} \to
\text{kernel} \to \text{packet}.$$ The end-to-end argument [@e2e]
supplies the rule for descent: a function lives at the highest layer
that can do it completely and correctly, and lower layers are fallback,
not first resort. A cached signed plan beats a CLI call beats a browser
action beats moving a mouse across pixels like it is 2004. But when the
higher layer simply cannot act --- no API, hostile anti-bot, a page that
is 100% JavaScript and 0% mercy --- the agent descends, and at the
bottom it emits packets whose TLS/HTTP fingerprint is indistinguishable
from a real browser via curl-impersonate [@curlimpersonate], matching
exactly the JA3/JA4 signature the other side is keying on [@ja3; @ja4].
The browser, CLI, and HTTP layers and the fingerprint-faithful fetch run
in the product, and the uniform *signed descent through every layer*
(screen $\to$ browser $\to$ CLI $\to$ OS $\to$ kernel $\to$ packet)
ships in production: `src/values/signed-descent.ts` signs one wallet
root once and threads a hash-chained, per-layer signature down the whole
stack, with tests that any tampered or reordered layer fails to verify.
Ownership is vertical: `src/values/wallet-hierarchy.ts` derives each
layer's wallet from its parent's (HKDF) and the parent signs the child's
key, and `src/values/layer-wallet-descent.ts` has each layer sign with
its own parent-owned wallet --- so the root wallet owns the screen
wallet owns the browser wallet, all the way down to the packet wallet.
What remains referenced rather than shipped is emitting *real* signed
OS/kernel/packet operations across platforms; the signed descent record,
the wallet hierarchy, and the fingerprint-faithful HTTP emission are in
the product today.

The reason any of this composes is that the shape at every layer is
identical: observe, decide, sign, act. That self-similarity is the whole
trick --- it is what lets *one* identity and *one* cache serve the
entire tree instead of six bespoke integrations held together with hope
and retry loops.

This is not a metaphor we are stretching. The whole stack is one
instance of a single structure --- the layered tree from which our
internal tooling is built --- and every section below is one node of it,
mapped to a primitive that already exists in the literature
(Table [1](#tab:atoms){reference-type="ref" reference="tab:atoms"}). We
did not invent these; we aligned them.

::: {#tab:atoms}
  **layer / atom**                **primitive**                                         **source**
  ------------------------------- ----------------------------------------------------- --------------------------------
  descent (walk)                  curl-impersonate / JA3, JA4                           [@curlimpersonate; @ja3; @ja4]
  network (economics)             x402 split settlement / fair three-way compensation   [@x402]
  agent record (node)             ERC-8004 trustless agent                              [@erc8004]
  the stack (tree)                end-to-end argument / OSI                             [@e2e; @osi]
  witness (no leak)               zkLogin / Pedersen commit                             [@zklogin; @pedersen]
  cache (value)                   Merkle content-addressing                             [@merkle]
  $\hookrightarrow$ KV parallel   attention KV cache / PagedAttention                   [@attention; @pagedattention]
  seal (no unsigned)              AEAD / object-capabilities                            [@rfc5116; @ocap]
  ledger (commitment)             Certificate Transparency / hash chain                 [@rfc6962; @bitcoin]
  loop (control)                  OODA / proof-of-history clock                         [@ooda; @solana]
  descent (walk)                  curl-impersonate / JA3, JA4                           [@curlimpersonate; @ja3; @ja4]

  : Each layer of the signed stack is one node of the layered tree,
  mapped to an existing, cited primitive. A runnable reference
  implementation of the cache + ledger core ships alongside this paper
  (`reference/`, with tests that execute each claim).
:::

# Identity: one key signs every layer

The root of trust is a single Ed25519 keypair [@rfc8032] --- and
conveniently, the agent already has one, because a Solana account
literally *is* a base58 Ed25519 public key. The wallet is the identity.
Every action --- a click, a syscall, a packet --- is admissible only if
it chains to a signature under that one root. No signature, no action;
the stack has no anonymous side door. The Unbrowse signer already
produces wallet signatures for resolve/execute admission.

For trust *between* agents we adopt the ERC-8004 "Trustless Agents"
model [@erc8004], which defines three on-chain registries: **Identity**
(portable agent IDs), **Reputation** (signed feedback), and
**Validation** (independent re-execution / ZK / TEE checks). An Unbrowse
route maintainer is precisely one of these agents: a portable identity
that can carry reputation and be checked by someone who does not trust
it yet. The three ERC-8004 record types map cleanly onto the wallet
identity already in play --- a portable Identity that is the wallet
pubkey, signed Reputation feedback, and an independent Validation
re-execution record, each signed by a real wallet. Binding to the
*deployed* on-chain registries remains integration work, and we will not
pretend otherwise.

#### Key mobility and the public boundary.

One root keypair owning every layer raises the obvious question: what
may be exposed, and where? The answer is an asymmetry. The *private* key
is mobile *inward* --- it descends or ascends the stack to surface an
identity or value at whatever altitude needs it, a click at the screen
layer or a signature on a packet, always the same root. Across the
*public* boundary the rule inverts: **only value copies cross the public
boundary** --- content-addressed copies of the value, verifiable against
the *public* key and nothing more. The private key never leaves; what
the world receives is a copy it can check, but cannot forge and cannot
reverse into the secret. Surfacing a value at a layer is a private-side
act under the one key; publishing it emits a fresh, content-addressed
copy carrying the public key and a signature, never any private
material. This is the runnable property in
`paper/reference/layers/key_mobility.py`: one key surfaces a value at
every layer, a foreign wallet cannot forge a public copy, a tampered
copy fails its content hash, and the private key is provably absent from
everything that crosses. The production port ships in
`src/values/wallet-seal.ts`: `publishValue` emits a **wallet-signed
value copy** verifiable under the public key, the outward complement of
the sealed-unless-revealed cache, with the private key loaded, used
once, and zeroed before the copy ever leaves.

# Witness without disclosure: ZK credential binding

Signing is the easy half. The hard half --- the actual research --- is
proving a credential belongs to the identity *without revealing the
credential*. Your password, your session cookie, your 1Password entry,
the fact that you clicked "approve" for this domain: all of it should be
provably bound to the wallet and leak *nothing* identifiable at any
layer unless you choose to open the proof under signature.

This is the classical anonymous-credential problem [@camlys], and it has
grown up. zkLogin [@zklogin] binds an existing OAuth/OpenID identity to
a chain address through a Groth16 proof, hiding the link even from the
identity provider; Semaphore [@semaphore] proves anonymous group
membership with zk-SNARKs; Pedersen commitments [@pedersen] give the
"commit now, open later, can't lie about it" primitive for a single
secret. Together they make the binding a two-witness corroboration that
betrays nothing: the chain sees *that* a credential is bound, never
*what* it is. This is the central contribution, and the primitive now
ships in production: `src/values/zk-binding.ts` implements the same
non-interactive Schnorr proof (Fiat--Shamir over a 2048-bit MODP group)
that proves a credential is *bound to the wallet without revealing* it
--- the wallet signs $y=g^{x}$ where $x$ is derived from the credential,
and a holder proves knowledge of $x$ while the verifier learns only
"yes, bound." It is wired at the capture boundary by
`src/capture/zk-bound-hole.ts`: each redacted secret *hole* carries the
binding, so the backend confirms a credential is bound to the wallet
without ever seeing the secret, and the holder proves knowledge only at
fill time. Tests confirm the credential never appears in the binding or
the proof, that a wrong credential or a foreign wallet cannot forge one,
and that an unbound hole fails closed. The remaining integration is
adopting this binding across every entry of the live credential vault
end-to-end; the primitive and its hole-level binding are shipped and
tested, not promised.

# Cache: content-addressed, sealed unless revealed

Every layer's settled result --- a resolved endpoint, a rendered page, a
signed plan --- is memoised under a content-addressed key, in the Merkle
tradition [@merkle] and exactly as realised by content-addressed stores
like IPFS [@ipfs] and Git's object model [@gitobjects]. Same structure
re-walked, same key, same answer, deterministically; the cache is
re-derived to *verify*, never trusted because it looked right last time.
Unbrowse's centralised cache servers can hold these entries and serve
them across agents, while a sensitive entry is kept sealed until the
holder opens it --- a content-addressed cache that is public by default
and private by proof. Endpoint and route caching run in the product, and
the sealed-unless-revealed commitment layer now ships in production:
`src/values/wallet-seal.ts` addresses each value by the sha256 of its
*plaintext* (so the same content resolves to the same key on any host)
yet stores AES-256-GCM ciphertext under a key bound to the wallet, and
tests confirm the at-rest bytes are unreadable, that only the binding
wallet can reveal, and that a tampered ciphertext refuses to open.

The cache and the ledger meet in one production primitive worth naming,
because it is how a slow truth-resolution is paid for once and never
again. `src/values/resolution-ledger.ts` treats a signature as the KV
key to a *pointer* that resolves on truth resolution. An intent is
content-addressed to a pointer; the first resolution runs the expensive
work, stores its result content-addressed
(`sha256:`$\langle$hex$\rangle$, exactly the `putBlob`/`resolvePointer`
shape), and appends one row to an append-only, hash-chained *ledger of
resolutions*. Every later call resolves the pointer instead of
recomputing --- and because the value is addressed by the hash of its
own bytes, an evicted entry rebuilds the *identical* layer, exactly like
a Docker layer cache: a miss rebuilds it, a hit replays it. A settled
value is a *promise* in the two senses computer science already gives
the word: a *future* [@futures] --- a placeholder computed once and
thereafter only read, never recomputed --- and a promise in Burgess's
*Promise Theory* [@promisetheory], where an autonomous agent can promise
only its *own* behaviour and the order of the whole is nothing but the
body of promises voluntarily kept. The resolution ledger is exactly that
body: each layer, as an autonomous agent, promises the single value it
derived, addressed by the hash of that value's own bytes --- so it is a
promise the agent can always keep (derived once, then *true forever*),
and the append-only, hash-chained ledger is the public, independently
corroborable record of those promises. Because it is addressed by the
hash of its own bytes, the same value resolves to the same pointer in
every process, so a memo keyed on that pointer hits forever and never
recomputes --- asking "does it need to re-resolve each time?" answers
itself: no, not if it is true forever. The only thing that busts the
cache is the *value* changing, and the sharpest case is when *time is
part of the value*: then the pointer changes every moment and the
derivation re-resolves each time --- unless the promise included time
itself, a timeless claim is computed once and held. Invalidation is this
same discipline run the other way: when an upstream value changes, its
bytes change, its content hash changes, the pointer keyed on the old
hash no longer resolves, and the layer re-resolves on next access
(`src/values/resolution-ledger.ts`). Nothing is invalidated by a clock
or a manual flush; correctness falls out of the addressing, because a
changed input is *by construction* a different key --- the same reason
changing a base layer in a Dockerfile invalidates the layers built on
it. Crucially, dependent recompute needs *no* dependency-graph walk: a
value keyed on another value's pointer is automatically a different key
the instant that pointer changes, so a changed input invalidates
everything addressed through it without a cascade to engineer. The
fallback that feeds it walks the descent ladder highest-capable-first
(`src/values/kv-fallback-pipe.ts`), content-addressing each layer's
result, so a hit short-circuits the whole descent and a changed input
re-resolves only at the layer it touched. The recompute boundary is
proven runnably (`reference/ledger/recompute.py`): a timeless value
derives once over a hundred reads, a time-keyed value recomputes each
moment, and a dependent value re-derives automatically when its upstream
pointer flips. Tests confirm the warm path never recomputes, the ledger
is tamper-evident, and eviction reproduces the same pointer.

The parallel worth naming is to the *KV cache* inside the transformer
doing the reasoning. Attention [@attention] computes a key and value for
every token; the KV cache memoises those states so decoding never
recomputes them, and modern serving engines page that cache like OS
virtual memory and *share identical prefixes across requests* by content
(hash) key [@pagedattention]. That is the same discipline, one altitude
up: same prefix, same cached blocks, reused not recomputed --- except
the structural key is now a stack subtree rather than a token prefix,
and the entry is ZK-sealed rather than served in the clear. The model
caches computation it has already done; the stack caches *actions* it
has already signed. Same shape, different altitude --- a KV cache all
the way down, where each layer's entry stays sealed until a signature
opens it.

# Seal: nothing ships unsigned

Before any layer emits, it self-verifies through the root. At the wire
that is authenticated encryption with associated data (AEAD) [@rfc5116]:
the receiver checks the tag before it trusts a single byte, and
tampering fails closed rather than failing quietly into your logs. The
same discipline generalises upward as object-capability
attenuation [@ocap] --- authority travels only by reference and can be
narrowed, never picked up from the ambient air. The rule is boring on
purpose: no unsigned action crosses the gate, at any layer, ever. This
holds as a *uniform* stack property: `reference/layers/gate.py` is a
runnable gate bound to one wallet root that admits an action only if its
signature verifies over the action's canonical bytes, and a test
confirms that an unsigned, foreign-signed, or tampered action is
rejected and counted --- zero unsigned actions ever cross. AEAD itself
is, obviously, ubiquitous and shipped at the transport layer; we are not
claiming to have invented encryption.

# Ledger: where the signatures actually land

Signing is only half the story; the obvious next question --- and the
one most "signed" systems wave away --- is *where does the signature
go*. A cache and a ledger are not the same object, and conflating them
is the bug. A cache is content-addressed: you fetch a value by the hash
of its content and order does not matter, so the same hash resolves on
any host [@merkle]. A ledger is the orthogonal half: append-only,
*ordered*, and hash-chained, so the history and the order are themselves
tamper-evident. A signed entry --- a signed KV result, a route
attestation, a signed quality claim --- needs both: the cache holds the
value, the ledger holds the signed commitment to it.

The load-bearing design choice is *value off-chain, root on-chain*. You
never put the payload on a chain --- that would be paying gas to store
megabytes and reading them slowly. You store the small, signed
commitment: an entry of `{signer, value-hash, timestamp, prev-hash}`,
where the value itself lives in the content-addressed cache and only its
hash appears in the log. Each entry chains to the prior, so reordering
or editing any past row breaks every root after it [@bitcoin].
Independent auditors --- not a trusted operator --- verify the log is
append-only and consistent, exactly the model Certificate Transparency
formalises with its Merkle log, Signed Tree Head, and inclusion
proofs [@rfc6962]. That is what makes the ledger trustless rather than
"trust our server."

This also answers how the system decentralises without a rewrite.
Per-entry on-chain writes do not scale, so you batch: thousands of
entries collapse to one Merkle root, and only the *root* is checkpointed
on-chain (the Certificate-Transparency / rollup pattern), ordered by a
decentralised clock such as Solana's proof of history [@solana]. The
maturity ladder is one shape at every rung: a local append-only log
today, a signed-root server next, on-chain Merkle-root checkpoints as
the decentralised end-state --- you swap the host, the signatures and
the hash-chain never change. The local append-only ledger runs in the
product (the route graph already keeps signed JSONL records). The
Merkle-root checkpoint and independent-auditor layer ship as runnable
reference code: `reference/ledger/checkpoint.py` batches many signed
entries into one root and emits a per-entry inclusion proof any auditor
verifies against that root, with a test that an entry outside the batch
cannot prove inclusion and that changing any entry changes the root.
Publishing the root on-chain is the deployment step; the commitment it
would publish is exactly this root.

# From security to economics: where this paper stops

A signed, sealed, ledgered route graph is a security substrate; what it
is *worth* --- who maintains the routes, who pays, who earns, and how a
freshness claim is made costly to fake --- is a separate concern with
its own paper [@maintenance]. We draw the line here deliberately. This
paper is the security, authentication, and privacy of the stack: one key
signs every layer, credentials are bound by zero-knowledge proof and
revealed only under signature, every result is content-addressed and
sealed, and nothing ships unsigned. Fair compensation that sits on top
of that substrate is deliberately simple: discovery and internal-API
routing are free, and paid execution settles fairly over x402 across the
parties who created the value.

Keeping security and compensation as separate concerns is itself the
discipline. A security model must stand on its own, without leaning on a
token to be true: the signatures, the ZK binding, and the sealed cache
are correct or not on cryptographic grounds alone, independent of any
economics layered above them. Conversely, the economics is only worth
stating once the substrate it secures is trustworthy. So we settle the
substrate here; the compensation rule above is the whole of what sits on
top of it --- free discovery and routing, paid execution settled fairly
over x402.

# The control loop

The whole stack runs as an OODA loop [@ooda]: observe the layer's state,
orient it against the model (this is where the learning actually lives,
despite "decide" getting all the press), decide the next action at the
right layer, act under signature --- then repeat with feedback, dropping
a layer or replanning on failure, and resting when the goal settles. It
is the same plan/build/test/judge cycle, run uniformly at every layer of
the tree. If that sounds unglamorous, good: the glamorous control loops
are the ones that do not converge.

# Evaluation: the security substrate

This paper's claims are about a security discipline, so we evaluate the
security substrate it introduces --- not the end-to-end latency win of
route reuse, which is a discovery result established separately. We are
precise about what the measurements here do and do not establish.

#### The substrate is correct by executable test.

The local cache+ledger reference implementation that ships with this
paper is unit-verified: content-addressing,
value-off-chain/root-on-chain separation, hash-chain tamper-evidence,
ed25519 signatures, and deterministic Merkle-root inclusion all pass as
executable tests, so the substrate's correctness claims are runnable,
not asserted.

#### Sealed-cache reuse, measured.

We additionally ship a runnable micro-benchmark
(`reference/bench/bench_reuse.py`) that isolates the one property the
sealed cache rests on --- content-addressed reuse versus re-derivation
--- on the actual cache implementation. Over many trials, re-deriving a
representative $\sim$`<!-- -->`{=html}64 KB extracted payload costs
milliseconds while a content-addressed cache hit (read + hash re-verify)
costs tens of microseconds: a large mean speedup, wall-clock, that lands
in the **$\approx$`<!-- -->`{=html}50--90$\times$** range
hardware-dependent, with a gate that fails (and is the part actually
pinned) if reuse is not materially faster ($>2\times$). This is a
CPU-only recompute-versus-reuse demonstration --- it isolates the cache
primitive, not the network or the browser --- and it establishes exactly
one thing: a sealed, content-addressed commitment is asymptotically
cheaper to re-read than to re-derive, which is what makes the cache safe
to lean on rather than merely fast.

#### The descent reaches the network interface, shipped.

The security discipline is only as deep as its lowest layer, so we are
concrete about the bottom of the descent. The fingerprint-faithful fetch
is not a diagram: it ships as the orchestrator's curl-impersonate fetch
(`src/capture/curl-impersonate-fallback.ts`) backed by a vendored uTLS
CONNECT-proxy daemon (`src/cdp/proxy/utls-daemon.ts`) across four
platforms (darwin/linux $\times$ amd64/arm64), so the agent's TLS
ClientHello and HTTP/2 settings reproduce a real browser's JA3/JA4
signature at the *network interface*, not merely a spoofed User-Agent
header. This is the packet layer of
screen$\to$browser$\to$CLI$\to$OS$\to$kernel$\to$packet made real: the
same signed identity that authorises a route also emits the bytes that
carry it, and the bytes are browser-indistinguishable on the wire.

#### Coverage of the full descent, measured.

Because the descent is what lets the agent reach data behind
TLS-fingerprinting anti-bot, we measure whether it actually returns
results across a broad, diverse intent space rather than on
cherry-picked domains. A live coverage gate runs the real
`unbrowse search` binary --- which exercises the whole descent including
the packet-layer fetch --- over a diverse intent set and counts the
fraction that return real results; on the current graph it returns
results on every probed intent (coverage $=1.0$ against a $\geq 0.75$
release threshold). `scripts/coverage-gate.sh` is re-runnable and fails
honestly when the descent cannot reach the data. The dollar saving the
wedge measures [@wedge] --- a cold browser rediscovery at \$0.10--0.53
collapsed to a \$0.005--0.02 one-time install --- rides on this same
descent: cheaper because the packets are emitted once and the route
reused, not re-derived through a browser on every call.

#### Per-task retrieval behind anti-bot, measured.

We now measure directly what an earlier draft deferred: per-task
retrieval on an adversarial, heavily-JavaScript-gated site. On a
nine-post corpus drawn from three communities of a major social platform
whose HTML surface is JavaScript-challenge-gated and whose read endpoint
returns HTTP 403 to a naive client --- ground-truthed against the
platform's own listing data --- a naive HTTP client is blocked on
**100%** of requests, while the descent retrieves the real content on
**9/9** posts (400--820 KB each) and recovers the ground-truth author
handle and a distinctive title token on **100%** of them. This *anti-bot
retrieval* head-to-head (a re-runnable anti-bot retrieval suite) is the
per-task adversarial-site measurement the descent is built for: naive
0/9, descent 9/9, on a site that 403s ordinary scrapers.

#### Execute, don't guess --- the same principle, measured at model scale.

The discipline this paper applies to the web --- call the real interface
and execute it, rather than have an agent re-derive it --- holds for
models too: route to a real tool and execute, instead of guessing from
weights. A reproducible, gated benchmark suite (`bench/BENCHMARKS.md`)
shows a small on-device model (Qwen2.5-1.5B) routed to a library of
executable tools turning tasks it fails from weights alone into tasks it
solves reliably. Two are genuine tools-versus-no-tools gains on the same
1.5B model: knowledge absent from the weights **0% $\to$ 95%** by
retrieve-then-execute, and applying a retrieved skill rather than
reasoning it from scratch **63% $\to$ 93%**. Two are distillation gains
on the served model: code-correctness **68% $\to$ 100%** (raw base $\to$
distilled, in-distribution), and hard reasoning families **50% $\to$
92%** by distilled routing --- against a trained-specialist baseline, a
scope we flag rather than overclaim. The architecture is the capability,
not the raw weights --- the same claim the route graph makes for the
web.

#### Self-improving by reuse.

The system improves by running against itself. Resolving a fixed probe
set repeatedly, latency falls **21.1 s cold $\to$ 4.1 s warm
(**$-$`<!-- -->`{=html}80.7%**)** as the route cache fills, then
plateaus (tail spread 4.9% over the last five of twenty passes). The
plateau is a physical limit, not a tuning choice: once every route is
cached, further passes cannot reduce latency. Reuse, not retraining, is
where the compounding comes from.

#### Credentials are wallet-bound, witnessed end-to-end.

The auth descent is exercised against live endpoints: a credential is
*sealed to the holder's wallet*, revealed only for the correct key (a
wrong key fails closed), and attached to a real authorised request ---
an authenticated search and an authenticated action each round-trip
successfully, with the agent ever holding only a content-addressed
commitment, never the raw secret (`bench/agent-experience/`,
re-runnable). Sealing, fail-closed reveal, and the authorised round-trip
are all witnessed, not asserted.

#### BrowseComp and warm-cache self-improvement, measured.

On OpenAI's **BrowseComp** multi-hop browsing benchmark, driving the
same gpt-4.1 agent and grader through the route-graph search path across
repeated tries, the route/content cache warms run-over-run: per-query
wall-clock moves from 71 s on the cold graph to 82 s once warmed (**17%
slower**), the capture$\to$index$\to$reuse self-improvement the sealed
cache predicts. Accuracy is dominated by the agent harness above
retrieval and sits honestly below specialised search stacks (Exa's
published 0.336); we record the full per-try ledger in
`bench/browsecomp/SELF-IMPROVEMENT.md` rather than headline a number
this single-shot agent does not earn.

#### What this establishes, and what it does not.

The substrate tests establish that the security primitives are correct
as implemented; the micro-benchmark establishes that sealed-cache reuse
is cheap; the vendored uTLS layer and the coverage gate establish that
the descent reaches the network interface and returns real results
broadly; the anti-bot and wallet-auth measurements establish that the
descent retrieves real content past JavaScript-challenge anti-bot and
that credentials bind to the wallet end-to-end. What remains out of this
paper's scope is *end-to-end multi-hop task accuracy* on the open web
--- which is dominated by the agent harness above the retrieval layer,
not the substrate (we report our reproducible BrowseComp figure and its
warm-cache behaviour in the repository, honestly below specialised
search stacks) --- and emitting *real signed* OS/kernel/packet syscalls
across platforms: the fingerprint-faithful HTTP emission is shipped; raw
signed syscall descent is referenced, not claimed.

# Threat model

We state the adversary explicitly, because a trust paper that never
names what it defends against is decoration. We assume a Dolev--Yao
network attacker [@dolevyao] --- able to read, drop, replay, and forge
messages on any layer --- plus three application-level adversaries the
route economy specifically invites. For each, we name the atom that
resists it and the residual risk we do not claim to close.

#### (A1) The impersonator.

An attacker replays or forges an action to act as another identity.
Resisted at the *root*: every action carries an Ed25519 signature over
its canonical bytes [@rfc8032], and the ledger's `prev`-hash makes a
replayed entry detectable out of order [@rfc6962]. Residual: key theft
is out of scope --- a stolen wallet key is the user, by construction.
This is the same boundary every signing system accepts.

#### (A2) The credential thief / over-reach.

An operator retargets imported sessions at accounts they do not own ---
the abuse vector that closed the source [@ossnotice]. The *witness* atom
narrows it: credentials are bound to the identity by zero-knowledge
proof and revealed only under signature [@zklogin; @camlys], so a leaked
ledger or cache exposes *that* a credential is bound, never the
credential. Capability attenuation [@ocap] bounds what a delegated
action may do. Residual: an operator authenticated as themselves can
still drive their own credentials; we constrain reach, not self-harm.

#### (A3) The poisoner.

An adversary publishes a false or stale route to mislead later agents
--- the integrity attack on a shared graph. Resisted at *witness* and
*ledger*: every route attestation is signed and appended to the
hash-chained log [@rfc6962], and finalisation can require a $t$-of-$n$
quorum [@frost], so one dishonest maintainer cannot unilaterally settle
a claim and any tampered or reordered attestation is detectable.
Residual: routes are re-derived to verify rather than trusted on sight;
the model moves trust-sensitive traffic to corroborated routes, it does
not claim every route is adversary-proof.

#### (A4) The free-rider.

An actor consumes paid execution without paying. The *verb* atom binds
payment to the act: an unpaid `execute` gets HTTP 402, not
service [@x402], while discovery and internal-API routing stay free.
Residual: the free tier is, by design, free to consume; the payment gate
sits at execution, which is where the cost actually lands.

#### (A5) The exfiltrator of the moat.

An adversary --- or an honest contributor by accident --- leaks the
closed capture/integrity engine into a public artifact. Resisted
mechanically, not by policy: `leak-guard.sh` and `paper-gate.sh` run in
release CI and fail the build if a sensitive term or an unanchored claim
reaches a public path. This paper is itself subject to that gate.
Residual: NDA source review remains the only full-disclosure path, by
the abuse reasoning of [@ossnotice].

#### What we do not defend.

We make no claim against a malicious endpoint that lies in its own
responses (a route can faithfully replay a hostile API), a global
passive adversary correlating timing across the whole network, or
coercion of a key holder. These are out of scope and named so the reader
is not misled by silence.

# What is built, what is referenced (no fabricated green)

In the spirit of not selling a roadmap as a changelog, we separate what
runs in the product, what ships as runnable code, and where the work
stops:

- In the product: Intent $\to$ route resolve $\to$ execute; live browser
  capture; HTTP fetch with browser-faithful TLS fingerprinting;
  wallet-signed admission; route/endpoint caching.

- The cross-layer security primitives now ship in production, each with
  tests that execute the claim: the signed descent through every layer
  with vertical wallet ownership (`src/values/signed-descent.ts`,
  `src/values/wallet-hierarchy.ts`,
  `src/values/layer-wallet-descent.ts`), ZK credential binding --- the
  central contribution --- and its capture-boundary wiring
  (`src/values/zk-binding.ts`, `src/capture/zk-bound-hole.ts`), the
  sealed-unless-revealed cache (`src/values/wallet-seal.ts`), the
  signature-keyed, recomputable resolution cache and its ledger of
  resolutions (`src/values/resolution-ledger.ts`,
  `src/values/kv-fallback-pipe.ts`), and the hash-chained signed ledger
  (`src/values/sealed-ledger.ts`). The intended architecture is
  backend-as-harness --- the client surfacing only the holes to fill
  plus wallet-sealed auth, the backend returning nothing but structure;
  the composed flow and its sealing primitives are implemented
  (`src/capture/backend-reveng-endpoint.ts`), while the migration that
  moves the reverse-engineering engine fully server-side (out of the
  client's `src/reverse-engineer/`) is in progress. The stateless binary
  writes no local state (only pointers and signatures cross the wire).

- The runnable reference suite in `reference/` remains the cited
  foundation for each primitive above and for the parts not yet in the
  product: Merkle-root checkpoints with inclusion proofs
  (`ledger/checkpoint.py`). The on-chain deployment of the checkpoint
  root, the ERC-8004 registry binding, and a real signed
  OS/kernel/packet descent across platforms remain integration work,
  honestly labelled.

- Zero-edit drop-in replacements for the libraries an agent would
  otherwise reach for ship as packages backed by the route graph: an
  `exa-py` drop-in (`packages/py-exa`) and a `browser-use` drop-in
  (`packages/py-browser-use`), each providing the upstream's public
  surface so a single import swap routes the call through Unbrowse
  instead.

Treat the reference suite as running, tested code with cited foundations
--- not a feature list with a release date, and not a research agenda
either. The gap between running code and a press release is the entire
difference between a whitepaper and a pitch, and we would like to stay
on the correct side of it.

# Conclusion

Internal APIs were an excellent first layer --- enough to prove the
wedge in a real market, which is more than most ideas manage. They were
never going to be the last layer, because an agent that is sovereign
over its own actions has to be one coherent entity across every layer it
touches: under one key, revealing nothing it did not choose to reveal,
and standing behind its routes with something it can actually lose. The
contribution is deliberately modest --- one discipline (sign it, seal
it, cache it, bind identity without disclosure) that holds all the way
down, each layer pinned to a real primitive. Internal APIs were a great
deal of what you needed [@wedge] --- but it turns out *cryptography* was
what you needed for security.

::: thebibliography
99 L. Tham, N. Mac Gregor Garcia, J. Hahn. *Internal APIs Are All You
Need: Shadow APIs, Shared Discovery, and the Case Against Browser-First
Agent Architectures*. arXiv:2604.00694, 2026. L. Tham. *Unbrowse
Maintenance Network: Proof of Indexing and Bonded Accountability in a
Shared Route Graph*. Unbrowse AI, 2026. Unbrowse AI. *Open Source Notice
--- the closed/open boundary*. docs/OPEN-SOURCE-NOTICE.md, 2026.
Coinbase. *x402: An Open Protocol for Internet-Native Payments over HTTP
402*. x402.org whitepaper, 2025. <https://github.com/coinbase/x402>.
J. H. Saltzer, D. P. Reed, D. D. Clark. *End-to-End Arguments in System
Design*. ACM TOCS 2(4):277--288, 1984. DOI: 10.1145/357401.357402. ITU-T
Recommendation X.200 (= ISO/IEC 7498-1), *OSI Basic Reference Model*,
1994. S. Yao, J. Zhao, et al. *ReAct: Synergizing Reasoning and Acting
in Language Models*. ICLR 2023. arXiv:2210.03629. X. Deng, Y. Gu, et al.
*Mind2Web: Towards a Generalist Agent for the Web*. NeurIPS 2023.
arXiv:2306.06070. S. Zhou, F. F. Xu, et al. *WebArena: A Realistic Web
Environment for Building Autonomous Agents*. ICLR 2024.
arXiv:2307.13854. B. Zheng, B. Gou, et al. *GPT-4V(ision) is a
Generalist Web Agent, if Grounded (SeeAct)*. ICML 2024.
arXiv:2401.01614. T. Schick, J. Dwivedi-Yu, et al. *Toolformer: Language
Models Can Teach Themselves to Use Tools*. NeurIPS 2023.
arXiv:2302.04761. S. G. Patil, T. Zhang, et al. *Gorilla: Large Language
Model Connected with Massive APIs*. NeurIPS 2024. arXiv:2305.15334.
Anthropic. *Model Context Protocol*. 2024.
<https://modelcontextprotocol.io>. D. Dolev, A. C. Yao. *On the Security
of Public Key Protocols*. IEEE Trans. Information Theory 29(2), 1983.
DOI: 10.1109/TIT.1983.1056650. S. Josefsson, I. Liusvaara.
*Edwards-Curve Digital Signature Algorithm (EdDSA)*. RFC 8032, IRTF
CFRG, 2017. *ERC-8004: Trustless Agents*. Ethereum Improvement Proposals
(Draft). <https://eips.ethereum.org/EIPS/eip-8004> J. Camenisch,
A. Lysyanskaya. *An Efficient System for Non-transferable Anonymous
Credentials with Optional Anonymity Revocation*. EUROCRYPT 2001, LNCS
2045. IACR ePrint 2001/019. F. Baldimtsi, K. Chalkias, et al. *zkLogin:
Privacy-Preserving Blockchain Authentication with Existing Credentials*.
ACM CCS 2024. arXiv:2401.11735. Semaphore Protocol. *Semaphore:
anonymous signaling on Ethereum*.
<https://github.com/semaphore-protocol/semaphore> T. P. Pedersen.
*Non-Interactive and Information-Theoretic Secure Verifiable Secret
Sharing*. CRYPTO 1991, LNCS 576. DOI: 10.1007/3-540-46766-1_9.
R. C. Merkle. *A Digital Signature Based on a Conventional Encryption
Function*. CRYPTO 1987, LNCS 293. DOI: 10.1007/3-540-48184-2_32.
B. Laurie, A. Langley, E. Kasper. *Certificate Transparency*. RFC 6962,
IETF, 2013. S. Nakamoto. *Bitcoin: A Peer-to-Peer Electronic Cash
System*. 2008. <https://bitcoin.org/bitcoin.pdf> A. Yakovenko. *Solana:
A New Architecture for a High Performance Blockchain*. 2018.
<https://solana.com/solana-whitepaper.pdf> Protocol Labs. *IPFS / IPLD
Merkle-DAG specifications*. A. Vaswani, N. Shazeer, et al. *Attention Is
All You Need*. NeurIPS 2017. arXiv:1706.03762. W. Kwon, Z. Li, et al.
*Efficient Memory Management for Large Language Model Serving with
PagedAttention*. SOSP 2023. arXiv:2309.06180;
<https://github.com/vllm-project/vllm>. <https://github.com/ipfs/specs>
S. Chacon, B. Straub. *Pro Git*, 2nd ed., §10.2 Git Internals --- Git
Objects. <https://git-scm.com/book/en/v2/Git-Internals-Git-Objects>
D. McGrew. *An Interface and Algorithms for Authenticated Encryption*.
RFC 5116, 2008. M. S. Miller. *Robust Composition: Towards a Unified
Approach to Access Control and Concurrency Control*. PhD thesis, Johns
Hopkins University, 2006. curl-impersonate. *A special build of curl
that impersonates real browsers (TLS/HTTP fingerprints)*.
<https://github.com/lwthiker/curl-impersonate> Salesforce. *JA3: TLS
client fingerprinting*. <https://github.com/salesforce/ja3> FoxIO. *JA4+
network fingerprinting suite*. <https://github.com/FoxIO-LLC/ja4>
C. Komlo, I. Goldberg. *FROST: Flexible Round-Optimized Schnorr
Threshold Signatures*. SAC 2020, LNCS 12804. IACR ePrint 2020/852; RFC
9591. J. R. Boyd. *The Essence of Winning and Losing*, 1995; in *A
Discourse on Winning and Losing*, ed. G. Hammond, Air University Press,
2018. M. Burgess. *An approach to understanding policy based on autonomy
and voluntary cooperation*. DSOM 2005, LNCS 3775, pp. 97--108. See also
J. A. Bergstra, M. Burgess. *Promise Theory: Principles and
Applications*, 2014. B. Liskov, L. Shrira. *Promises: Linguistic Support
for Efficient Asynchronous Procedure Calls in Distributed Systems*. PLDI
1988, pp. 260--267. Originating the future construct: H. C. Baker,
C. Hewitt. *The Incremental Garbage Collection of Processes*.
Proc. Symp. on AI and Programming Languages, ACM, 1977.
:::

[^1]: The title is an affectionate mugging of "Attention Is All You
    Need." Yes, we know. That *is* the bit.
