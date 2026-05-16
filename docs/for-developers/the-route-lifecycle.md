# The Route Lifecycle

This page describes, at a conceptual level, what happens to a route from first discovery to retirement. It is the model, not the implementation.

A route moves through a small set of states:

1. **Discovered.** An agent completed a task live and the structured request path behind it was recorded with what it needs and what it returns.
2. **Published.** The route entered the shared graph so other agents with the same intent can find it.
3. **Reused.** Resolve ranked it into a shortlist, an agent executed it, and the outcome fed back.
4. **Scored.** Reliability, freshness, and verification state move the route up or down in future shortlists.
5. **Drifted or retired.** When a site changes and a route stops returning what it used to, it is detected, demoted, and eventually deprecated so it stops misleading callers.

The practical consequence for an integrator: a route is not a frozen cURL string. It carries enough state for the system to keep good ones hot and route around dead ones, which is why reuse stays reliable as sites change. The deeper mechanics of discovery, scoring, and verification are described conceptually in the published paper and are out of scope here.

For what is and is not open, see the [Open Source Notice](../OPEN-SOURCE-NOTICE.md).
