//! One wallet, several nodes (spec §76.1 item 1.7, R1.20). Each node is linked to the owner's wallet (`link`), which is
//! optional: a node joins and pays on its own wallet with no link (§86). Its
//! agents pay from the node's own deposit until the owner's wallet grants their keys itself: then they pay from the
//! wallet's deposit, each key with its own cap, so every node of the wallet shares one deposit and a stolen node spends
//! at most its own key's cap.
//!
//! What Settlement already allows, and what it doesn't:
//! - **Agent keys per wallet.** `authorizeAgent(agent, cap, expiry)` keys a grant by `(msg.sender, agent)`, any number
//!   of them, each with its own cap, spend and revocation. So one wallet grants a key on each node, with no contract
//!   change. The grant is the payer's own: the node can't send it, so the wallet does (`grant`: the calls it sends).
//! - **The deposit.** A voucher names its payer, and Settlement and every server check the agent against that payer's
//!   grant and deposit. So a key the wallet granted pays from the wallet's deposit, which the owner funds and withdraws
//!   from the wallet itself.
//! - **The identity** (R1.12, R6.1, R7.22). Every node linked to the wallet lists, serves and earns under the wallet's
//!   one identity, so its entries, reputation, coins and payouts are the wallet's (`listing::lister`). A listing is
//!   still signed by the wallet's own key, never by a key the wallet granted (issue #184): a key the wallet granted pays
//!   and signs nothing else, so a stolen node key costs at most its cap and never the wallet's credit for an entry. A
//!   node that doesn't hold the wallet's key keeps each listing until the owner's wallet signs it (`to_sign`,
//!   `sign_listing`), as the wallet sends its own grants.
//! - **Checks** (`coin.check`). The wallet stakes route coins, and a line paid from its deposit is its check, whichever
//!   of its keys signed the voucher: Settlement's claim notes each line for its payer, the wallet
//!   (`CoinStakes.noteLine`), so the node sends nothing for it.
//!
//! Peers that don't run this lose nothing: an old node keeps paying from its own deposit, and an old server checks the
//! wallet's grant and deposit as it checks any payer's. *(contract for the grant and the deposit; client for which payer
//! a node names.)*

use alloy::primitives::Address;
use serde::Serialize;

use crate::{agents, chain, link, store, St};

/// A call the owner's wallet sends, as any wallet takes one: where to, and the calldata.
#[derive(Serialize)]
pub struct Call {
    pub to: String,
    pub data: String,
    /// What it does, said plainly.
    pub what: String,
}

/// `wallet_grant`: what the owner's wallet sends so this node's agents pay from its deposit.
#[derive(Serialize)]
pub struct Grant {
    pub wallet: String,
    pub settlement: String,
    /// The wallet's deposit, less any withdrawal it asked for: what the keys it grants pay from.
    pub deposit_usdc: f64,
    /// One `authorizeAgent` for each live key on this node the wallet hasn't granted at its cap and expiry. Empty when
    /// every key is granted.
    pub calls: Vec<Call>,
}

/// The owner's wallet linked to this node, once they confirmed it (`link::confirmed`): keys pay from it, so a link this
/// user's other programs could have written never counts.
fn wallet(node: St) -> Result<Address, String> {
    let l = link::signed_in(node).ok_or(NO_LINK)?;
    link::confirmed(node.key()?).ok_or_else(|| format!("the linked wallet {} isn't one you confirmed: `unbrowse-node nodes grant` shows it to you and asks", l.owner))
}

/// The keys naming a payer that isn't `wallet`, the one the owner has confirmed now, if any: a wallet unlinked or
/// never confirmed has no say over them, and a key left naming one fails every paid fetch once it stops granting.
fn named_elsewhere(all: &[agents::Agent], wallet: Option<Address>) -> Vec<agents::Agent> {
    all.iter().filter(|a| !a.revoked && a.pays_from().is_some() && a.pays_from() != wallet).cloned().collect()
}

/// Has key `a` pay from `want` from here, as `follow` does: a stream already begun in epoch `now` keeps its payer until
/// the next.
fn move_payer(a: &agents::Agent, want: Option<Address>, now: u64, note: impl FnOnce(u64) -> String) {
    let from = match chain::moving_payer(a.index, now, |from| agents::set_payer(a.index, from, want).map(|()| from)) {
        Ok(from) => from,
        Err(e) => {
            eprintln!("owner's nodes: {}: {e}", a.name);
            return;
        }
    };
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "This node".into(),
        site: String::new(),
        what: match want {
            Some(_) => format!("{} pays from your account's balance", a.name),
            None => format!("{} pays from this node's own balance", a.name),
        },
        kind: "key".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(note(from)),
    });
}

