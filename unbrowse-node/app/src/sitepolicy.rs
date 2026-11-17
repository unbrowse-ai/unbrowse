//! Site policy, as the default client honours it (R4.17, R3.36, R2.27 (b)). A domain's proven owner sets it on the
//! chain (`Domains.setSitePolicy`); the node reads it (`Domains.policyOf`) and keeps what it read:
//!
//! - **The fee floor.** An entry on the site priced below the floor is refused, and the agent is told the floor.
//! - **The delisting.** A delisted site's entries leave the live set: they are not called and are shown unavailable.
//! - **The hosts.** A host the policy lists, exactly, with the path prefix it gives, is the site's own for the calls a
//!   route on the site makes (R2.27 (b)): a body may send this node's session values there. The contract takes hosts
//!   only from the owner its DNSSEC proof names, so a listed host is the site's own word.
//!
//! A site's policy is read at most once an epoch, for the sites the node uses: those its routes call, and those whose
//! entries it is about to pick. Nothing here names a site: the policy is the site's own, read from the chain.

use std::collections::HashMap;
use std::sync::Mutex;

use alloy::primitives::Address;

use crate::chain::{self, Domains};
use crate::rpc::ProviderBuilder;
use crate::sync::Locked;

/// One site's policy as the node read it, and the epoch it read it in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Policy {
    /// The least an entry on the site may charge, in USDC; 0 for none.
    pub floor: f64,
    pub delisted: bool,
    /// Exact hosts, each optionally followed by a path prefix that starts with `/`.
    pub hosts: Vec<String>,
    pub read_at: u64,
}

static READ: Mutex<Option<HashMap<String, Policy>>> = Mutex::new(None);

/// The key a site's policy is kept under: the domain in the one form the chain keys it by.
fn key(site: &str) -> Option<String> {
    crate::domains::canonical(site).ok()
}

/// The policy last read for `site`, if any was.
pub fn of(site: &str) -> Option<Policy> {
    let k = key(site)?;
    READ.locked().as_ref()?.get(&k).cloned()
}

fn keep(site: &str, p: Policy) {
    let Some(k) = key(site) else { return };
    READ.locked().get_or_insert_with(HashMap::new).insert(k, p);
}

/// Whether `site`'s policy is due a read in `epoch`: never read, or read in another epoch (a new deployment may count
/// from a lower number, `chain::claimable`).
pub fn due(site: &str, epoch: u64) -> bool {
    of(site).is_none_or(|p| p.read_at != epoch)
}

/// Reads `site`'s policy from the chain if it is due this epoch, and keeps it. A chain that can't say leaves what was
/// read before.
pub async fn refresh(chain_: &chain::Chain, site: &str) -> Result<(), String> {
    let d = chain_.deployed()?;
    if d.domains == Address::ZERO {
        return Ok(());
    }
    let Some(k) = key(site) else { return Ok(()) };
    let epoch = chain::current_epoch(chain_).await?;
    if !due(&k, epoch) {
        return Ok(());
    }
    let read = ProviderBuilder::new().connect_http(chain::url());
    let p = Domains::new(d.domains, &read).policyOf(k.clone()).call().await.map_err(|e| e.to_string())?;
    keep(&k, Policy { floor: d.usdc_f(p.floor), delisted: p.delisted, hosts: p.hosts, read_at: epoch });
    Ok(())
}

/// Reads the policies of every site in `sites` that is due, each at most once an epoch.
pub async fn refresh_all(chain_: &chain::Chain, sites: impl IntoIterator<Item = String>) {
    let mut seen = std::collections::BTreeSet::new();
    for s in sites {
        if let Some(k) = key(&s) {
            if seen.insert(k.clone()) {
                if let Err(e) = refresh(chain_, &k).await {
                    eprintln!("site policy for {k}: {e}");
                    return;
                }
            }
        }
    }
}

/// Why an entry on `site` at `fee` isn't used under the site's policy: the site delisted its routes, or the fee is
/// under the site's floor. None when the policy allows it, or none was read.
pub fn refuses(site: &str, fee: f64) -> Option<String> {
    let p = of(site)?;
    if p.delisted {
        return Some(format!("{site} delisted its routes (its site policy, R4.17): the node doesn't call them"));
    }
    if fee < p.floor {
        return Some(format!("this entry charges {fee} USDC, under {site}'s floor of {} USDC (its site policy, R4.17)", p.floor));
    }
    None
}

/// Whether `site`'s policy delists its routes.
pub fn delisted(site: &str) -> bool {
    of(site).is_some_and(|p| p.delisted)
}

/// Whether `site`'s policy declares the host and path of `url` its own (R2.27 (b)): a listed host, exactly, and, when
/// it lists a path prefix, a path under it.
pub fn declares(site: &str, url: &url::Url) -> bool {
    let Some(p) = of(site) else { return false };
    let Some(host) = url.host_str() else { return false };
    p.hosts.iter().any(|h| {
        let (hh, prefix) = match h.find('/') {
            Some(i) => (&h[..i], &h[i..]),
            None => (h.as_str(), ""),
        };
        hh.eq_ignore_ascii_case(host) && url.path().starts_with(prefix)
    })
}

