# unbrowse-detector

The pinned credential detector, **`unbrowse-detector/1`** (protocol R6.36, `fraud.detector`; spec §73.7 item 3).

One open set of patterns, run on the same bytes in two places:

- **The publishing node**, before it lists: `recipe::of_route` refuses a recipe whose canonical bytes it flags, and the
  compiler refuses a fixed value with no public source that it reads as a credential (R2.2).
- **Every verifier and caller**, on every body it fetches (`share::fetch`), before the body is run, kept or paid for.

A match is a leak. Liveness is never tested, because testing a credential means using it.

The crate has no float: byte regexes with Unicode off, integer entropy, and serde_json, so every node reads the bytes
the same way. (A zero-knowledge leak prover once linked it too; it went with the fraud court.)

## Patterns

| k | Name | Family | Shape | Randomness of its random part |
|---|---|---|---|---|
| 1 | `cloud-access-key-id` | cloud | `(AKIA\|ASIA)[A-Z2-7]{16}` | ≥ 2.5 bits/char |
| 2 | `cloud-api-key` | cloud | `AIza[0-9A-Za-z_-]{35}` | ≥ 3.5, letters and digits |
| 3 | `payment-live-secret-key` | payment | `(sk\|rk)_live_[0-9A-Za-z]{24,}` | ≥ 3.3, letters and digits |
| 4 | `payment-application-secret` | payment | `sq0csp-[0-9A-Za-z_-]{43}` | ≥ 3.5, letters and digits |
| 5 | `code-host-token` | code host | `gh[pousr]_[A-Za-z0-9]{36}` | ≥ 3.5, letters and digits |
| 6 | `code-host-fine-grained-token` | code host | `github_pat_[A-Za-z0-9_]{82}` | ≥ 4.0, letters and digits |
| 7 | `code-host-access-token` | code host | `glpat-[A-Za-z0-9_-]{20,}` | ≥ 3.3, letters and digits |
| 8 | `package-registry-token` | code host | `npm_[A-Za-z0-9]{36}` | ≥ 3.5, letters and digits |
| 9 | `chat-workspace-token` | chat | `xox[abposr]-[0-9]{6,16}-[0-9A-Za-z-]{12,}` | ≥ 3.3, letters and digits |
| 10 | `private-key-block` | private key | `-----BEGIN … PRIVATE KEY-----` and ≥ 64 base-64 chars of body | ≥ 4.5 over the body |
| 11 | `signed-session-token` | session | a JWT whose header names an `alg` other than `none` and whose claims name a `sub` | signature ≥ 3.5 |
| 12 | `bearer-credential` | session | `Bearer` and a token68 value of ≥ 20 | ≥ 3.3, letters and digits |
| 13 | `cookie-value` | session | a `cookie`/`set-cookie` field's `name=value` with a value of ≥ 16 | ≥ 3.3, letters and digits, ≥ 1/5 letters |
| 14 | `secret-named-value` | session | a value of ≥ 20 under a name with a secret word (`secret`, `password`, `api_key`, `access_token`, `session`, `token`, …) and none of the public words (`csrf`, `nonce`, `page`, `cursor`, `next`, `publishable`, …) | ≥ 3.3, letters and digits, ≥ 1/5 letters |

Formats 1 to 11 match anywhere in the bytes; a token is never part of a longer run of letters and digits. Patterns 13
and 14 read the bytes as names and values: JSON keys, a recipe field's `loc` key, body templates held as JSON strings,
and query strings. Payment patterns match live secret keys only: a publishable key is public by design, and a
test-mode key moves no money. A signed token with no subject (a project's public key a page ships) names no one.

**Excluded** (`exclude.rs`): a token whose SHA-256 is in the documented-examples list (`DOCUMENTED`, hashes only; the
keys themselves are never written in this repository), and any token that says it is a placeholder: it carries a
marker word vendors use for examples (`EXAMPLE`, `XXXX`, `YOUR`, `REDACTED`, `dummy`, …), a template brace or mask
character, or a run of more than six of one character.

The documented-examples list ships empty in version 1, so only the shape rules exclude examples: one without a marker
word or a long run would match. Filling the list means hashing the examples in vendors' documentation without writing
them down; that wasn't done for version 1, and a hash added later is a new version.

**Card numbers** (`card.rs`) are not a pattern of version 1. A Luhn-valid run of 13 to 19 digits, standing on its
own, with at most one space, dash or dot between two digits, is refused by the publishing node before it lists a body
(`recipe::leaks`). Verifiers don't read it: making it a pattern needs a new version. A long
id that happens to pass the check digit (about one in ten random ones) is refused too, and stays unlisted.

## False-positive rates (measured 1 November 2026, before pinning)

Measured with `leak::measure::measure_false_positives` (an ignored test that prints counts, pattern numbers, field names
and value shapes, never a value):

```sh
UNBROWSE_MEASURE_ROUTES=~/.unbrowse/routes UNBROWSE_MEASURE_BODIES=~/.unbrowse/bodies \
UNBROWSE_MEASURE_BANKS=test-banks cargo test -p unbrowse-node-app --bin unbrowse-node \
  measure_false_positives -- --ignored --nocapture
```

| Corpus | Documents | Flagged, any pattern | Rate, each of patterns 1 to 14 |
|---|---|---|---|
| Recipes compiled from a node's real learned routes (192 routes, 91 shareable) | 91 | 0 | 0 / 91 |
| Bodies the node published or fetched | 5 | 0 | 0 / 5 |
| `test-banks/` entries (sites, scenarios, probe results) | 168 | 0 | 0 / 168 |

So every pattern's measured false-positive rate on published bytes is 0 of 264 documents (below 1.1% at 95%
confidence, by the rule of three). Two of the 192 **raw route records**, which are never published, matched (pattern 2
once, pattern 14 once); the compiler took both values out, so neither reached a recipe.

**Misses.** On 10,000 made-up credentials of each format (`synth`), every pattern found its own in every case but two:
pattern 6 missed 1 and pattern 10 missed 1, each a random draw that fell under its randomness threshold (0.01%).

**What the measurement changed.** The compiler's old token rule refused any token-shaped header with no public source.
On the 192 routes it fired 8 times, every time on a `content-type` holding a multipart boundary, which refused 2 routes.
HTTP's representation and negotiation fields (RFC 9110 §8.3 to §8.6, §12.5) are now exempt. A broader rule that would
also refuse every random fixed value in a path or query was measured and dropped: it would have refused 18 of the 91
shareable recipes (one in five), every hit an id in a path segment and none a credential. A fixed value is refused
instead when the detector reads it, alone and under its field's name, as a credential.

## Versions

`VERSION` is `unbrowse-detector/1` and `VERSION_NUMBER` is 1, the `v` a leak proof names. A pattern's number never
changes meaning. A new version is a new leak program, so a new verifying key and a new court deployment: it applies
only to listings made under it.