/// What `nodes` says on a node with no linked wallet: it isn't missing anything, since it pays from its own (§86).
pub const NO_LINK: &str = "no linked wallet: this node pays from its own wallet, and needs none. To have several of your nodes pay from one deposit, link your wallet to each (`unbrowse-node sign-in`)";

/// Whether `want` (cap, expiry) is granted by `have`: the same cap, and an expiry as late (0 is none), to within an
/// epoch: the chain keeps a grant's expiry in blocks (R1.28), and as a date it moves with the chain's pace, which must
/// not read as a grant running short and ask the owner to sign it again.
fn covers(have: Option<(f64, u64)>, cap: f64, expires: u64) -> bool {
    have.is_some_and(|(c, e)| (c - cap).abs() < 1e-9 && (e == 0 || e.saturating_add(chain::EPOCH) >= expires))
}

/// The calls the owner's wallet sends to grant this node's live keys against its own deposit, at the cap and expiry
/// each has here. The node can't send them: a grant is its payer's own.
pub async fn grant(node: St<'_>) -> Result<Grant, String> {
    // The owner is at the node here: a link they never confirmed is shown to them now, and only a yes goes on.
    link::payout(node).await?;
    let w = wallet(node)?;
    // A grant the wallet has sent since the last pass is taken now, not at the next hourly one.
    follow(node).await;
    let d = node.chain.deployed()?;
    let mut calls = Vec::new();
    for a in agents::list().into_iter().filter(|a| !a.revoked && a.expires > store::now()) {
        let agent: Address = a.address.parse().map_err(|_| format!("{}'s address doesn't read", a.name))?;
        if covers(chain::grant_of(&node.chain, w, agent).await?, a.cap_usdc, a.expires) {
            continue;
        }
        let (to, data) = chain::authorize_call(&node.chain, agent, a.cap_usdc, a.expires).await?;
        calls.push(Call { to: format!("{to:#x}"), data: format!("{data}"), what: format!("Lets {} on this node pay up to {} USDC an epoch from your wallet's deposit, and nothing else: it signs no listing", a.name, a.cap_usdc) });
    }
    let deposit_usdc = chain::spendable_usdc(&node.chain, w).await?;
    Ok(Grant { wallet: w.to_checksum(None), settlement: format!("{:#x}", d.settlement), deposit_usdc, calls })
}

/// `listings_to_sign`: the listings this node keeps for the owner's wallet to sign, each in plain words and as the
/// typed data the wallet signs. Empty when the node lists under no wallet but its own.
pub async fn to_sign(node: St<'_>) -> Result<Vec<crate::listing::ToSign>, String> {
    crate::listing::to_sign(&node.chain, node.key()?).await
}

/// `listing_sign`: the owner's wallet's signature of the listing waiting under `id`. Only the wallet's own key signs
/// it; an agent key's signature, or anyone else's, is refused (`listing::owner_signed`). Once signed it is put under a
/// root and spread as any listing of this node's is.
pub async fn sign_listing(node: St<'_>, id: &str, signature: &str) -> Result<serde_json::Value, String> {
    let proven = crate::listing::sign_waiting(&node.chain, node.key()?, id, signature).await?;
    let spread = proven.is_some();
    if let Some(p) = proven {
        crate::peers::provide(node, &p.listing.site).await;
        crate::share::provide(node, &p.listing.content_id, true).await;
    }
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "You".into(),
        site: String::new(),
        what: "Signed a listing with your wallet".into(),
        kind: "key".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(if spread { "It is listed under your account now.".into() } else { "It is listed under your account once its root is posted.".into() }),
    });
    node.events.emit("activity", ());
    Ok(serde_json::json!({ "id": id, "spread": spread }))
}

/// How long before a wallet's grant runs out the app asks the owner to renew it (§76.2 item 3): the week the node
/// renews its own key in.
pub const RENEW_BEFORE_SECS: u64 = agents::RENEW_BEFORE_SECS;

/// The grants the sign-in page sends from the owner's wallet for this node's live keys, at each key's cap and expiry
/// (never without one). Without `wallet` (a first sign-in, the wallet not known yet), every live key; with it, only
/// those the wallet doesn't grant at that cap and expiry. Empty off a deployment.
pub async fn page_grants(node: St<'_>, wallet: Option<Address>) -> Vec<link::PageGrant> {
    let Ok(d) = node.chain.deployed() else { return vec![] };
    let mut out = Vec::new();
    for a in agents::list().into_iter().filter(|a| !a.revoked && a.expires > store::now()) {
        let Ok(agent) = a.address.parse::<Address>() else { continue };
        if let Some(w) = wallet {
            if chain::grant_of(&node.chain, w, agent).await.is_ok_and(|g| covers(g, a.cap_usdc, a.expires)) {
                continue;
            }
        }
        // The page sends the grant as it stands here: the expiry goes as the chain keeps it, a block.
        let Ok(expiry) = chain::expiry_block(&node.chain, a.expires).await else { continue };
        out.push(link::PageGrant { chain_id: d.chain_id, settlement: format!("{:#x}", d.settlement), agent: agent.to_checksum(None), cap_units: d.usdc_units(a.cap_usdc).to_string(), expiry });
    }
    out
}

