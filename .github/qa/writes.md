# Writes: the node, on sites built to be written to

You are checking Unbrowse's writes against public sites made for this: an order form, a demo login and a demo bank. A
node built from this repository is running on this machine, and you reach it through its MCP tools. Use only those
tools to reach websites. Nothing here is a real person's account, and nothing is bought. `RUN` below makes each account
your own for this run.

A write passes only when the site says so: what it echoes, the page it lands on, the balance it shows. `ok: true` is
not enough. A site that is down, or that its own demo reset broke, is `blocked`. Anything else that doesn't work is
`fail`, with the reply that shows it. Keep going after a failure.

## Checks

1. **an order form.** `unbrowse_do` with goal `submit the pizza order form`, url `https://httpbin.org/forms/post`. The
   reply's `how` is `browse`: loading a form never answers a goal that asks for a change. Fill the form with
   `unbrowse_browse` and submit it. The site echoes what it got: every value you filled is in its answer. A route was
   learned from it. `unbrowse_call` that route with other values: they come back in the echo.
2. **a login, right and wrong.** With `unbrowse_browse` on `https://the-internet.herokuapp.com/login`, sign in as
   `tomsmith` with `vault:the-internet.herokuapp.com:tomsmith`. The page says "You logged into a secure area!". Log out,
   then try the password `wrong-password`. The page says "Your password is invalid!". The two answers differ. Nothing any
   tool returned contains the real password.
3. **a bank, to the cent.** On `https://parabank.parasoft.com/parabank/register.htm` register the customer `qa<RUN>`
   with any made-up details. Read the accounts overview, open a second account if you need one, and transfer $1 between
   two accounts. The learned transfer route's inputs are named for what they are (`amount`, `fromAccountId`,
   `toAccountId`), never a snapshot's ref. Then, with no browser: transfer $1 through that route, read the balances
   through the learned balances route, and check both accounts moved by exactly $1.

## Report

Write two files in the working directory:

- `writes-report.md`: one line per check, `pass`, `fail` or `blocked`, and for anything but `pass` the reply that shows why
  (trimmed).
- `writes-verdict.json`: `{"pass": true|false, "checks": [{"n": 1, "result": "pass", "note": "..."}]}`. `pass` is false when
  any check is `fail`; `blocked` doesn't fail it.
