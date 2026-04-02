# Evaluation and Benchmarks

This page separates the paper’s evaluation claims from the evaluation stack that ships in the repo today.

## Paper Benchmark Context

The whitepaper reports:

* a warmed-cache comparison against browser automation
* cold-start measurements
* a 94-domain benchmark
* a broader framing around route reuse and benchmark amortization

Those results belong to the paper and should be cited as paper results.

## Current Product-Truth Eval Stack

The repo’s canonical product evals are:

* `bun run eval:core`
* `bun run eval:full`

`eval:core` is the main public-confidence gate. It combines:

* marketplace retrieval checks
* product-success tasks
* WebArena-style multistep checks
* stable benchmark-backed slices

`eval:full` extends that when auth behavior matters.

## What the Current Evals Enforce

The current stack is stricter than a simple “did the final answer look okay?” check. It can enforce:

* retrieval correctness
* endpoint selection correctness
* execution correctness
* multistep workflow correctness

That is closer to the real product risk surface than a single benchmark score.

## Stable Benchmark-Backed Coverage

The repo also contains:

* WebArena-style cases
* adapted WebArena-Verified corpora
* stable verified slices that are healthy enough to use in the product gate

This matters because the paper benchmark is useful research context, but the shipping product needs a repeatable, clean gate that can run reliably during development and release work.

## How To Talk About Results

Use this split:

* Paper docs: historical benchmark and system-level argument
* Product docs: canonical eval stack and current gating behavior

That avoids mixing research numbers with whatever the repo currently enforces in CI or release validation.

## Benchmark Claims That Need Care

Treat these as paper-context statements unless freshly re-run:

* exact 94-domain result summaries
* exact warmed-cache medians and confidence intervals
* exact cold-start amortization break-even counts
* exact graph-size claims like total domains and endpoint counts

The repo’s eval system is alive and evolving. These docs therefore anchor on the evaluation framework that exists today, while keeping the paper benchmark available as research context.
