# The Agentic Web

Unbrowse is built around a simple idea:
agents should work with web systems as *capabilities*, not as *screens*.

## The current reality: every action is already an API

Modern apps expose behavior through HTTP APIs first, and UIs render that behavior second.
When an agent:

- reads a page,
- clicks a button,
- waits for the view to update,
- and then reads text,

it is often reproducing a sequence of API calls through the browser.  
The browser is a translation layer between intent and service behavior.

This is expensive for agents:

- launch/attach cost in browser automation,
- DOM waits and selector drift,
- brittle parsing of rendered text,
- and repeated failures from layout/JS timing changes.

## What changes in an agentic web model

In an agentic web approach, an agent:

1. **Observes** a site through a normal browsing session once.
2. **Extracts** the real request/response contracts from that session.
3. **Replays** subsequent actions against direct endpoints.
4. **Composes** those endpoints as reusable, installable capabilities.

This is the transition from "UI-automation agent" to "service-aware agent."  
The user experience stays fast, while the agent gains reliability and composability.

## Why this matters for Unbrowse users

- Repetition gets faster: the second and later run uses endpoint paths, not rendering loops.
- Reliability increases: contracts are less sensitive than CSS selectors or screen order.
- Cost drops: fewer heavy browser cycles means less memory and less tail latency.
- Team value compounds: one capture can improve future workflows across agents.

## Speed implications (practical lens)

The difference is not incremental. A workflow that waits through:

- page startup,
- hydration,
- selector discovery,
- and DOM polling

can often be reduced to direct API calls after first learn.

In the same script shape, agents usually move from many-second UI loops to sub-second endpoint execution.

## Local-first foundation + shared growth

Unbrowse keeps execution local by default:

- capture and replay in `~/.openclaw/skills/<service>/`,
- keep private auth/session context local,
- run without the marketplace.

Optional publish turns a local skill into shared infrastructure:

- normalized and merged into marketplace index,
- discoverable via `search/install`,
- executable through remote contracts when configured.

The remote path is an **optional** growth layer, not the default control plane.

## Where Unbrowse’s marketplace sits in this model

The marketplace is intentionally a **contract boundary**:

- plugin emits local artifacts and requests,
- backend handles validate/merge/search/execute contracts,
- execution details, ranking internals, and partner routing are not required for agent behavior reasoning at user level.

From a contributor perspective, the important part is:
- deterministic captures,
- merge-compatible artifacts,
- predictable extension contracts.

## Agentic web vs automation-only strategy

Browser automation-first systems:
- scale poorly with action-heavy loops,
- can fail on tiny UI drift,
- repeat expensive browser work for the same endpoint behavior.

Agentic web systems:
- treat discovered endpoints as assets,
- treat skills as shareable software interfaces,
- turn each successful capture into reusable infrastructure.

That is the direction the docs and architecture here are organized around.

## In one line

Unbrowse is a protocol for turning website behavior into stable agent capabilities, starting with one local observation and expanding to reusable ecosystem skills.
