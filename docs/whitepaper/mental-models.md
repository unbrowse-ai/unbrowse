# Mental Models

Analogies that help, updated for the current service.

## Search engine for actions

Google indexes information. Unbrowse indexes ways to get something done on a website.

Not every route is precomputed. In practice:

- learned capabilities are found in the caller's private space or the public registry
- if nothing fits, the agent does the task once in the cloud browser and Unbrowse learns it
- the learned capability serves later calls

An action index with live learning behind it.

## Private road, not public transit

Without Unbrowse, an agent walks through the visible interface: load, wait, click, guess.

With Unbrowse, it calls the request the page would have sent. A browser comes back only when it adds something: learning a new site, signing in once, or rendering a page HTTP cannot read.

Unbrowse is not "no browser ever". It is "browser only where it pays".

## Compiler, not recorder

Unbrowse is not a request recorder that replays forever. It compiles:

- two sessions are diffed to find what the caller fills in
- every token is traced back to the response that produced it
- the outcome request is picked and given a check
- the result is a typed harness, not a script

Then the run ledger decides what stays trusted.

## Paper vision vs product reality

- capability layer (learn, replay, verify): real
- shared registry: real for read-only lookups, still maturing
- flat metering and x402 pay-per-call: real
- route economy, payouts, validators: not built

## Read next

- [What Is Unbrowse?](./what-is-unbrowse.md)
- [How It Works](./how-it-works.md)
- [Coming Soon](./coming-soon.md)
