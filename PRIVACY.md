# Privacy Policy

Version 2026-10-29. Effective 29 October 2026.

This policy is from Unbrowse AI Pte. Ltd. (UEN 202425961N, Singapore) ("Unbrowse", "we") and covers the Unbrowse
node, its window, CLI and SDK (the "Software"). The unbrowse.ai website and hosted services have their own policy at
[unbrowse.ai/privacy](https://unbrowse.ai/privacy).

## The short version

The node runs on your machine. What it sends us is usage telemetry (which tools ran, whether they worked, how long
they took), on by default in a release while the node is on the network, and off with one command. The node joins the
network with its own wallet; no sign-in is needed. A node you keep off the network is local and sends us nothing:
telemetry counted then is dropped, and bug reports wait. If you link an optional wallet, the node's signed events to
unbrowse.ai name that wallet, `install_id`, and (for unbrowse.ai sign-ins) your browser's visitor id so Unbrowse can
see the path from first visit to first good call and fix drop-offs. Telemetry never carries what you browse, call or
keep. Bug reports are the one exception, and they are public: when an agent reports a problem with Unbrowse, or the
node notices one itself, a scrubbed report naming the site and the route's path template becomes a GitHub issue anyone
can read. They follow telemetry and turn off with one command. Everything else that leaves your machine goes to the
sites you call, to other nodes you deal with, and to public blockchains, all because you or your agents asked.

## What stays on your machine

- Your root key and wallet, in your system keychain.
- Your vault: logins, passwords, one-time-code keys, and website passkeys.
- Cookies, tokens, and browser profiles for the sites you visit.
- The routes your node learns, its activity log, settings, and agents' keys.

We never receive any of these. You can delete them by deleting the node's data folder and keychain items.

## What leaves your machine, and to whom

- **Sites you call.** Your node calls sites the way your browser would, from your IP address and with your sessions.
  Those sites' own privacy policies apply.
- **Other nodes.** When your node joins the peer network it publishes its wallet address, peer ID, network
  addresses (which can include your IP address), and node name. When you list a route, its site, description, inputs,
  and price are visible to other nodes. When another node calls your route, your node runs it and sends back the
  answer. When your node calls another node's route, that node sees the call and its inputs. Other nodes are run by
  independent people; we don't control what they keep.
- **Unbrowse, as usage telemetry.** A release sends batches to `telemetry.unbrowse.ai` with only these fields: the
  event (the node started, or an agent called a tool), the node's version and operating system, a random `install_id`
  that by itself names no person, account, machine or name, though linking a wallet joins its counts to that wallet,
  which agent tool or API route ran (never which route or site), the outcome and a coarse error class, and how long it
  took. If started with `unbrowse start --from <tag>` or `UNBROWSE_FROM=<tag>`, `node_start` also sends `from` (saved
  once in `~/.unbrowse/from.json` and shared by everyone copying that install line) so Unbrowse can count which places
  send people who reach a first working call. It never sends URLs, sites or host names, page content, requests or
  answers, route ids, goals or inputs, cookies, passwords, passkeys, vault entries, keys, wallet addresses, user or
  machine names, or your IP address. We keep each event and the hour it arrived, delete it 400 days after that hour,
  and never read or keep your IP address. A build from source sends nothing unless you turn it on.
- **Everyone, as bug reports.** While telemetry and reports are on, an agent can report a problem with Unbrowse (a
  result for the wrong thing, a block page answered as a success, a call that failed), and the node reports a few
  problems it notices itself (a crash, an internal error, a route that still failed after its page was walked again).
  A report goes to `telemetry.unbrowse.ai`, which files it as a **public issue** on
  [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse/issues), or counts it on the issue the
  same problem already has. It holds: the kind of problem, the agent's own words (a one-line summary, what it expected,
  what it got, its goal, the error), the page's scheme, host and path (never its query), the route's shape (method,
  host, path template, input names, whether it writes, its step count; never an input's value, a cookie, a header or a
  body), the agent's last failed call (its tool, class, and the HTTP status or kind of error the node saw: never what
  the site said), and the node's version and operating system. The node's own reports carry the same: never a site's
  words. Before it leaves, the node decodes what is encoded and removes hidden characters, query strings and
  fragments, emails, IP addresses, numbers of nine digits or more (cards, phone numbers and national ids, however they
  are spaced), tokens, keys, the values of fields named as secrets (passwords, tokens, keys, codes, sessions), vault
  references, your home folder, user name, machine name and vault account names, and cuts each field to a fixed
  length. Of a host it keeps only the site's own name: the names in front of it (often a company's or a person's, as
  in `acme.atlassian.net`) become `*`, a machine on your network becomes `[internal]` and an address `[ip]`; of a path
  it keeps only plain words, so a user name, an id or a file name becomes `{id}`. The relay checks the shape again
  and scrubs again. So a report says which site an agent was using, never whose account it was. The random install
  id goes with it so the relay can limit reports per install, and is never published or kept: the relay keeps a
  day's count under a hash of the id and the day, and for each problem only its issue and how often it was reported.
  Later reports of a problem add only a count to its issue.
  An agent is told never to put personal data in a report, and every reply shows the agent exactly what was filed.
