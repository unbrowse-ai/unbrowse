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

## The runtime predicate (read this before reporting a bug)

The bridge only takes effect when the browser launches under Unbrowse's control. When Unbrowse attaches to a Chrome process the user already has open (the default in local development), the proxy flag is never applied: that Chrome was launched without a proxy, and CDP cannot retrofit one onto a running process.

In CI and in clean dev environments without a user Chrome, the browser launches under Unbrowse's control and the proxy takes effect. In local environments with a running Chrome, the user needs to close that Chrome (or set `KURI_ATTACH_TO_EXISTING_CHROME=0`) before the bridge produces observable behavior.

## What this rules out

- Hardcoded per-site proxy lists in the codebase.
- "We always route Reddit through proxy" style decisions in any conditional.
- Proxy credentials in any commit, any artifact, any log line at any verbosity.
- A bridge that wires the proxy but does not surface the wire-up.
