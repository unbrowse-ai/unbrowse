# Credits and usage

Unbrowse uses account credits for metered work.

- Searching and resolving can be offered free or metered by the service.
- Metered executions deduct credits from the API key's account.
- New accounts may receive promotional credits.
- Contributors can earn credits when maintained routes are reused.
- Earned credits stay on the account ledger and can be redeemed later when the
  redemption program opens.

Agents authenticate with an API key and receive an ordinary HTTP error when the
balance is too low.

Check the balance in the CLI:

```bash
unbrowse settings
```

Or in TypeScript:

```ts
const credits = await unbrowse.account.credits();
console.log(credits.balance_uc);
```
