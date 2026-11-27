# unbrowse-rpc

`rpc.unbrowse.ai`: Arc's JSON-RPC for the nodes of owners signed in on unbrowse.ai with Privy, relayed to the Alchemy app
Unbrowse pays for. Arc's public endpoints can't carry a node: Circle's rate-limits each address and refuses block
filters, Blockdaemon's keyless one has pruned its history, and Alchemy's free tier reads logs ten blocks at a time. A
node of a signed-in owner reads the chain here; every other node reads Circle's public endpoint. Circle's endpoint stays
every node's second RPC (`check_rpc`), which this gateway's operator isn't.

## What it serves

| Path | From | What |
|---|---|---|
| `POST /members` | the link page | `Authorization: Bearer <Privy access token>`, body `{"node": "0x…"}`: the node becomes a member under the Privy user the token names, at most 10 nodes a user |
| `POST /<network>/<pass>` | a member node | JSON-RPC, one call or a batch of up to 50, relayed to Alchemy; `<network>` is `arc-mainnet` or `arc-testnet` |
| `POST /<network>/<pass>/createTask`, `/getTaskResult` | a member node | a captcha task, relayed to the solver Unbrowse pays for with its key (`SOLVER_KEY`) put in: the node's own solver (`unbrowse-node/app/src/solver.rs`) when its owner configured none |

A **pass** is `<node>.<expiry>.<signature>`: the node's own key signs `passMessage(network, expiry)` (`src/gate.js`) as
an EIP-191 message, for at most two days ahead. The gateway recovers the signer, holds it to the node the pass names and to
the network in the path, and relays only for members. A Privy token is checked against the keys Privy publishes for the
app (`auth.privy.io/api/v1/apps/<app id>/jwks.json`): no Privy secret is needed.

**Gas.** A member node's gas is Unbrowse's: the first time it reads a network here holding less than 0.05 USDC, the
gateway sends it 0.10 from the gas wallet (`GAS_KEY`) as a plain 21,000-gas transfer, once a node a network, within 20 USDC a network a day, the gas fee counted in it
(`src/drip.js`). The send runs beside the node's call, one at a time in the `Members` Durable Object, recorded before it
goes out.

**Captchas.** A member node meets a check with Unbrowse's solver account (2captcha, `api.2captcha.com`) through the
same pass: the gateway takes the node's createTask or getTaskResult, drops any key the node sent, puts `SOLVER_KEY` in and
relays the solver's answer as it came (`src/captcha.js`). It relays only token tasks the solver answers from its own
network (reCAPTCHA v2, v2 Enterprise and v3, Turnstile, GeeTest) and picture tasks (coordinates, grid); a node reads
only the answers to tasks it started; one Privy account's nodes start at most 50 tasks a day, and all members together
1,000. A refusal made here is said in the solver's own shape (`errorId`, `errorCode`).

It relays only the methods a node calls (`METHODS`), `eth_getLogs` over at most 10,000 blocks, and each node at most 600
calls a minute, a batch costing one a call (the `PER_NODE` rate limit). It logs nothing: invocation logs would hold the passes in the URLs.

## Running it

| | Staging | Production |
|---|---|---|
| Config | `wrangler.staging.jsonc` | `wrangler.jsonc` |
| Address | `rpc-staging.unbrowse.ai` | `rpc.unbrowse.ai` |
| Members | its own | its own |

Both are deployed by the release train (`.deploy/manifest.json`), never by hand. Each environment requires three Wrangler secrets:

- `ALCHEMY_KEY`: Arc RPC provider API key
- `GAS_KEY`: signing key for the member gas wallet
- `SOLVER_KEY`: captcha solver API key (without it, captcha paths answer `ERROR_NO_SOLVER`)

```sh
npx wrangler secret put ALCHEMY_KEY -c wrangler.staging.jsonc
npx wrangler secret put GAS_KEY -c wrangler.staging.jsonc
npx wrangler secret put SOLVER_KEY -c wrangler.staging.jsonc
# Repeat with -c wrangler.jsonc for production
```

```sh
npm ci
npm test                                         # passes, Privy tokens, the methods and ranges relayed
node gate.mjs <base url>                         # a deployed gateway's refusals; prints RPC_GATE_OK
```
