//! Domain proofs as the node reads them (R4.14). A domain is proven by DNSSEC only: a TXT record `wallet=0x…` at
//! `_unbrowse.<domain>` in a signed zone, submitted to `Domains.claimEscrow` by anyone with its chain. A domain without
//! DNSSEC can't be proven, and its site share waits in escrow until it has DNSSEC and a proof is submitted.
//! `unbrowse-node domain status <domain>` shows where a domain stands.

use std::sync::Arc;

use alloy::primitives::keccak256;
use serde::{Deserialize, Serialize};

use crate::chain::{self, Domains, LeanSettlement};
use crate::rpc::ProviderBuilder;
use crate::Node;

/// What a domain without a proof is told: the one way to prove it, and what happens to its share meanwhile.
pub const UNPROVEN: &str = "not proven: a domain is proven only by DNSSEC, a TXT record wallet=0x… at _unbrowse.<domain> in a signed zone, submitted with Domains.claimEscrow. A domain without DNSSEC can't be proven; its site share waits in escrow until it has DNSSEC and a proof is submitted.";

/// A domain in the one form the chain keys it by (`FixedDNSSEC.canonicalDomain`): ASCII lowercase, no trailing dot,
/// labels of letters, digits, `-` and `_`.
pub fn canonical(domain: &str) -> Result<String, String> {
    let d = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let ok = !d.is_empty()
        && d.len() <= 253
        && d.split('.').all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    if ok { Ok(d) } else { Err(format!("{domain} isn't a domain name in ASCII (an internationalised name goes in its punycode form)")) }
}

/// What `domain status` answers: the domain's proven wallet, when its escrow is released to it, and the escrow.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DomainStatus {
    pub domain: String,
    /// The wallet its DNSSEC proof names; `None` when it has none.
    pub wallet: Option<String>,
    /// The epoch its escrow is released from (R4.14, `escrow.wait` after the proof).
    pub release_at: Option<u64>,
    pub escrow_usdc: f64,
    /// For a domain with no proof, how one is made (`UNPROVEN`).
    pub note: Option<String>,
}

pub async fn status(node: &Arc<Node>, domain: String) -> Result<DomainStatus, String> {
    let d = node.chain.deployed()?;
    let domain = canonical(&domain)?;
    let read = ProviderBuilder::new().connect_http(chain::url());
    let e = |e: alloy::contract::Error| e.to_string();
    let site = Domains::new(d.domains, &read).siteOf(domain.clone()).call().await.map_err(e)?;
    let escrow = LeanSettlement::new(d.settlement, &read).escrow(keccak256(domain.as_bytes())).call().await.map_err(e)?;
    Ok(status_of(domain, (!site.wallet.is_zero()).then_some((site.wallet, site.releaseAt)), d.usdc_f(escrow)))
}

/// The answer, from what the chain read: `proven` the wallet and release epoch, `None` for no proof.
fn status_of(domain: String, proven: Option<(alloy::primitives::Address, u64)>, escrow_usdc: f64) -> DomainStatus {
    DomainStatus {
        domain,
        wallet: proven.map(|(w, _)| format!("{w:#x}")),
        release_at: proven.map(|(_, at)| at),
        escrow_usdc,
        note: proven.is_none().then(|| UNPROVEN.to_string()),
    }
}

// ---- `unbrowse-node domain` ----

pub fn cli(args: &[String]) -> i32 {
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["status", domain] => match crate::owner_call("domain_status", serde_json::json!({ "domain": domain })) {
            Ok(v) => {
                println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        _ => {
            eprintln!("usage: unbrowse-node domain status <domain>\n{UNPROVEN}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A domain with no proof is told, in the answer itself, that only DNSSEC proves one; a proven one isn't.
    #[test]
    fn an_unproven_domain_is_told_only_dnssec_proves_one() {
        let types = crate::apischema::types();
        let schema = crate::apischema::r("DomainStatus");
        let none = status_of("shop.example".into(), None, 3.0);
        crate::apischema::check(&schema, &serde_json::to_value(&none).unwrap(), &types).unwrap();
        assert!(none.wallet.is_none() && none.note.as_deref().is_some_and(|n| n.contains("only by DNSSEC") && n.contains("without DNSSEC can't be proven")));
        let w = alloy::primitives::Address::repeat_byte(0xaa);
        let proven = status_of("shop.example".into(), Some((w, 14)), 0.0);
        crate::apischema::check(&schema, &serde_json::to_value(&proven).unwrap(), &types).unwrap();
        assert_eq!((proven.wallet.as_deref(), proven.release_at, proven.note), (Some(format!("{w:#x}").as_str()), Some(14), None));
    }

    #[test]
    fn a_domain_has_one_canonical_form() {
        assert_eq!(canonical(" Shop.Example. ").unwrap(), "shop.example");
        assert!(canonical("shop..example").is_err());
        assert!(canonical("bücher.example").is_err());
    }
}
