# Resolve and Execute

Resolve and execute are deliberately two calls so that the picking decision stays with the agent's reasoning, not with a heuristic.

## Resolve

Resolve takes an intent (a natural-language task) and usually a URL or domain. It returns a ranked shortlist of candidate routes. Each candidate carries evidence the agent can judge against the intent:

* the route and what it returns
* what inputs it requires and what it yields
* a reliability and freshness signal
* the action kind (read versus write)

Resolve searches local cache and the shared graph first. It only falls back to live capture when reuse genuinely fails.

## Execute

Execute runs one chosen route. The agent passes the route (or the resolve result) plus any parameters. The response is the data the intent asked for. Projection options control the shape of the response so the agent gets the content it needs rather than the schema.

## Why two calls

A single auto-executing call would force a machine to guess which route the agent meant. The two-call contract keeps that judgement in the calling model, which is the part that actually understands the intent. Unbrowse's job is to make the shortlist correct and the evidence honest, not to choose.

## After execute

Send feedback. Feedback is what keeps a reused graph trustworthy: routes that satisfy intents stay ranked, routes that stop working fall away.
