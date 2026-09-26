# Key Concepts

The terms used across these docs and the hosted service.

## Capability

The reusable unit Unbrowse learns. A capability does one task on one site: search flights, read a profile, book a seat. It may take several requests in order. It is called as one run.

Learned capabilities are named `learned.<site>.<goal>`. Public registry entries are named `public.<host>.<goal>`.

Older docs said "skill" or "endpoint". In the current service, a *skill* is the SKILL.md that describes a capability, and `unbrowse.skill.*` tools are typed tools for one capability.

## Harness YAML

Each capability is a versioned `unbrowse/v1alpha1` YAML package. It declares:

- slots: inputs the caller fills and choices the user picks
- operations: the requests, in order
- bindings: where each token and id comes from
- guards and outcome checks

YAML is the authoring form. The runtime executes a typed form of it. No eval, no shell, no website-provided expressions.

## Inputs, choices and parameters

- **Input**: a value the caller supplies, like `origin` or `query`.
- **Choice**: an option the user picks mid-run, like a flight. It comes back as an `input_required` requirement.
- **Parameter**: an optional knob the site's API takes (sort, page size, a paging field), defaulted to the value it was recorded with.

Session cookies, csrf values and tokens are never inputs.

## Learn

Turning recorded browser sessions into a capability. Sources: the service's cloud browser (`unbrowse.browse.*`), or HAR files and traces (`unbrowse.learn`). Two sessions with different inputs are needed to tell inputs from constants.

## Lifecycle

- `observed`: some values are unexplained. Browser-backed, not trusted.
- `candidate`: callable over the network.
- `validated`: passed validation for this exact package.

## Replay

Running a capability over first-party HTTP, with no browser. This is the fast path.

## Rendered

When HTTP cannot finish a read, the service renders the page in a browser and returns it. A rendered run is labelled `via: "rendered"`. A rendered capability is slower than a warm one.

## Private space and public registry

- **Private space**: what a workspace learned or connected. Searched first.
- **Public registry**: scrubbed, re-verified read-only capabilities any workspace can run.

## Verified outcome

`succeeded` means the declared business outcome was independently checked. HTTP 200 is not success. Only verified successes bill.

## Health and hints

Each capability has a run ledger. Discover turns it into hints: health (`healthy`, `degraded`, `failing`, `cooling_down`, `excluded`, `needs_sign_in`, `untested`), state (`warm`, `rendered`, `cold`), p50/p95 latency, success rate, and `next`.

## Exclusion

A capability whose binding no longer matches the site is excluded until a targeted revalidation passes. A new build does not lift it.

## Vault

The password manager. Agents see `vault://` references and masked hints, never values. The cloud browser fills logins into pages. See [Credential Sovereignty](./credential-sovereignty.md).

## Jev

A TypeSafe System One model that picks among eligible capabilities for a plain-language task. It may abstain. Without it, routing is deterministic. It never makes an ineligible capability eligible.

## Verified call

The billing unit. 500 a month free, then $10 per 10,000. Also payable per call with x402.

## Read next

- [How It Works](./how-it-works.md)
- [Evaluation and Benchmarks](./evaluation.md)
- [Paper vs Product Status](./paper-vs-product.md)
