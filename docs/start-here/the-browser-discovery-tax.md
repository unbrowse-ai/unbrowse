# The Browser-Discovery Tax

Every time an agent re-drives a website's interface, it pays a tax that produces nothing reusable.

A browser-first agent that checks the same dashboard a hundred times performs the same DOM parsing, the same element lookups, the same retries, and the same language-model reasoning a hundred times. The published research calls this the browser-discovery tax: the recurring cost of rediscovering a workflow that has not changed. None of that work is saved for the next run, so the hundred-and-first visit costs exactly as much as the first.

This matters because agent workloads are repetitive by nature. The same small set of tasks (read this inbox, list these events, fetch this price) runs over and over across many agents, and a browser-first design pays full price each time. Removing the tax does not require a smarter model; it requires not redoing solved work.

Unbrowse exists to collect that solved work once and hand it back cheaply, which is the subject of the next page.
