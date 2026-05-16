# When It Uses a Browser

Unbrowse keeps a real browser in the loop only when the site genuinely depends on browser-bound state, and treats opening one as a cost to avoid, not a feature.

A browser session is used when the task needs things a bare request cannot carry:

* sign-in and session cookies
* cross-site request tokens
* redirect chains
* stricter authenticated single-page behaviour

For everything else, the reused route is cheaper and faster, so that path is preferred.

When live capture is unavoidable, Unbrowse opens a browse session, the agent drives it (navigate, snapshot, click, fill, submit), and the traffic is indexed passively so the next agent with the same intent does not have to repeat the session. The result is that browser use trends toward zero as the shared graph fills, rather than being paid on every run.

The operating principle: a browser open during normal operation is a multi-step event to be designed out, not relied on.
