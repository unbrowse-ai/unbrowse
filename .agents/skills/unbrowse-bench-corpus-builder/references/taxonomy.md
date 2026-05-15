# Corpus Taxonomy

## Lanes

- `anchor`: must-pass public probes that block release when they fail.
- `semantic-rank`: entity substitution and wrong-entity regression probes.
- `graphql`: POST or GraphQL operation probes.
- `ssr-list`: server-rendered list pages where page content may be the data.
- `auth-gated`: expected auth handoff probes excluded from denominator.
- `hostile`: vendor-shielded probes expected to block, excluded when blocked.

## Auth

- `none`: public route.
- `optional`: public route may improve with cookies.
- `required`: login required for meaningful content.
- `blocked`: anti-bot or vendor shield expected.

## Difficulty

- `easy`: one public endpoint or stable structured page.
- `medium`: needs ranking, DOM extraction, or structured replay.
- `hard`: needs auth handoff, GraphQL, hostile SSR, or fragile entity binding.
- `hostile`: anti-bot or vendor-shielded.

## Strategy

- `direct-api`: known public API route.
- `dom-artifact`: extracted content from HTML or SSR page.
- `page-fetch`: rendered page fallback.
- `structured-replay`: captured network route replay.
- `graphql`: GraphQL operation route.
- `ssr-list`: public list page where page is data.
- `semantic-rank`: same host/template but entity must stay correct.
- `auth-handoff`: correct output is a login/session handoff.
- `browser-block`: correct output is blocked/excluded evidence.
