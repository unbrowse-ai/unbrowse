# Security

The node holds an owner's root key, their logins and their sessions, and it pays for calls. A flaw here costs people
money or accounts, so please report it privately.

## Reporting

Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**. Don't open a
public issue, pull request or discussion for it.

Say what you found, how to reproduce it, and what an attacker gets. You'll get a reply within three working days and
updates as it's fixed. Tell us how you'd like to be credited.

## How the node keeps secrets

The node acts for agents with the owner's logins, sessions and money, so an agent that is fooled by a page must
have nothing to give away. We follow the design Meta published for Muse, its personal agent [1]: secrets live in a
store apart from the agent, the agent holds references to them, and the real value goes in only where it is used and
only for the place it belongs to. The node runs on the owner's machine, not in a cloud VM, so some of Muse's parts
have a different shape here, and a few don't apply. Each rule below names what holds it in the code.

| Muse [1] | The node |
|---|---|
| **Credential surrogation.** Credentials go straight to `authd`, out of the agent's reach; the agent sees surrogates, and real values go in at the boundary. | Stored passwords are sealed under the vault key the root key derives (`vault::Keep`, `vault.unlock-once`), with XChaCha20-Poly1305, each bound to its login: in `vault.sealed.keychain.json` on a node whose root key is in the system's keystore (the Keychain, Credential Manager, the Secret Service), or in `vault.sealed.json` on one that keeps its root key in a file (a Linux machine with no desktop session, a dev build) (`app/src/vault.rs`). The keystore holds the root key alone, read once a run and held in memory (`unbrowse_core::Remembered`), so the vault opens with it and no call raises a keystore dialog; until the root key is read the vault is locked and says so. The vault reads no keystore item: a login an older build kept as a keystore item of its own isn't read, and is imported again to be used. Derived passwords aren't stored at all (`crates/core/src/derive.rs`). Imports, from the window or a shell, report counts and references, never a value. A login a password manager saved in an Android app is filed under a website only when one site linked from the app's store listing names that app in its own Digital Asset Links file under the login relation (and its signing certificate where the export kept one), and the owner then confirms that pairing app by app before anything is imported (`applinks.rs`, `vault::import`). **Accepted limit:** the node reads only the site's half of the link; the app's own half is inside the app, which an import can't read, and a certificate fingerprint is public, so a site the listing links to that names someone else's app in its file is taken at its word. The owner's confirmation, which names the site and the app, is what stands between that and a login filed under the wrong site; a no leaves that app's logins out. Agents get `vault:<site>:<account>` references (`GET /v1/logins`, or the `unbrowse_logins` tool on MCP) and never a value. The node types the password itself (`browse::fill_from_vault`), and a route keeps the reference as its secret input, so later calls sign in from the vault (`vault::fill_inputs`). |
| **Injected at the point of need, for the right destination.** | A login goes only into a field whose page **and own frame** are on its site. The browser reads the origin of the field's own document at the moment it types, so another site's frame inside the right page gets nothing (`interaction::fill`, `on_site`). A route sends a login only to its own site, and only a route this node learned itself takes one: a route another node listed says for itself which input is a secret and where it goes, so no vault login fills it (`vault::fill_inputs`). |
| **The agent never sees what it could be talked into handing over.** | Whatever the browser says back (a snapshot, a field's value, a script's answer) has every value the node typed replaced by its reference (`browse::unsaid`), as itself and as an address, markup, a JSON string or base64 carry it. The document a secret went into runs no agent script for as long as the agent is on it (`browse::holds_a_secret`), whatever the page does to its fields: a "show password" button turns the field into a text field with the value still in it. Only a new document at another address lets scripts back, and the hold fails closed (external security review round 3, 2026-11-04): the page is held before the browser is asked to type, so a fill that fails after typing still holds it; a page whose document the browser can't name is held on a site that holds a secret; a new document at a held page's address (going back in history) is held; the holds and the tabs scripts ran in are kept on disk (`secret-holds.json`, never a secret), so a node that restarts while its browsers run keeps them; and a scripted tab that closes leaves its site marked while a popup it opened stays open. A route's answer, its error and the activity log say a password the vault holds for the route's site, or one the node typed there, as its name too (`run::call_with`). Walk records, routes and the activity log keep references only. |
| **What the owner's session gave a page isn't said back to an agent.** | A route learned while the owner browsed keeps what they typed, chose or clicked as its defaults, on this machine, for the owner's own calls (`Route::given`, `session_gave`). An agent key holder never reads it: every answer that shows a route (`search`, `do`, `inspect`, `judge`, a goal's options, a report's route shape; the MCP tools and `unb` are the same handlers) shows such an input with no default and `supply: true`, drops each step's query, masks a fixed path segment the walk didn't read from served bytes as `{fixed}`, gives a fixed or derived address as its origin, and replaces any whole occurrence left, raw, form- or percent-encoded, with `{name}` (`store::Route::shown_to_an_agent`, `api::said_to_an_agent`). An agent's call doesn't spend it either: the node can't tell a session an agent drove from the owner's own hands (the capture logs actions the same way, and the owner can take over the window), so it fails closed and runs an agent's call with those defaults cleared (`Route::usable_by_an_agent`, `api/call.rs` `do_call_fields`); one left out is refused by name. Nor does it run with that value anywhere else the call would send it: a fixed value at the very place another step takes the input becomes the agent's there (the graph says which input it is), the page a heal walks keeps none of it, and a route that still carries it anywhere the call sends (a path piece, a header, a body field, a cookie, a fixed value's own source address, the page a signing bridge boots), read by the one reader of "carries" the sharing boundary uses too (`recipe::still_carries`, `trace::carries_written`: however written, base64 included), across the whole graph as it is serialised (each step, and the page, scripts and answers the signing sandbox runs with; only an answer's shape, which is never sent, is left out), is refused before anything is sent, naming the place: the agent walks the page itself (`Route::callable_by_an_agent`). What the call says back, answer or error, crosses the same masking, since a fixed part of an address the call still sends may hold the value (`api::said_to_an_agent_who_sent`; a value the agent sent itself is said back as the site said it). The cost: an agent that taught the route through `browse` supplies its value again on every call, and a heal found on such a call isn't kept, since the route it ran differs from the kept one; and an answer in which the site says the owner's word back, the agent not having sent it, reads `{name}` there. The activity log has no agent primitive. A value an agent named for a walk (`keep_as`, no `session_gave`) is the caller's word and is shown as a default to any agent key the owner made, since the route doesn't record which key named it. |
| **The site's session never reaches an agent as a value.** | An agent key lets an agent act on a site the owner is signed in to (its tabs share the site's profile); it never lets it carry the session away. Every answer to an agent, over HTTP or MCP, crosses one last pass (`api::run_primitive`, `session_held`): a page read, a snapshot, a value or markup read, a script's result (`eval document.cookie`), console output, a walk's list of calls with their addresses, a route's answer and an error each say `{session}` wherever a value the node holds as a session stood, however it is written (`trace::written_forms`, the one list of it: as itself, percent- or form-encoded, as JSON or markup escapes it, as base64, and those again three layers deep). What counts is read when the answer is made: every value of every jar (the cookies, the header tokens, the storage values the learner marked as the session's, every value of the page storage kept beside a jar whether marked or not, and cookies an import left in the jar alone); every cookie in the cookie store of each running site browser, HttpOnly or not, for any domain (`browse::session_cookies`, the browser's own `Storage.getCookies`, so a cookie the server reflects into a page is caught too); a cookie or a value in HTTP's credential fields a route carries; and what each walk's capture held as its session, by the learner's own reading (`provenance::session_values`: its cookies, and every value any answer of the walk delivered, an asset's included, that a later request sent back in any position, a header, a cookie, an address or a body, as a login answer's token sent on is; plus its credential fields and a token-shaped value in any other request header), noted as the walk is read, since its browser may be gone before the answer is. The running browsers are asked at once, all within 10 s; one that doesn't answer fails the answer closed (503). Exempt: a flag and a value under 4 characters, which sign no one in and stand in every page; a value under 12 is matched only as a whole word, so `theme=dark` doesn't take a word out of every page. Screenshots aren't read for text and are out of scope. Before that pass, an agent's own script reads the session only as the stand-in: it runs in an isolated world of its own where `document.cookie` and the page's storage say `{session}` before the script can change them (`agent_world`). What neither stops is in "What isn't defended". |
| **When a person must act, the agent hands over and gets back a result, not the secret.** | A page only the owner can pass goes to them: the agent asks (`ask_owner`) and the window shows the page live; the owner clicks and types on its picture (`app/src/hands.rs`, owner commands only). What they type into a password or code field leaves the walk record before the form sends it and is said as `[typed by the owner]` to the agent (`browse::owner_typed`, `browse::unsaid`); the page runs no agent script while it may hold it, takes no picture, and answers no read of a field's value, an attribute or its markup (those come back in whatever form the page wrote the secret, which no list of forms covers); its text and snapshot are said back with references (`browse::held_near_a_secret`). The same goes for a page the node filled a vault login or a card into. The learner's flow is cut at both ends of the owner's turn, so a sign-in by hand never becomes a route. |
| **One-time passcodes, reset links and magic links are filtered from what the agent reads.** | Codes are filled by reference: `vault:code:<site>:<account>`. The vault keeps the key the site gave for two-step sign-in (`vault code`, or the TOTP column of an imported export), and the node makes the RFC 6238 code when it types it (`crates/core/src/code.rs`). The agent signs in with both steps and holds neither the key nor a code, and the page a code went into runs no agent script. Muse filters codes out of email with fixed rules and a classifier. We don't mask number-shaped text in pages: a price or an order number reads the same as a code, and a false positive costs more than a rare miss. |
| **Sentinel: limits are capabilities, not chat.** | Each agent key has a spending cap and an expiry (`app/src/agents.rs`), enforced before signing and again by the contract. No call waits for the owner: the node pays another contributor's route fee itself, and never more for one fetch than the owner's maximum (`max_fetch_usdc`, `app/src/api/call.rs` `call_entry`), read from the chain at the moment it would pay. Nothing an agent says changes either limit. The owner can pause the node or revoke a key. |
| **Purchases: every card use asks the owner; a card limit lets nothing through.** | Cards are sealed under the root key, as passwords are (`vault::Keep`); the index `cards.json` holds a card's label and last four digits only. Only the owner adds one (`unbrowse-node vault card add`, from stdin). Agents fill `vault:card:<label>:<field>` and the node types the value itself (`browse::fill_card`). **Every checkout asks the owner** in the window, showing the card and the site it goes to (`api/browse.rs` `approve_checkout`, `hands::Pay`): the window shows the page live, and the owner reads the amount there, since the node can't read what a checkout costs. A tab an agent's script ran in since it opened is never shown for a card, since the script could have redrawn the total or the order (`browse::unscripted_for_a_card`, the same check a hand-over to the owner makes). One approval covers that card's fields on that one checkout page for one fill sequence (60 seconds), and is bound to the page's address (without its fragment), the origins of every frame in it (out-of-process ones included) and which fields are shown, beside its controls. The page is measured by the node over the browser's own protocol, never by script in the page (`checkout::measure`: the main frame's loader id from `Page.getFrameTree`, and every control's live value, choice and attributes from `DOMSnapshot.captureSnapshot`, in the page and in every frame of another origin, attached the same way), with the digest keyed per run of the node. It is measured once the tab is locked and before the owner is asked, again after, before every fill and at the hand-off: every control must read as approved, except the controls the node itself filled from the card (one the browser held to a card input, or one the page marks `cc-…`), which may only go from empty to the value typed. **The action that sends a filled card is the owner's, and so is the site until they say the checkout is over:** from the moment the owner is first asked about a card for a site until they themselves say the checkout is finished or dismissed, no agent-initiated act reaches that site or any host the measured checkout names: its frames, its forms' actions, and every host the browser's own record shows its pages submitting to (`payhold`). While any checkout waits, the node sends no route request at all, of any method, to any host: no route of the node's own or another contributor's, read or write, no socket frame, no heal, and no page driven in its own browser for a walled step, a signing page or a mint (`unbrowse_learn::hold`). A request's method is no evidence that it changes nothing: a `GET` to a processor's `/confirm?order=…` commits as surely as a `POST`. And no agent command takes a step (a click, a key, a fill, a focus, a scroll, a navigation, a script, a challenge step) in any page of any site. No agent command reads a page either, on any site: a read runs code the page defines (`get text` reads `innerText`, which a page can make a getter that sends a request), so only `close` and the tab's address and title, read from the browser's own tab list, go anywhere while a checkout waits (`browse::card_gate`). When a hold begins, every other page in the node's browsers is frozen through the browser's own protocol (`Page.setWebLifecycleState`, `quiet.rs`), so a timer or a dedicated worker a page started before the hold sends nothing; the checkout's own tab stays live, and every page is made active again when the last hold is released (a page's timers then run as a background tab's until it is brought forward). What holds is the browsers' egress proxy: each site's browser has a listener of its own, and while a checkout waits only the checkout's own browser makes any connection; every other browser connects nowhere, the checkout's own hosts included, so a page whose freeze failed, a worker, a service worker or a tab opened since can send nothing. A connection another browser opened before the hold is closed when it begins, and nothing it carries is written past the commit: each chunk the page sends is written only while the hold is unchanged since the connection was authorised, and a hold is made durable only once the writes already under way are done, so a chunk read just as the hold commits is dropped; and one being set up as the hold begins (its name resolving, its upstream connecting) is refused too: a connection listens for a change in the hold before its first check, its final authorisation is read under the same lock a hold is made durable under, just before success is said, and a change is met before its first byte is carried. A hold record that can't be trusted refuses every connection (`browse::browser_may_connect`, `unbrowse_learn::proxy`). The freeze is belt and braces: service and shared workers are closed rather than frozen, the pass runs again at the hand-off to catch what started since, and what it couldn't freeze is told to the owner there. A browser visit the node drives (a signing page, a walled step, a heal's walk, a mint) and the start of a hold exclude each other (`hold::visit`). The trade-off: while a checkout waits, every other browser of the node is offline until the owner releases the hold; the checkout's own browser reaches any host its page needs (its card issuer's 3-D Secure page, a provider's). The proxy tells browsers apart, not tabs, so the exception is the checkout site's whole browser: another session's tab on that same site, and a worker of that site, can still connect anywhere. Those are frozen or closed, take no agent command and send no route, and they are the merchant's own pages, the site the owner is giving the card to; what they send is the merchant's doing, under the limit above. The agent is told why: a card checkout is waiting for the owner. So an order can't be committed through a host the checkout reaches only after the node's last look. The held hosts decide only where even reads are refused. They are what the browser showed when the node last looked (when the owner was asked, after each card fill, at the hand-off): the checkout's own registrable site, whole; its frames; its forms' actions; and the hosts its pages sent something to, read from the last 16 MiB and an hour of the browser's walk record. A checkout adds at most 8 hosts besides its own site, and the owner sees every one in the card question, at the hand-off and in `checkout list`, with how many more it named; a host past those isn't held for reads. A record cut short or missing is said to the owner; nothing that changes state goes anywhere meanwhile, so what it misses is only a read. On a held site only `close`, `get url` and `get title` go (default-deny at `browse::card_gate`, every tab and session, the node's heal included), and nothing the node sends reaches a held host by any path: both request transports on every hop, the browser it drives for walled steps, heals, signing pages and mints, and socket routes (`unbrowse_learn::hold`). Nothing an agent does ends a hold, and neither does time: closing the tab or the browser, navigating, waiting, or the node restarting. The hold is kept on disk, the owner's alone, sealed with a key derived from the node's root key over the holds and a sequence that only grows (`payhold`); a record that doesn't read, isn't sealed, or was edited, emptied or sealed with another key holds every site until the owner dismisses all. While the node runs it keeps the last record it read or wrote, so a file deleted or an older sealed copy put back takes no hold away. A hold that can't be written isn't begun, and no card is filled. It ends only by the owner: finished or dismissed in their window (`checkout_release`) or shell (`unbrowse-node checkout done|dismiss`), each asked in the node's own dialog; their Done on the hand-off of the page; or their no to the card. A hold a day old is said again to the owner in the activity log, once a day, and stays on. The last measurement and the keystrokes of each card fill are one turn of the site's browser, and the page is measured again after them; a change the page made beside the card is told to the owner at the hand-off, which brings them the live page with what the node checked and what it can't vouch for. A route call that pays by card is not a checkout page and isn't held: the owner approves that one call, seeing the route and the values it sends. A card limit the owner saves (`vault card limit`) is kept but authorises nothing: the node can't bind an amount and a currency to what a page or a route charges, so no fill and no route call goes without the owner's yes, whatever the limit, and no yes carries over to another page, another fill sequence or another call.

  **Accepted limit: a site you give a card to can charge it.** Once the card is typed into the checkout, the page's own code can send it to its site at any moment, before the owner looks: on the input event, on a timer, when the tab closes. That is what a checkout page does for a person too, and blocking the page from its own site would break every checkout. The node does not firewall the page from its site. Its promise is narrower and holds: the agent can't change the order or send it, nothing the node sends reaches the site until the owner releases it, and the owner gives the card only to the site they approved. What the page shows (a total drawn as text or on a canvas) can't be bound by the node either; the final look and the pay click are the owner's, on the live page. A route call that heals mid-call has its card and login inputs checked again on the graph it actually sends (`RouteClient::with_held_inputs`). A card number never stays in a walk record however the page writes it: grouped, split by any characters, encoded (base64, hex, percent, `\u` and HTML escapes), in full-width or mathematical digits, or split across one request's strings (the capture knows the digits it typed). A body holding a Luhn-valid number under the same decodings, or a step whose consecutive digit-only values join into one, is never listed (`recipe::leaks`, `split_card`). What can't be caught: a number the page's own script encrypts (a payment provider's client-side encryption is not a leak and reads as nothing), and digits of other scripts (Arabic-Indic and so on). A card goes only into a field whose page came over https and whose own frame is on the page's site, or into a payment provider's hosted field (UNB-119): a field marked `cc-…`, in a frame of another site that came over https and whose `<iframe>` element sits in a document of the checkout's own site, so the checkout page put it there. Any other frame from another site inside the checkout gets nothing, and neither does a frame inside such a frame (an ad's); the browser reads all three facts itself, in an isolated world (`interaction::hosted_card_field`), and the activity log names the provider's frame the card went into. Everywhere a card goes only into a field made for a card: one the page marks `cc-…`, or (on the page's own site) one too short for anything else, never a plain text box. A secret typed into a frame holds the whole tab: holds and script marks are kept on the tab's top document, whichever frame is selected. A route may keep a card's reference as a secret input; **every call of it asks the owner**, showing the card, the site, what the route does and the values it sends (`api/call.rs` `approve_route_payment`), and the card goes only to the route's own site, encrypted (`vault::fill_inputs`). A route the owner runs from the window (`call_route`) never fills a card: only an agent's call, which waits for the owner, does. The number, the code and the expiry are said as their reference in anything the browser returns to an agent (the number as any grouping of it too), and the page runs no agent script while the agent is on it. **Open:** cards are the owner's real cards, not single-use ones; a month, a year or a name filled alone is written as itself in the walk record, since naming it would rename every match in the record. |
