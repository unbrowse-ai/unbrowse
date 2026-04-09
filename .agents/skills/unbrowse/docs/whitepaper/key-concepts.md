# Key Concepts

This page keeps the useful terminology from the old docs, but uses the names and system boundaries that match the repo today.

## Skill

A skill is the reusable unit Unbrowse learns from real web usage.

In practice, skills contain one or more executable endpoints plus metadata used for search, ranking, verification, and execution.

The older docs sometimes used "ability." The current repo and public surfaces use "skill."

## Endpoint

An endpoint is the concrete executable route inside a skill.

It describes things like:

- method
- normalized URL pattern
- request templates
- extraction behavior
- safety and drift state
- reliability and verification status

## Resolve

Resolve is the product entrypoint where Unbrowse takes a task and determines the best route to execute.

That decision can use:

- local cache
- marketplace search
- live capture fallback

## Browser Parity

Browser parity means preserving the parts of site behavior that depend on a real browser session.

That can include:

- cookies
- CSRF state
- redirect behavior
- stricter authenticated runtime assumptions

It does not mean the browser is always the execution path. It means Unbrowse can stay faithful to browser behavior when the site requires it.

## Marketplace

The marketplace is the shared memory layer for learned skills.

Today it supports:

- publish
- fetch
- search
- ranking
- verification-aware reuse
- issue reporting

It is already real product infrastructure, but it is not yet the full route economy described in the paper.

## Reliability

Reliability is the practical trust signal used to keep good routes hot and bad routes out of the way.

The current system incorporates:

- success and failure behavior
- verification state
- freshness
- user feedback
- schema drift

## Verification

Verification in the repo today is a practical replay and health concept, not a cryptographic attestation market.

That distinction matters.

Shipped today:

- route verification
- status-aware ranking
- drift handling

Coming soon:

- validator staking
- signed attestations
- TEE or E2B-backed trust proofs

## Eval Truth

The canonical product-truth gates in this repo are:

- `eval:core`
- `eval:full`

These are the right reference points when describing current product quality. Historical paper benchmark numbers should be treated as paper context unless freshly re-run.

## Read Next

- [How It Works](./how-it-works.md)
- [Evaluation and Benchmarks](./evaluation.md)
- [Paper vs Product Status](./paper-vs-product.md)
