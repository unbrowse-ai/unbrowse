# Unbrowse In Plain English

Imagine you have a very capable assistant.

You ask them to book a flight, pull a price list, or check an inbox.

The assistant is smart enough to do it. The problem is the path.

Most AI agents use the web the way a tired human would:

- open the site
- wait for the page
- click through menus
- fight popups
- fill forms
- wait again

That is like sending your assistant through the lobby, the security desk and the elevator queue every single time.

## What Unbrowse changes

Every website has two layers:

- the pages humans see
- the requests the browser sends underneath

Unbrowse learns the second layer. The first time, the agent does the task in Unbrowse's cloud browser, and Unbrowse records what the site actually sends. After that, the same task runs as a direct request. No browser, no clicking.

Same permissions. Less ceremony.

## What it looks like today

Unbrowse is a hosted service. This repo is the small client that talks to it: a command-line tool, and a bridge so agent apps can use it.

1. An agent asks for a task.
2. Unbrowse checks what it already knows: the user's own sites, then a shared public list.
3. If it knows the task, it runs it directly.
4. If not, the agent does it once in the cloud browser. The task gets done, and Unbrowse learns it.
5. Next time, it runs directly.

## Logins

The agent never sees your passwords. You keep them in Unbrowse's password manager. When a site needs a login, Unbrowse types it into the page itself. If nothing is saved, you get a link to save it. Once signed in, Unbrowse keeps the session so it does not have to log in every time.

## What it costs

500 successful calls a month free, then $10 per 10,000. Only calls that actually returned a checked result count. Agents without an account can pay per call.

## What not to misread

Unbrowse is not a permission bypass. It does not grant access you do not already have.

It never shares your logins. Only public, read-only lookups are shared, with your own values removed.

And it is not everything the paper describes. The paper also imagines a market where people who teach routes get paid, and a system of independent validators. Neither exists today. See [Coming Soon](./coming-soon.md).

## Choose your next page

- [For Technical Readers](./for-technical-readers.md): architecture and evidence.
- [For Investors](./for-investors.md): market and business framing.
- [System Today](./system-today.md): the current-state reference.