/// The soonest a wallet grant to one of this node's live keys runs out, when that is within `RENEW_BEFORE_SECS`.
async fn renew_due(node: St<'_>, w: Address) -> Option<u64> {
    let now = store::now();
    let mut soonest = None;
    for a in agents::list().into_iter().filter(|a| !a.revoked && a.expires > now) {
        let Ok(agent) = a.address.parse::<Address>() else { continue };
        if let Ok(Some((_, e))) = chain::grant_of(&node.chain, w, agent).await {
            if e != 0 && e < now + RENEW_BEFORE_SECS {
                soonest = Some(soonest.map_or(e, |s: u64| s.min(e)));
            }
        }
    }
    soonest
}

/// Whether a key pays from the owner's wallet's deposit rather than the node's own: only while the wallet grants it
/// and that deposit can cover a call (`free`, what the wallet's deposit holds, at least `need`, the most one fetch
/// costs). A key never pays from a deposit that can't cover it: a grant from a wallet with nothing deposited leaves the
/// key on the node's own deposit, which the node keeps filled (`top_up`), and it moves to the wallet's once the wallet
/// deposits.
pub fn pays_from_wallet(granted: bool, free: f64, need: f64) -> bool {
    granted && free + 1e-9 >= need
}

/// Which payer each live key names from here, by the chain: the owner's wallet while it grants the key (live, not
/// revoked, not expired) and its deposit can cover a call (`pays_from_wallet`), else the node's own. A switch takes
/// effect from the next voucher epoch when the key already has lines in this one, so a stream keeps the payer it began
/// under. Run each background pass, with the keys' upkeep (`agents::keep_granted`), and whenever the owner looks
/// (`grant`, `list`), so a grant the wallet just sent is taken at once.
pub async fn follow(node: St<'_>) {
    let Ok(now) = chain::current_epoch(&node.chain).await else { return };
    let Ok(w) = wallet(node) else {
        // Unlinked, or never confirmed: nothing the wallet does reaches this node any more, so its keys go back to the
        // node's own deposit now, not when a pass that has a wallet comes.
        for a in named_elsewhere(&agents::list(), None) {
            move_payer(&a, None, now, |from| format!("No wallet you confirmed is linked to this node; from epoch {from}"));
        }
        return;
    };
    // A deposit that couldn't be read leaves every key's payer as it is, until a pass that can read it.
    let Ok(free) = chain::spendable_usdc(&node.chain, w).await else { return };
    let need = store::load_settings().max_fetch();
    // Asked once for each grant that is about to run out: renew it in one step (§76.2 item 3).
    if let Some(e) = renew_due(node, w).await {
        let told = store::home().join("renew-told.json");
        if store::read_json::<u64>(&told, &unbrowse_files::RENEW_TOLD) != e {
            let _ = store::write_json(&told, &unbrowse_files::RENEW_TOLD, &e);
            store::log_activity(&store::Activity {
                at: store::now(),
                who: "This node".into(),
                site: String::new(),
                what: "Renew your wallet's grant to this node's agents".into(),
                kind: "key".into(),
                result: "asked".into(),
                ms: None,
                unb: None,
                tx: None,
                note: Some(format!("It runs out at {e} (unix time); until it is renewed the agents pay from this node's own deposit after that. Renew in one step: the window's Renew, or `unbrowse-node nodes renew`.")),
            });
            node.events.emit("activity", ());
        }
    }
    for a in agents::list().into_iter().filter(|a| !a.revoked) {
        let Ok(agent) = a.address.parse::<Address>() else { continue };
        let Ok(g) = chain::grant_of(&node.chain, w, agent).await else { continue };
        let live = g.is_some_and(|(_, e)| e == 0 || e > store::now());
        let want = pays_from_wallet(live, free, need).then_some(w);
        if a.pays_from() == want {
            continue;
        }
        move_payer(&a, want, now, |from| match want {
            Some(w) => format!("Your account {w:#x} allowed this agent to spend from its deposit; from epoch {from}"),
            None if live => format!("Your account {w:#x} allows this agent, but its deposit of {free} USDC can't cover a call of up to {need} USDC, so the agent pays from this node's own deposit; from epoch {from}"),
            None => format!("Your account's grant of this agent ended; from epoch {from}"),
        });
    }
}

