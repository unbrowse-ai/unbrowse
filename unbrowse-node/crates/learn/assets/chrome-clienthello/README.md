# The browser's ClientHello, captured

Taken without privileges: a local CONNECT proxy (`/tmp/chsniff.js`) records the
first TLS record of each tunnel while the minting Chrome browses through it.

Why it is here: a door (AWS WAF at Skyscanner) challenges our client but never
the browser, and the difference is the handshake. Measured against the
browser's own numbers, our transport sends 18 extension entries (16 counted,
2 GREASE) and the browser sends 20 (18 counted). The two it has and we do not:

| extension | bytes | note |
|---|---|---|
| 0x12e0 (4832) | `0000` | two bytes |
| 0xca34 (51764) | 186 bytes | a capability list, saved in `ext-51764.hex` |

With those bytes, a BoringSSL patch can emit them: the vendored btls fork
already registers extensions in `ssl/extensions.cc`'s `kExtensions[]` table
(see its own `record_size_limit` entry for the pattern), so the same shape of
patch adds ours with static payloads.

## The patch, and where it stops

`chrome-ext.patch` applies to BoringSSL's `ssl/extensions.cc`: two
`add_clienthello` callbacks writing the captured bytes, and two entries in the
`kExtensions[]` table. To try it:

    cp -R ~/.cargo/registry/src/*/btls-sys-0.5.6 vendor/btls-sys
    cp chrome-ext.patch vendor/btls-sys/patches/
    # register it in vendor/btls-sys/build/main.rs after "boringssl.patch"
    # add to the workspace Cargo.toml:
    #   [patch.crates-io]
    #   btls-sys = { path = "vendor/btls-sys" }

Status: **working**. The callbacks take the table's four-argument form
(`const SSL_HANDSHAKE*, CBB* out, CBB* out_compressible,
ssl_client_hello_type_t`). Every slot is non-null: BoringSSL calls each
extension's `parse_serverhello` with a null buffer for whatever the server left
out, so a null handler is a call through a null pointer. The first version of
this patch left them null and crashed the process inside
`ssl_parse_serverhello_tlsext` on the first TLS 1.3 handshake — every
browserless call, and the node with it. The two entries now borrow the fork's
own `ignore_parse_clienthello` / `dont_add_serverhello`, and take an echoed
extension rather than rejecting it, since neither carries anything a client
acts on.

`scripts/apply-tls-patch.sh` vendors btls-sys, drops the patch in and points
the workspace at it (idempotent; the vendored tree stays out of git).

Measured after the patch: Skyscanner, which challenged every call with a 405
before, answers the browserless call with a redirect and then 200 — the WAF's
handshake judgement no longer fires. Every site in the sweep is now served
browserlessly.

## The signature algorithms, and the drift alarm

The extensions were not the whole handshake. Measured 2026-11-20 against the
minting Chrome 157 (`tls.peet.ws`, both clients): ciphers, the 18-extension set
and the HTTP/2 Akamai fingerprint matched, but the JA4 differed —
transport `t13d1518h2_8daaf6152771_f9a770a73cc2`, browser
`t13d1518h2_8daaf6152771_4980c97edce0`. The difference was the
`signature_algorithms` extension: the browser offers the RSA-PSS-PSS trio
(0x0904, 0x0905, 0x0906) and the transport's BoringSSL did not know them, so
`http.rs`'s sigalgs list was refused (`INVALID_SIGNATURE_ALGORITHM`) and the
client silently fell back to a shape no Chrome has. A door that binds its
clearance to the browser's ClientHello (DataDome's `datadome`) then refuses
every browserless replay while the walk itself passes.

`chrome-pss.patch` adds the three code points, their `kSignatureAlgorithms`
entries (the fork's own RSAE shape, `EVP_PKEY_RSA_PSS`), their names, and the
key type. Additive: nothing selects them unless a sigalgs list asks by name.
`scripts/apply-tls-patch.sh` vendors and registers both patches.

Two build traps, both measured:

- **cmake-rs reuses its cache.** `cargo clean -p btls-sys` removes the rlib but
  not `target/debug/build/btls-sys-*/out`, and the patched source compiles to
  zero CXX objects against the stale cache. Remove `build/btls-sys-*` (and its
  `.fingerprint`) to force the rebuild; `grep -c 'Building CXX'` on the build
  log says whether it happened.
- **CI caches the vendor dir** keyed on the script and `chrome-ext.patch`
  (ci.yml, coverage.yml). A new patch must join that key or CI restores the
  unpatched tree.

`http::sigalgs_held()` and the test
`the_transport_holds_the_browsers_pss_pss_signature_algorithms` hold every
build to the patched stack: the fallback still keeps an unpatched build
calling, but it can no longer pass silently.
