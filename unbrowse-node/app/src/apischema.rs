//! The shapes the node's two APIs answer with, as JSON Schema: the agent API's primitives (`api::PRIMITIVES`) and the
//! owner's commands (`commands::OWNER_COMMANDS`) name these by `{"$ref": "#/types/<Name>"}`. `agent-api.json` carries
//! them, so the SDKs can be written from that one file. Each type keeps the name the
//! TypeScript SDK exports it under, and the fields as the node sends them (snake case, as on the wire): where the two
//! differ, the node is the truth, and the tests check real answers against these (`check`).
// The node itself reads none of this: `api::manifest` writes it out, from a test.
#![cfg_attr(not(test), allow(dead_code))]

use serde_json::{json, Map, Value};

/// A reference to one of `types()`.
pub fn r(name: &str) -> Value {
    json!({ "$ref": format!("#/types/{name}") })
}

/// `s`, or null.
pub fn or_null(s: Value) -> Value {
    json!({ "anyOf": [s, { "type": "null" }] })
}

/// An object with exactly these properties, `required` among them always there.
pub fn obj(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

/// The same, open to properties a flattened part adds (`allOf`, a tagged union's fields).
fn open(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

/// An object with exactly these properties, every one always there.
fn all(properties: Value) -> Value {
    let required: Vec<String> = properties.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

pub fn list(items: Value) -> Value {
    json!({ "type": "array", "items": items })
}

fn one_of(values: &[&str]) -> Value {
    json!({ "type": "string", "enum": values })
}

/// A tagged union's variant: `tag` is one of `values`, beside the variant's own fields.
fn variant(tag: &str, values: &[&str], mut properties: Value, required: &[&str], closed: bool) -> Value {
    let mut props = Map::new();
    props.insert(tag.into(), one_of(values));
    props.extend(properties.as_object_mut().map(std::mem::take).unwrap_or_default());
    let required: Vec<&str> = std::iter::once(tag).chain(required.iter().copied()).collect();
    if closed {
        obj(Value::Object(props), &required)
    } else {
        open(Value::Object(props), &required)
    }
}

/// The named types, sorted by name, each with its name as `title`.
pub fn types() -> Map<String, Value> {
    let s = || json!({ "type": "string" });
    let int = || json!({ "type": "integer" });
    let num = || json!({ "type": "number" });
    let yes = || json!({ "type": "boolean" });
    let s_null = || json!({ "type": ["string", "null"] });
    let int_null = || json!({ "type": ["integer", "null"] });
    let num_null = || json!({ "type": ["number", "null"] });
    let named: Vec<(&str, Value)> = vec![
        // ---- the agent API ----
        // `kind` says a file input takes a path to upload; a route listed by a node that predates file inputs has none.
        // A step of a route besides its last that may change something on the site: never an input of the agent's.
        ("RouteStep", all(json!({ "method": s(), "host": s(), "path": s() }))),
        ("RouteInput", obj(json!({ "name": s(), "default": s_null(), "secret": yes(), "kind": one_of(&["text", "file"]), "optional": yes(), "supply": yes(),
            "options": list(obj(json!({ "value": s(), "label": s() }), &["value"])) }), &["name", "default", "secret"])),
        (
            "Route",
            json!({ "anyOf": [
                // `verdict`, `why` and `was`: what a confirming browse or the route's own call said of a route of one
                // sighting, beside an unbrowse_do reply (`api::goal`). Unpublished, every such reply broke this schema
                // (QA's MCP check, run 44694418133, UNB-235).
                obj(json!({ "id": s(), "site": s(), "what": s(), "method": s(), "path": s(), "write": yes(), "listed": yes(), "yours": yes(),
                    "inputs": list(r("RouteInput")), "link": s(), "also_sends": list(r("RouteStep")),
                    "verdict": one_of(&["agreed", "differed", "failed", "cannot-tell"]), "why": s_null(), "was": s() }),
                    &["id", "site", "what", "method", "path", "write", "listed", "yours", "inputs"]),
                obj(json!({ "id": s(), "remote": { "type": "boolean", "enum": [true] }, "contributor": s(), "fee": num(),
                    "listed_as": all(json!({ "site": s(), "what": s() })), "unverified": s(), "over_max": s(), "reputation": r("Reputation"), "link": s() }),
                    &["id", "remote", "contributor", "fee", "listed_as", "unverified", "reputation"]),
            ] }),
        ),
        ("CardLimit", all(json!({ "card": s(), "site": s(), "per_payment": num(), "per_day": num(), "day": int(), "spent": num() }))),
        ("CardCodes", all(json!({ "on": yes(), "forgotten": list(s()) }))),
        ("PaymentApprover", obj(json!({ "approver": { "type": "string", "enum": ["dialog", "sdk"] }, "since": { "type": "integer" } }), &["approver"])),
        (
            "LinkPreview",
            obj(json!({ "link": s(), "site": s(), "entry": s(), "routes": list(r("Route")), "checked": yes(), "unavailable": s(), "next": s(),
                "asked_network": yes(), "not_asked": s() }),
                &["link", "site", "routes", "next"]),
        ),
        ("Retry", one_of(&["as_is", "check_first", "never"])),
        // What a reply of unbrowse_do, unbrowse_call, unbrowse_browse or unbrowse_challenge came to, answered or failed:
        // one word of a closed set (`outcome::Outcome`), and the call to make next as given, absent when there is none.
        ("Outcome", one_of(&crate::outcome::Outcome::ALL.map(|o| o.word()))),
        ("Next", obj(json!({ "tool": one_of(crate::outcome::NEXT_TOOLS), "args": { "type": "object" } }), &["tool", "args"])),
        ("Cut", all(json!({ "at": s(), "kept": int(), "total": int(), "unit": one_of(&["items", "chars"]) }))),
        ("Truncated", obj(json!({ "kept_bytes": int(), "total_bytes": int(), "cuts": list(r("Cut")), "whole": s_null(), "left_out": list(s()), "next_page": or_null(json!({ "type": "object", "additionalProperties": s() })), "note": s() }), &["kept_bytes", "total_bytes", "cuts", "whole", "note"])),
        ("AnswerField", obj(json!({ "path": s(), "kind": one_of(&["text", "long text", "number", "true/false", "money", "link", "date", "address", "list", "object", "empty"]), "example": s() }), &["path", "kind"])),
        (
            "Fields",
            obj(json!({ "returned": list(s()), "more": list(r("AnswerField")), "more_total": int(), "whole": yes(), "add": s(), "copies": list(s()) }), &["returned", "more", "more_total", "whole"]),
        ),
        (
            "CallResult",
            obj(
                json!({ "ok": yes(), "ms": int(), "data": {}, "error": s_null(), "paid_usdc": num_null(),
                    "paid_unb": { "type": ["number", "null"], "description": "@deprecated The same as paid_usdc, under its name from before fees were USDC." },
                    "possible_commit": yes(), "retry": or_null(r("Retry")), "truncated": or_null(r("Truncated")), "fields": or_null(r("Fields")),
                    "ignored_inputs": list(s()), "inputs": list(s()), "also_sends": list(r("RouteStep")), "notes": list(s()), "more": { "type": "object", "additionalProperties": s() },
                    "records": { "type": ["integer", "null"], "description": "How many records the answer holds where a confirming browse saw this route's records, read on the answer whole before the reply chose its fields or cut it: 0 is the site finding nothing, null an answer without that place. Absent where no place was seen." },
                    "bounties": r("BountyAsks"),
                    "browser": yes(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "ask": s(), "network": all(json!({ "entry_id": s(), "content_id": s(), "contributor": s_null(), "served_by": s_null(), "cached": yes(),
                        "listed_as": s(), "ran_on": s() })) }),
                &["ok", "ms", "data", "error", "paid_usdc", "paid_unb", "possible_commit", "retry", "truncated"],
            ),
        ),
        ("RouteFailure", json!({ "anyOf": [all(json!({ "route_id": s(), "error": s_null() })), all(json!({ "entry_id": s(), "error": s_null() }))] })),
        ("PaymentRefused", all(json!({ "entry_id": s(), "error": s(), "why": s() }))),
        ("NetworkSkipped", all(json!({ "entries": list(all(json!({ "entry_id": s(), "fee_usdc": num() }))), "max_fetch_usdc": num(), "budget_usdc": num_null(), "why": s() }))),
        // The site's listings in other words than the goal's, for the agent to judge and call by entry id (R3.2).
        ("NetworkOffers", all(json!({ "entries": list(all(json!({ "entry_id": s(), "what": s(), "fee_usdc": num() }))), "next": s() }))),
        // An entry's standing among its route's entries (R3.36), as this node computes it from the chain.
        (
            "Reputation",
            all(json!({ "default": yes(), "unverified": yes(), "counted_uses": int(), "pass_rate": num(), "unavailable": yes(), "version": int(), "rank_version": int() })),
        ),
        ("NetworkEntry", all(json!({ "id": s(), "contributor": s(), "fee": num(), "listed_as": all(json!({ "site": s(), "what": s() })), "reputation": r("Reputation") }))),
        (
            "DoResult",
            json!({ "anyOf": [
                variant("how", &["called", "learned"], json!({ "route": r("Route"), "result": r("CallResult"), "picked_by": s(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "ask": s(),
                    "notes": list(s()), "route_failed": r("RouteFailure"), "network_skipped": r("NetworkSkipped"), "network_offers": r("NetworkOffers"), "payment_refused": r("PaymentRefused") }), &["route", "result"], true),
                variant("how", &["network"], json!({ "entry": r("NetworkEntry"), "result": r("CallResult"), "route_failed": r("RouteFailure"), "explored": yes(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "ask": s() }),
                    &["entry", "result"], true),
                variant("how", &["browse"], json!({ "site": s(), "page": s(), "why": s(), "note": s(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "ask": s(), "route_failed": r("RouteFailure"),
                    "network_skipped": r("NetworkSkipped"), "network_offers": r("NetworkOffers"), "payment_refused": r("PaymentRefused") }), &["site", "page", "why", "next"], true),
                // The work goes on behind the reply: `next` collects its answer by `ask` (`asks::answer_within`).
                variant("how", &["working"], json!({ "ask": s(), "phase": s(), "note": s(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next") }), &["ask", "phase", "outcome", "outcome_from", "next"], true),
                variant("how", &["pages"], json!({ "ms": int(), "count": { "type": "object", "additionalProperties": int() }, "pages": list(r("PageAnswer")),
                    "fields": { "type": "object", "additionalProperties": list(r("AnswerField")) }, "pending": list(s()), "note": s(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "ask": s() }), &["ms", "count", "pages", "fields"], true),
            ] }),
        ),
        // One page of several asked at once (`do_pages`), naming its own ask; one still being done says how: working.
        (
            "PageAnswer",
            obj(
                json!({ "url": s(), "how": one_of(&["called", "learned", "network", "browse", "error", "working"]), "ms": int(), "ok": yes(), "route_id": s(), "data": {},
                    "error": s_null(), "truncated": or_null(r("Truncated")), "fields": list(r("AnswerField")), "why": s(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "route_failed": r("RouteFailure"),
                    "ask": s() }),
                &["url", "how", "ms", "ok"],
            ),
        ),
        ("LearnedRoute", all(json!({ "route_id": s(), "what": s(), "inputs": list(s()), "write": yes() }))),
        (
            "BrowseReply",
            obj(
                json!({ "site": s(), "output": s(), "learned": list(r("LearnedRoute")), "route_for_goal": r("LearnedRoute"), "note": s(),
                    "owner": one_of(&["done", "declined", "no_answer"]), "url": s(), "waited_s": int(), "needs_owner": yes(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "ask": s() }),
                &["site", "output"],
            ),
        ),
        // A challenge the agent met with its own eyes (`unbrowse_challenge`): the picture it was shown, what the page
        // says, and whether the page still asks. `asks` is the page's answer, never the node's.
        (
            "ChallengeReply",
            obj(
                json!({ "site": s(), "url": s(), "title": s(), "text": s(), "asks": yes(), "w": num(), "h": num(), "image": { "type": ["string", "null"] }, "mime": s(), "said": list(s()), "note": s(), "outcome": r("Outcome"), "outcome_from": s(), "next": r("Next"), "ask": s() }),
                &["site", "url", "title", "text", "asks", "image", "said"],
            ),
        ),
        // `browser` and `browser_fetch` are absent from a node older than the browser add-on.
        ("Whoami", obj(json!({ "agent": s(), "address": s(), "node": s(), "browser": r("BrowserState"), "browser_fetch": yes(), "owner": r("OwnerReach") }), &["agent", "address", "node"])),
        // Whether `ask_owner` can reach the owner (`hands::owner_reach`); absent from an older node.
        ("OwnerReach", one_of(&["watching", "can_open", "off"])),
        ("BrowserState", one_of(&["present", "missing", "installing"])),
        // A bug report (`report.rs`): the route's shape and the agent's last error are the node's additions, and
        // `contents` is the report as the relay is sent it, without the install id.
        ("ReportRoute", all(json!({ "method": s(), "host": s(), "path": s(), "inputs": list(s()), "write": yes(), "steps": int() }))),
        ("ReportLastError", obj(json!({ "tool": one_of(crate::report::TOOLS), "class": s(), "error": s() }), &["tool", "class"])),
        (
            "ReportContents",
            obj(
                json!({ "kind": one_of(crate::report::KINDS), "summary": s(), "expected": s(), "got": s(), "goal": s(), "error": s(), "url": s(),
                    "tool": one_of(crate::report::TOOLS), "route": r("ReportRoute"), "last_error": r("ReportLastError"), "version": s(), "os": s(),
                    "source": one_of(&["agent", "node"]) }),
                &["kind", "version", "os", "source"],
            ),
        ),
        (
            "ReportResult",
            obj(
                json!({ "report": one_of(&["sent", "queued", "already_sent", "limited", "off", "refused", "waiting_for_owner"]), "fingerprint": s(),
                    "scrubbed": { "type": "object", "additionalProperties": int() }, "contents": r("ReportContents"), "public": s(), "next": s(),
                    "why": s(), "issue": s(), "new_issue": yes(), "reports": int() }),
                &["report", "fingerprint", "scrubbed", "contents", "public", "next"],
            ),
        ),
        // What an agent said of a route from its answers (`unbrowse_judge`), as the route now holds it.
        ("WrongPage", all(json!({ "page": s(), "why": s() }))),
        ("Judged", all(json!({ "wrong_pages": list(r("WrongPage")), "named": yes(), "fields": list(s()), "writes": yes() }))),
        ("JudgeResult", all(json!({ "route": r("Route"), "judged": r("Judged"), "next": s() }))),
        // What a passed call's result asks the agent about bounties (spec ch. 8): whether the entry it called does one of
        // the owner's open bounties for its site.
        (
            "BountyAsks",
            all(json!({
                "confirm": list(all(json!({ "bounty": int(), "entry": s(), "site": s(), "amount_unb": num(), "limit_unb": num_null() }))),
                "next": s()
            })),
        ),
        // The agent's answer to a bounty ask, as the node kept it (`unbrowse_judge` with bounty and entry).
        (
            "BountyAnswer",
            all(json!({
                "answered": all(json!({ "bounty": int(), "entry": s(), "does": yes() })),
                "next": s()
            })),
        ),
        ("Login", obj(json!({ "ref": s(), "site": s(), "code": s(), "from": s() }), &["ref", "site"])),
        (
            "Card",
            // `cvv` only for a card kept with its security code, which the vault keeps only when the owner chose to (#185).
            obj(json!({ "label": s(), "last4": s(), "number": s(), "expiry": s(), "month": s(), "year": s(), "yy": s(), "cvv": s(), "name": s() }),
                &["label", "last4", "number", "expiry", "month", "year", "yy", "name"]),
        ),
        // ---- the owner's commands ----
        ("Identity", all(json!({ "address": s(), "created": yes() }))),
        ("OwnerLink", all(json!({ "owner": s_null(), "waiting": yes(), "error": s_null() }))),
        ("LinkStart", all(json!({ "url": s(), "opened": yes() }))),
        ("LinkMessage", all(json!({ "message": s(), "nonce": s(), "owner": s() }))),
        ("GasShort", all(json!({ "have": num(), "need": num(), "why": s(), "chain_id": int() }))),
        (
            "Funding",
            all(json!({ "live": s_null(), "short": or_null(r("GasShort")), "site": s(), "address": s(), "identity_usdc": num_null(),
                "deposit_floor_usdc": num(), "deposited_usdc": num_null(), "fund_usdc": num_null(),
                "other_chains": or_null(all(json!({ "cctp_domain": int(), "cctp_messenger": s(), "gateway_minter": s() }))) })),
        ),
        // The Money screen's one reply (`money.rs`): decimal strings of USDC.
        (
            "Money",
            all(json!({ "balance": s(), "available_to_spend": s(), "needed_to_start": s(), "add_funds_url": s_null(),
                "payments": one_of(&["test", "open", "not_open", "offline", "starting"]),
                "parts": all(json!({ "at_address": s(), "kept_for_fees": s(), "deposit": s(), "account_deposit": s_null(), "signed": s() })),
                "agents": list(all(json!({ "index": int(), "name": s(), "daily_limit": s(), "spent_today": s(), "pays_from": one_of(&["node", "account"]) }))),
                "earnings": all(json!({ "available": s() })),
                "first_buys": list(r("FirstBuy")) })),
        ),
        (
            "FirstBuy",
            all(json!({ "entry": s(), "coin": s(), "bps": int(), "unb": num(), "coins": num(), "units": s(), "delay": int(),
                "launch_tx": s_null(), "stake_tx": s_null(), "at": int() })),
        ),
        ("AddFunds", all(json!({ "url": s(), "opened": yes() }))),
        ("ShareMode", one_of(&["used", "all", "off"])),
        (
            "ShareBlocked",
            json!({ "anyOf": [
                variant("kind", &["locked", "network_off"], json!({}), &[], true),
                variant("kind", &["no_settlement"], json!({ "error": s() }), &["error"], true),
                variant("kind", &["no_gas"], json!({ "have": num(), "need": num(), "message": s() }), &["have", "need", "message"], true),
            ] }),
        ),
        (
            "ShareStanding",
            json!({ "anyOf": [
                variant("why", &["listed", "off", "opted_out", "not_run_yet", "queued", "preview", "unsigned"], json!({}), &[], false),
                variant("why", &["local"], json!({ "signed_in": yes() }), &["signed_in"], false),
                variant("why", &["unspread"], json!({ "poster": yes() }), &["poster"], false),
                variant("why", &["excluded"], json!({ "host": s() }), &["host"], false),
                variant("why", &["not_shareable"], json!({ "reason": s() }), &["reason"], false),
                variant("why", &["below_threshold"], json!({ "days": int(), "runs": int(), "days_needed": int(), "runs_needed": int() }),
                    &["days", "runs", "days_needed", "runs_needed"], false),
                variant("why", &["cap_reached"], json!({ "per_day": int() }), &["per_day"], false),
                variant("why", &["blocked"], json!({ "reason": r("ShareBlocked") }), &["reason"], false),
                variant("why", &["failed"], json!({ "error": s() }), &["error"], false),
            ] }),
        ),
        (
            "ShareRoute",
            json!({ "allOf": [
                open(json!({ "id": s(), "site": s(), "what": s(), "share": { "type": ["boolean", "null"] }, "passed": int(), "days": int() }),
                    &["id", "site", "what", "share", "passed", "days"]),
                r("ShareStanding"),
            ] }),
        ),
        (
            "ShareStatus",
            all(json!({ "mode": r("ShareMode"), "per_day": int(), "listed_today": int(), "blocked": or_null(r("ShareBlocked")), "routes": list(r("ShareRoute")) })),
        ),
        ("NodeInfo", all(json!({ "name": s(), "version": s(), "api_port": int(), "dev": yes(), "terms_version": s() }))),
        ("TermsText", all(json!({ "version": s(), "terms": s(), "privacy": s() }))),
        ("Site", all(json!({ "host": s(), "walked": int_null() }))),
        ("Session", all(json!({ "host": s(), "cookies": int(), "updated": int_null() }))),
        ("Settings", settings(false)),
        ("KeptRouteInput", all(json!({ "name": s(), "secret": yes(), "default": s_null() }))),
        (
            "KeptRoute",
            obj(
                json!({ "id": s(), "site": s(), "what": s(), "method": s(), "path": s(), "root": s(), "inputs": list(r("KeptRouteInput")),
                    "steps": int(), "browser_assisted": yes(), "write": yes(), "provisional": yes(), "learned_at": int(),
                    "stats": all(json!({ "calls": int(), "passed": int(), "last_ms": int_null(), "last_at": int_null(), "last_error": s_null(),
                        "pass_days": int(), "last_pass_day": int(), "fields_rule": int() })),
                    "listing": or_null(all(json!({ "entry_id": s(), "tx": s(), "listed_at": int(), "live": yes() }))),
                    "yours": yes(),
                    // The socket a route opens, and the learner's graph of its steps: the node's own records, read back
                    // only by the node.
                    "socket": { "type": "object" },
                    "fetched": r("FetchedFrom"),
                    "share": yes(),
                    // What the node read of its walk for sharing it (`learn::page_made`, `learn::walk_without_fragment`):
                    // its own record, read back only by the node.
                    "page_made": or_null(list(s())),
                    "walk_without_fragment": yes(),
                    "read_by": all(json!({ "addresses": int(), "page_made": int() })),
                    "given": list(s()),
                    "session_gave": yes(),
                    "graph": { "type": "object" } }),
                &["id", "site", "what", "method", "path", "root", "inputs", "steps", "browser_assisted", "write", "provisional", "learned_at", "stats",
                    "listing", "yours", "graph"],
            ),
        ),
        ("FetchedFrom", all(json!({ "entry_id": s(), "route_id": s(), "agent_id": s(), "content_id": s(), "listed_as": s(), "fetched_at": int() }))),
        ("RouteChain", all(json!({ "id": s(), "listed": yes(), "live": yes(), "fee": num(), "held": yes(), "coin": s_null(), "staked": num(), "held_coins": num(), "rank": num() }))),
        // Route coins (`chain::coins`).
        ("CoinDone", all(json!({ "tx": s(), "coin": s(), "entry": s(), "amount": num_null() }))),
        ("CoinLot", all(json!({ "delay": int(), "earning": num(), "pending": num(), "unstaking": num(), "ready_at": int() }))),
        (
            "Holding",
            all(json!({ "coin": s(), "entry": s(), "state": one_of(&["trading", "not launched"]), "held": num(), "lots": list(r("CoinLot")),
                "owed_usdc": num(), "parked_usdc": num(), "checked": yes(), "latest_passed": yes(), "price": num(), "value_unb": num(), "value_usd": num_null() })),
        ),
        ("Holdings", all(json!({ "wallet": s(), "coins": list(r("Holding")), "owed_as_contributor_usdc": num(), "fetch_delay": int(), "unb_usd": num_null() }))),
        (
            "DomainStatus",
            all(json!({ "domain": s(), "wallet": s_null(), "release_at": int_null(), "escrow_usdc": num(), "note": s_null() })),
        ),
        (
            "OwnerCallResult",
            all(json!({ "ok": yes(), "ms": int(), "data": {}, "error": s_null(), "possible_commit": yes(), "retry": or_null(r("Retry")) })),
        ),
        (
            "Activity",
            all(json!({ "at": int(), "who": s(), "site": s(), "what": s(), "kind": s(), "result": s(), "ms": int_null(), "unb": num_null(), "tx": s_null(),
                "note": s_null() })),
        ),
        (
            "Agent",
            obj(
                json!({ "index": int(), "name": s(), "address": s(), "cap_usdc": { "type": "number", "description": "The most the key spends a day, in USDC." },
                    "cap_unb": { "type": "number", "description": "@deprecated The same as cap_usdc, under its name from before fees were USDC." },
                    "expires": int(), "created": int(), "revoked": yes(), "tx": s_null(),
                    "salt": s(), "auto": yes(), "cap_set": yes(), "payers": list(json!({ "type": "array" })),
                    "gateway": { "type": ["string", "null"], "description": "The gateway a remote key opens the node through (its host); none for a key of the node's own door." } }),
                &["index", "name", "address", "cap_usdc", "cap_unb", "expires", "created", "revoked", "tx"],
            ),
        ),
        ("NewAgent", all(json!({ "agent": r("Agent"), "setup": s(), "token": s() }))),
        // This node's own remote MCP address at a gateway (`remote.rs`, graph `gateway.relay-to-own`).
        ("Remote", all(json!({ "on": yes(), "public": yes(), "gateway": s(), "url": s_null(), "account_link": s_null(), "peer": s_null(), "keys": list(r("Agent")) }))),
        ("NewRemoteKey", all(json!({ "agent": r("Agent"), "token": s(), "url": s(), "claude": s() }))),
        ("AgentSpend", all(json!({ "index": int(), "spent": num(), "cap": num() }))),
        (
            "VaultLogin",
            all(json!({ "site": s(), "account": s(), "kind": one_of(&["derived", "stored"]), "counter": int(), "created": int(), "code": yes(), "derivation": int() })),
        ),
        ("VaultCard", all(json!({ "label": s(), "last4": s(), "created": int(), "code": yes() }))),
        ("VaultImport", all(json!({ "added": int(), "codes": int(), "known": int(), "restored": int(), "skipped": list(all(json!({ "why": s(), "count": int() }))) }))),
        ("BrowserFound", all(json!({ "name": s(), "path": s(), "downloaded": yes() }))),
        (
            "Browsers",
            all(json!({
                "using": s_null(), "chosen": s_null(), "found": list(r("BrowserFound")), "downloading": yes(), "download_error": s_null(),
                "program": s_null(), "state": r("BrowserState"), "fetch": yes()
            })),
        ),
        ("Restored", all(json!({ "address": s(), "previous": s_null() }))),
        ("KeyBackup", all(json!({ "address": s(), "backup": s() }))),
        ("EarningsLine", all(json!({ "earned": num(), "claimed": num(), "to_claim": num() }))),
        (
            "Earnings",
            all(json!({ "staking": r("EarningsLine"), "contributor": r("EarningsLine"), "routes_paid": num(), "to_claim": num() })),
        ),
        (
            "WalletGrant",
            all(json!({ "wallet": s(), "settlement": s(), "deposit_usdc": num(), "calls": list(all(json!({ "to": s(), "data": s(), "what": s() }))) })),
        ),
        (
            "WalletRenew",
            all(json!({ "url": s_null(), "opened": yes(), "calls": list(all(json!({ "to": s(), "data": s(), "what": s() }))) })),
        ),
        (
            "OwnerNodes",
            all(json!({
                "wallet": s(), "deposit_usdc": num(), "renew_by": { "type": ["integer", "null"] },
                "keys": list(obj(json!({ "agent": s(), "cap_usdc": num(), "expiry": int(), "revoked": yes(), "spent_usdc": num(), "this_node": yes(), "name": s_null() }), &["agent", "cap_usdc", "expiry", "revoked", "spent_usdc", "this_node", "name"])),
            })),
        ),
        (
            "ListingToSign",
            all(json!({
                "id": s(), "route_id": s(), "site": s(), "description": s(), "version": int(), "price_usdc": num_null(), "wallet": s(), "what": s(),
                "typed_data": { "type": "object" },
            })),
        ),
        ("ListingSigned", all(json!({ "id": s(), "spread": yes() }))),
        ("ListingsSign", all(json!({ "url": s_null(), "opened": yes(), "asked": int() }))),
        (
            "Passkey",
            all(json!({ "id": s(), "site": s(), "account": s(), "created": int(), "used": int_null(), "how": one_of(&["auto", "manual", "phone"]), "approve": yes() })),
        ),
        ("Passkeys", all(json!({ "on": yes(), "never": list(s()), "passkeys": list(r("Passkey")) }))),
        ("PasskeyArmed", all(json!({ "site": s(), "until": int(), "how": s() }))),
        (
            "UpdateStatus",
            all(json!({ "running": s(), "enabled": yes(), "latest": s_null(), "min_version": s_null(), "outdated": yes(), "checking": yes(),
                "ready": s_null(), "error": s_null(), "channel": s_null(), "halted": s_null(), "update_root_warning": s_null() })),
        ),
        (
            "Deployment",
            all(json!({ "usdc": s(), "usdc_decimals": int(), "unb": s(), "pool": s(), "settlement": s(), "dnssec": s(), "domains": s(), "escrow_wait": int(), "coins": r("Coins"), "chain_id": int(),
                "block": int(), "code": s() })),
        ),
        (
            "Coins",
            all(json!({ "route_coins": s(), "route_coin_implementation": s(), "coin_stakes": s(), "coin_fetch": s(), "coin_bounties": s() })),
        ),
        ("ChainStatus", all(json!({ "up": yes(), "error": s_null(), "rpc": s(), "network": s(), "deployment": or_null(r("Deployment")), "settlement_missing": yes(), "payments": s(), "second_rpc": s(), "held_back": s_null() }))),
        (
            "Wallet",
            all(json!({ "address": s(), "chain_id": int(), "block": int(), "epoch": int(), "epoch_ends_in": int(), "usdc": s(), "unb": s(),
                "settlement": s(), "held": num(), "unb_held": num(), "deposit": num(), "pending_withdrawal": num(),
                "withdraw_epoch": int(),
                // Each day as [day, USDC its entries' lines sent to their coins].
                "earned": all(json!({ "entries": num(), "staking": num(), "lines": int(), "by_day": list(list(num())) })),
                "to_claim": num(), "fee": num(), "pricing": r("Pricing"), "split": r("Split") })),
        ),
        ("Split", all(json!({ "contributor": int(), "site": int(), "platform": int(), "serving": int(), "burn": int() }))),
        ("Pricing", all(json!({ "auto": yes(), "floor": num(), "ceiling": num(), "epoch": int(), "block": int(), "lines": int() }))),
        (
            "BountyView",
            obj(
                json!({ "id": int(), "poster": s(), "mine": yes(), "site": s(), "site_name": s(), "amount": num(), "limit_price": num(),
                    "posted_at": int(), "deadline": int(), "confirmed": yes(), "settled": yes(), "reserved": num(), "use_usdc": num(), "refundable": num(),
                    "state": one_of(&["open", "to settle", "confirmed", "settled"]) }),
                &["id", "poster", "mine", "site", "amount", "posted_at", "deadline", "confirmed", "settled", "reserved", "use_usdc", "refundable", "state"],
            ),
        ),
        ("BountyAuto", all(json!({ "on": yes() }))),
        ("BountyDone", all(json!({ "tx": s(), "id": int() }))),
        ("BoardRow", all(json!({ "contributor": s(), "entries": int(), "lines": int(), "earned": num(), "sites": int() }))),
        (
            "EntryStanding",
            all(json!({ "id": s(), "contributor": s(), "fee": num(), "yours": yes(), "default": yes(), "unverified": yes(), "unavailable": yes(),
                "counted_uses": int(), "pass_rate": num() })),
        ),
        ("RouteEntries", all(json!({ "site": s(), "what": s(), "default": s_null(), "entries": list(r("EntryStanding")) }))),
        ("HandsBrowser", all(json!({ "site": s(), "url": s(), "held": yes(), "walk": s() }))),
        (
            "HandsAsk",
            obj(
                json!({ "id": s(), "site": s(), "why": s(), "agent": s(), "asked_at": int(), "expires_at": int(),
                    // A payment the owner is asked to approve: the card, where it goes, and for a route call what the
                    // route does and the other values it sends; the amount the agent says it costs, when it says, and
                    // why it asks though a limit is set.
                    "pay": obj(json!({ "card": s(), "merchant": s(), "route": s(), "inputs": list(s()), "amount": num(), "over": s() }), &["card", "merchant"]),
                    // A login the owner is asked to add to the vault (`vault:ask:`): its site and account, never a
                    // password.
                    "login": all(json!({ "site": s(), "account": s() })) }),
                &["id", "site", "why", "agent", "asked_at", "expires_at"],
            ),
        ),
        ("Hands", all(json!({ "browsers": list(r("HandsBrowser")), "asks": list(r("HandsAsk")), "watching": s_null() }))),
        ("HandsPage", all(json!({ "site": s(), "url": s(), "walk": s(), "width": num(), "height": num(), "held": yes() }))),
        (
            "HandsInput",
            json!({ "anyOf": [
                variant("kind", &["click"], json!({ "x": num(), "y": num(), "clicks": int() }), &["x", "y"], false),
                variant("kind", &["scroll"], json!({ "x": num(), "y": num(), "dy": num(), "dx": num() }), &["x", "y", "dy"], false),
                variant("kind", &["text"], json!({ "text": s() }), &["text"], false),
                variant("kind", &["key"], json!({ "key": one_of(&["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowUp",
                    "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) }), &["key"], false),
            ] }),
        ),
    ];
    let mut sorted: Vec<(&str, Value)> = named;
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    sorted
        .into_iter()
        .map(|(name, schema)| {
            let mut titled = Map::new();
            titled.insert("title".into(), json!(name));
            if let Value::Object(o) = schema {
                titled.extend(o);
            }
            (name.to_string(), Value::Object(titled))
        })
        .collect()
}

/// The owner's settings: as the node answers them (every field there but `list_per_day`, which is left out when it is
/// the mode's own), or, for `taking`, as `save_settings` takes them: only the fields a settings file has always had
/// are needed, the rest read their defaults, `share_routes` also reads an older file's switch, and anything else is
/// read past.
pub fn settings(taking: bool) -> Value {
    let (s, int, num, yes) = (json!({ "type": "string" }), json!({ "type": "integer" }), json!({ "type": "number" }), json!({ "type": "boolean" }));
    let props = json!({
        "map_while_browsing": yes, "hold_routes": yes, "signed_in_calls": yes, "paused": yes, "api_port": int, "storage_gb": num,
        "excluded": list(s.clone()),
        "proxies": { "type": "object", "additionalProperties": { "type": "string" } },
        "shared_mint": yes,
        "share_routes": if taking { json!({ "anyOf": [r("ShareMode"), yes] }) } else { r("ShareMode") },
        "share_notice_seen": yes,
        "share_previewed": yes,
        "share_preview_told": { "type": ["integer", "null"] },
        "list_per_day": if taking { json!({ "type": ["integer", "null"] }) } else { int },
        "private_network": yes, "terms_accepted": { "type": ["string", "null"] }, "peer_network": yes, "light": yes, "serve_kept": yes, "auto_update": yes, "fetch_browser": yes, "headless_only": yes,
        "update_channel": { "type": ["string", "null"], "enum": ["stable", "canary", null] },
        "passkeys": yes, "passkeys_never": list(s.clone()), "chain": s, "max_fetch_usdc": num, "deposit_floor_usdc": num, "coin_dev_buy_bps": { "type": "integer" }, "coin_complete_others": yes,
        "gas_reserve_usdc": num, "max_gas_price_gwei": num, "gas_budget_usdc_per_day": num, "check_rpc": { "type": ["string", "null"] }, "claim_gas_share": num, "bounty_auto": yes, "keep_card_codes": yes, "accept_bearer": yes
    });
    if taking {
        return open(props, &["map_while_browsing", "hold_routes", "signed_in_calls", "paused", "api_port", "storage_gb", "excluded"]);
    }
    let required: Vec<String> = props.as_object().unwrap().keys().filter(|k| *k != "list_per_day" && *k != "check_rpc").cloned().collect();
    let required: Vec<&str> = required.iter().map(String::as_str).collect();
    obj(props, &required)
}

/// Whether `value` is what `schema` describes, its `$ref`s read from `types`: the part of JSON Schema these schemas
/// use (`type`, with a list for nullable; `properties`, `required`, `additionalProperties`, `items`, `enum`, `anyOf`,
/// `allOf` and `$ref`). Else where it first differs, as a path into `value`, and how.
#[cfg(test)]
pub fn check(schema: &Value, value: &Value, types: &Map<String, Value>) -> Result<(), String> {
    check_at(schema, value, types, "$")
}

#[cfg(test)]
fn check_at(schema: &Value, value: &Value, types: &Map<String, Value>, at: &str) -> Result<(), String> {
    let Some(schema) = schema.as_object() else { return Err(format!("{at}: the schema isn't an object")) };
    if let Some(to) = schema.get("$ref") {
        let name = to.as_str().and_then(|t| t.strip_prefix("#/types/")).ok_or_else(|| format!("{at}: $ref {to} isn't #/types/<name>"))?;
        let named = types.get(name).ok_or_else(|| format!("{at}: no type {name}"))?;
        check_at(named, value, types, at)?;
    }
    if let Some(want) = schema.get("type") {
        let kinds: Vec<&str> = match want {
            Value::String(k) => vec![k.as_str()],
            Value::Array(ks) => ks.iter().filter_map(Value::as_str).collect(),
            _ => return Err(format!("{at}: type {want} isn't a name or a list of names")),
        };
        if !kinds.iter().any(|k| is_kind(value, k)) {
            return Err(format!("{at}: {} isn't {}", short(value), kinds.join(" or ")));
        }
    }
    if let Some(Value::Array(allowed)) = schema.get("enum") {
        if !allowed.contains(value) {
            return Err(format!("{at}: {} isn't one of {}", short(value), Value::Array(allowed.clone())));
        }
    }
    if let Some(Value::Array(any)) = schema.get("anyOf") {
        let tries: Vec<String> = any.iter().filter_map(|s| check_at(s, value, types, at).err()).collect();
        if tries.len() == any.len() {
            return Err(format!("{at}: matches none of anyOf ({})", tries.join("; ")));
        }
    }
    if let Some(Value::Array(every)) = schema.get("allOf") {
        for s in every {
            check_at(s, value, types, at)?;
        }
    }
    if let Value::Object(o) = value {
        let props = schema.get("properties").and_then(Value::as_object);
        for k in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !o.contains_key(k) {
                return Err(format!("{at}: {k} is missing"));
            }
        }
        for (k, v) in o {
            let here = format!("{at}.{k}");
            match (props.and_then(|p| p.get(k)), schema.get("additionalProperties")) {
                (Some(s), _) => check_at(s, v, types, &here)?,
                (None, Some(Value::Bool(false))) => return Err(format!("{here} isn't a property the schema names")),
                (None, Some(s @ Value::Object(_))) => check_at(s, v, types, &here)?,
                (None, _) => {}
            }
        }
    }
    if let (Value::Array(items), Some(each)) = (value, schema.get("items")) {
        for (i, v) in items.iter().enumerate() {
            check_at(each, v, types, &format!("{at}[{i}]"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn is_kind(v: &Value, kind: &str) -> bool {
    match kind {
        "null" => v.is_null(),
        "boolean" => v.is_boolean(),
        "string" => v.is_string(),
        "number" => v.is_number(),
        "integer" => v.is_i64() || v.is_u64() || v.as_f64().is_some_and(|f| f.fract() == 0.0),
        "array" => v.is_array(),
        "object" => v.is_object(),
        _ => false,
    }
}

#[cfg(test)]
fn short(v: &Value) -> String {
    let s = v.to_string();
    match s.char_indices().nth(80) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s,
    }
}

/// Every `$ref` in `schema`, by the type's name.
#[cfg(test)]
pub fn refs(schema: &Value, out: &mut std::collections::BTreeSet<String>) {
    match schema {
        Value::Object(o) => {
            if let Some(name) = o.get("$ref").and_then(Value::as_str).and_then(|t| t.strip_prefix("#/types/")) {
                out.insert(name.to_string());
            }
            o.values().for_each(|v| refs(v, out));
        }
        Value::Array(a) => a.iter().for_each(|v| refs(v, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types_with(name: &str, schema: Value) -> Map<String, Value> {
        let mut t = Map::new();
        t.insert(name.into(), schema);
        t
    }

    #[test]
    fn a_value_is_checked_against_its_type() {
        let t = Map::new();
        assert!(check(&json!({ "type": "string" }), &json!("x"), &t).is_ok());
        assert!(check(&json!({ "type": "string" }), &json!(1), &t).is_err());
        assert!(check(&json!({ "type": "integer" }), &json!(3), &t).is_ok());
        assert!(check(&json!({ "type": "integer" }), &json!(3.5), &t).is_err());
        assert!(check(&json!({ "type": "number" }), &json!(3.5), &t).is_ok());
        assert!(check(&json!({ "type": "boolean" }), &json!(null), &t).is_err());
        assert!(check(&json!({}), &json!({ "anything": [1, "two"] }), &t).is_ok(), "an empty schema takes any value");
    }

    #[test]
    fn a_list_of_types_takes_any_of_them() {
        let t = Map::new();
        let s = json!({ "type": ["string", "null"] });
        assert!(check(&s, &json!(null), &t).is_ok());
        assert!(check(&s, &json!("x"), &t).is_ok());
        assert!(check(&s, &json!(false), &t).is_err());
    }

    #[test]
    fn an_object_has_what_it_requires_and_nothing_it_doesnt_name() {
        let t = Map::new();
        let s = obj(json!({ "a": { "type": "integer" }, "b": { "type": "string" } }), &["a"]);
        assert!(check(&s, &json!({ "a": 1 }), &t).is_ok());
        assert!(check(&s, &json!({ "a": 1, "b": "x" }), &t).is_ok());
        let missing = check(&s, &json!({ "b": "x" }), &t).unwrap_err();
        assert!(missing.contains("a is missing"), "{missing}");
        let extra = check(&s, &json!({ "a": 1, "c": 2 }), &t).unwrap_err();
        assert!(extra.contains("$.c"), "{extra}");
        let wrong = check(&s, &json!({ "a": "1" }), &t).unwrap_err();
        assert!(wrong.starts_with("$.a"), "{wrong}");
        // Open, and with a schema for what it doesn't name.
        assert!(check(&open(json!({}), &[]), &json!({ "c": 2 }), &t).is_ok());
        let map = json!({ "type": "object", "additionalProperties": { "type": "string" } });
        assert!(check(&map, &json!({ "q": "x" }), &t).is_ok());
        assert!(check(&map, &json!({ "q": 1 }), &t).is_err());
    }

    #[test]
    fn each_item_of_a_list_is_checked() {
        let t = Map::new();
        let s = list(json!({ "type": "integer" }));
        assert!(check(&s, &json!([1, 2]), &t).is_ok());
        let e = check(&s, &json!([1, "2"]), &t).unwrap_err();
        assert!(e.starts_with("$[1]"), "{e}");
    }

    #[test]
    fn an_enum_takes_only_its_values() {
        let t = Map::new();
        assert!(check(&one_of(&["a", "b"]), &json!("a"), &t).is_ok());
        assert!(check(&one_of(&["a", "b"]), &json!("c"), &t).is_err());
        let nullable = json!({ "type": ["string", "null"], "enum": ["a", null] });
        assert!(check(&nullable, &json!(null), &t).is_ok());
        assert!(check(&nullable, &json!("later"), &t).is_err());
    }

    #[test]
    fn any_of_takes_one_branch_and_all_of_needs_every_one() {
        let t = Map::new();
        let either = json!({ "anyOf": [{ "type": "string" }, { "type": "integer" }] });
        assert!(check(&either, &json!(1), &t).is_ok());
        assert!(check(&either, &json!(true), &t).is_err());
        let both = json!({ "allOf": [open(json!({ "a": { "type": "integer" } }), &["a"]), open(json!({ "b": { "type": "string" } }), &["b"])] });
        assert!(check(&both, &json!({ "a": 1, "b": "x" }), &t).is_ok());
        assert!(check(&both, &json!({ "a": 1 }), &t).is_err());
    }

    #[test]
    fn a_ref_reads_the_named_type() {
        let t = types_with("Thing", obj(json!({ "n": { "type": "integer" } }), &["n"]));
        assert!(check(&r("Thing"), &json!({ "n": 1 }), &t).is_ok());
        assert!(check(&list(r("Thing")), &json!([{ "n": "1" }]), &t).is_err());
        assert!(check(&or_null(r("Thing")), &json!(null), &t).is_ok());
        let e = check(&r("Other"), &json!({}), &t).unwrap_err();
        assert!(e.contains("no type Other"), "{e}");
    }

    /// A tagged union's variants tell its values apart by the tag, as serde writes them.
    #[test]
    fn a_tagged_union_is_told_apart_by_its_tag() {
        let t = types();
        assert!(check(&r("ShareBlocked"), &json!({ "kind": "locked" }), &t).is_ok());
        assert!(check(&r("ShareBlocked"), &json!({ "kind": "no_gas", "have": 0.1, "need": 1.0, "message": "m" }), &t).is_ok());
        assert!(check(&r("ShareBlocked"), &json!({ "kind": "no_gas" }), &t).is_err());
        let route = json!({ "id": "r", "site": "a.example", "what": "w", "share": null, "passed": 0, "days": 0, "why": "not_run_yet" });
        assert!(check(&r("ShareRoute"), &route, &t).is_ok());
        let blocked = json!({ "id": "r", "site": "a.example", "what": "w", "share": true, "passed": 3, "days": 1, "why": "blocked", "reason": { "kind": "network_off" } });
        assert!(check(&r("ShareRoute"), &blocked, &t).is_ok());
        assert!(check(&r("ShareRoute"), &json!({ "id": "r", "why": "listed" }), &t).is_err());
    }

    /// Every type names itself, and every type a schema refers to is one of them.
    #[test]
    fn every_ref_names_a_type() {
        let t = types();
        let names: Vec<&String> = t.keys().collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "sorted by name");
        let mut used = std::collections::BTreeSet::new();
        for (name, schema) in &t {
            assert_eq!(schema["title"], json!(name));
            refs(schema, &mut used);
        }
        refs(&settings(true), &mut used);
        let missing: Vec<&String> = used.iter().filter(|n| !t.contains_key(*n)).collect();
        assert!(missing.is_empty(), "{missing:?}");
    }
}
