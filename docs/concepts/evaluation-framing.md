# How Quality Is Evaluated

Unbrowse is judged by whether an agent actually got the data the intent asked for, not by whether a call returned a 200.

The canonical check is an agent-experience harness: it runs real intents end to end, collects the artifacts (what was returned, from where, how long it took), and an agent judges whether the result satisfied the intent. There is no regex pass or fail, because a page can return HTTP 200 and still be a captcha, an empty array, or the wrong shape. Evidence is collected; judgement is made against the intent.

The paper separates two performance regimes, and it is worth keeping them distinct when reading any claim:

* **Warmed-cache** performance: the route already exists in the graph, so the cost is a lookup and a call.
* **Cold-start** performance: the route has to be learned live first, which is the expensive path the wedge is designed to amortise.

A claim about speed or cost only means something once you know which regime it describes. Aggregate cost and network-growth analysis live in the published paper; specific internal numbers move and are not pinned here. Current live metrics are exposed at the public stats endpoint rather than baked into this page, because numbers in prose go stale.
