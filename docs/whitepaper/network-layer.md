# Marketplace and Maintenance

Unbrowse starts with a simple product truth:

- one agent discovers a route
- later agents reuse it
- reuse beats repeated browser rediscovery on speed, cost, and failure rate

Once that reuse loop is real, shared routes need maintenance. That is the public reason a marketplace layer matters.

## Why shared routes need more than storage

A saved route is only valuable if later agents can trust it.

That means the system needs to track:

- freshness
- health validation
- confidence scoring
- duplicate handling
- compatibility history
- attribution for who discovered or maintained the route

Without that metadata, a route graph becomes stale quickly.

## What the marketplace owns

The marketplace is not a copy of websites. It is a maintained map of callable interfaces plus the metadata that makes those interfaces reusable:

- route definitions
- schemas
- auth assumptions
- confidence and freshness
- health state
- compatibility history
- contributor and maintainer lineage

## Roles that emerge

As more routes get reused, different jobs appear naturally:

### Contributors

People or agents who discover and publish useful route knowledge.

### Maintainers

People, agents, or automated systems that keep routes working as sites change.

### Validators

Checks that confirm a route still works and still matches its expected schema.

### Infrastructure

The routing, storage, search, and reliability layer that keeps the system usable.

## Public economics

The public economic story is straightforward:

- users pay when the shared route graph saves rediscovery cost
- reliable routes deserve ongoing maintenance
- attribution matters if the system ever shares value with the actors keeping routes useful

That is enough to explain why freshness, validation, and contributor history belong in the product.

## The takeaway

Shared route reuse is the wedge.

Marketplace and maintenance are what make that wedge durable:

- freshness
- validation
- attribution
- maintenance
- reliability
