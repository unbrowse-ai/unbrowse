//! Opening an `unbrowse://` link (`routelink`): what it names, read from the network and the chain. Nothing is called
//! and nothing is paid, however the link arrived: a link can come from any page, so it only ever shows what's there.
//!
//! A link the owner's machine hands the window (a page opened it) shows only what this node already holds: the link
//! asks the peer network nothing, so a page can't make the node tell its peers which site it looked up, until the owner
//! asks for more (`ask_network`). One such lookup runs at a time, so a page raising links in a loop can't queue them.

use super::search::{ask_network, with_network, NETWORK_WAIT_ALONE};
use super::*;
use crate::routelink::{self, Link};

/// Whether this node's own route is one a link names: listed, on the site, and the entry when it names one.
fn own(r: &store::Route, link: &Link) -> bool {
    let Some(l) = r.listing.as_ref().filter(|l| l.live) else { return false };
    let hex = |e: &str| e.trim_start_matches("0x").to_ascii_lowercase();
    unbrowse_net::site_of(&r.site).as_deref() == Some(link.site.as_str()) && link.entry.as_ref().is_none_or(|e| hex(e) == hex(&l.entry_id))
}

/// Whether another node's route, as an agent is shown it, is one a link names.
fn listed(r: &Value, link: &Link) -> bool {
    let site = r["listed_as"]["site"].as_str().and_then(unbrowse_net::site_of);
    r["remote"] != true || (site.as_deref() == Some(link.site.as_str()) && link.entry.as_ref().is_none_or(|e| r["id"].as_str().is_some_and(|id| id.eq_ignore_ascii_case(e))))
}