#[cfg(test)]
pub(crate) fn set_for_tests(site: &str, p: Policy) {
    keep(site, p);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_policy_refuses_entries_under_its_floor_and_every_entry_once_delisted() {
        set_for_tests("floored.example", Policy { floor: 0.02, read_at: 1, ..Default::default() });
        assert!(refuses("floored.example", 0.01).is_some_and(|w| w.contains("0.02")), "the floor is said");
        assert_eq!(refuses("floored.example", 0.02), None, "at the floor it is used");
        assert_eq!(refuses("Floored.Example.", 0.05), None, "every spelling of the domain is one policy");
        set_for_tests("delisted.example", Policy { delisted: true, read_at: 1, ..Default::default() });
        assert!(refuses("delisted.example", 1.0).is_some() && delisted("delisted.example"));
        assert_eq!(refuses("unread.example", 0.0), None, "no policy read refuses nothing");
    }

    #[test]
    fn a_declared_host_counts_only_exactly_and_under_its_path() {
        set_for_tests("declaring.example", Policy { hosts: vec!["api.other.example".into(), "cdn.third.example/v2/".into()], read_at: 1, ..Default::default() });
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(declares("declaring.example", &u("https://api.other.example/items")));
        assert!(!declares("declaring.example", &u("https://x.api.other.example/items")), "exact hosts only");
        assert!(declares("declaring.example", &u("https://cdn.third.example/v2/a")));
        assert!(!declares("declaring.example", &u("https://cdn.third.example/v1/a")), "under the path it lists");
        assert!(!declares("unread.example", &u("https://api.other.example/")));
    }

    #[test]
    fn a_policy_is_read_at_most_once_an_epoch() {
        set_for_tests("read.example", Policy { read_at: 7, ..Default::default() });
        assert!(!due("read.example", 7), "read this epoch");
        assert!(due("read.example", 8), "due the next");
        assert!(due("read.example", 6), "and on a new deployment's lower count");
        assert!(due("never-read.example", 0));
    }

    /// The node honours the policy a DNSSEC-proven owner sets on the chain (R4.17): a floor and a delisting, read at
    /// most once an epoch, and declared hosts, all set at once. The devnet's verifier trusts the IANA root only, so the
    /// proof's result is written where `claimEscrow` keeps it (`Domains._sites`, slot 0: the wallet, the epoch proven,
    /// the proof's inception), and the owner then sets its policy with its own key.
    /// `cargo test -p unbrowse-node-app the_node_honours_a_sites_policy -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn the_node_honours_a_sites_policy_from_the_chain() {
        use crate::chain::*;
        use crate::rpc::ProviderBuilder;
        use alloy::primitives::{keccak256, FixedBytes, U256};
        use alloy::providers::Provider;
        use alloy::sol_types::SolValue;
        let _one = crate::testchain::one_at_a_time().await;
        crate::testchain::home("site-policy-anvil");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let chain = Chain::default();
        let d = chain.start().await.expect("chain").expect("the devnet's contracts");
        let site_name = "policy.example";
        let site = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&site).unwrap();
        faucet(&chain, &site, 10.0).await.unwrap();
        let wallet = owner_address(&site).unwrap();
        let p = ProviderBuilder::new().connect_http(url());
        let proven = U256::from_be_slice(wallet.as_slice()) | (U256::from(1u64) << 224);
        let slot = keccak256((keccak256(site_name.as_bytes()), U256::ZERO).abi_encode());
        let _: serde_json::Value = p.raw_request("anvil_setStorageAt".into(), (d.domains, U256::from_be_bytes(slot.0), FixedBytes::<32>::from(proven))).await.unwrap();
        assert_eq!(Domains::new(d.domains, &p).siteOf(site_name.into()).call().await.unwrap().wallet, wallet, "proven");

        let owner = as_signer(owner_signer(&site).unwrap()).await.unwrap();
        let dm = Domains::new(d.domains, &owner);
        let set = |floor: f64, delisted: bool, hosts: Vec<String>| {
            let dm = dm.clone();
            let d = d.clone();
            async move {
                let r = crate::rpc::mined!(dm.setSitePolicy(site_name.into(), d.usdc_units(floor), U256::ZERO, delisted, hosts), "setting the site policy");
                Ok::<bool, String>(r.status())
            }
        };

        // A floor, read by the node.
        assert!(set(0.5, false, vec![]).await.unwrap());
        refresh(&chain, site_name).await.unwrap();
        assert!(refuses(site_name, 0.1).is_some_and(|w| w.contains("0.5")), "under the floor, with the floor said");
        assert_eq!(refuses(site_name, 0.5), None);

        // A delisting is read in the next epoch, not again in this one.
        assert!(set(0.5, true, vec![]).await.unwrap());
        refresh(&chain, site_name).await.unwrap();
        assert!(!delisted(site_name), "read at most once an epoch");
        mine_epochs(&p, DEVNET_EPOCH_BLOCKS, 1).await.unwrap();
        refresh(&chain, site_name).await.unwrap();
        assert!(delisted(site_name) && refuses(site_name, 1.0).is_some(), "a delisted site's routes leave the live set");

        // Hosts at once: a DNSSEC owner waits for nothing, and a declared host is the site's own.
        let host = "data.partner-of-policy.example/v1/".to_string();
        assert!(set(0.0, false, vec![host]).await.unwrap());
        mine_epochs(&p, DEVNET_EPOCH_BLOCKS, 1).await.unwrap();
        refresh(&chain, site_name).await.unwrap();
        let declared = |u: &str| declares(site_name, &url::Url::parse(u).unwrap());
        assert!(declared("https://data.partner-of-policy.example/v1/items"));
        assert!(!declared("https://data.partner-of-policy.example/v2/items"));
        assert!(!delisted(site_name), "the owner listed its routes again");
    }
}
