# Build on Unbrowse

Install the current package:

```bash
npm install unbrowse@11.1.1
```

Choose the smallest useful surface:

- `createHole().fill()` for one intent-to-result call
- `Unbrowse.resolve()` plus `execute()` when your agent should inspect candidates
- `Unbrowse.proxy.fetch()` for controlled server-side egress
- `Unbrowse.account` and `Unbrowse.keys` for account operations

Applications authenticate with an API key. Metered work uses the account credit
balance and throws `UnbrowseInsufficientCreditsError` when the balance is too
low. State-changing executes receive idempotency keys automatically.

Keep site credentials in the local Unbrowse runtime. Do not send cookies or
site bearer values through your own application server unless that is already
part of your security model.
