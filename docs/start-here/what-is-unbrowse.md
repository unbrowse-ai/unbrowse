# What Is Unbrowse

Unbrowse is an action layer for AI agents on the web. Instead of driving a browser by default, the agent tries to act through the site's real first-party APIs when those routes are available.

When an AI assistant books a flight, pulls a report, or posts an update, it usually controls a real browser: it opens the site, waits for the page, finds buttons, clicks, and re-reads the screen after every step. Every one of those steps can fail, and every one costs time and money. Unbrowse learns the request the browser was going to make underneath all that clicking, and makes that request directly the next time the same task comes up.

The reason this is faster is that the slow part of web automation is not the network, it is the interface dance: rendering pages, locating elements, recovering from layout changes, and asking a language model what to click next. Skipping that dance when it is not needed turns a multi-second, failure-prone sequence into a single call. When the site truly needs a browser, for example to sign in or carry a session cookie, Unbrowse still uses one; it just stops paying that cost on every routine run.

That is the whole idea: do the expensive discovery once, reuse the result, and keep a browser for the cases where a browser is actually required.
