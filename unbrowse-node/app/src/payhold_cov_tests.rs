//! Coverage tests for `payhold.rs`: the owner-facing side of a checkout hold, kept in a scratch home.

use super::*;

fn told(site: &str) -> Vec<store::Activity> {
    store::read_activity(50).into_iter().filter(|a| a.site == site && a.kind == "vault").collect()
}

/// A hold a day old is said again in the activity log, once, and stays on.
#[test]
fn a_hold_a_day_old_is_said_again_in_the_owners_activity_once() {
    store::scratch_home("payhold-cov-remind");
    let old = store::now() - 3 * REMIND_EVERY;
    with(|h| h.begin("shop.example", &[], old)).unwrap();
    assert!(told("shop.example").is_empty(), "nothing said while the hold is young");
    assert!(held("shop.example").is_some_and(|why| why.contains("in the owner's hands")));
    let said = told("shop.example");
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!(said[0].result, "waiting");
    assert!(said[0].what.contains("still held for you") && said[0].who == "the node");
    assert!(held("shop.example").is_some());
    assert_eq!(told("shop.example").len(), 1, "once a day, not at every read");
    assert!(held("elsewhere.example").is_none());
}

/// The owner's "finished" lifts the hold and is logged as theirs; a site with no hold logs nothing.
#[test]
fn a_checkout_the_owner_says_is_finished_is_logged_as_theirs_and_lifts_the_hold() {
    store::scratch_home("payhold-cov-release");
    begin("shop.example", &["pay.example".to_string()]).unwrap();
    assert_eq!(of("pay.example").map(|h| h.site), Some("shop.example".to_string()));
    warn("shop.example", "the total changed");
    assert_eq!(of("shop.example").unwrap().warnings, ["the total changed"]);
    assert!(waiting().is_some_and(|w| w.contains("a card checkout on shop.example is waiting for the owner")));
    assert_eq!(release_by("nothing.example", "finished"), Ok(0));
    assert!(told("nothing.example").is_empty());
    assert_eq!(release_by("shop.example", "finished"), Ok(1));
    let said = told("shop.example");
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(said[0].what.contains("checkout was finished") && said[0].who == "you" && said[0].result == "done");
    assert!(held("shop.example").is_none() && held("pay.example").is_none() && waiting().is_none());
}

/// A record that can't be trusted holds every site and says so, until the owner dismisses them all.
#[test]
fn a_record_that_cannot_be_trusted_holds_every_site_until_all_are_dismissed() {
    store::scratch_home("payhold-cov-forged");
    begin("shop.example", &[]).unwrap();
    std::fs::write(file(), "[]").unwrap();
    restore();
    assert!(list().is_err());
    assert!(waiting().is_some_and(|w| w.contains("can't be trusted") && w.contains("changes nothing anywhere")));
    assert!(held("anything.example").is_some_and(|why| why.contains("every site is held")));
    assert!(release("shop.example").unwrap_err().contains("dismiss all of them"));
    assert_eq!(release("*"), Ok(1));
    assert!(list().unwrap().is_empty() && waiting().is_none());
}

#[test]
fn what_the_owner_is_shown_of_a_hold_names_its_hosts_and_the_rest() {
    let hold = |hosts: &[&str], more| Hold { site: "shop.example".into(), hosts: hosts.iter().map(|h| h.to_string()).collect(), since: 1, remind_at: 2, warnings: Vec::new(), more };
    assert_eq!(shown(&hold(&[], 0)), "shop.example");
    assert_eq!(shown(&hold(&["a.example", "b.example"], 0)), "shop.example and a.example, b.example");
    assert_eq!(shown(&hold(&[], 3)), "shop.example (3 more the checkout named aren't listed, and aren't held for reads)");
}