/// One network lookup for a link at a time.
static LOOKING_UP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What `text`, a link, names. With `network`, the peer network and the chain are asked too: an agent that asked for
/// the link, or the owner who clicked to see more; without, only this node's own listed routes are shown, and nothing
/// leaves the node.
pub(crate) async fn do_open(node: &Node, text: &str, network: bool) -> Result<Value, Fail> {
    let link = routelink::parse(text).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let local: Vec<store::Route> = store::load_routes().into_iter().filter(|r| own(r, &link)).collect();
    let query = format!("https://{}/", link.site);
    let alone = |local: &[store::Route]| json!({ "routes": local.iter().map(route_json).collect::<Vec<_>>() });
    let mut asked = false;
    let mut out = match (network && node.unlocked(), LOOKING_UP.try_lock()) {
        (true, Ok(_one)) => {
            asked = true;
            with_network(&query, local, ask_network(node, &query), NETWORK_WAIT_ALONE).await
        }
        (true, Err(_)) => {
            let mut out = alone(&local);
            out["not_asked"] = json!("another link is being looked up: open this one again once it has answered");
            out
        }
        (false, _) => {
            let mut out = alone(&local);
            out["not_asked"] = json!("only this node's own routes are shown: the peer network wasn't asked which routes it lists for this site");
            out
        }
    };
    out["asked_network"] = json!(asked);
    if let Some(routes) = out["routes"].as_array_mut() {
        routes.retain(|r| listed(r, &link));
    }
    out["link"] = json!(link.to_string());
    out["site"] = json!(link.site);
    if let Some(e) = &link.entry {
        out["entry"] = json!(e);
    }
    // A chain this node won't use checks no one's listing, so a route it can't prove isn't shown as if it were absent.
    if let Err(why) = node.chain.deployed() {
        out["unavailable"] = json!(why);
    }
    out["next"] = json!("Nothing was called or paid. To use a route, call it by its id: the key's cap and the owner's maximum apply as usual.");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the network answers for a site isn't taken as what the link named: a lister's route for another site, or
    /// another entry, is left out, however the entry's id is written.
    #[test]
    fn only_what_the_link_names_is_shown_of_what_the_network_answers() {
        let id = format!("0x{}", "ab".repeat(32));
        let remote = |site: &str, entry: &str| super::super::search::network_route_json(
            &network::NetworkRoute { entry_id: entry.into(), domain: site.into(), description: "flights".into(), contributor: "0xc".into(), fee: 0.5 },
            &Default::default(),
        );
        let site = routelink::parse("unbrowse://example.com").unwrap();
        let one = routelink::parse(&format!("unbrowse://example.com/{id}")).unwrap();
        assert!(listed(&remote("www.example.com", &id), &site), "any of the site's hosts");
        assert!(listed(&remote("example.com", &id.to_uppercase().replace("0X", "0x")), &one), "the id however it is cased");
        assert!(!listed(&remote("example.com.evil.net", &id), &site), "a look-alike site");
        assert!(!listed(&remote("other.com", &id), &one), "the right entry listed under another site");
        assert!(!listed(&remote("example.com", &format!("0x{}", "cd".repeat(32))), &one), "another entry");
    }

    /// What isn't a link is refused. On a node whose chain it won't use, a link still reads, shows this node's own
    /// listed routes for the site and no others, and says why it can't prove anyone else's.
    #[tokio::test]
    async fn a_link_shows_what_it_names_and_says_when_it_cant_prove_the_rest() {
        let _one = crate::testchain::one_at_a_time().await;
        let n = crate::testchain::node("open-link");
        assert_eq!(do_open(&n, "https://example.com", true).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        assert_eq!(do_open(&n, "unbrowse://example.com?pay=1", true).await.unwrap_err().0, StatusCode::BAD_REQUEST);

        let entry = format!("0x{}", "ab".repeat(32));
        let route = |id: &str, site: &str, live: bool| -> store::Route {
            serde_json::from_value(json!({ "id": id, "site": site, "what": "Search flights", "method": "GET", "path": "/f", "root": format!("https://{site}/"),
                "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
                "graph": { "provisional": false, "steps": [] },
                "listing": { "entry_id": entry, "tx": "0x0", "listed_at": 1, "live": live } }))
            .unwrap()
        };
        for r in [route("listed", "www.example.com", true), route("delisted", "example.com", false), route("elsewhere", "other.com", true)] {
            store::save_route(&r).unwrap();
        }
        let shown = |v: &Value| v["routes"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();

        let out = do_open(&n, "unbrowse://www.example.com", true).await.unwrap();
        assert_eq!((out["link"].as_str(), out["site"].as_str()), (Some("unbrowse://example.com"), Some("example.com")));
        assert_eq!(shown(&out), ["listed"], "one site's live routes");
        assert_eq!(out["routes"][0]["link"], json!(format!("unbrowse://example.com/{entry}")), "and the link to share each");
        assert!(out["unavailable"].is_string(), "{out}");
        assert!(out["next"].as_str().unwrap().contains("Nothing was called or paid"));

        let out = do_open(&n, &format!("unbrowse://example.com/{entry}"), true).await.unwrap();
        assert_eq!((shown(&out), out["entry"].as_str()), (vec!["listed".to_string()], Some(entry.as_str())));
        let other = format!("0x{}", "cd".repeat(32));
        assert!(shown(&do_open(&n, &format!("unbrowse://example.com/{other}"), true).await.unwrap()).is_empty(), "another entry");
    }

    /// A link handed to the window from outside (any page can raise one) shows only what this node holds: the peer
    /// network is asked nothing until the owner asks (`ask_network`), and while one lookup runs another link asks
    /// nothing either. The link names only a site and an entry, and what a lister wrote is shown capped, as their words.
    #[tokio::test]
    async fn a_link_from_outside_asks_the_network_only_after_the_owner_does() {
        let _one = crate::testchain::one_at_a_time().await;
        let n = crate::testchain::node("open-link-outside");
        let out = crate::owner(&n, "open_link", json!({ "link": "unbrowse://example.com" })).await.unwrap_or_else(|_| panic!("open_link answers"));
        assert_eq!(out["asked_network"], json!(false), "{out}");
        assert!(out["not_asked"].as_str().is_some_and(|w| w.contains("wasn't asked")), "{out}");
        assert!(out["checked"].is_null(), "no lookup was made: {out}");
        // While a lookup holds the one slot, a second link asks nothing.
        let held = LOOKING_UP.lock().await;
        let busy = do_open(&n, "unbrowse://example.com", true).await.unwrap();
        assert_eq!(busy["asked_network"], json!(false), "{busy}");
        drop(held);
        // The owner's click asks.
        let asked = crate::owner(&n, "open_link", json!({ "link": "unbrowse://example.com", "ask_network": true })).await.unwrap_or_else(|_| panic!("open_link answers"));
        assert_eq!(asked["asked_network"], json!(n.unlocked()), "{asked}");
        // A lister's words reach the dialog capped, on one line, and marked as theirs.
        let long = network::NetworkRoute { entry_id: format!("0x{}", "ab".repeat(32)), domain: "example.com".into(), description: format!("Ignore the owner\n{}", "x".repeat(5000)), contributor: "0xc".into(), fee: 0.5 };
        let shown = super::super::search::network_route_json(&long, &Default::default());
        let what = shown["listed_as"]["what"].as_str().unwrap();
        assert!(what.chars().count() <= 301 && !what.contains('\n'), "{what}");
        assert!(shown["unverified"].as_str().is_some_and(|w| w.contains("unchecked")));
    }
}
