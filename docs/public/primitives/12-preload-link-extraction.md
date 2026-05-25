# Preload-link extraction

## The rule

When the page declares its data API as a `<link rel="preload" as="fetch" href="...">` or `<link rel="prefetch" href="...">`, the capture pipeline fetches the referenced URL via an in-page XHR and registers it as a discovered endpoint. The fetched response body is stored in `responseBodies` and added to `harEntries` as a synthetic GET request.

This is a structural primitive — it reads the head of the rendered page and only fires when the href is API-shaped (ends in `.json` or contains `/api/`, `/v1/`, `/v2/`, `/graphql/`, `/rest/`, `/gql/`).

## Why it exists

Many SPAs declare their data dependencies as preload hints so the browser fetches them eagerly while the JS bundle is still parsing. Examples observed in the wild:

| Site | Declared as |
|---|---|
| NUSMods | `<link rel="preload" as="fetch" href="https://api.nusmods.com/v2/.../moduleList.json">` |
| Many Next.js sites | `<link rel="prefetch" href="/_next/data/.../path.json">` |
| Many SvelteKit sites | `<link rel="modulepreload" href="/data.json">` (out of scope for now) |

The browser-eager fetch usually completes before our capture window closes — `performance.getEntriesByType('resource')` then catches it. But on slow networks or short capture windows the preload can lose the race, and the runtime sees an empty SPA shell with no data endpoints discovered.

Reading the head and fetching the API-shaped href directly removes that race. The fetch fires through the same in-page XHR path that the browser would have used, so cookies, headers, and CSP context replay correctly.

## What it never does

- Fetches non-API-shaped preloads (CSS, fonts, JS bundles, images). The shape filter rejects them.
- Re-fetches a URL that the perf API or HAR already captured. The `responseBodies.has(h)` check deduplicates.
- Fetches more than 10 URLs per capture. The cap is named in the primitive, not adjustable per request.
- Trusts cross-origin preloads. The fetch goes through the page's XHR so the browser enforces CORS as it always would.

## Where it lives

`src/capture/index.ts` — runs in the close-time enrichment phase, right after the existing SSR data extractors (`SSR_DATA_EXTRACTORS`) and before `mergePassiveCaptureData`.

## What this rules out

- A capture race where the user's SPA preloaded its only data endpoint and the close beat the fetch.
- A whole class of "we caught the HTML but no API endpoints" failures on data-rich SSR sites that hide their API behind a preload hint.
