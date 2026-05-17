# Stripe test-mode IDs provisioned in wave 5

Provisioned 2026-05-18 via `stripe` CLI against account
`acct_1Ruu6UJmoy2l93T2`, `livemode: false`. These are the **test-mode**
ids; recreate the same shapes in live mode when shipping to production.

## Meter

```
ID:               mtr_test_61UhYzMYYLbSbd1Mu41Jmoy2l93T2Hu4
display_name:     Unbrowse Execute
event_name:       unbrowse_execute
aggregation:      sum
customer_mapping: by_id from event payload key `stripe_customer_id`
value_settings:   payload key `value` (the amount_uc we POST per execute)
status:           active
```

Matches the default `STRIPE_METER_EVENT_NAME` constant in
`backend/src/services/stripe-meter-ring.ts` (`unbrowse_execute`), so no
env override is needed.

## Pro tier (flat $20/mo)

```
Product ID:  prod_UXFXWIVKShvUGm  (name: Unbrowse Pro)
Price ID:    price_1TYB2BJmoy2l93T2jDMukbCt
amount:      2000 cents = $20.00 USD
recurring:   month
usage_type:  licensed (flat fee)
```

Wave-3 `inferTier` will detect this price id and the wave-3 grant
dispatcher will add 200_000 µ¢ to the user's balance on subscription
events.

Set `STRIPE_PRICE_PRO_MONTHLY=price_1TYB2BJmoy2l93T2jDMukbCt`
(test-mode worker secret).

## Metered tier (per-execute usage)

```
Product ID:  prod_UXFXUoQi983q9F  (name: Unbrowse Metered)
Price ID:    price_1TYB2MJmoy2l93T2lHmCYMy0
amount:      $0.0000001 per unit (= 0.1 micro-cents)
recurring:   month, metered, linked to mtr_test_61UhYz...
```

Wave-5 W5-B fires `enqueueMeterEvent` per paid execute when the user
is on this tier; wave-3 `inferTier` returns `tier=metered, grant_uc=0`
so the flat grant path skips correctly.

Set `STRIPE_PRICE_METERED=price_1TYB2MJmoy2l93T2lHmCYMy0`
(test-mode worker secret).

## Archived

```
prod_UXFXZPt0vmudW8 (duplicate "Unbrowse Pro" created during the CLI
session, archived immediately)
```

## Live-mode handoff (when ready)

Re-run the same `stripe billing meters create`, `stripe products
create`, `stripe prices create` invocations against the live key (set
`STRIPE_API_KEY=sk_live_...` or `stripe --live-mode`), and update the
production worker secrets with the resulting `mtr_...` / `prod_...` /
`price_...` ids. The `event_name: unbrowse_execute` should stay the
same so the backend code doesn't have to branch.
