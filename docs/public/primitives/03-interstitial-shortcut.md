# Interstitial shortcut

## The rule

When the orchestrator detects that a URL serves a verification interstitial (Cloudflare's "Please wait", a similar JS challenge), it attempts a fingerprinted HTTP fetch before falling back to a real browser session.

If the fingerprinted fetch returns real content, the request resolves in a few seconds. If it does not, the request falls through to the existing browser ladder. There is no regression on either side.

## Why it exists

A full browser session for a content read takes 30 seconds or more (cold Chrome launch, navigation, hydration wait, network capture, snapshot). For sites that serve the interstitial only to high-volume datacenter traffic, the same URL fetched with a browser-shaped TLS fingerprint and a residential IP returns the underlying HTML in one HTTP round trip.

The shortcut saves the multi-second startup cost when it works. The browser ladder is still the fallback when the page is genuinely behind a JS challenge that requires execution.

## How it fires

The orchestrator inspects the response shape on direct document fetches. When the response body matches an interstitial signature (a small inline script that schedules a refresh, a known vendor banner, "verifying your browser"), the orchestrator routes the URL to the fingerprinted fetch path.

The fingerprinted fetch uses libcurl-impersonate via a Python subprocess (`scripts/curl-impersonate-fetch.py`). It picks a Chrome 131 TLS fingerprint and routes through the residential proxy when `UNBROWSE_PROXY_URL` is set.

Honest fall-through conditions logged to stderr:

```
[direct-document] curl_cffi returned <N> bytes but extraction quality insufficient (JS-challenge body still interstitial) — falling through to browser ladder
[direct-document] curl_cffi status=<code> bytes=<N> — proxy reachable but content not viable, falling through to browser ladder
```

When the shortcut succeeds:

```
[direct-document] <url> interstitial bypassed via curl_cffi: <N> bytes proxy=<url-redacted> — skipping browser ladder
```

## What this rules out

- A "we always curl_cffi this domain" registry of any kind.
- Silent shortcuts that report success when the body is still an interstitial.
- Shortcuts that skip the existing browser ladder when fingerprinted fetch fails.
