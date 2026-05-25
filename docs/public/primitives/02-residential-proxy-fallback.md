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

## How managed Chrome is forced (and the auth caveat)

CDP cannot retrofit a proxy onto a Chrome process that was already launched without one. When the bridge wires a proxy, it tries to set `KURI_DISABLE_CDP_ATTACH=1` so the Unbrowse launcher starts a new managed Chrome that actually receives the `--proxy-server` flag.

There is one honest exception. Chrome's `--proxy-server` flag does not accept inline credentials (`user:pass@host:port`); a URL in that shape returns `ERR_NO_SUPPORTED_PROXIES` on every navigation. When the bridge detects inline credentials in the proxy URL, it does not force managed Chrome. It logs the limitation to stderr so the operator knows the wire-up is partial:

```
[kuri-proxy] proxy has inline credentials; Chrome --proxy-server rejects auth-in-URL.
Not forcing managed Chrome (proxy applies only when kuri launches its own browser for other reasons).
```

In this state, the bridge still sets `KURI_PROXY`. When kuri launches managed Chrome for other reasons (no user Chrome to attach to, or `KURI_DISABLE_CDP_ATTACH=1` already in env), the proxy is passed through. When kuri attaches to user Chrome, the proxy is not applied for that session.

The proper fix is a future `KURI_PROXY_USERNAME` / `KURI_PROXY_PASSWORD` env that kuri injects via a PAC script or basic-auth extension, so credentials never travel in the URL. Until that ships, an unauthenticated proxy URL gives the bridge full effect, and an authenticated one gives partial effect with an honest stderr line.

## What this rules out

- Hardcoded per-site proxy lists in the codebase.
- "We always route Reddit through proxy" style decisions in any conditional.
- Proxy credentials in any commit, any artifact, any log line at any verbosity.
- A bridge that wires the proxy but does not surface the wire-up.
