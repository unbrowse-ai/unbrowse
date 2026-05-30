# @unbrowse/adopt

**One command makes any repo a free Unbrowse drop-in — in its own syntax, with the upstream kept as the fallback.**

```bash
npx @unbrowse/adopt            # dry-run: show every swap as a diff, change nothing
npx @unbrowse/adopt --write    # apply the swaps
```

It rewrites imports of supported libraries to the matching Unbrowse drop-in shim:

```diff
- import axios from 'axios';
+ import axios from '@unbrowse/axios-shim';

- const got = require('got');
+ const got = require('@unbrowse/got-shim');

- import { chromium } from 'playwright';
+ import { chromium } from '@unbrowse/playwright-shim';
```

Each shim routes a safe `GET` through Unbrowse's resolved-route cache (free on a
hit) and **falls through to the original library on a miss** — so behaviour is
preserved, cost drops on cache hits, and the upstream stays installed as the
attributed fallback. Only the import specifier changes; your bindings, options,
and `package.json` are untouched (you choose when to `npm i` the shims).

## Supported libraries

`axios` · `got` · `ky` · `node-fetch` · `cross-fetch` · `puppeteer` ·
`playwright` · `@mendable/firecrawl-js` · `@browserbasehq/stagehand`

(The native `fetch` global is covered separately by `@unbrowse/client`'s
`unfetch`, since it has no import line to rewrite.)

## Adoption is by consent

This tool exists so a repo's **own maintainer** can adopt Unbrowse in one step and
review the diff — or so a contributor can open a clean, reviewable PR that the
maintainer accepts or declines. It never phones home, never edits `package.json`,
and is a pure local transform. We do not open unsolicited dependency PRs; the diff
is yours to run, read, and ship.

### Generating a PR for your own repo

```bash
git checkout -b adopt-unbrowse
npx @unbrowse/adopt --write
git commit -am "perf: route HTTP/browse through Unbrowse drop-ins (free on cache hit, upstream fallback)"
gh pr create --fill
```

## Programmatic use

```ts
import { adoptSource, summarize, DROP_IN_MAP } from '@unbrowse/adopt';
const { source, rewrites } = adoptSource(readFileSync('client.ts', 'utf8'));
```

## License

MIT. Mirrors and attributes the public surfaces of the upstream libraries it
adopts; each remains its owners' under its own license and stays the fallback.