| **Least privilege: the model never sees API keys.** | Agent keys are derived from the root key and only their addresses leave `crates/core`. The owner's window has its own token, made fresh at each start and readable only by the owner's OS user (`api::owner_token`). Revealing a password is an owner command, never an agent's. Since another program running as the same user can read the token, the commands that hand out a secret the node can't take back (`wallet_phrase`, `vault_reveal`, `wallet_export`), replace the node's key (`wallet_restore`, `wallet_import`) or raise an agent key's cap (`agent_set_cap`) also wait on the owner's yes, which the node asks for itself (`app/src/owner_dialog.rs`; see "The owner's yes" below); nothing sent with the token answers it. A same-user program that can press buttons in other windows (any X11 client; on macOS one granted Accessibility), or that reads a file-kept `root.key` (Linux with no working keyring), is not stopped by that; running agents as their own OS user is: `unbrowse-node agent-user install` makes `unbrowse-agent`, which can read none of the owner's folder, keystore or session ([guides/agents-os-user.md](docs/guides/agents-os-user.md)). The node's browsers open no DevTools port, on any platform, Windows included: each is launched with `--remote-debugging-pipe`, so its debugger is a pair of pipes only the launching process holds, and a `--remote-debugging-port` asked for is dropped. Other clients reach it through a relay in that process, on loopback, which answers only a WebSocket at a path carrying a 256-bit secret drawn at launch, sent with no Origin and with the relay's own `127.0.0.1:<port>` as its Host; the secret goes only to the launcher's callers and owner-only files (`unbrowse-browser/core/src/cdp/pipe.rs`). A browser daemon's own door on Windows, a loopback port, takes a command only with the key it wrote beside its port file, owner-only (`browse::send_now`). |
| **Egress: SSRF guards; public hostnames that resolve to private infrastructure are blocked.** | The node's own calls (both replay transports, the judge, the network client) resolve names through one resolver (`crates/learn/src/egress.rs`). A name under a public suffix that answers with a loopback, private or link-local address is refused before anything is sent. The check is in the resolver, so the addresses checked are the ones connected to. A call addressed plainly to a private place (an IP literal, `localhost`) goes there. An intranet whose public names resolve privately needs the owner to turn on **Reach private networks** in Settings. **The browser's own loads meet a stricter rule**: every browser the node launches is given a SOCKS5 proxy on loopback that resolves each name itself and checks the address the socket would connect to before connecting (`crates/learn/src/proxy.rs`), with Chrome's loopback bypass removed, QUIC off and WebRTC held to the proxy. A page the node's browser loads never reaches this machine (loopback, unspecified, or an address one of its own interfaces holds) or a link-local address (`169.254.0.0/16`, `fe80::/10`, where the clouds' IPv4 metadata services answer), whatever took it there — an address typed, a redirect, a script's navigation, a rebound name — and reaches the owner's network only with **Reach private networks** on. An IPv6 address that wraps an IPv4 one (mapped, compatible, NAT64, 6to4, Teredo) is judged as the address it wraps. What remains: a metadata service on a unique-local IPv6 address or in shared (CGNAT) space can't be told from the owner's intranet by its address, so it is refused only while Reach private networks is off. The node's own control channels are never reached through the browser, so the rule has no exception for them. The tunnel is opaque, so the site still reads the browser's own TLS handshake — the door is not weakened, which is why this is a proxy and not the engine's fetch-interception mode. Every launch gets its proxy from one place (`proxy::switches`): a proxy that won't start is tried again, and if it still won't, the browser isn't launched. |
| **Isolation: a runtime cell; classifiers and taint tracking run outside it.** | Not the node's shape: the agent is a separate program on the owner's machine that reaches the node only through its token-checked API on 127.0.0.1. The node runs no classifiers and no kernel taint tracking; its rules are fixed properties of each request, tested like the code. |

### The root key

The owner's address, every agent key and every derived password are made from one root key, and the Keychain
holds the only copy. The window's Wallet screen shows it as a recovery phrase (BIP-39), to write down and keep off the
machine, and restores from one (`crates/core/src/recovery.rs`). A new node's key is made from 12 seed words at the
standard Ethereum path `m/44'/60'/0'/0/0` (`crates/core/src/seed.rs`), so the same 12 words open the same address in
MetaMask, Rabby or any EVM wallet. The node keeps the words beside the key, in the same store, to show them again. A
node made before seed words keeps its key as it is (its address is its identity on chain) and shows 24 words: the
key's own bytes, which bring back this node only; another wallet reading them derives another address, so its wallet
goes into a wallet app through `wallet export`. A restored node has the same address, agents and passwords. A restore
never drops the key it replaces; that key, and its seed words, are kept in the Keychain under its address first. A
phrase with a wrong word, a count other than 12 or 24, or a failing checksum changes nothing. The phrase is an owner
command: no agent can ask for it, and the shell never prints it (`unbrowse-node wallet restore` reads one from
stdin).

### Website passkeys

**On by default**, off when the owner says (`unbrowse-node passkey off` or `UNBROWSE_PASSKEYS=0`), and never on a
site the owner names (`passkey never <site>`). When the owner signs in on a page by hand (they take the page over with
`ask_owner` and give it back), the node attaches a virtual authenticator to that site's pages for ten minutes, and a
passkey the site offers to make then is kept (`app/src/passkey.rs`). The node never navigates to a site's settings to
make one. A vault login an *agent* fills arms nothing (`passkey::SignIn::Agent`): a passkey signs in as the owner with
no password and no second factor, so one an agent could make would be a credential stronger than the agent's own key —
and every key on the node as strong as the weakest of them. So **a site gets a passkey registered on the owner's
account only when the owner signed in there themselves, or ran `passkey enrol <site>`**; an agent can neither make one
nor quietly cause one. The owner's Vault screen carries the same waiver: an enrolment is their act. Every enrolment is
an activity line (the site and when, no secret), and `passkey list` says whether each passkey was enrolled `auto` or
`manual`. To undo one, `passkey remove <id>` on the node and delete it on the site's
own passkeys page; the site accepts it until then. A credential is sealed in `passkeys.json` with XChaCha20-Poly1305 under a
key derived from the root key and bound to its entry (`crates/core/src/sealed.rs`); it is never written in the
clear, logged, shown to an agent or sent to a peer. It goes only to the virtual authenticator the node attaches to
the browser's pages, and Chrome signs only for a page on the passkey's own site. A credential a site makes when no
enrolment is waiting (no owner sign-in in the last ten minutes, no `passkey enrol`) is refused. An owner sign-in is a hand-over (`ask_owner`) the owner ends with Done after typing a password or a code there by hand; a hand-over where they only clicked or solved a check arms nothing (`browse::owner_signed_in_since`). Every sign-in with one is an
activity line. No agent script runs on a site the vault holds a passkey for, or while the owner enrols one
(`passkey::holds_scripts`): a script in the page could have the authenticator, which needs no one present, sign a
challenge of its own and carry the assertion off the node. A passkey is used only when the site's own page asks for
it, from a click. A script on a site in a sign-in's automatic enrolment window closes the window, so nothing made
after it is kept, and the authenticator never comes to a site's browser while a tab an agent script ran in is open.
A passkey the owner imports from a password manager's export (`passkey import`) is sealed the same
way; the export holds its private key in the clear until the owner deletes it. Turning passkeys off, or saying never to a site, takes the authenticator off that site's pages at once.
Automatic enrolment arms only the node's own browser; a browser it doesn't run (`--cdp`) gets passkeys only by the
owner's command. **Open:** the credential is wiped from the node's own structures after use, but the DevTools
messages that carry it to the browser are not.

### The owner's yes

Some owner commands run only once the owner says yes on this machine, whoever sent them (`commands::asks_the_owner`):
`wallet_phrase`, `vault_reveal`, `wallet_export`, `wallet_restore`, `wallet_import`, `agent_set_cap`, `agent_create`
(a new key with any cap), `save_settings` when it loosens anything `store::SPENDING` or `commands::raised_limits`
names (the spending and gas limits, the deposit floor, the chain and the second RPC, listing per day, the
bounty switch, sharing more, serving kept routes, passkeys, bearer tokens, the canary channel), `link_wallet`, `wallet_send` (USDC sent from the node's address), a wallet the sign-in page answers with (`link_start`), the first
withdrawal to a linked wallet the node didn't seal (below), and, from a shell with the key in an OS keystore,
`unbrowse-node wallet export`, `wallet restore`, `wallet import` and `agent new`. A shell's command that writes
settings is asked the same question the window's `save_settings` would ask, whichever command writes them: the rule is
at the write (`store::ask_before_shell_writes`), not in a list of commands. Setting the first owner passphrase
takes the owner's yes too (below).

- **Card payments answered away from the machine (opt-in, UNB-117).** A card payment an agent waits on is approved
  in this same dialog by default. The owner may let the owner SDK approve it instead: `unbrowse-node vault card
  approver sdk`, or the owner command `payment_approver` with `sdk`, which waits on the owner's yes in the dialog
  every time (from a shell too, even with the key in a file). The choice is kept in `~/.unbrowse/owner.payment-approver`,
  mode 0600, sealed with HMAC-SHA256 under a key derived from the root key (`owner_pass::seal_text`), not in
  `settings.json`: a record the node's key didn't seal reads as the dialog. With it on, `hands_give_back` with done
  and the payment's own ask id approves that one payment with no dialog; an id that no longer waits is refused, so a
  late answer never approves a payment that came after it. Each approval is logged in the owner's activity with where
  it came from (`via`). The daemon hub's Telegram bot uses it: it shows the owner the card, site and agent, and only
  the owner's tap on its own button sends the call. **Limit:** with it on, any program running as the owner's OS user
  that reads `owner.token` can approve a payment an agent waits on (one at a time, each logged), as it could already
  read a file-kept root key. Nothing else moves off the dialog: the recovery phrase, vault passwords, spending caps and
  wallets still wait on it. `vault card approver dialog` turns it off with no question.

- **With a screen**, the node opens a native dialog itself (osascript on macOS, zenity or kdialog on Linux, a
  MessageBox on Windows).
  - Whether there is a screen is read from the node's own session before anything starts: on macOS whether the
    session has the window server (`SessionGetInfo`), on Windows whether its window station is the visible one, on
    Linux whether the node was given `DISPLAY` or `WAYLAND_DISPLAY`.
  - Each dialog program runs from the system's own folder (`/usr/bin/osascript`; zenity or kdialog in `/usr/bin`,
    `/bin` or NixOS's system profile, owned by root and writable by no one else; Windows PowerShell from the folder
    Windows names as its system folder), never one found on `PATH`, with an environment of its own rather than the
    caller's, and PowerShell's modules from the system folder only.
  - Once a dialog has started, how it ends is the owner's answer. A dialog that is killed, crashes or ends in a way
    no answer ends it is a **no**, never a reason to fall back on the passphrase.
  - The question is shown as plain text: control characters and invisible or right-to-left formatting in a site's or
    an agent's words are dropped (`owner_dialog::plain`). Each question ends with its own request id, which
    `unbrowse-node confirm` shows too, so two questions that read alike still look different.
- **With no screen** (a server, an SSH session), the node waits two minutes on the **owner passphrase** instead:
  - The owner sets it once on a terminal with `unbrowse-node passphrase`. It needs 10 characters or more. Setting the
    first one takes the owner's yes: the dialog where there is a screen, or with none a code the terminal shows and
    the owner types back. Changing it takes the one set now.
  - The node keeps only its scrypt hash (2^17, r 8) in `~/.unbrowse/owner.passphrase`, mode 0600, sealed with
    HMAC-SHA256 under a key derived from the root key (`unbrowse_core::owner_pass`). A record the node's key didn't
    seal is refused, so a program that can write the owner's files but can't read the root key can't put a passphrase
    of its own in place.
  - The owner answers with `unbrowse-node confirm` on a terminal. It reads the passphrase from `/dev/tty` (the
    console on Windows) with echo off, never from stdin, and sends it over the owner door (`confirm`). It asks only
    on the process's own controlling terminal with the process in its foreground, and throws away anything typed
    ahead of the question (`tty::ours`; on Windows the console's input is flushed).
  - 3 wrong passphrases refuse a question. 5 wrong in a row lock every question for 15 minutes. The count is kept on
    disk (`owner.passphrase.tries`), so a restart doesn't reset it.
  - With no passphrase set, the node refuses and says how to set one.
- **Why a passphrase, not a paired device.** The node has no channel to an owner device it can trust. The sign-in
  relay belongs to whoever serves the site, and a linked wallet is optional and confirmed through this same yes. A
  passphrase in the owner's head needs nothing paired.
- **What it doesn't stop.**
  - A same-user program that reads the root key where its store lets this user read it (a file-kept `root.key`, a
    Linux Secret Service collection, Windows Credential Manager). Such a program has the node's wallet already, so on
    a default install on Linux and Windows the owner's yes guards against mistakes and simple programs, not against a
    hostile program running as the owner. On macOS the Keychain keeps the key from other programs, and the yes holds.
  - A same-user program that starts `unbrowse-node passphrase` or `confirm` inside a pseudo-terminal of its own, and
    so reads the prompt and types the answer. No terminal check can tell such a terminal from the owner's. It still
    needs the passphrase to answer a question, and, where there is a screen, the dialog to set the first one. On
    Linux a shell's command takes its screen from its caller's environment, so a program that clears `DISPLAY` gets
    the terminal instead.
  - A same-user program that reads the owner's keystrokes on the terminal, or pushes keys into it while a prompt is
    up (Linux kernels that still allow `TIOCSTI`).
  - A same-user program that reads the passphrase file can guess offline against the slow hash: choose a long
    passphrase.
  - A same-user program that writes the node's files directly (`settings.json`, `agents.json`) rather than through
    the owner's token. The node's limits there are files of this user's.
  - The card checkout hold (`checkout-holds.json`) is sealed with a key derived from the root key, so a same-user
    program can't forge, edit or empty it where it can't read that key (the macOS Keychain). Where it can (a file-kept
    `root.key`, and the stores above on Linux and Windows), it can forge a sealed record and so release a hold. And
    while the node is stopped, any same-user program can delete the record, or put back an older sealed copy, and the
    node starting again reads that: the node remembers the last record only while it runs.
  - Running agents as another OS user (`unbrowse-node agent-user`, [guides/agents-os-user.md](docs/guides/agents-os-user.md))
    closes all of these. It is opt-in, so a default install carries them.

### Agents as their own OS user

`unbrowse-node agent-user install` makes the OS user `unbrowse-agent` (`app/src/agent_user.rs`), with no password, no
admin rights and its own group, and gives it an agent key of its own. Its token is written into that user's home,
readable by it alone, from stdin. `agent-user run -- <program>` runs an agent harness as it. `agent-user status` checks,
as that user, that it can neither list the node's folder nor read any file in it, and CI runs install, status, run and
remove for real on macOS, Linux and Windows. Every node start makes `~/.unbrowse`, and everything directly in it, the
owner's alone (`agent_user::keep_folder_private`), so an install from before this closes at its next start.

Since the external security review round 3, 2026-11-04: the agent user has no login shell (`/usr/sbin/nologin` on
Linux, `/usr/bin/false` on macOS; `install` takes an older user's away too), and the sudoers rule gives what it runs a
terminal of sudo's own (`Defaults>unbrowse-agent use_pty`), so it can't push keys into the owner's terminal. On Windows
the agent's folder is never taken from an environment value that could mean something in the Administrator shell's
script, and every path that script carries is quoted. **Open on Windows:** `run` starts the agent on the owner's
desktop and console. A desktop of its own needs the node to start it with Win32 calls and relay its console, which CI
(a service session) can't run, so it isn't built; until it is, a program run as the agent user on Windows can send
input to the owner's windows. **The separate OS user is opt-in:** a default install runs agents as the owner, with the
limits listed under "The owner's yes".

### Linking a wallet

A wallet the sign-in page answers with (`link_start`) is where withdrawals go, so the node keeps it only once the
owner allows its full address in the node's own question, a dialog or, with no screen, the owner passphrase
(`link::keep_once_confirmed`). The signature
alone can't say the wallet is the owner's: whoever serves the sign-in page (`UNBROWSE_SITE`, or a site that took the
page over) reads its nonce and can sign with a wallet of its own. A wallet the owner names themselves
(`link_message`, `link_wallet`) is asked about the same way when `link_wallet` arrives, since the owner's token can be
sent by another program.

Every link kept on the owner's yes is sealed with a key derived from the root key (`link::seal`). A withdrawal goes to
the linked wallet only when the node sealed its link; a link file the node didn't seal (written by another program, with
that program's wallet and that wallet's own valid signature, or kept before links were sealed) waits on the owner's yes,
showing the address, before anything is withdrawn to it (`link::payout`). A no withdraws nothing.

### Certificates

The node's HTTPS clients ask the operating system whether a server's certificate is good
(`crates/learn/src/tls.rs`, `rustls-platform-verifier`). A root list compiled into a binary stays the same until
the binary is rebuilt. That is how the eMudhra intermediates of October 2026, whose private keys could be recovered
from the certificates [2][3], stayed trusted by clients carrying their own roots after every browser had blocked
them. Apple blocked them on 19 October [4]. A client that asks the OS follows a block like that without a new
build.

The Chrome-shaped replay transport speaks BoringSSL, which takes a root list but no verifier, so it keeps Mozilla's
list (`webpki-root-certs`). That list is held at a version without the distrusted root. A test checks that no list
the node carries holds the key of the root those intermediates chain to (`tls::no_bundled_root_holds_a_distrusted_key`).

### Updates

A release node installs only what Unbrowse's release key signed (`unbrowse-node/app/src/update.rs`): the manifest in
the npm package is checked against `manifest.sig` and the Ed25519 public key `RELEASE_KEY`, and each package against
the sha512 the manifest names. So a compromised registry, mirror or certificate can withhold an update but not
install one. Every read from the registry is size-bounded, a package unpacks to files and folders only (a link or a
path outside its folder is refused), and an older signed manifest never lowers the network's `min_version` the node
kept. A build from source never updates itself. More: [docs/guides/updates.md](docs/guides/updates.md).

On a Mac the `unbrowse` command runs the Unbrowse.app its platform package brought, or a newer one installed in
Applications only when that one's signature checks and names the vendor's Apple Team ID: the one the release pinned in
the package (`unbrowseAppTeam`, read back from the signing job's own signature), else the package app's own. Signed by
somebody is not identity: with no pinned team and no signed app from the package, no app found elsewhere runs, and the
command says so. An app `UNBROWSE_APP` names is held to the same rule: an environment variable is inherited by
everything started from the shell that set it, so naming an app is not vouching for it. The one way to run an app whose
signature isn't checked (a build of one's own, which no team signed) is `UNBROWSE_UNCHECKED_APP`, whose value must be
that app's absolute path; while it is set every run of the command prints on stderr that signature checks are off and
which app it runs. `UNBROWSE_BIN` (the programs' folder, for machines with no app bundle) is not checked: it is the
same owner's word, and anything that can set a variable in the owner's shell can already run its own programs there.
The signature is checked when the command picks the app, and the app is started by its path a moment later: a program
already running as the owner that can rewrite that folder in between can swap it. That is the same owner-equivalent
program as above, not a stranger; the check is against an app left in Applications by someone else, not against the
owner's own account.

### What isn't defended

- **An agent can act as the owner on a signed-in site, and the page's own world still holds the real session.** An
  agent that holds a key can drive a signed-in page and so act as the owner on that site for as long as it holds the
  key: that is what an agent key is for. Its own script never reads the session's value: every script an agent runs
  (`eval`, a wait on a function) runs in an isolated world of its own (`unbrowse-browser/cli/src/native/agent_world.js`),
  installed in every frame before any agent code, where `document.cookie` and the page's storage say every value as
  `{session}` before the script can change it, writes to them are refused, and IndexedDB, the caches, the Cookie Store
  API, workers, service workers, new windows and the Navigation API aren't there; the script sees the page's DOM, not
  the page's JavaScript variables. Code reaches the page's own world, where the real cookie is, by two ways only:
  - **the page's own code and server**, which can read the cookie, change it (split it, reverse it, encode it) and put
    the result in the page or send it over the network; what lands in the page meets only the answer's mask, which
    reads a value whole and in the forms it knows but not every transform, and what is sent over the network meets
    nothing of the node's. A site that writes what it is sent back into its page as markup or script (a reflected
    injection flaw of the site's own) is this case: an agent that points a frame, a link or a form at such an address
    chooses the code the site's page then runs, and that code can read a script-readable cookie and send it away.
    Measured: a fixture that reflects its query ran the agent's text and its collector received the cookie; the
    agent's own reads of that page still said `{session}`. The node doesn't find a site's flaws for it;
  - **a `javascript:` address the agent's script assigns to the page's own `location`** (`location = …`,
    `location.href`, `assign`, `replace`, on this window or a frame's), which is unforgeable, so no world can wrap it:
    that code runs in the page's own world, and what it writes into the page or sends over the network is held only as
    above.

  Every other way is closed. The agent's world refuses a script address (`javascript:` or `vbscript:`, read as the
  browser reads one: spaces, tabs, newlines and control characters dropped, any case) anywhere in any text its script
  writes through any property of any interface it has (an HTML or SVG link, an animated string's `baseVal`, a form's
  `action`, a refresh's content, an animation's values) or through `setAttribute`, and a value is made text once, so the
  text checked is the text written; it refuses a `script` element, an `on…` attribute, attribute nodes, HTML parsed
  from a string (`innerHTML`, `outerHTML`, a shadow root's or a template's, `insertAdjacentHTML`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `document.write`, `createContextualFragment`, `DOMParser`), markup for a frame (`srcdoc`, attribute or property), `document.open`, a worklet's module, a `blob:` address of its own making, XSLT and `execCommand`; and it may not change a script element (its type, text, source or address, or the text in it) nor insert, move, clone, import or adopt one or anything holding one, so a page's own inert, empty or template script can't be given the agent's code. Allowed, each for a reason measured in this browser (`e2e_no_markup_or_code_sink_reaches_the_pages_world`): the sanitizing `setHTML` and `Document.parseHTML` (they drop code); a `data:` document in a frame, an object or an embed (an origin of its own: it reads neither the page nor its cookie); an `about:srcdoc` frame (empty); and a blank frame's `eval`, an imported `data:` module, a timer's string and `Function` (they run in the agent's own world, where the cookie reads `{session}`). And neither the agent's script
  (an element's `click()`, an event it dispatches, a form it submits) nor any command the browser takes (`click`,
  `dblclick`, `check`, `uncheck`, `press` on the focused element, a newline `type`d into a field) activates an element
  when anything that activation could reach is a script address the page holds, unless that address is a literal
  no-op (`javascript:void(0)`, `javascript:;`, `javascript:`), which runs nothing and leaves the page's own handlers to
  act. What it could reach is read as the platform forwards it, from one description both use
  (`unbrowse-browser/cli/src/native/activation.js`): every element on the click's path up (through slots and shadow
  roots), a link's address, a submit control's `formaction` and its form owner's `action` (the owner the `form`
  attribute names from outside included), a label's labelled control read as clicked itself, every `area` in an image
  map's tree, and for Enter in a field its form with every submit control in it; where which one would be reached isn't
  certain (an image map's point, a form's default button), every one it could be is read. A form submitted without a
  submitter is refused if any submit control in it has a script `formaction`, though only its `action` would be used.
  The browser's commands read all of it in an isolated world of their own (`unbrowse-guard`) where no code but the
  guard's runs, so nothing the page replaced in its own world (`Array.prototype.filter`, `document.activeElement`)
  changes what the guard sees, and an answer of any other shape than a list of addresses refuses the command. A `press`
  reads the focused element (through shadow roots, closed ones included, and frames, another process's through its own
  session) and, for a chord holding Alt or Control, which some platform reads as an access key, every element of the
  page with an `accesskey`: if any of them reaches a script address, the chord isn't pressed.

  The read before a command and the command's dispatch are separate steps, so the guard also checks at the moment of
  activation: while one of the browser's commands dispatches (`click`, `dblclick`, `check`, `uncheck`, `press`, a
  newline `type`d, and `find` when it clicks or checks), a capturing listener armed in the guard's own world of every
  frame reads the real target of each `click`, `auxclick`, `dblclick`, `submit` (with its submitter) and Enter, Space
  or Alt/Control `keydown`, and cancels the event if anything it reaches is a script address or the read fails; the read
  and the cancel run in the event's own task, so no timer gets between them. The agent's script may not change where an
  activation goes (a control's `form`, a label's `for`, an image's `usemap`, a button's or an input's `type`, as
  attributes or properties) nor stop an event's propagation. Measured in this browser
  (`e2e_the_race_between_the_guard_and_the_click`): the agent's own timer moving a button between a no-op form and a
  script-action one, and a script-`formaction` submit into and out of a label, while the browser clicked 80 times,
  never ran a script address (most clicks refused before dispatch, some cancelled at the moment of activation, the
  rest went where they were safe); the agent's own listener moving the clicked button into the script-action form
  during the click's dispatch was cancelled at the submit; and moving the clicked element into a page's script link
  during the dispatch ran nothing, since the browser fixes the activation target when the dispatch starts. Not tried
  because not reachable from the agent's world: a move by a listener the page registered before the guard's on the
  same window, which is the page's own code. What still runs: a page whose own click handler rewrites its link to a
  `javascript:` address during the click runs that address (measured: the page became the address's result); that is
  the page's own code, as below.

  This guard is about script addresses an agent supplies or activates. A page that serves its own script addresses and
  its own code is "the page's own code" above: that code already runs in the page's world with whatever the page's
  scripts can read, with or without an agent's click. The guard refuses to activate such addresses anyway, as defence
  in depth, but a page determined to run its own code when an agent interacts with it (any click handler) can. The cost: a link or form whose address is code (an old site's
  `javascript:__doPostBack(…)`) can't be activated by an agent at all; the owner can, from the window.
- **A token a site shows in an answer that nothing in the walk ever sent back is, to the node, just page content.** And a token an answer delivered further in than its first 4 MiB (inside a larger script or page) is read there by nothing: any answer of the walk, an asset as much as an API's, is read for a value a later request sent back, but only that far (`provenance::ANSWER_SCAN_MOST`); such a token is held as the session only if a cookie, a credential field or a smaller answer carries it too.
- **Masking every agent answer costs a read of what the node holds, and can refuse an answer.** Each answer to an agent
  reads every jar and route record and asks every running site browser for its cookies, all at once and within 10 s; a
  browser that doesn't answer makes the node refuse the answer (503) rather than give it unmasked, and so does a jar or a browser folder that is there and can't be read, isn't JSON or was written by a newer build (a file of a jar's name holding JSON of another shape, a stale file of another kind, is no jar and is passed over), or a mask that can't be built (no jar and no browser folder is nothing held). A reader whose one-pass finder can't be built (`trace::Written`, the walk's answer scan) reads each form on its own instead: slower, never a reading that found nothing. A value under 4
  characters (and a flag) isn't masked, one under 12 only where it stands as a whole word, and a value a site returns as
  a JSON number isn't masked at all: only text is read. The one reader of a value however it is written (`trace::written_forms`, `carries_written`) knows it as itself, as an address, a form, JSON and markup escape it, and as base64 whole or inside a longer encoding, and those applied to each other three layers deep (`trace::WRITTEN_DEPTH`: base64 of base64, the escape of base64, base64 of a JSON string, at most 2,048 forms a value); a transform it doesn't know (a reversal, a cipher, a split) or nesting deeper than three isn't seen, by the masks, an agent's call guard or the sharing boundary.
- **Answers.** No one re-runs a call to check what a route answered. The contract pays a line the payer's agent signed
  as passed; a wrong but well-formed answer is the caller's to catch. Nothing is bonded and nothing is forfeited: a route that
  fails its payers loses rank once the failure is shown on chain, since a stake counts only while its wallet's own
  latest paid call passed. The node shows no failure on chain: it claims no failed line and sends no
  `CoinStakes.reportFailed`. It reports a failed fetch to the telemetry worker and, when the owner has reports on, as
  a public issue (`decide.failures-reported-off-chain`). So stake behind a route that broke keeps counting until its
  holder sells or reports the failure itself ([docs/MONEY.md](docs/MONEY.md) §7). A failed line costs its payer nothing, so a payer
  that marks good answers failed keeps them unpaid, and nothing on chain stops it
  (unbrowse-settlement/README.md (private repository)).
- **The chain.** Settlement is only as sound as the chain it runs on. Calls to routes a node already holds go
  straight to the site and need no chain.
- **Domains.** The contract's admin binds a domain to the owner its escrow pays, by hand, until DNSSEC proofs replace
  it ([MONEY.md](docs/MONEY.md)).
- **A GET that changes something is repeated while the node learns.** A route is checked against the site before it
  is kept: the node calls a newly learned read route as the walk called it, and again with a word nobody searches for,
  to see whether its answer hears the caller (`learn::hears`), and a trial calls it to see that the site answers
  (`learn::mint_trial`). These calls go with the owner's session for the site. A route is read or write by its method
  (`ledger::writes`): every `GET` and `HEAD` is a read, and writes are never repeated at learn time. A site that
  changes state on a `GET` (an unsubscribe link, a one-click confirm) therefore sees that `GET` again, once or twice,
  while the node learns the page. The node's own routes only: a route another node listed is never probed this way.
- **What a walk with a fragment can share.** A route is listed under the rule in SHARING.md only when its walk shows
  it was never at an address with a fragment, or every text it carries is found in what the site served before any
  of the walk's page code ran. That costs: every route learned before walks recorded their addresses, every route a
  browsing session taught (its capture records no addresses), and every route a heal rebuilt needs a fresh walk to be
  listed; a walk at a page with an ad or a sign-in frame whose address has a fragment is held to the rule; and a
  hash-routed or signed-in page (one whose first document runs code of its own, or came with a cookie) rarely
  explains its constants, so most such routes stay on the owner's node. What it does not cover: state the site's
  pages left in the walk's browser profile on an earlier walk (local storage, a cookie the jar didn't keep) that this
  walk's page code reads and sends: such a value has no address of this walk to be found at.
  The record of where a walk's browser was counts only when it is whole (`walk::addresses_in`): it closes with a
  count of its address lines that matches, no failed write and no event the walk lost (one its relay dropped, or a message from the browser it couldn't read, a
  frame that wasn't UTF-8 included), a record its browser's line closed under before the walk ended it, no attached frame or page
  refused to report its moves, every line reads, nothing is recorded outside its opening and closing lines, and every
  request names a frame or target whose address was recorded first; anything less reads as a walk that
  may have been at an address with a fragment. One gap stays: an attached frame or popup starts running before the
  node asks it to report its moves, so a move it makes in that moment is missed while its address at attach is
  recorded. Holding each new target until it reports (`waitForDebuggerOnStart`) would close it. Evidence is only as good as the reader that judged it:
  a route records which version of the address reader and of the rule of what explains a constant judged it
  (`Route::read_by`), and one judged by another version, or kept before this was recorded, is read as unjudged and
  listed only after its page is walked again. That holds for a listing already live too: a listing stands only while
  its route would be listed today (`share::listed_today`). One that fails the check is served, spread and announced
  no more at once, and the node's regular pass, which runs at start, withdraws it by the node's one delist path (on
  the chain with the node's key when it may; when only the owner's wallet may, the transaction is handed to them),
  telling the owner once in the activity log to walk the page again. On an upgrade this may withdraw many listings at
  once: that is meant, and each comes back once its page is walked again and the route shared again.
- **One answer's size while a walk reads it.** A walk keeps at most each body's own cap and 128 MiB of body text in
  all (`session::KeptBodies`), so what a walk records and reads back is bounded. Each body is still read whole from the
  browser before it is cut (`session::response_body`), so one very large answer the browser itself kept is held in the
  node's memory for that moment: the node sets no buffer limit on the browser, and the browser's own is the bound.
- **A cookie's path in an older jar.** The jar keeps each cookie's path beside it (`jars/<host>.json.meta`), from the
  line that set it or the walk's browser. A cookie the jar held before paths were kept has none recorded, and goes as
  a root-path cookie: to every path of its host, as a browser sends a cookie set with `Path=/`. One the site meant for
  a single path (`/admin`) can then reach the host's other paths until the next walk or answer records its path. Its
  HttpOnly is never assumed the same way: unknown is hidden from a page's script.
- **One cookie per name.** A browser can hold several cookies of one name with different paths or domains and sends
  each only where its own line said. The node's jar holds one per name, and keeps it whole: one line's value with
  that same line's domain (or its host alone), path and life, never a mix of two lines (`mint::keep_line`). Of two
  cookies of one name it keeps the narrower (the host alone before any domain, a longer domain before a shorter one,
  a longer path before a shorter one), and on a tie (two disjoint paths of one length) the one it already held;
  HttpOnly is never loosened by the choice. Every writer keeps to this: an answer's cookies, a walk's capture and its
  browser's cookies, a heal, an import, a door's earned cookies. So a value is never sent where its own line didn't
  send it. The cost: an address only the other cookie's line covers gets no cookie of that name from the node, where
  a browser would send it that other cookie, and a call there may fail as one with no session would.
  A line that ends a cookie ends it everywhere the node keeps cookies: by `Max-Age`, or by an `Expires` already past,
  read as a browser reads the date (RFC 6265 §5.1.1, `http::cookie_date`), Max-Age winning where a line has both. And
  when the walk's browser is asked what it holds, its answer is the judge: a cookie the walk saw set that the browser
  no longer holds leaves the jar, even when it holds nothing for the host. Only a well-formed answer is a judgment
  (`mint::browser_cookie_list`): a query that failed, timed out or answered in another shape is asked again, up to
  three times, and a walk that still has no answer fails plainly; a heal then changes none of the jar's cookies. No
  cookie is ever kept on the capture's word alone.
- **A proposer program the owner configures is shown the walk it is asked about.** With `UNBROWSE_PROPOSE_PROGRAM`
  set (off unless the owner sets it), the learner hands that command, at learn time, the goal, the page's address,
  what the page was asked, the words the page offers, and for each call that could be the answer its place, the
  names of its answer's fields and what it sent, each value cut to 80 characters (`learn/sitegraph.rs`,
  `learn/trial.rs`). What the site gave the session to hand back (a cookie's value, a token an answer delivered:
  `provenance::session_values`) is named `{session}` there, a value of the address's query that was not asked is
  named by its key alone, and no header or cookie is included. A piece of an address (the page's, or a call's)
  is named the same way when it carries what the session holds, however many times the address wrote it over, or
  when it is written as a key and not as a word: a long run of hex, or a long unbroken run of letters and digits
  together. A word the page offers that carries either is not passed on. What still reaches it: the caller's own
  values, the words of the address's path, and values a call sent that the walk cannot trace to the session and that
  do not read as a key (shorter than six characters, a plain word, or a short value the page's code made or kept in
  its storage). Words the page offers are the page's text, so a page can write to that program's input; its answer
  is used only as a word to ask the site or as the number of a call the walk already holds. The program runs as the owner and sends what it is given wherever the owner pointed it.
  It is also shown a kept route's chain of calls (`learn/links.rs`): each step's address, and the values it sends
  that are not plainly fixed, cut to 60 characters. There too a value the session holds is told by its shape alone
  (`{session}`, its length, what it is written in). What it says of the chain (keep a value, fix it as the walk
  sent it, drop a header) is applied only to a route that reads, and kept only if the site then answers the walked
  value and a second one with answers of their own; a value fixed that way is never carried by a shared route.
- **A learn walks the page twice.** A page learned for a caller's value is walked a second time for another word
  (one the page offers, or the proposer's), in the same browser profile as the first. That is one more load of the
  same site's page with one value of its address changed, by the same caller; an agent that may learn a page could
  already load it, and what a signed-in page's own code sends when it loads is the page's (the first limit above).

### References

1. Meta, [How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), 8 September 2026.
2. Mozilla, [Protecting Firefox users following the compromise of eMudhra intermediate certificates](https://blog.mozilla.org/security/2026/10/20/protecting-firefox-users-following-the-compromise-of-emudhra-intermediate-certificates/), 20 October 2026.
3. eMudhra, [Statement on Recent Certificate Security Incident](https://emudhra.com/en/post/certificate-security-incident).
4. Apple, [About the compromised eMudhra intermediate CAs](https://support.apple.com/en-us/149555).

## In scope

- **Keys.** Anything that reads the root key, its recovery phrase or an agent key, or signs with one, without the
  owner.
- **The vault.** A password, a one-time code or its key, or a card's number, code or expiry reaching an agent, a
  log, a walk record, a route, or a page or frame on another site; a card filled or sent without the owner's approval.
- **Certificates.** An HTTPS client of the node accepting a certificate the operating system rejects.
- **Egress.** A call of the node's following a public name to an address inside the owner's network while
  Reach private networks is off.
- **The agent API.** A request on 127.0.0.1 that acts without a valid token, an agent acting beyond its key's cap
  or expiry, the node paying more for one route's fetch than the owner's per-fetch maximum, or a page in a browser reaching the node.
- **Sessions.** Cookies or tokens from the jar leaving the node, or a route sending them to a host they weren't
  issued for.
- **The browser.** Capture recording a secret field's value, or a browse command that escapes the site's profile.
- **Settlement contracts.** Funds moved, frozen or minted outside the rules in
  `unbrowse-settlement/README.md` (private repository).

## Out of scope

- A site's own security. The node calls a site's API the way its app does; report a site's flaw to that site.
- Findings that need root or the owner's login on the machine already.
- The devnet's Anvil account, whose key is public by design.
