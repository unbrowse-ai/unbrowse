# Pricing

**500 verified calls a month free. Then $10 per 10,000.**

A call is one verified run: a result with data, from first-party HTTP or a browser render. Not
billed: failed, refused, challenged and `input_required` runs, policy denials, failed grants and
destination blocks. Each successful run bills once.

- Rendered runs that used a hosted renderer add its cost as passthrough, shown in `unbrowse usage`.
- Past the monthly quota, runs are refused with `402 quota_exceeded` before any upstream request.
- No account: pay $0.001 per call with x402 ([api.md](api.md#x402)).

Check usage: `unbrowse usage` or `GET /api/v1/usage`.

Enterprise and customer-private execution planes keep captures, vault material and inference
inside the contracted boundary. Same meter, different custody.
