# unbrowse-utls-proxy

CONNECT proxy daemon that re-fingerprints TLS to look like Chrome 131.

> Eph 6:11-13 — *"Put on the whole armor of God... and having done all, to stand."*
> This binary IS the TLS-layer armor for unbrowse v7. Chrome's own TLS stack
> emits the stock Chromium ClientHello, but when routed through a generic
> HTTP CONNECT proxy (e.g. iproyal residential), the proxy re-handshakes
> upstream and THAT handshake is what anti-bot vendors fingerprint via
> JA3/JA4. This daemon sits between Chrome and the upstream and uses
> [refraction-networking/utls](https://github.com/refraction-networking/utls)
> to emit the Chrome 131-shaped ClientHello upstream.

## What it does

```
Chrome  ──CONNECT──▶  utls-proxy (this)  ──CONNECT──▶  iproyal residential  ──▶  origin
                          │
                          └──uTLS HelloChrome_131 primes the destination's first hello
```

The primer is the load-bearing spoof: the origin's first ClientHello is
uTLS-shaped (Chrome 131 cipher/extension order). After the primer tears
down, Chrome's own TLS flows through unchanged — and Chrome's own
ClientHello is also Chrome-shaped, so subsequent handshakes still
fingerprint as Chrome.

## Build

```bash
bash build.sh                                  # cross-compile all 4 platforms
go build ./cmd/utls-proxy                      # local-platform only
```

Binaries land in `dist/utls-proxy-<os>-<arch>`. Cross-compile targets:
darwin/arm64, darwin/amd64, linux/amd64, linux/arm64. Compressed with
`upx` if installed (binary size budget ≤8 MB per platform; build fails
loudly if exceeded).

## Run

```bash
# Local CONNECT proxy on random port, no upstream (direct dial).
./utls-proxy --verbose

# Front an iproyal upstream. Auth comes from env, NEVER argv.
export UNBROWSE_UPSTREAM_PROXY_AUTH="USERNAME:PASSWORD_country-us_session-abc"
./utls-proxy --upstream http://geo.iproyal.com:12321 --listen 127.0.0.1:0
# stdout emits "listening on 127.0.0.1:<port>" once ready.
```

### Flags

| flag | default | meaning |
|---|---|---|
| `--listen` | `127.0.0.1:0` | bind address (0 = ephemeral). Always loopback. |
| `--upstream` | (none) | upstream proxy URL; empty = direct dial. URL-embedded creds are stripped (use env). |
| `--fingerprint` | `chrome_131` | uTLS fingerprint: `chrome_131` (alias chrome_120 in utls v1.6.7), `chrome_120`, `firefox_120`, `auto` |
| `--verbose` | false | log connection events. NEVER logs auth or body. |

### Env

| var | meaning |
|---|---|
| `UNBROWSE_UPSTREAM_PROXY_AUTH` | `user:pass` for the upstream proxy. Base64-encoded into `Proxy-Authorization`. NEVER appears in `ps`/`argv`. |

## Security / trust model

- The daemon binds 127.0.0.1 only. There is no remote listener.
- The primer uTLS handshake DOES terminate against the destination's TLS;
  this means the daemon process sees plaintext at the moment of handshake.
  It does not log, persist, or inspect any payload — it tears down the
  primer immediately and lets Chrome re-handshake.
- Upstream proxy auth is env-only. Passing creds in `--upstream` is
  silently stripped to prevent argv leakage. Same reason logs only show
  the upstream host, never the auth.
- Bundle size is capped at 8 MB post-upx so the npm vendor surface stays
  reasonable. Bump the go.mod dep list cautiously.

## Fingerprint pin

`chrome_131` resolves to `utls.HelloChrome_120` in utls v1.6.7 (that is the
highest named Chrome hello shipped by utls at the time of W13.1). The JA3
shape matches Chrome 131 at the wire level. When utls publishes a true
`HelloChrome_131`, bump `go.mod` AND the switch in
`cmd/utls-proxy/main.go:resolveFingerprint` in lockstep with
`PINNED_CHROME_BUILD_ID` in `src/cdp/chrome.ts`.

## Honest fall-through

If `go build` fails on a platform, `build.sh` logs it and continues. The
TypeScript wrapper at `src/cdp/proxy/utls-daemon.ts` returns a 503
envelope when the binary is missing for the runtime platform — the rest
of the proxy chain still works (iproyal-only, no TLS spoof). No silent.
