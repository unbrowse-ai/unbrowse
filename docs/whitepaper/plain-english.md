# Unbrowse In Plain English

Imagine you have an extremely capable assistant.

You ask them to book a flight, pull a pricing report, or post an update online.

The assistant is smart enough to do the task.

The problem is the path.

Most AI agents are forced to use the web the way a tired human would:

- open the site
- wait for the page
- click through menus
- fight popups
- fill forms
- wait again

That is like sending your assistant through the front lobby, security desk, elevator queue, and reception line every single time.

## What Unbrowse Changes

Unbrowse learns the structured request flow behind the website.

So instead of making the agent fight through the visible interface on every run, it can often use the underlying request path directly.

If the site still needs real browser state such as cookies, CSRF tokens, or redirect handling, Unbrowse keeps that browser context in the loop.

Same permissions.

Less ceremony.

## The Simple Mental Model

Think of a website as having two layers:

- the front-of-house layer humans see
- the request layer the browser uses under the hood

Traditional browser automation stays stuck in front-of-house.

Unbrowse learns the request layer, then reuses it.

That is why the product is usually faster and more reliable than UI-only automation.

## What The Product Actually Does Today

In this repo today, Unbrowse ships as:

- a local CLI
- a local server
- a browser-backed capture runtime
- a marketplace for reusable skills
- an MCP mode for agent hosts

The loop is straightforward:

1. An agent asks for a task.
2. Unbrowse checks local cache and the shared marketplace.
3. If a good route already exists, it uses it.
4. If not, it captures the site, learns candidate endpoints, and executes from that learned path.
5. Good routes can then be reused later.

## Why That Matters

The core advantage is not "AI got smarter."

The advantage is that the system stops rediscovering the same website workflow over and over.

One good capture can become a reusable skill.

That turns repeated web work from:

- slow
- brittle
- one-off

into something that gets better with reuse.

Another way to say it:

the web is full of useful workflows and live data, but most of that value is buried behind interfaces built for humans.

Unbrowse helps agents unlock that buried layer and turn it into reusable capability.

## What Not To Misread

Unbrowse is not a permission bypass.

It does not grant access the user does not already have.

It does not publish the user's credentials to the marketplace.

It is also important not to mix the shipped product with every forward-looking idea in the whitepaper.

Shipped today:

- local-first capture and execution
- reusable learned skills
- marketplace-backed reuse
- reliability scoring, verification, and drift handling
- x402-gated marketplace payment lane for paid search/execution, with wallet-linked payment metadata and current payout routing

Not fully shipped today:

- the paper's full multi-party payout and attribution model
- validator staking
- TEE-backed attestation

Those roadmap pieces are documented in [Coming Soon](./coming-soon.md).

## Choose Your Next Page

- Read [For Technical Readers](./for-technical-readers.md) if you want the architecture and eval truth.
- Read [For Investors](./for-investors.md) if you want the market and business framing.
- Read [System Today](./system-today.md) if you want the cleanest current-state reference.
