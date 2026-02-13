# Unbrowse Purpose and Vision

Unbrowse exists to make web app behavior machine-operable for agents using captured, reusable artifacts.

## What it does

- capture traffic from real user sessions
- infer endpoint contracts
- generate deterministic local skill artifacts
- replay locally by default from those artifacts
- publish to shared index when collaboration or discoverability is needed

## What it does not do

- It is not a generic browser bot.
- It does not expose raw credentials in public packages.
- It does not document marketplace internals beyond contract behavior.

## Core thesis

One agent learning from real traffic should make that behavior discoverable and reusable, while preserving local control over execution credentials.

## Local-first philosophy

- Every skill starts local.
- A skill can be used immediately without publishing.
- Local artifacts remain the source of truth for private sessions.
- Publish converts behavior to a shared skill artifact governed by server validation and merge policy.

## Contribution and sharing model

- local capture writes deterministic artifacts
- publish routes can merge and normalize with existing public versions
- contributions are tracked through contribution metadata and scoring behavior
- merged artifacts improve future replay quality when done correctly

## Backend visibility policy

This repo documents the server contract surface used by plugin + web:
- route shapes
- validation and auth policy
- trace and workflow outputs exposed at execution boundaries

It does not document settlement internals, hidden ranking strategies, or partner execution details.

## Payments

Payments are not enabled in this repository currently.

- wallet and payment middleware surfaces may exist
- paid settlement and payout routing are off
- do not treat paid behavior as currently active
