# Terms of Service

Version 2026-11-01. Effective 1 November 2026.

These terms are between you and Unbrowse AI Pte. Ltd. (UEN 202425961N, Singapore) ("Unbrowse", "we"). They cover
your use of the Unbrowse node, its window, CLI and SDK (the "Software"), and the peer network and settlement contracts
the Software takes part in (the "Network"). The Software's source code is also licensed to you under the Apache
License 2.0 ([LICENSE](LICENSE)); nothing here takes away a right that license gives you over the code. These terms
govern running the Software and joining the Network.

The node joins the Network only once you have been shown these terms and chosen: on the window's first-run screen,
which also lets you keep the Network off, or with `unbrowse-node terms accept` on a machine with no window. Until then
it stays off the Network. You can keep it off at any time (in the window, or with `unbrowse-node network off`).
Acknowledging these terms with the Network on means you agree to them. If you don't agree, keep the Network off or
don't run the Software.

## 1. What Unbrowse is, and what it isn't

The Software is a tool, like a web browser or a BitTorrent client. It runs on your machine, under your control. It
learns how sites you visit answer their own pages ("routes"), and lets you share those routes with other nodes and use
routes other nodes share.

Unbrowse does not host, store, index, review, select, or control the routes, data, or content that nodes make, share,
call, or receive. Routes travel directly between nodes run by independent people. We have no ability to see what
passes between nodes, and no ability to remove it from a node we don't run. We are not a party to any exchange between
nodes or between you and any site.

## 2. Your responsibility

You alone are responsible for what you do with the Software, and for every route, call, page, and piece of data your
node learns, shares, serves, requests, or receives. In particular, you agree that:

- You will comply with every law that applies to you, including copyright, data protection, computer misuse, and
  export laws.
- You will respect the terms, access rules, and rate limits of the sites your node calls, and you are responsible for
  any breach of them. The Software calling a site does not mean you are permitted to call it.
- You will not use the Software or the Network to infringe anyone's intellectual property, to access an account or
  system you are not authorised to access, to collect personal data unlawfully, to distribute malware, to harass
  anyone, or to do anything illegal.
- You will not share a route that carries your, or anyone else's, credentials, cookies, tokens, or personal data.
- You are responsible for the security of your machine, your root key, your wallet, and your agents' keys. Lost keys
  cannot be recovered by us.

## 3. Payments, UNB, and the chain

Fees on the Network are priced in US dollars and paid in USDC, a stablecoin issued by Circle, through smart contracts
on the Arc blockchain. Transactions are public, final, and cannot be reversed by us. Unbrowse does not hold your USDC:
it stays at your node's address, or in your node's deposit in those contracts, under your node's key.

If you add funds by card or bank transfer, you buy USDC from the third-party provider named on the payment page, under
that provider's terms and identity checks. Unbrowse is not the seller and does not receive that money.

Fees for routes are paid in USDC, not in UNB. Each listed route can have its own route coin, bought and sold with
UNB on the Network's contracts. When your node pays a fee, part of that fee is converted into UNB and buys the route's
coin, which is staked in your node's name; staked coins of a route your node has checked are paid a part of later fees
on that route, in USDC. Nothing is bonded, and the Network's rules forfeit nothing. The Software may show UNB as "UNB
points". UNB and route coins are not an investment, security, deposit, or promise of any return, and we make no
promise about their value; it can change, and it can fall to nothing. Test chains and test tokens have no value. You are responsible for any taxes on what you earn
or pay.

## 4. Content complaints

Because we don't host or control what nodes share, a complaint about a route or content should go to the person
running the node that serves it, and, where relevant, to the site concerned. If you believe something served through
a service Unbrowse itself operates infringes your rights, write to hello@unbrowse.ai with: the material and where it
is, the right you hold, your contact details, and a statement made in good faith that the use is not authorised. We
will act on valid notices for services we operate, and may suspend repeat infringers from them.

## 5. No warranty

THE SOFTWARE AND THE NETWORK ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY,
OR THAT THEY WILL BE SECURE, UNINTERRUPTED, OR ERROR-FREE. We do not vouch for any route, node, or data on the
Network. Routes may be wrong, stale, or malicious. Smart contracts may have bugs. You use them at your own risk.

## 6. Limitation of liability

TO THE FULLEST EXTENT THE LAW ALLOWS, UNBROWSE, ITS AFFILIATES, AND THE PROJECT'S CONTRIBUTORS ARE NOT LIABLE TO YOU
OR ANYONE ELSE FOR ANY DAMAGES OR LOSS OF ANY KIND, WHETHER DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
EXEMPLARY, OR PUNITIVE, INCLUDING ANY LOSS OF PROFITS, DATA, TOKENS, FUNDS, ACCOUNTS, OR GOODWILL, ARISING FROM THE
SOFTWARE, THE NETWORK, ANY ROUTE OR CONTENT, OR THE CONDUCT OF ANY NODE OR USER, WHETHER IN CONTRACT, TORT
(INCLUDING NEGLIGENCE), OR OTHERWISE, EVEN IF TOLD SUCH LOSS WAS POSSIBLE.

IF, DESPITE THE PARAGRAPH ABOVE, A COURT HOLDS ANY OF THEM LIABLE, THEIR TOTAL LIABILITY FOR ALL CLAIMS TOGETHER IS
LIMITED TO SGD 100. This limit applies only to the extent the exclusion above is found not to apply.

Nothing here limits liability that cannot be limited by law, such as for death or personal injury caused by
negligence, or for fraud.

## 7. Indemnity

You will defend and indemnify Unbrowse, its affiliates, and the project's contributors against any claim, loss, or
cost (including reasonable legal fees) arising from your use of the Software or the Network, the routes or content
your node learns, shares, or serves, your breach of these terms, or your breach of any law or anyone's rights.

## 8. Changes and ending

We may change these terms. A new version takes effect when the node asks you to accept it; until you do, the node
stays off the Network. You can stop at any time by stopping the node and deleting it. Sections 2 to 7 and 9 survive.

## 9. Law and disputes

These terms are governed by the laws of Singapore. The courts of Singapore have exclusive jurisdiction over any
dispute about them. If a part of these terms is unenforceable, the rest stays in force.

## 10. Contact

hello@unbrowse.ai. Security issues: see [SECURITY.md](SECURITY.md). How the Software handles data: see
[PRIVACY.md](PRIVACY.md).
