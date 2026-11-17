# Sessions and passwords

Many routes need the node signed in to a site. The vault holds what that takes, and agents get a reference to a
login, never its value. Every way in is the owner's, from the window or a shell, and each import prints counts and
references, never a secret. The full list of formats and where each secret is kept is in the node's
[README](../../unbrowse-node/README.md#imports-from-the-window-or-a-shell); how the node keeps them from agents is
[SECURITY.md](../../SECURITY.md#how-the-node-keeps-secrets).

| To bring in | In the window | From a shell |
|---|---|---|
| Passwords from a browser's or password manager's export | Vault, Import passwords | `unbrowse vault import <export.csv \| .json \| ->` |
| One site's signed-in session from your browser | Vault, Live sessions on this node, Import a site's session | `unbrowse session import <host>` |
| The same from a cookie file you exported | | `unbrowse session import <host> --from <file \| ->` |
| A login made by the node, never stored | Vault, Add login | `unbrowse vault add <site> <account>` |
| A stored password | Vault, Add login | `unbrowse vault add <site> <account> --stored` (stdin) |
| A two-step code key | Vault, on the login | `unbrowse vault code <site> <account>` (stdin) |
| Passkeys a password manager exported | | `unbrowse passkey import <file>` |
| A payment card | | `unbrowse vault card add <label>` (stdin) |

Delete an export once it's in: it holds every secret in plain text.

## Passwords

An import reads the file you chose. The one thing it fetches is for a login saved in an Android app: the app's Play
Store listing and the `/.well-known/assetlinks.json` of the sites it links to, public pages with no login in the
request, so the login comes in under the website that names the app as sharing its logins (`app/src/applinks.rs`).
An app no site claims is left out and counted. A stored password is sealed under the root key, in
`~/.unbrowse/vault.sealed.keychain.json` (or `vault.sealed.json` on a node whose root key is a file), so the vault
opens once with the root key and never asks again (`app/src/vault.rs`). A
derived password is made from the root key when it is typed and never stored, so the backup key brings it back on
a new machine. Agents fill `vault:<site>:<account>` and the node types the value, only into a field whose page and
own frame are on that login's site.

## Steps the node runs again

Some state only hands on a page can make, so a route can't carry it as calls. The node keeps those steps, per site, in
`~/.unbrowse/setups/<site>.json`, and runs them in the site's browser when they're needed (`crates/learn/src/setup.rs`,
`app/src/setups.rs`). The file is never shared.

- **A sign-in:** the steps that typed a vault login, up to the one that sent it, and through a provider's pages back to
  the site. A call that finds its session gone signs in before it re-walks the page, and a walk sent to the sign-in's page
  signs in and walks again. The login stays a vault reference, typed by the same checked fill an agent uses. Other typed
  text, such as an email address, is kept as typed, in a file only the owner can read, as the jar is.
- **A choice:** a click that led to another page and a cookie the browser hadn't sent before, such as picking a country.
  The page that asked is kept by its title. When a call or a walk gets that page again, the node answers it the same way.
- **A quiet choice:** a store or location picked with the page staying put. Its own call must carry what was typed, or be
  small and sent at once, and must set a cookie later calls send. When the jar loses that cookie, the node makes the
  choice again before the call.

A read that lands on another page asking for a password has lost its session: it fails rather than answering with the
sign-in page, whether or not the node has steps for the site.

The node keeps no sign-in with a secret the vault can't type, a step with no selector that lasts, or a first page on
another site (an address a provider made for one visit can't be opened again). Such a sign-in stays the owner's. The node
watches for the sign-in's page to go, for up to 20 seconds. If the login is still asked for, it doesn't try again for an
hour, so repeated calls can't lock the account. A route from another contributor never runs these steps. Choices that
only change state on the server, with no cookie, can't be told from any other click, and aren't kept.

## A site's session

`session import <host>` (`app/src/import.rs` `session`):

1. finds the profile of the browser chosen in Settings;
2. copies only its cookie files (`Local State`, `Default/Cookies`, `Default/Network/Cookies`) into a throwaway
   profile;
3. opens that copy headless and asks the browser over DevTools for its cookies, so the browser decrypts them as it
   does for you, and the node never reads the store itself;
4. keeps only the cookies a browser would send to that host (its own and its parent domain's), as the host's session
   (`~/.unbrowse/jars/<host>.json`) and in the node's browser profile for the site, then deletes the copy.

The first call and the first page are then signed in. Name the host the site's pages are on, `www.` included if the
site uses it. `session list` shows the hosts held and their cookie counts; `session forget <host>` drops one.

**One host, on your word, never a sweep.** A node that also serves routes to agents and joins a peer network should
not hold every live session from every browser. This is the cookie counterpart of importing one site's password.

**A limit.** A browser can lock its cookies to itself (app-bound encryption), so a copied profile can't decrypt them.
The node then says so and points to the other two ways: export the cookies to a file and import that with `--from`
(`import.rs` `session_from`: a cookie extension's JSON, `cookies.txt`, a Playwright or Puppeteer storage state, a
`Cookie:` header), or sign in through Unbrowse once.

## Sign in through Unbrowse

Always available: let the node open the site in its browser and sign in there, with a vault login
(`fill @e4 vault:<site>:<account>`) or by hand on the window's Browser screen when an agent asks
([the-app.md](../start/the-app.md#what-the-node-asks-you)). The session stays in the site's profile; after a sign-in by hand,
the window offers to keep the login in the vault.

## Passkeys and cards

Website passkeys are on by default: when the **owner** signs in on a page by hand and the site offers a passkey, the
node keeps it and answers later prompts itself. A vault login an agent fills arms nothing: a passkey signs in as the
owner with no password and no second factor, so one an agent could make would be a credential stronger than its own
key. Read the risk before you rely on it, and turn it off for a site with
`unbrowse passkey never <site>` or everywhere with `passkey off`
([README](../../README.md#website-passkeys-on-by-default)). On a site the vault has a login for and no passkey, a passkey
prompt is refused at once, so the site offers its other ways in (Google's "Try another way") instead of waiting for good;
the password and any second step are then the site's as usual. Cards are filled by reference
(`vault:card:<label>:<field>`). Cards are the one payment the node asks about, and it asks every time: each checkout page, each fill sequence on it, and
each route call that pays by card. The node can't see what a checkout really charges, so you read the amount on the live
page yourself. A limit saved in the app (Vault, Card limits) or with
`unbrowse-node vault card limit <card> <site> <per payment> [per day]` is kept, but lets nothing through without asking.
The vault keeps no card security code unless you choose to: a checkout that asks for one waits for you to type it on the
page, and a route call that needs one is refused. Card rules (PCI DSS) forbid keeping a code after a payment is
authorised, even encrypted. To keep them anyway, so agents pay without you, turn on Keep card security codes in Settings
or run `unbrowse-node vault card codes on`; a card added from then on keeps its code. Turning it off forgets every code.
A payment that asks waits on your yes in the node's dialog on this machine's screen (or the owner passphrase on its
terminal). To answer away from the machine, run `unbrowse-node vault card approver sdk` there once and say yes in the
dialog: from then on a program holding the owner token, such as the daemon hub's Telegram bot, may approve one waiting
payment it names (`hands_give_back` with the ask's id), with no dialog. Each approval is in Activity, saying where it came
from. It covers card payments only; `unbrowse-node vault card approver dialog` turns it off.

Related: [Unbrowse a site](unbrowse-a-site.md) · [CLI.md §2](../CLI.md#vault).
