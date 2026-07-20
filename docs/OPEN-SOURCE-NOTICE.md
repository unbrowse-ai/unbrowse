# Open-source notice

The Unbrowse client boundary is MIT licensed and auditable in this repository.
It includes the CLI, local runtime bridge, TypeScript SDK, Agent Skill, drop-in
adapters, browser control, capture sanitization, and local credential handling.

The hosted route graph, ranking service, account credit ledger, and web
application are operated services. The public client communicates with those
services through typed HTTP contracts and remains usable for local capture and
execution.

Unbrowse publishes the code that runs on your machine because it can access
browser profiles and site sessions. The backend never needs those raw values;
only sanitized route shapes may cross the boundary after an explicit publish
checkpoint.
