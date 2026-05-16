# Shadow APIs

Every website an agent visits is already an API; the browser is just the client.

When a page loads or a button is clicked, the browser issues structured requests to the site's own backend and renders the responses. Those requests are the shadow API: a real, working interface that exists whether or not the site documents one. A browser-first agent ignores this layer and re-derives the same outcome through the visible page every time.

The published paper's argument is that internal APIs are all you need: most agent web tasks reduce to a request the browser was already going to make, so an agent that learns that request can skip the interface. This reframes web automation from "control a browser" to "discover and reuse the request behind the browser."

Shadow APIs are per-site and undocumented, which is why they have to be discovered from real use rather than looked up. How discovered routes are stored and kept useful is the subject of the next pages. The deeper extraction mechanics are described at the paper's level of abstraction and not below it.
