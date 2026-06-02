# The Shared Route Graph

Unbrowse turns one agent's successful web task into a reusable route that other agents can call.

When an agent completes a task through Unbrowse, the structured request path behind it (the route) is recorded with the information needed to run it again: the request shape, what it needs as input, what it returns, and how reliable it has been. That route goes into a shared graph, so the next agent with the same intent can look it up instead of rediscovering it from the visible page.

The payoff compounds because web tasks are shared, not unique to one user. A route learned by the first agent that needed it saves every later agent the full discovery cost, the way a map drawn once spares everyone after from re-surveying the road. The graph also tracks which routes still work, so stale ones fall out of the way rather than misleading callers.

A shared graph that many agents rely on raises its own question, which is how route quality is kept honest over time; that is covered in Concepts.