- **Unbrowse, as your account.** Linking a wallet is optional because the node joins the network with its own wallet.
  If you link one (with email or Google on unbrowse.ai, or your own wallet), the node sends unbrowse.ai three signed
  events while telemetry is on: `node_started`, `owner_linked` and `owner_unlinked`. If unbrowse.ai cannot be reached,
  the node sends them to unbrowse.si instead, a second address of the same Unbrowse website run by Unbrowse under the
  same site privacy policy. Each carries the node's address, your wallet, `install_id`, and, when you sign in on
  unbrowse.ai, your browser's random visitor id (cookie `ub_vid`, kept in `~/.unbrowse/owner.json`). Unbrowse collects
  these to see each signed-in person's path from first visit to installing, signing in, and their agent's first good
  call, to fix where people drop off. `ub_vid` requires Allow in the EU, EEA, UK and Switzerland, has a one-click Opt
  out notice elsewhere, and is skipped for Global Privacy Control. Visits join only through the sign-in the site kept
  itself, and events never name a site, route or input. The website deletes each record it holds under `ub_vid`
  (visits, sign-in, and the node and install it joined) 400 days after it last changed. Unlinked nodes send
  none, outside links send no `ub_vid`, turning telemetry off stops them, and opting out on unbrowse.ai/privacy
  deletes everything kept under `ub_vid`.
- **Public blockchains.** Registering your node, listing routes, and paying or being paid for calls are recorded on
  chain with your wallet address. Blockchain records are public and permanent; we can't change or delete them.

Routes are built to carry no credentials: inputs marked secret are filled from your vault on your machine and are not
shared. Check what you list before you list it.

## Your choices

You can turn usage telemetry off with `unbrowse-node telemetry off` or `UNBROWSE_TELEMETRY=0` (bug reports stop with
it), turn bug reports alone off with `unbrowse-node reports off` (a running node stops at once) or
`UNBROWSE_REPORTS=0`, turn passkeys off with `unbrowse-node passkey off` (or never for one site with `passkey never
<site>`), run the node without joining the network, turn off learning, keep routes unlisted, delist a route, or stop
the node. Delisting removes a route from future searches but not from copies other nodes already hold or from the
chain. Start without `--from` or `UNBROWSE_FROM` to keep no source tag, delete `~/.unbrowse/from.json` to remove a
saved tag, and opt out on unbrowse.ai/privacy to delete what the site kept under your visitor id, including the
sign-in and the node it joined.

## Children

The Software is not meant for anyone under 18.

## Changes

A new version of this policy is shown with the terms the node asks you to accept.

## Contact

hello@unbrowse.ai. Data protection requests about anything Unbrowse itself holds go to the same address.