/// One key the owner's wallet granted, on this node or another.
#[derive(Serialize)]
pub struct WalletKey {
    pub agent: String,
    pub cap_usdc: f64,
    pub expiry: u64,
    pub revoked: bool,
    /// What it has paid this epoch.
    pub spent_usdc: f64,
    /// It is a key of this node's, and its name here.
    pub this_node: bool,
    pub name: Option<String>,
}

/// `owner_nodes`: the owner's wallet, its deposit, and every key it granted, on this node and its others: each node's
/// keys spend from the one deposit, each up to its own cap.
#[derive(Serialize)]
pub struct OwnerNodes {
    pub wallet: String,
    pub deposit_usdc: f64,
    pub keys: Vec<WalletKey>,
    /// When the soonest of the wallet's grants to this node's keys runs out, once that is within a week: the owner
    /// renews it in one step (`wallet_renew`). None while nothing is due.
    pub renew_by: Option<u64>,
}

pub async fn list(node: St<'_>) -> Result<OwnerNodes, String> {
    let w = wallet(node)?;
    follow(node).await;
    let mine = agents::list();
    let mut keys = Vec::new();
    for agent in chain::granted_by(&node.chain, w).await? {
        let Some((cap, expiry, revoked, spent)) = chain::agent_terms(&node.chain, w, agent).await? else { continue };
        let here = mine.iter().find(|a| a.address.parse::<Address>().ok() == Some(agent));
        keys.push(WalletKey {
            agent: agent.to_checksum(None),
            cap_usdc: cap,
            expiry,
            revoked,
            spent_usdc: spent,
            this_node: here.is_some(),
            name: here.map(|a| a.name.clone()),
        });
    }
    Ok(OwnerNodes { wallet: w.to_checksum(None), deposit_usdc: chain::spendable_usdc(&node.chain, w).await?, keys, renew_by: renew_due(node, w).await })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A node with no linked wallet isn't told to sign in: it pays from its own wallet, and only sharing one deposit
    /// across several nodes needs a link (§86).
    #[tokio::test]
    async fn a_node_with_no_linked_wallet_is_told_it_pays_from_its_own() {
        let _one = crate::testchain::one_at_a_time().await;
        let _home = crate::testchain::home("owner-nodes-no-link");
        let node = crate::testchain::node("no-link");
        let e = grant(&node).await.err().unwrap();
        assert_eq!(e, NO_LINK);
        let e = link::renew(&node).await.err().unwrap();
        assert!(e.contains("pays from its own wallet") && !e.contains("sign in first"), "{e}");
    }

    /// A key that names a wallet no longer confirmed goes back to the node's own: unlinking stops the schedule the
    /// wallet set, rather than freezing it at its last entry.
    #[test]
    fn a_key_naming_a_wallet_the_owner_did_not_confirm_is_named_for_moving() {
        let (w, other): (Address, Address) = ("0x00000000000000000000000000000000000000a1".parse().unwrap(), "0x00000000000000000000000000000000000000b2".parse().unwrap());
        let key = |index: u32, payer: Option<Address>, revoked: bool| agents::Agent {
            index,
            name: "a".into(),
            address: String::new(),
            cap_usdc: 1.0,
            expires: 1,
            created: 1,
            revoked,
            tx: None,
            salt: None,
            auto: false,
            cap_set: false,
            payers: vec![(1, payer.map(|p| p.to_checksum(None)))],
            gateway: None,
        };
        let all = [key(0, Some(w), false), key(1, None, false), key(2, Some(w), true), key(3, Some(other), false)];
        let named = |wallet| named_elsewhere(&all, wallet).iter().map(|a| a.index).collect::<Vec<_>>();
        assert_eq!(named(None), [0, 3], "no wallet confirmed: every live key naming one");
        assert_eq!(named(Some(w)), [3], "the confirmed wallet keeps its keys");
    }

    /// A grant covers what the node asks only at the same cap and an expiry as late or later, to within an epoch.
    #[test]
    fn a_grant_covers_the_cap_and_expiry_the_node_asks() {
        assert!(!covers(None, 5.0, 100));
        assert!(covers(Some((5.0, 100)), 5.0, 100));
        assert!(covers(Some((5.0, 0)), 5.0, 100), "no expiry");
        let (want, day) = (100 * chain::EPOCH, chain::EPOCH);
        assert!(covers(Some((5.0, want - 60)), 5.0, want), "a date a minute out: the chain's pace, not a shorter grant");
        assert!(!covers(Some((5.0, want - day - 1)), 5.0, want), "an earlier expiry");
        assert!(!covers(Some((20.0, 100)), 5.0, 100), "another cap");
    }

    /// A key pays from the wallet's deposit only while the wallet grants it and the deposit can cover a call at the
    /// owner's per-fetch maximum; otherwise it pays from the node's own.
    #[test]
    fn a_key_pays_from_a_deposit_that_can_cover_it() {
        assert!(pays_from_wallet(true, 10.0, 0.05), "granted, and the deposit covers a call");
        assert!(pays_from_wallet(true, 0.05, 0.05), "exactly one call's worth");
        assert!(!pays_from_wallet(true, 0.0, 0.05), "granted from an empty deposit: the node's own");
        assert!(!pays_from_wallet(true, 0.04, 0.05), "less than one call");
        assert!(!pays_from_wallet(false, 10.0, 0.05), "not granted");
    }

    /// A key pays from the wallet from the epoch it switched in, and a stream already begun keeps the payer it began
    /// under: its earlier epochs still name the node's own wallet.
    #[test]
    fn a_key_names_its_payer_by_epoch() {
        let _home = store::scratch_home("owner-nodes-payer");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let a = agents::ensure_first(&keys, 7788).unwrap().unwrap();
        let w: Address = "0x00000000000000000000000000000000000000a1".parse().unwrap();
        assert_eq!(agents::payer_at(a.index, 10), None, "the node's own until the wallet grants it");
        agents::set_payer(a.index, 11, Some(w)).unwrap();
        assert_eq!((agents::payer_at(a.index, 10), agents::payer_at(a.index, 11), agents::payer_at(a.index, 50)), (None, Some(w), Some(w)));
        agents::set_payer(a.index, 20, None).unwrap();
        assert_eq!((agents::payer_at(a.index, 19), agents::payer_at(a.index, 20)), (Some(w), None));
        let root = chain::owner_address(&keys).unwrap();
        assert_eq!(chain::payer_of(&keys, a.index, 15).unwrap(), w);
        assert_eq!(chain::payer_of(&keys, a.index, 25).unwrap(), root);
    }

    /// A program running as this user writes a link file naming its own wallet, signed by that wallet, and grants the
    /// node's key from a funded deposit: nothing the owner confirmed, so the key doesn't move, and naming the wallet in
    /// `agents.json` too moves no earnings to it. A wallet the owner did confirm takes the key, and unlinking it brings the
    /// key back, where it used to stay naming a wallet the node no longer follows.
    /// `cargo test -p unbrowse-node-app owner_nodes -- --ignored`
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn only_a_wallet_the_owner_confirmed_takes_a_key_or_its_earnings() {
        use alloy::providers::Provider;
        use alloy::signers::SignerSync;
        use crate::testchain;
        let _one = testchain::one_at_a_time().await;
        let _home = testchain::home("owner-nodes-forged");
        let _env = testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let attacker = alloy::signers::local::PrivateKeySigner::random();
        let attacker_keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::KeyStore::set(&attacker_keys, &attacker.credential().to_bytes()).unwrap();
        let n = testchain::node("forged");
        let me = crate::identity(&n).unwrap().address;
        link::set_node(&me);
        n.chain.start().await.expect("the devnet");
        chain::faucet(&n.chain, &attacker_keys, 20.0).await.unwrap();
        chain::deposit(&n.chain, &attacker_keys, 10.0).await.unwrap();
        let key = agents::ensure_first(n.keys.as_ref(), 0).unwrap().unwrap();
        let (to, data) = chain::authorize_call(&n.chain, key.address.parse().unwrap(), key.cap_usdc, key.expires).await.unwrap();
        let p = chain::as_signer(attacker.clone()).await.unwrap();
        let tx = alloy::rpc::types::TransactionRequest::default().to(to).input(data.into());
        assert!(p.send_transaction(tx).await.unwrap().get_receipt().await.unwrap().status(), "the wallet's grant");

        let owner = attacker.address().to_string();
        let signature = format!("0x{}", hex::encode(attacker.sign_message_sync(link::message(&me, &owner, "ab12").as_bytes()).unwrap().as_bytes()));
        let forged = link::Link { owner, nonce: "ab12".into(), signature, linked: 1, seal: None, vid: None };
        store::write_json(&store::home().join("owner.json"), &unbrowse_files::LINK, &forged).unwrap();
        assert!(link::signed_in(&n).is_some(), "the file checks as a link");
        let (now, own) = (chain::current_epoch(&n.chain).await.unwrap(), chain::owner_address(n.keys.as_ref()).unwrap());
        follow(&n).await;
        assert_eq!(chain::payer_of(n.keys.as_ref(), key.index, now).unwrap(), own, "the key stays on the node's own deposit");
        agents::set_payer(key.index, now, Some(attacker.address())).unwrap();
        assert_eq!(crate::listing::lister_wallet(&n.chain, n.keys.as_ref()).await.unwrap(), own, "and nothing lists under that wallet");
        follow(&n).await;
        assert_eq!(chain::payer_of(n.keys.as_ref(), key.index, now).unwrap(), own, "a key made to name it goes back");

        // The owner confirms that wallet after all, and later unlinks it.
        testchain::sign_in_as(&n, &attacker);
        follow(&n).await;
        assert_eq!(chain::payer_of(n.keys.as_ref(), key.index, now).unwrap(), attacker.address(), "a confirmed wallet takes the key");
        link::forget().unwrap();
        follow(&n).await;
        assert_eq!(chain::payer_of(n.keys.as_ref(), key.index, now).unwrap(), own, "unlinking brings it back");
    }

    /// A node under the owner's wallet lists under the wallet's identity and never signs a listing itself: the listing
    /// waits, under no root, until the wallet signs it. Its agent key, granted by the wallet and paying from its
    /// deposit, can't sign it; the wallet's own signature puts it under a root, and a reader credits it to the wallet
    /// (R1.12, issue #184). A devnet with no registry, so the identity is the wallet's address.
    /// `cargo test -p unbrowse-node-app owner_nodes -- --ignored`
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn a_node_without_the_wallets_key_waits_for_the_owner_to_sign_each_listing() {
        use alloy::providers::Provider;
        use crate::testchain;
        let _one = testchain::one_at_a_time().await;
        let _home = testchain::home("owner-nodes-lists-as-itself");
        let _env = testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let owner = alloy::signers::local::PrivateKeySigner::random();
        let wallet_keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::KeyStore::set(&wallet_keys, &owner.credential().to_bytes()).unwrap();
        let n = testchain::node("a");
        link::set_node(&crate::identity(&n).unwrap().address);
        n.chain.start().await.expect("the devnet");
        chain::faucet(&n.chain, &wallet_keys, 20.0).await.unwrap();
        chain::deposit(&n.chain, &wallet_keys, 10.0).await.unwrap();
        let key = agents::ensure_first(n.keys.as_ref(), 0).unwrap().unwrap();
        testchain::sign_in_as(&n, &owner);
        let p = chain::as_signer(owner.clone()).await.unwrap();
        for c in grant(&n).await.unwrap().calls {
            let tx = alloy::rpc::types::TransactionRequest::default().to(c.to.parse().unwrap()).input(c.data.parse::<alloy::primitives::Bytes>().unwrap().into());
            assert!(p.send_transaction(tx).await.unwrap().get_receipt().await.unwrap().status(), "the wallet's grant");
        }
        agents::keep_granted(&n).await;
        let now = chain::current_epoch(&n.chain).await.unwrap();
        assert_eq!(chain::payer_of(n.keys.as_ref(), key.index, now).unwrap(), owner.address(), "the key pays from the wallet's deposit");
        let who = crate::listing::lister(&n.chain, n.keys.as_ref(), "a").await.unwrap();
        assert_eq!((who.wallet, who.agent_id.as_str(), who.key.is_none()), (owner.address(), format!("{:#x}", owner.address()).as_str(), true), "the wallet's identity, and no key of the node's signs for it");
        assert_eq!(crate::listing::lister_wallet(&n.chain, n.keys.as_ref()).await.unwrap(), owner.address());

        // The node lists a route: kept, unsigned, under no root, and asked of the owner.
        chain::faucet(&n.chain, n.keys.as_ref(), 5.0).await.unwrap();
        let route: store::Route = serde_json::from_value(serde_json::json!({
            "id": "route-items", "site": "shop.localtest.me", "what": "Search items", "method": "GET", "path": "/api/items",
            "root": "http://shop.localtest.me:1/?q=lamps", "inputs": [{ "name": "q", "secret": false, "default": "lamps" }],
            "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "http://shop.localtest.me:1/api/items?q={q}", "needs_browser": false,
                "response_shape": { "items": [{ "id": "number" }] }, "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] },
        }))
        .unwrap();
        let body = crate::recipe::of_route(&route).unwrap();
        let listed = crate::listing::publish(&n.chain, n.keys.as_ref(), "a", "route-items", "Search items", &body, 0.01).await.unwrap();
        assert!(listed.is_none(), "it spreads nowhere before the wallet signs it");
        let kept = crate::listing::load_book(&n.chain).latest("route-items").unwrap().clone();
        assert!(kept.listing.sig.is_empty() && kept.root.is_none(), "never signed by the node, never under a root");
        let asked = to_sign(&n).await.unwrap();
        assert_eq!((asked.len(), asked[0].id.clone()), (1, format!("{:#x}", kept.leaf)));
        assert!(asked[0].what.contains("shop.localtest.me") && asked[0].wallet == owner.address().to_checksum(None), "{}", asked[0].what);

        // The agent key the wallet granted can't sign it; the wallet can.
        let domain = chain::domain(&n.chain.deployed().unwrap());
        let by_agent = kept.listing.clone().signed(&chain::agent_signer(n.keys.as_ref(), key.index).unwrap(), &domain).unwrap().sig;
        let refused = sign_listing(&n, &asked[0].id, &by_agent).await.unwrap_err();
        assert!(refused.contains("agent key"), "{refused}");
        assert_eq!(to_sign(&n).await.unwrap().len(), 1, "still waiting");
        let by_wallet = kept.listing.clone().signed(&owner, &domain).unwrap().sig;
        assert_eq!(sign_listing(&n, &asked[0].id, &by_wallet).await.unwrap()["spread"], true);
        assert!(to_sign(&n).await.unwrap().is_empty(), "nothing waits now");
        let p = crate::listing::load_book(&n.chain).current().pop().expect("proven under a root");
        let v = crate::listing::verify(&n.chain, &p).await.unwrap();
        assert_eq!(v.contributor, owner.address(), "credited to the wallet, whose identity it lists under");
    }

    /// Two nodes signed in with one wallet share its deposit, each with its own agent key and cap, once the wallet sends
    /// the grants the nodes ask for (no contract change: Settlement keys grants by wallet and key). Each node's vouchers
    /// then name the wallet as payer; the owner's nodes list both keys; a stream begun this epoch keeps its payer when
    /// the wallet revokes a key, and the next epoch's goes back to the node's own deposit.
    /// `cargo test -p unbrowse-node-app owner_nodes -- --ignored`
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn two_nodes_signed_in_with_one_wallet_pay_from_its_deposit_with_their_own_keys() {
        use alloy::providers::Provider;
        use crate::testchain;
        let _one = testchain::one_at_a_time().await;
        let home_a = testchain::home("owner-nodes-a");
        let _env = testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        // The owner's wallet, a key of its own, with USDC in its deposit.
        let owner = alloy::signers::local::PrivateKeySigner::random();
        let wallet_keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::KeyStore::set(&wallet_keys, &owner.credential().to_bytes()).unwrap();
        let send_from_wallet = |g: Grant| {
            let owner = owner.clone();
            async move {
                let p = chain::as_signer(owner).await.unwrap();
                for c in g.calls {
                    let tx = alloy::rpc::types::TransactionRequest::default().to(c.to.parse().unwrap()).input(c.data.parse::<alloy::primitives::Bytes>().unwrap().into());
                    assert!(p.send_transaction(tx).await.unwrap().get_receipt().await.unwrap().status(), "the wallet's grant");
                }
            }
        };

        let a = testchain::node("a");
        link::set_node(&crate::identity(&a).unwrap().address);
        a.chain.start().await.expect("the devnet");
        chain::faucet(&a.chain, &wallet_keys, 20.0).await.unwrap();
        let ka = agents::ensure_first(a.keys.as_ref(), 0).unwrap().unwrap();
        testchain::sign_in_as(&a, &owner);
        agents::keep_granted(&a).await;
        let now = chain::current_epoch(&a.chain).await.unwrap();
        let own = chain::owner_address(a.keys.as_ref()).unwrap();
        assert_eq!(chain::payer_of(a.keys.as_ref(), ka.index, now).unwrap(), own, "its own deposit until the wallet grants the key");
        // The wallet grants the key before it has deposited anything: the key stays on the node's own deposit (which
        // the node keeps filling: `the_node_keeps_its_own_deposit_filled_while_a_wallet_grants_its_keys`).
        let g = grant(&a).await.unwrap();
        assert_eq!((g.calls.len(), g.deposit_usdc), (1, 0.0), "one call: a's key at its cap, from an empty deposit");
        send_from_wallet(g).await;
        agents::keep_granted(&a).await;
        assert_eq!(chain::payer_of(a.keys.as_ref(), ka.index, now).unwrap(), own, "a grant from an empty deposit leaves the key on the node's own");
        // Once the wallet deposits, the key moves to its deposit.
        chain::deposit(&a.chain, &wallet_keys, 10.0).await.unwrap();
        agents::keep_granted(&a).await;
        assert_eq!(chain::payer_of(a.keys.as_ref(), ka.index, now).unwrap(), owner.address(), "a pays from the wallet's deposit");
        assert!(grant(&a).await.unwrap().calls.is_empty(), "nothing more to send");
        assert_eq!(chain::agent_spend(&a.chain, a.keys.as_ref(), ka.index, now).await.unwrap().1, agents::AUTO_CAP_USDC, "under the wallet's grant, at 5 USDC");
        chain::add_receipt(ka.index, now, "route-a", 0.01, true, 0.0, agents::AUTO_CAP_USDC, 10.0).unwrap();
        let run = chain::running_voucher(&a.chain, a.keys.as_ref(), ka.index, now).await.unwrap().unwrap();
        assert_eq!(run.voucher.payer, owner.address(), "a's voucher names the wallet");
        chain::check_agent(&a.chain, run.voucher.payer, run.voucher.agent).await.expect("a server takes it: the wallet granted the key");

        // A second node, on a second data dir on the same chain, signed in with the same wallet.
        let home_b = testchain::home("owner-nodes-b");
        std::fs::create_dir_all(home_b.join("devnet")).unwrap();
        for f in ["mark.key", "deployment.json", "network.json"] {
            let _ = std::fs::copy(home_a.join("devnet").join(f), home_b.join("devnet").join(f));
        }
        let b = testchain::node("b");
        link::set_node(&crate::identity(&b).unwrap().address);
        b.chain.start().await.expect("the same devnet");
        let kb = agents::ensure_first(b.keys.as_ref(), 0).unwrap().unwrap();
        assert_ne!(ka.address, kb.address, "each node has its own key");
        testchain::sign_in_as(&b, &owner);
        agents::keep_granted(&b).await;
        send_from_wallet(grant(&b).await.unwrap()).await;
        agents::keep_granted(&b).await;
        assert_eq!(chain::payer_of(b.keys.as_ref(), kb.index, now).unwrap(), owner.address(), "b pays from the same deposit");
        let mine = list(&b).await.unwrap();
        assert_eq!((mine.wallet.as_str(), mine.deposit_usdc, mine.keys.len()), (owner.address().to_checksum(None).as_str(), 10.0, 2), "one wallet, one deposit, two keys");
        let (here, there): (Vec<_>, Vec<_>) = mine.keys.iter().partition(|k| k.this_node);
        assert_eq!((here.len(), here[0].agent.to_lowercase(), there[0].agent.to_lowercase()), (1, kb.address.to_lowercase(), ka.address.to_lowercase()));
        assert!(mine.keys.iter().all(|k| k.cap_usdc == agents::AUTO_CAP_USDC && !k.revoked), "each with its own 5 USDC cap");

        assert_eq!(mine.renew_by, None, "nothing to renew: the grant runs to the key's own expiry, 30 days on");
        assert!(page_grants(&b, Some(owner.address())).await.is_empty(), "the page has nothing to send");
        assert_eq!(page_grants(&b, None).await.len(), 1, "a first sign-in's page sends b's one key");
        // A grant that runs out in two days is asked to be renewed, in one step, at the key's own expiry.
        let p = chain::as_signer(owner.clone()).await.unwrap();
        let d = b.chain.deployed().unwrap();
        let soon = store::now() + 2 * 86_400;
        let block = chain::expiry_block(&b.chain, soon).await.unwrap();
        let short = chain::LeanSettlement::new(d.settlement, &p).authorizeAgent(kb.address.parse().unwrap(), d.usdc_units(agents::AUTO_CAP_USDC), block).send().await.unwrap().get_receipt().await.unwrap();
        assert!(short.status());
        let by = list(&b).await.unwrap().renew_by;
        assert!(by.is_some_and(|e| e.abs_diff(soon) < 600), "asked to renew before it runs out: {by:?}, {soon}");
        let again = page_grants(&b, Some(owner.address())).await;
        let want = chain::expiry_block(&b.chain, kb.expires).await.unwrap();
        assert_eq!(again.len(), 1);
        assert!(again[0].agent.eq_ignore_ascii_case(&kb.address) && again[0].expiry.abs_diff(want) < 100, "the renewal runs to the key's expiry: {}, {want}", again[0].expiry);
        send_from_wallet(grant(&b).await.unwrap()).await;
        assert_eq!(list(&b).await.unwrap().renew_by, None, "renewed in one step");
        assert!(chain::authorize_call(&b.chain, kb.address.parse().unwrap(), 5.0, 0).await.is_err(), "never a grant that doesn't expire");

        // The wallet revokes a's key: a's stream begun this epoch keeps the wallet; the next is a's own again.
        let d = a.chain.deployed().unwrap();
        let revoked = chain::LeanSettlement::new(d.settlement, &p).revokeAgent(ka.address.parse().unwrap()).send().await.unwrap().get_receipt().await.unwrap();
        assert!(revoked.status());
        store::use_home(&home_a);
        std::env::set_var("UNBROWSE_HOME", &home_a);
        agents::keep_granted(&a).await;
        assert_eq!(agents::payer_at(ka.index, now), Some(owner.address()));
        assert_eq!(chain::payer_of(a.keys.as_ref(), ka.index, now + 1).unwrap(), chain::owner_address(a.keys.as_ref()).unwrap());
        let _ = (std::fs::remove_dir_all(&home_a), std::fs::remove_dir_all(&home_b));
    }
}
