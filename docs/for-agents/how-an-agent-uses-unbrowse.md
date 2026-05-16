# How an Agent Uses Unbrowse

This page is the operating model for an AI agent that has Unbrowse available as a tool.

The mental model is two steps, not one. The agent describes an intent and a target. Unbrowse returns a ranked shortlist of routes that could satisfy it, each with evidence (what it returns, what it needs, how reliable it has been). The agent's own reasoning picks the route that matches the intent, then calls execute on it. Unbrowse does not silently decide for the agent; it filters out the wrong routes and surfaces the evidence on the rest.

The loop in practice:

1. **Resolve** the intent against the shared graph and local cache.
2. **Read the shortlist.** Each candidate carries enough evidence to judge fit.
3. **Execute** the chosen route.
4. **Give feedback** on whether the result satisfied the intent. This keeps good routes ranked and bad ones out of the way.

If nothing in the graph fits, Unbrowse can open a browse session and learn the site live; the agent drives that session and Unbrowse indexes it passively so the next agent does not have to.

The single most important habit: treat resolve and execute as separate decisions. Resolve gathers options; the agent judges; execute commits.
