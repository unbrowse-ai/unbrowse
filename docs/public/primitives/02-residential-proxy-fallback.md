# Residential proxy fallback

## The rule

When the capability the agent asked for requires it (a Cloudflare JS challenge, a Reddit datacenter-IP block, a Linkedin-style fingerprint check), Unbrowse can route the request through a residential proxy. The default is off. The user opts in by env. Once on, the proxy is the canonical fallback for every transport in the chain (managed Chrome, libcurl-impersonate, direct fetch).

We use IPRoyal as the default residential pool. Any HTTP or SOCKS5 proxy URL the user sets works.

## Why we made it the canonical fallback

The alternative we ran first was per-domain heuristics: an internal list of "Cloudflare-protected sites" routed through proxy, everything else direct. That list grew, drifted, and never generalized to the eleventh site.

A residential proxy is a generic capability. The decision to use it is one bit, set by the user once. Every transport that supports a proxy honors the same env. The agent has no per-site code path.

## How a user opts in

```
UNBROWSE_KURI_PROXY=auto
IPROYAL_USER=<username>
IPROYAL_PASS=<password>
```

`UNBROWSE_KURI_PROXY=auto` is the master switch. When it is `auto`, `1`, or `true`, the runtime derives the proxy URL from `IPROYAL_USER`/`IPROYAL_PASS` (or `UNBROWSE_PROXY_URL` if set directly) and routes Kuri-managed Chrome, libcurl-impersonate, and HTTP fetches through it.

When `UNBROWSE_KURI_PROXY` is unset, `0`, or `false`, every transport runs direct. This is the default.

## What the user sees when it fires

On every CLI invocation where the bridge wired the proxy:

```
[kuri-proxy] wired KURI_PROXY (source=auto, url=http://***@geo.iproyal.com:12321)
```

The credentials are redacted in the log line. The redaction happens before stderr write.

When the user sets `UNBROWSE_KURI_PROXY=auto` but the credentials are missing:

```
[kuri-proxy] UNBROWSE_KURI_PROXY=auto but IPROYAL_USER/PASS + UNBROWSE_PROXY_URL both unset — kuri runs direct
```

This is the honest mode of the bridge: it tells the user the toggle was on but the credentials were missing, instead of silently routing direct.

## How managed Chrome is forced

CDP cannot retrofit a proxy onto a Chrome process that was already launched without one. The bridge sets `KURI_DISABLE_CDP_ATTACH=1` automatically when it wires a proxy, so the Unbrowse launcher starts a new managed Chrome instead of attaching to whatever Chrome the user already has open.

## How auth proxies work (the local forwarder)

Chrome's `--proxy-server` flag rejects URLs with inline credentials (`user:pass@host:port`) with `ERR_NO_SUPPORTED_PROXIES`. Because most residential pools (including IPRoyal) require auth, the bridge bridges Chrome to the authenticated upstream through a local TCP forwarder.

The mechanics:

1. Bridge detects the proxy URL has inline credentials.
2. Bridge spawns `scripts/local-proxy-auth-forwarder.py` with the upstream URL as an argument and a `--ready-file` pointer.
3. The forwarder listens on a kernel-picked localhost port, writes `port=<N>\n` to the ready file, then accepts unauthenticated connections.
4. Bridge polls the ready file (up to 3s), reads the port, sets `KURI_PROXY=http://127.0.0.1:<port>`, and forces managed Chrome.
5. Chrome accepts the localhost URL (no inline auth), connects to the forwarder. On every outbound, the forwarder injects `Proxy-Authorization: Basic <base64>` and forwards to the upstream.
6. Upstream returns residential traffic to Chrome.

The forwarder is detached from the parent process, so it survives the bridge's own exit; it cleans up when the standard `pkill` set runs (or when its parent kuri broker shuts down).

```
[kuri-proxy] auth-forwarder bridged: Chrome connects to http://127.0.0.1:51284 (unauth),
forwarder injects Proxy-Authorization to upstream. Chrome accepts the unauth localhost
URL where it rejected inline-auth.
```

Credentials never appear in the Chrome launch arguments or in the `KURI_PROXY` env that kuri's Zig binary sees. They live only inside the forwarder's memory and in the Proxy-Authorization header on outbound TCP.

The forwarder is the L0 wedge. The longer-term path is a Zig-native HTTP/2 stack with auth-aware proxy support baked directly into the kuri binary (`DEFERRED-KURI-FORK-FIRST-PRINCIPLES`); when that ships, the forwarder becomes obsolete.

## What this rules out

- Hardcoded per-site proxy lists in the codebase.
- "We always route Reddit through proxy" style decisions in any conditional.
- Proxy credentials in any commit, any artifact, any log line at any verbosity.
- A bridge that wires the proxy but does not surface the wire-up.
