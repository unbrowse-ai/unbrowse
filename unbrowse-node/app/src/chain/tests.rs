use super::*;

/// What `reputation_history` reads off a real Settlement: each claimed line, paid from its payer's deposit, as a
/// use, each agent key a wallet authorised, USDC sent between wallets Settlement knows, and an entry's
/// end when it is delisted; a second read takes only the new blocks and counts no line twice. `cargo test -p
/// unbrowse-node-app the_chain_shows_each_use_key_and_send_reputation_reads -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn the_chain_shows_each_use_key_and_send_reputation_reads() {
    use crate::rank::reputation::Link;
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("reputation-anvil");
    let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
    let chain = Chain::default();
    let d = chain.start().await.expect("chain").expect("the devnet's contracts");
    let wallet = || {
        let k = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&k).unwrap();
        k
    };
    let (contributor, honest, sybil) = (wallet(), wallet(), wallet());
    faucet(&chain, &contributor, 1_000.0).await.unwrap();
    set_fee(&chain, &contributor, 0.25, None).await.unwrap();
    list_entry(&chain, &contributor, "route-rep", "www.shop.example", "Search items").await.unwrap();
    let c_addr = owner_address(&contributor).unwrap();
    // The contributor funds one payer with its own USDC: an edge from it to that payer.
    let s_addr = owner_address(&sybil).unwrap();
    {
        let p = as_signer(owner_signer(&contributor).unwrap()).await.unwrap();
        async {
            let _ = crate::rpc::mined!(USDC::new(d.usdc, &p).transfer(s_addr, d.usdc_units(50.0)), "funding the payer");
            Ok::<(), String>(())
        }
        .await
        .unwrap();
    }
    faucet(&chain, &honest, 1_000.0).await.unwrap();
    for k in [&honest, &sybil] {
        deposit(&chain, k, 20.0).await.unwrap();
        authorize(&chain, k, 0, 100.0, 0).await.unwrap();
    }
    let epoch = current_epoch(&chain).await.unwrap();
    // One passed line of 0.25 on the entry, signed by the payer's agent and claimed by the payer.
    let pay = |keys: &unbrowse_core::MemoryStore, index: u64| {
        let payer = owner_signer(keys).unwrap();
        let agent = agent_signer(keys, 0).unwrap();
        let d = d.clone();
        async move {
            let line = LeanSettlement::Line { index: U256::from(index), entryId: test_entry("route-rep"), amount: d.fee_units(0.25), passed: true, holders: vec![], bounty: U256::ZERO };
            let leaf = line_leaf(&line);
            let v = LeanSettlement::Voucher { payer: payer.address(), agent: agent.address(), epoch, cumulative: d.fee_units(0.25) * U256::from(index + 1), lines: index + 1, passedLines: index + 1, receiptsRoot: leaf };
            let sig = agent.sign_hash_sync(&voucher_digest(&d, &v)).unwrap();
            let p = as_signer(payer).await.unwrap();
            let s = LeanSettlement::new(d.settlement, &p);
            async {
                // Sent as the node sends a claim: the estimate and room for the pool's first change in its block.
                let c = s.claimBatch(vec![v], vec![Bytes::from(sig.as_bytes().to_vec())], vec![line], vec![vec![]]);
                let c = match crate::chain::gas::swap_limit(&c).await { Some(g) => c.gas(g), None => c };
                let _ = crate::rpc::mined!(c, "claiming");
                Ok::<(), String>(())
            }
            .await
            .unwrap();
        }
    };
    pay(&honest, 0).await;
    pay(&sybil, 0).await;

    let h = reputation_history(&d).await.unwrap();
    let h_addr = owner_address(&honest).unwrap();
    let payers: Vec<Address> = h.uses.iter().map(|u| u.payer).collect();
    assert_eq!(payers.len(), 2, "two lines paid from deposits: {payers:?}");
    assert!(payers.contains(&h_addr) && payers.contains(&s_addr));
    assert!(h.uses.iter().all(|u| u.entry == test_entry("route-rep") && (u.amount - 0.25).abs() < 1e-9 && u.epoch == epoch));
    assert!(h.uses.iter().any(|u| u.payer == h_addr && u.agent == agent_signer(&honest, 0).unwrap().address()));
    for k in [&honest, &sybil] {
        let key = Link::Key { wallet: owner_address(k).unwrap(), agent: agent_signer(k, 0).unwrap().address() };
        assert!(h.links.contains(&key), "{key:?}");
    }
    assert!(h.links.contains(&Link::Sent { from: c_addr, to: s_addr }), "the contributor's USDC reaching a payer: {:?}", h.links);
    assert!(!h.links.iter().any(|l| matches!(l, Link::Sent { to, .. } | Link::Sent { from: to, .. } if *to == d.settlement)), "Settlement itself is no wallet");
    assert_eq!(h.entries.len(), 1);
    let e = &h.entries[0];
    assert_eq!((e.contributor, e.site.as_str(), e.what.as_str(), e.fee, e.ended_epoch), (c_addr, "shop.example", "Search items", 0.25, None));
    assert_eq!(h.canary_operator, None, "Settlement names no platform since route coins, so no canary operator");

    // The standings from it: the entry is its route's only one, so it is the default (R5.17: a new route's default
    // is its earliest live listing), and unverified, below ranking.unverified_uses counted uses.
    let st = standings(d.clone()).await.unwrap();
    let s = st.of(test_entry("route-rep")).unwrap();
    assert!(s.unverified && s.default && s.live);

    // Delisted, it ends; read again, no line is counted twice.
    delist_entry(&chain, &contributor, test_entry("route-rep"), "Search items").await.unwrap();
    let again = reputation_history(&d).await.unwrap();
    assert_eq!(again.uses.len(), 2);
    assert_eq!(again.entries[0].ended_epoch, Some(current_epoch(&chain).await.unwrap()));
}

/// On mainnet a deploy refuses to stand up its own UNB, pool or USDC, and takes UNB's pool only from the operator's
/// machine; the shipped file names neither. Elsewhere nothing changes.
#[test]
fn a_mainnet_deploy_builds_only_on_the_existing_unb_and_pool() {
    let net = &arc::ARC_MAINNET;
    let shipped: NetworkFile = serde_json::from_str(net.file).unwrap();
    assert_eq!((shipped.existing.unb, shipped.existing.pool), (None, None), "the shipped file names neither");
    let arcs = Existing { usdc: Some(net.usdc), ..Default::default() };
    let e = mainnet_guard(net, &arcs, None, None).unwrap_err();
    assert!(e.contains("never deploys its own UNB or pool") && e.contains("UNBROWSE_ARC_MAINNET_POOL"), "{e}");
    let named = Existing { pool: Some(Address::repeat_byte(7)), fee_recipient: Some(Address::repeat_byte(8)), ..arcs.clone() };
    assert!(mainnet_guard(net, &named, None, None).is_ok(), "the pool named on the operator's machine");
    assert!(mainnet_guard(net, &named, None, Some(PoolSeed { usdc: 1.0, unb: 1.0 })).unwrap_err().contains("never seeds a pool"));
    assert!(mainnet_guard(net, &Existing { usdc: None, ..named.clone() }, None, None).unwrap_err().contains("Arc's own"), "never a test USDC");
    assert!(mainnet_guard(&arc::ARC_TESTNET, &Existing::default(), None, None).is_ok(), "the testnet takes stand-ins");
}

/// RouteCoins can't change who its curves' trade fee accrues to, so on mainnet a node's online key doesn't get it by
/// default (issue #186's rule, now for the fee recipient). Anywhere else the deployer still takes the fee, and an address named takes it everywhere.
#[test]
fn a_mainnet_deploy_never_assumes_the_fee_recipient() {
    let net = &arc::ARC_MAINNET;
    let pool = Existing { usdc: Some(net.usdc), pool: Some(Address::repeat_byte(7)), ..Default::default() };
    let e = mainnet_guard(net, &pool, None, None).unwrap_err();
    assert!(e.contains("trade fee") && e.contains("UNBROWSE_ARC_MAINNET_FEE_RECIPIENT"), "{e}");
    let multisig = Address::repeat_byte(8);
    assert!(mainnet_guard(net, &Existing { fee_recipient: Some(multisig), ..pool.clone() }, None, None).is_ok());

    let deployer = Address::repeat_byte(9);
    assert_eq!(fee_recipient_of(&Existing::default(), deployer).unwrap(), deployer, "a testnet or devnet deploy");
    assert_eq!(fee_recipient_of(&Existing { fee_recipient: Some(multisig), ..Default::default() }, deployer).unwrap(), multisig);
    assert!(fee_recipient_of(&Existing { fee_recipient: Some(Address::ZERO), ..Default::default() }, deployer).unwrap_err().contains("zero address"));

    let shipped: NetworkFile = serde_json::from_str(net.file).unwrap();
    assert_eq!(shipped.existing.fee_recipient, None, "the shipped file names none");
    let read = named_by_env(shipped, net, |k| match k {
        "UNBROWSE_ARC_MAINNET_FEE_RECIPIENT" => Some(format!("{multisig:#x}")),
        _ => None,
    })
    .unwrap();
    assert_eq!(read.existing.fee_recipient, Some(multisig));
    assert!(serde_json::to_string(&Existing::default()).is_ok_and(|j| !j.contains("fee_recipient")), "a file that names none stays as it was");
}

/// A rerun of a deploy that stopped partway keeps the set it made (the domain proofs and the coin contracts, each naming
/// the others by the nonce it takes) only while the key's nonce is where the set left off. A write from the key since
/// (another writer) moved its nonce past it: the set names addresses the key can never make, and it is begun again.
#[test]
fn a_set_is_kept_only_while_the_key_goes_on_where_it_stopped() {
    let made = [Address::repeat_byte(1), Address::repeat_byte(2), Address::repeat_byte(3)];
    assert_eq!(set_kept(&[], None, 10), (vec![], 10), "a first run begins the set at the key's nonce");
    assert_eq!(set_kept(&made, Some(10), 13), (made.to_vec(), 10), "three made from 10: the fourth goes at 13");
    assert_eq!(set_kept(&made[..1], Some(10), 11), (made[..1].to_vec(), 10));
    assert_eq!(set_kept(&made, Some(10), 14), (vec![], 14), "another write took 13");
    assert_eq!(set_kept(&made[..2], Some(10), 11), (vec![], 11), "the nonce is behind what was made: no set can be kept");
    let all: Vec<Address> = (1..=6u8).map(Address::repeat_byte).collect();
    assert_eq!(set_kept(&all, Some(10), 16), (vec![], 16), "a whole set and no Settlement: a new set, as `deploy_as` refuses the old one");
}

/// A deploy starts only on a key with no write pending, and sends each contract of the set only at the nonce the others
/// name it by: a write from another writer between them would put it where nothing names it.
#[test]
fn each_contract_of_the_set_goes_only_at_its_nonce() {
    let me = Address::repeat_byte(0x11);
    assert!(nonce_lands(me, 13, 13, "Settlement").is_ok());
    let e = nonce_lands(me, 14, 13, "Settlement").unwrap_err();
    assert!(e.contains("another write") && e.contains("Settlement"), "{e}");
    assert!(key_is_quiet(me, 9, 9).is_ok());
    let e = key_is_quiet(me, 9, 10).unwrap_err();
    assert!(e.contains("1 write still pending"), "{e}");
    assert!(key_is_quiet(me, 9, 12).unwrap_err().contains("3 writes still pending"));
    // The set's five and Settlement after them, as `script/DeployLean.s.sol` makes them.
    assert_eq!(SET, ["the domain proofs", "RouteCoins", "CoinStakes", "CoinFetch", "CoinBounties"]);
}

/// A deployed RouteCoins accrues its curves' trade fee to the address its network names, not the key that deployed it,
/// and with none named to that key. `cargo test -p unbrowse-node-app fee_recipient_is -- --ignored` (needs Anvil).
#[tokio::test]
#[ignore = "needs Anvil"]
async fn the_fee_recipient_is_the_address_named() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("fee-recipient");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    let owner = owner_address(&operator).unwrap();
    anvil.fund(owner).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    let multisig = Address::repeat_byte(0x5a);
    for (named, paid) in [(None, owner), (Some(multisig), multisig)] {
        let existing = Existing { fee_recipient: named, ..Default::default() };
        store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing, deployment: None, ..network_file(net).unwrap() }).unwrap();
        let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
        assert_eq!(RouteCoins::new(file.deployment.unwrap().coins.route_coins, &p).FEE_RECIPIENT().call().await.unwrap(), paid);
    }
}

/// A network file that still records the deployment from before route coins (an owner's own copy, say) is no
/// deployment this build runs on: the node says so as plainly as for none, before it reads anything from the chain, so
/// nothing is sent there (`decide.old-testnet-dropped`). The RPC here answers nothing at all.
#[tokio::test]
async fn a_deployment_from_before_route_coins_is_said_plainly_and_never_read() {
    let p = ProviderBuilder::new().connect_http("http://127.0.0.1:9".parse().unwrap());
    let old = Deployment { settlement: "0xdb9315219fe272747f6c8ab46b80b4265c5d272f".parse().unwrap(), ..Default::default() };
    match usable(&p, &arc::ARC_TESTNET, &old, None).await {
        Err(Missing::Absent(why)) => {
            assert!(why.starts_with(&not_deployed("arc-testnet")), "{why}");
            assert!(why.contains("from before route coins") && why.contains("sends no transaction on arc-testnet"), "{why}");
        }
        other => panic!("refused as no deployment: {other:?}"),
    }
}

/// A deploy that stopped partway is picked up by the next run: what it made and recorded is used, not made again, and
/// the record goes once the deployment is written. A rerun asked with other values is refused before anything is sent.
/// `cargo test -p unbrowse-node-app a_deploy_run_again -- --ignored` (needs Anvil).
#[tokio::test]
#[ignore = "needs Anvil"]
async fn a_deploy_run_again_uses_what_the_last_run_made() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("deploy-resume");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    // No devnet port this machine may be using: every write here goes to this test's Anvil.
    let _env = crate::testchain::Env::set(&[
        ("UNBROWSE_CHAIN", "arc-testnet".into()),
        ("UNBROWSE_RPC", anvil.url()),
        ("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()),
    ]);
    let net = &arc::ARC_TESTNET;
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    let owner = owner_address(&operator).unwrap();
    anvil.fund(owner).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    set_live(Some(l.clone()));
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing: Existing::default(), deployment: None, ..network_file(net).unwrap() }).unwrap();
    let file = network_file(net).unwrap();
    // A first run that stopped once it had made its test UNB.
    let p = paying(owner_signer(&operator).unwrap(), DEPLOY_GAS).await.unwrap();
    let unb = *UNB::deploy(&p).await.unwrap().address();
    let asked = asked_of(&file.existing, None, None, escrow_wait(file.escrow_wait).unwrap(), epoch_blocks(net, file.epoch_blocks).unwrap(), &DEVNET_OPEN);
    let record = |asked: String| Progress { by: owner, chain_id: net.chain_id, asked, unb: Some(unb), ..Default::default() };
    let at = deploying_path(net);
    let read = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());

    store::write_json(&at, &unbrowse_files::DEPLOYING, &record("another deploy".into())).unwrap();
    let sent = read.get_transaction_count(owner).await.unwrap();
    let e = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.unwrap_err();
    assert!(e.contains("other values") && e.contains("deploying.json"), "{e}");
    assert_eq!(read.get_transaction_count(owner).await.unwrap(), sent, "nothing was sent");

    store::write_json(&at, &unbrowse_files::DEPLOYING, &record(asked)).unwrap();
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
    let d = file.deployment.unwrap();
    assert_eq!(d.unb, unb, "the UNB the first run made");
    assert_eq!(UnbPool::new(d.pool, &read).unb().call().await.unwrap(), unb, "and the pool trades it");
    assert!(!at.exists(), "the record goes once the deployment is written");
}

/// A deploy that makes a contract only a devnet should have (a PoolManager from a v4-core build) does it only on a chain at
/// this machine's loopback, whatever chain id it answers with: a devnet forked from a live network answers with that
/// network's.
#[test]
fn a_loopback_rpc_is_this_machines_alone() {
    for local in ["http://127.0.0.1:8546", "http://localhost:8545", "http://LOCALHOST:1", "http://[::1]:8545", "http://127.0.0.2:8545"] {
        assert!(loopback(&local.parse().unwrap()), "{local}");
    }
    for shared in ["https://rpc.testnet.arc.network", "http://10.0.0.1:8545", "http://0.0.0.0:8545", "http://127.0.0.1.example.com", "http://localhost.example.com"] {
        assert!(!loopback(&shared.parse().unwrap()), "{shared}");
    }
}

/// UNB's v4 pool is named by all six of its variables or none; a partial set, or one that doesn't read, is refused
/// with the variable's name. On mainnet the key alone is enough for the guard, with UNB named beside it, and never
/// together with an `IUnbPool` or a seed.
#[test]
fn a_v4_pool_is_named_by_all_its_variables_or_none() {
    let net = &arc::ARC_MAINNET;
    let all: std::collections::HashMap<String, String> = [
        ("v4_manager", format!("{:#x}", Address::repeat_byte(0x11))),
        ("v4_hook", format!("{:#x}", Address::repeat_byte(0x22))),
        ("v4_fee", "0x800000".into()),
        ("v4_tick_spacing", "200".into()),
        ("v4_buy_fee_bps", "500".into()),
        ("v4_lp_fee", "0".into()),
    ]
    .into_iter()
    .map(|(w, v)| (existing_var(net, w), v))
    .collect();
    assert!(all.contains_key("UNBROWSE_ARC_MAINNET_V4_MANAGER") && all.contains_key("UNBROWSE_ARC_MAINNET_V4_BUY_FEE_BPS"));
    assert_eq!(v4_pool(net, |_| None).unwrap(), None, "none set: no v4 pool");
    let v = v4_pool(net, |k| all.get(k).cloned()).unwrap().expect("all set");
    assert_eq!(
        v,
        V4Pool { manager: Address::repeat_byte(0x11), hook: Address::repeat_byte(0x22), fee: 0x80_0000, tick_spacing: 200, buy_fee_bps: 500, lp_fee: 0 }
    );
    let without = |name: &str| v4_pool(net, |k| if k == name { None } else { all.get(k).cloned() }).unwrap_err();
    assert!(without("UNBROWSE_ARC_MAINNET_V4_HOOK").contains("set UNBROWSE_ARC_MAINNET_V4_HOOK too"));
    let with = |name: &str, v: &str| v4_pool(net, |k| if k == name { Some(v.to_string()) } else { all.get(k).cloned() });
    assert!(with("UNBROWSE_ARC_MAINNET_V4_MANAGER", "nope").unwrap_err().contains("isn't an address"));
    assert!(with("UNBROWSE_ARC_MAINNET_V4_TICK_SPACING", "0").unwrap_err().contains("at least 1"));
    assert!(with("UNBROWSE_ARC_MAINNET_V4_BUY_FEE_BPS", "10000").unwrap_err().contains("from 0 to 9999"), "a cut of everything");
    assert!(with("UNBROWSE_ARC_MAINNET_V4_LP_FEE", "-1").unwrap_err().contains("isn't a number"));

    // The key orders its currencies by address, whichever is UNB.
    let (lo, hi) = (Address::repeat_byte(0x05), Address::repeat_byte(0x36));
    for (usdc, unb) in [(hi, lo), (lo, hi)] {
        let k = v.key(usdc, unb);
        assert_eq!((k.currency0, k.currency1), (lo, hi));
    }

    let arcs = Existing { usdc: Some(net.usdc), unb: Some(lo), pool: None, fee_recipient: Some(Address::repeat_byte(8)) };
    assert!(mainnet_guard(net, &arcs, Some(&v), None).is_ok(), "the v4 key stands for the pool");
    assert_eq!(v4_guard(net, &arcs, &v, None).unwrap(), (net.usdc, lo));
    assert!(v4_guard(net, &Existing { unb: None, ..arcs.clone() }, &v, None).unwrap_err().contains("UNBROWSE_ARC_MAINNET_UNB"));
    assert!(v4_guard(net, &Existing { pool: Some(Address::repeat_byte(7)), ..arcs.clone() }, &v, None).unwrap_err().contains("Settlement swaps through one"));
    assert!(v4_guard(net, &arcs, &v, Some(PoolSeed { usdc: 1.0, unb: 1.0 })).unwrap_err().contains("seeds nothing"));
    let e = mainnet_guard(net, &Existing { unb: Some(lo), ..Existing { usdc: Some(net.usdc), ..Default::default() } }, None, None).unwrap_err();
    assert!(e.contains("UNBROWSE_ARC_MAINNET_V4_MANAGER"), "the refusal names the v4 way too: {e}");
}

/// The repayment comes out of the buffer before anything swaps, and a dry run never sees it (its base fee is zero). At
/// Arc's 20 gwei floor and 6 decimals a batch repays 11,137 units with the next block's rise, so a quiet network's buffer
/// of a few lines' burn share waits rather than cost the node a reverted transaction each pass.
#[test]
fn a_buffer_the_repayment_would_swallow_sends_no_batch() {
    let gwei = 1_000_000_000;
    assert!(!batch_pays(U256::from(11_137), 20 * gwei, 6), "all of it would go on the repayment");
    assert!(batch_pays(U256::from(11_138), 20 * gwei, 6), "one unit left to swap");
    assert!(!batch_pays(U256::ZERO, 0, 6), "an empty buffer has nothing to swap, base fee or not");
    assert!(batch_pays(U256::from(1), 0, 6), "at a base fee of zero nothing is repaid");
    let at_18 = 11_137_500_000_000_000u64;
    assert!(!batch_pays(U256::from(at_18), 20 * gwei, 18), "the same gas on the devnet's 18 decimals");
    assert!(batch_pays(U256::from(at_18 + 1), 20 * gwei, 18));
}

#[test]
fn nodes_spread_their_burn_batches_over_the_first_half_of_an_epoch() {
    let day = 86_400;
    let offsets: Vec<u64> = (1u8..=50).map(|i| burn_offset(Address::from([i; 20]), day)).collect();
    assert!(offsets.iter().all(|o| *o < day / 2), "every node may run it by midday");
    let mut distinct = offsets.clone();
    distinct.sort();
    distinct.dedup();
    assert!(distinct.len() > 40, "and different nodes wait different times");
    assert_eq!(burn_offset(Address::ZERO, 1), 0, "a one-second epoch never waits");
}

#[test]
fn a_node_runs_on_its_devnet_unless_told_otherwise() {
    assert!(matches!(choose(None, "devnet", None, |_| None), Ok(Mode::Devnet)));
    assert!(matches!(choose(None, "", None, |_| None), Ok(Mode::Devnet)), "an empty setting is the default");
    assert_eq!(store::Settings::default().chain, DEVNET);
}

#[test]
fn the_setting_names_a_live_network_and_the_environment_overrides_it() {
    let Ok(Mode::Live(l)) = choose(None, "arc-testnet", None, |_| None) else { panic!("the setting names arc-testnet") };
    assert_eq!((l.net.chain_id, l.rpc.as_str()), (arc::ARC_TESTNET.chain_id, "https://rpc.testnet.arc.io/"), "its RPC from the table");
    assert!(matches!(choose(Some("devnet"), "arc-testnet", None, |_| None), Ok(Mode::Devnet)), "UNBROWSE_CHAIN over the setting");
    let Ok(Mode::Live(l)) = choose(Some("arc-mainnet"), "devnet", None, |_| None) else { panic!("UNBROWSE_CHAIN names arc-mainnet") };
    assert_eq!(l.net.chain_id, arc::ARC_MAINNET.chain_id);
    assert!(matches!(choose(Some(" "), "devnet", None, |_| None), Ok(Mode::Devnet)), "an empty variable chooses nothing");
    let Ok(Mode::Live(l)) = choose(None, "arc-testnet", Some("http://127.0.0.1:9999"), |_| None) else { panic!("arc-testnet") };
    assert_eq!(l.rpc.as_str(), "http://127.0.0.1:9999/", "UNBROWSE_RPC moves the RPC");
    assert!(matches!(choose(None, "devnet", Some("http://127.0.0.1:9999"), |_| None), Ok(Mode::Devnet)), "and only a live network's");
    let e = choose(Some("another-chain"), "devnet", None, |_| None).unwrap_err();
    assert!(e.contains("devnet, arc-mainnet, arc-testnet"), "{e}");
    assert!(choose(None, "arc-testnet", Some("not a url"), |_| None).is_err());
}

/// A node holding a pass for Unbrowse's gateway reads its network there; an RPC named by hand wins over it, and the
/// network's table RPC is the rest's.
#[test]
fn a_node_with_a_gateway_pass_reads_through_the_gateway_unless_an_rpc_is_named() {
    let gateway = |net: &str| (net == "arc-testnet").then(|| "https://rpc.unbrowse.ai/arc-testnet/0xabc.1.0xdef".to_string());
    let Ok(Mode::Live(l)) = choose(None, "arc-testnet", None, gateway) else { panic!("arc-testnet") };
    assert_eq!(l.rpc.as_str(), "https://rpc.unbrowse.ai/arc-testnet/0xabc.1.0xdef", "the gateway with the node's pass");
    let Ok(Mode::Live(l)) = choose(None, "arc-testnet", Some("http://127.0.0.1:9999"), gateway) else { panic!("arc-testnet") };
    assert_eq!(l.rpc.as_str(), "http://127.0.0.1:9999/", "UNBROWSE_RPC over the gateway");
    let Ok(Mode::Live(l)) = choose(None, "arc-mainnet", None, gateway) else { panic!("arc-mainnet") };
    assert_eq!(l.rpc.as_str(), "https://rpc.mainnet.arc.io/", "no pass for this network: its table RPC");
}

#[test]
fn a_networks_own_token_can_be_named_on_the_owners_machine_not_in_the_repo() {
    let net = &arc::ARC_MAINNET;
    let shipped = read_network_file(net, Path::new("/nonexistent/unbrowse/network.json"), net.file).unwrap();
    assert_eq!(existing_var(net, "unb"), "UNBROWSE_ARC_MAINNET_UNB");
    let token = Address::repeat_byte(7);
    let named = named_by_env(shipped.clone(), net, |k| (k == "UNBROWSE_ARC_MAINNET_UNB").then(|| format!("{token:#x}"))).unwrap();
    assert_eq!(named.existing.unb, Some(token), "the variable names the UNB");
    assert_eq!(named.existing.usdc, shipped.existing.usdc, "what it doesn't name stays as the file says");
    let unset = named_by_env(shipped.clone(), net, |_| None).unwrap();
    assert_eq!(unset.existing, shipped.existing, "with nothing set the file stands");
    let typo = named_by_env(shipped, net, |k| (k == "UNBROWSE_ARC_MAINNET_UNB").then(|| "0x12".to_string()));
    assert!(typo.unwrap_err().contains("UNBROWSE_ARC_MAINNET_UNB"), "a value that isn't an address is refused, never deployed past");
}

#[test]
fn every_network_ships_a_file_for_its_own_chain() {
    for net in arc::NETWORKS {
        let f = read_network_file(net, Path::new("/nonexistent/unbrowse/network.json"), net.file).unwrap();
        assert_eq!((f.network.as_str(), f.chain_id), (net.name, net.chain_id));
        assert!(f.registry_from.is_some(), "{} names where its registrations start", net.name);
        // Each network names its own USDC, the one its gas is, so Settlement's fees are in it; no network has its
        // own UNB or pool yet, so `chain deploy` stands up the test UNB and a pool beside the USDC. An old file
        // without the place to name them reads as naming none.
        assert_eq!(f.existing, Existing { usdc: Some(net.usdc), ..Default::default() }, "{} names its own USDC", net.name);
        assert!(net.file.contains("\"existing\""), "{} shows where to name them", net.name);
    }
    let old: NetworkFile = serde_json::from_str(r#"{"network":"arc-testnet","chain_id":5042002,"deployment":null}"#).unwrap();
    assert_eq!(old.existing, Existing::default());
}

/// The owner's copy of a network's file is read over the build's; with neither naming a deployment the node runs
/// without Settlement; a file that doesn't read or names another chain is refused, never read as empty.
#[test]
fn the_owners_network_file_is_read_over_the_built_in_one() {
    let scratch = store::scratch_home("network-file");
    let net = &arc::ARC_TESTNET;
    let home = home_network_file(net);
    let shipped = r#"{"about":"…","network":"arc-testnet","chain_id":5042002,"registry_from":7,"deployment":null}"#;
    let f = read_network_file(net, &home, shipped).unwrap();
    assert!(f.deployment.is_none(), "absent: no deployment recorded");
    assert_eq!(f.registry_from, Some(7));

    let d = Deployment { usdc: Address::repeat_byte(3), usdc_decimals: 6, unb: Address::repeat_byte(1), pool: Address::repeat_byte(4), settlement: Address::repeat_byte(2), dnssec: Address::repeat_byte(6), domains: Address::repeat_byte(7), escrow_wait: ESCROW_WAIT, epoch_blocks: DEVNET_EPOCH_BLOCKS, coins: Coins::default(), chain_id: net.chain_id, block: 9, code: code_hash() };
    let mine = NetworkFile { network: net.name.into(), chain_id: net.chain_id, registry_from: Some(7), deployment: Some(d.clone()), ..Default::default() };
    store::write_json(&home, &unbrowse_files::NETWORK, &mine).unwrap();
    let f = read_network_file(net, &home, shipped).unwrap();
    assert_eq!(f.deployment.map(|d| (d.settlement, d.block)), Some((d.settlement, 9)), "the owner's copy wins");

    std::fs::write(&home, r#"{"network":"arc-mainnet","chain_id":5042,"deployment":null}"#).unwrap();
    assert!(read_network_file(net, &home, shipped).unwrap_err().contains("not arc-testnet"));
    let elsewhere = NetworkFile { deployment: Some(Deployment { chain_id: 1, ..d }), ..mine };
    store::write_json(&home, &unbrowse_files::NETWORK, &elsewhere).unwrap();
    assert!(read_network_file(net, &home, shipped).unwrap_err().contains("chain 1"), "a deployment made on another chain");
    std::fs::write(&home, "{").unwrap();
    assert!(read_network_file(net, &home, shipped).unwrap_err().contains("doesn't read"));
    let _ = std::fs::remove_dir_all(scratch);
}

/// On a live network the registry is found by the chain's own ID, whether or not Settlement is there, and the
/// devnet's clock is never moved.
#[tokio::test]
async fn a_live_chain_refuses_what_only_a_devnet_does() {
    let chain = Chain::default();
    *chain.live.locked() = Some(Live { net: &arc::ARC_TESTNET, rpc: "http://127.0.0.1:9".parse().unwrap() });
    *chain.unavailable.locked() = Some(not_deployed("arc-testnet"));
    assert_eq!(chain.chain_id().unwrap(), arc::ARC_TESTNET.chain_id);
    assert_eq!(crate::erc8004::registry_of(&chain).map(|n| n.name), Some("arc-testnet"), "no Settlement, still the registry");
    assert_eq!(chain.deployed().unwrap_err(), not_deployed("arc-testnet"));
    assert!(advance_day(&chain).await.unwrap_err().contains("keeps real time"));
    *chain.deployment.locked() = Some(Deployment { chain_id: arc::ARC_TESTNET.chain_id, ..Default::default() });
    assert!(advance_day(&chain).await.unwrap_err().contains("keeps real time"), "with Settlement too");
}

/// A live network is judged by what runs on it, not by what its file records. A real deployment passes whatever its
/// file says of its code; one byte of any contract it is made of (the coin set and the clone implementation
/// included), right code behind the wrong link, or a file naming other coin contracts, is refused; and a
/// coin is traded only once it is its entry's clone of the verified implementation.
/// `cargo test -p unbrowse-node-app live_network_is_judged -- --ignored` (needs Anvil).
#[tokio::test]
#[ignore = "needs Anvil"]
async fn a_live_network_is_judged_by_the_code_on_it() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("conform");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing: Existing::default(), ..network_file(net).unwrap() }).unwrap();
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
    let epoch_blocks = file.epoch_blocks;
    let d = file.deployment.unwrap();
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());

    let refused = |r: Result<Deployment, Missing>, says: &str, what: &str| match r {
        Err(Missing::Absent(why)) => assert!(why.contains(says), "{what}: {why}"),
        other => panic!("{what}: {other:?}"),
    };
    let read = usable(&p, net, &d, epoch_blocks).await.expect("the deployment as made");
    assert_eq!(Some(read.epoch_blocks), epoch_blocks, "the epoch is the chain's word");
    // The code can't say how long an epoch is: the same contracts, on another count of blocks, aren't a day (R1.28).
    refused(usable(&p, net, &d, Some(86_400)).await, "epochs of", "an epoch of other blocks than the file's");
    refused(usable(&p, net, &d, None).await, "epochs of", "a file that names none");
    usable(&p, net, &Deployment { code: String::new(), ..d.clone() }, epoch_blocks).await.expect("a file that records no code");
    usable(&p, net, &Deployment { code: "0xabcd".into(), ..d.clone() }, epoch_blocks).await.expect("what a file records of the code is no one's word");

    // A file that names another contract as Settlement, recording the right code.
    refused(usable(&p, net, &Deployment { settlement: d.domains, ..d.clone() }, epoch_blocks).await, "other contracts", "the wrong address");
    // A file that names money elsewhere than Settlement does.
    refused(usable(&p, net, &Deployment { pool: Address::repeat_byte(9), ..d.clone() }, epoch_blocks).await, "Settlement's pool", "another pool");
    refused(usable(&p, net, &Deployment { usdc: Address::repeat_byte(9), ..d.clone() }, epoch_blocks).await, "Settlement's USDC", "another USDC");
    refused(usable(&p, net, &Deployment { coins: Coins::default(), ..d.clone() }, epoch_blocks).await, "from before route coins", "a deployment with no coin contracts");

    let set_code = async |at: Address, code: &[u8]| {
        let _: serde_json::Value = p.raw_request("anvil_setCode".into(), (at, format!("0x{}", hex::encode(code)))).await.unwrap();
    };
    let s = LeanSettlement::new(d.settlement, &p);
    let c = d.coins;
    let every = [
        ("LeanSettlement", d.settlement),
        ("Listings", s.listings().call().await.unwrap()),
        ("Domains", d.domains),
        ("FixedDNSSEC", d.dnssec),
        ("UnbPool", d.pool),
        ("RouteCoins", c.route_coins),
        ("RouteCoin", c.route_coin_implementation),
        ("CoinStakes", c.coin_stakes),
        ("CoinFetch", c.coin_fetch),
        ("CoinBounties", c.coin_bounties),
    ];
    for (name, at) in every {
        let good = p.get_code_at(at).await.unwrap().to_vec();
        assert!(conform::built_from(name, &good), "{name} as deployed");
        // A comment changes the metadata and nothing else: not a different contract.
        let mut comment = good.clone();
        let (start, _) = *conform::expected(name).blank.last().unwrap();
        comment[start + 8] ^= 1;
        set_code(at, &comment).await;
        usable(&p, net, &d, epoch_blocks).await.unwrap_or_else(|e| panic!("{name}, its metadata changed: {e:?}"));
        // One byte of code.
        let blank = &conform::expected(name).blank;
        let open = (0..good.len()).find(|i| !blank.iter().any(|(s, l)| (*s..s + l).contains(i))).unwrap();
        let mut changed = good.clone();
        changed[open] ^= 1;
        set_code(at, &changed).await;
        refused(usable(&p, net, &d, epoch_blocks).await, "other contracts", name);
        set_code(at, &good).await;
    }
    // A file that names coin contracts other than the ones Settlement walks to.
    refused(usable(&p, net, &Deployment { coins: Coins { coin_fetch: Address::repeat_byte(9), ..c }, ..d.clone() }, epoch_blocks).await, "coin contracts", "another fetch in the file");

    // The right code behind the wrong link: Settlement's immutable names a fetch that isn't the one the stakes name. Its
    // code is unchanged once blanked, and so is the fetch's, so only the link can tell.
    let other = Address::repeat_byte(0x7f);
    set_code(other, &p.get_code_at(c.coin_fetch).await.unwrap()).await;
    let good = p.get_code_at(d.settlement).await.unwrap().to_vec();
    let at = c.coin_fetch.to_vec();
    let mut rewired = good.clone();
    let mut swapped = 0;
    for i in 0..good.len() - 20 {
        if good[i..i + 20] == at[..] {
            rewired[i..i + 20].copy_from_slice(other.as_slice());
            swapped += 1;
        }
    }
    assert!(swapped > 0, "Settlement holds the fetch's address in its code");
    set_code(d.settlement, &rewired).await;
    refused(usable(&p, net, &d, epoch_blocks).await, "stakes' fetch", "a fetch the stakes don't name");
    set_code(d.settlement, &good).await;
    usable(&p, net, &d, epoch_blocks).await.expect("put back");

    // A coin is traded only once it is its entry's clone of the verified implementation, at its predicted address.
    let entry = FixedBytes::<32>::repeat_byte(0xe1);
    assert!(coins::verify_coin(&p, &read, entry).await.unwrap_err().contains("no coin yet"), "nothing launched");
    let at = coins::coin_address(c.route_coins, c.route_coin_implementation, entry);
    set_code(at, &coins::clone_runtime(Address::repeat_byte(0x66), entry)).await;
    assert!(coins::verify_coin(&p, &read, entry).await.unwrap_err().contains("isn't a clone"), "a clone of another implementation at its address");
    set_code(at, &coins::clone_runtime(c.route_coin_implementation, entry)).await;
    assert_eq!(coins::verify_coin(&p, &read, entry).await.unwrap(), coins::test_verified(at, entry));
}

/// USDC an owner sends to the node's address lands in its wallet (a deposit credits whoever sends it); the node
/// moves it into its deposit, up to the floor, once a call, on a live chain only. Here with a test USDC of the network's own making (18 decimals), whose balance is apart from the gas,
/// so none of it is held back.
/// `cargo test -p unbrowse-node-app top_up -- --ignored` (needs Anvil).
#[tokio::test]
#[ignore = "needs Anvil"]
async fn usdc_the_owner_sends_the_wallet_becomes_the_deposit_up_to_the_floor() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("top-up");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    // A network file that names no USDC of its own: the deploy stands up a test one, and its gas is apart.
    let net = &arc::ARC_TESTNET;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing: Existing::default(), ..network_file(net).unwrap() }).unwrap();
    // Whoever runs the network deploys it; the faucet's key is theirs, and holds the test USDC's faucet.
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
    let d = file.deployment.unwrap();
    assert_eq!(d.usdc_decimals, 18);

    let node = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&node).unwrap();
    let me = owner_address(&node).unwrap();
    let chain = Chain::default();
    chain.start().await.expect("the node on its live chain");
    assert_eq!(top_up(&chain, &node, 0.5, 0.25).await.unwrap(), None, "nothing in the wallet, nothing to move");

    // The owner sends 0.25 of gas and 0.5 of Settlement's USDC to the node's address.
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    let _: serde_json::Value = p.raw_request("anvil_setBalance".into(), (me, gas_units(0.25))).await.unwrap();
    // The transfer, as a mint from the test USDC the operator's key owns: the node's wallet ends up holding it.
    async fn send_usdc(operator: &unbrowse_core::MemoryStore, d: &Deployment, to: Address, amount: f64) -> Result<(), String> {
        let p = as_signer(owner_signer(operator)?).await?;
        let _ = crate::rpc::mined!(USDC::new(d.usdc, &p).faucet(to, d.usdc_units(amount)), "the faucet's USDC");
        Ok(())
    }
    send_usdc(&operator, &d, me, 0.5).await.unwrap();
    let sent = p.get_transaction_count(me).await.unwrap();
    assert_eq!(top_up(&chain, &node, 0.5, 0.25).await.unwrap(), Some(0.5), "the wallet's USDC becomes the deposit");
    let s = LeanSettlement::new(d.settlement, &p);
    assert_eq!(s.account(me).call().await.unwrap().balance, d.usdc_units(0.5));
    // One transaction and no approval: Settlement pulled it under the key's EIP-3009 authorisation.
    assert_eq!(p.get_transaction_count(me).await.unwrap(), sent + 1, "the deposit is one transaction");
    assert_eq!(USDC::new(d.usdc, &p).allowance(me, d.settlement).call().await.unwrap(), U256::ZERO, "no approval was made");
    assert_eq!(USDC::new(d.usdc, &p).balanceOf(me).call().await.unwrap(), U256::ZERO);
    // At the floor, more USDC in the wallet stays the owner's.
    send_usdc(&operator, &d, me, 2.0).await.unwrap();
    assert_eq!(top_up(&chain, &node, 0.5, 0.25).await.unwrap(), None, "the deposit is at the floor");
    assert_eq!(top_up(&chain, &node, 1.0, 0.25).await.unwrap(), Some(0.5), "up to a higher floor, and no more");
    assert_eq!(USDC::new(d.usdc, &p).balanceOf(me).call().await.unwrap(), d.usdc_units(1.5));
    assert!(!gas_is_usdc(l.net, &d), "a test USDC of its own: its gas is apart, so no reserve is held back from it");
    let native = Deployment { usdc: l.net.usdc, ..d.clone() };
    assert!(gas_is_usdc(l.net, &native), "the network's own USDC is its gas");
    forget_live();
}

/// The node keeps its own deposit filled even while the owner's wallet grants every one of its keys: a key falls
/// back to the node's own deposit whenever the wallet's can't cover a call (`owner_nodes::pays_from_wallet`).
/// `cargo test -p unbrowse-node-app keeps_its_own_deposit -- --ignored` (needs Anvil).
#[tokio::test]
#[ignore = "needs Anvil"]
async fn the_node_keeps_its_own_deposit_filled_while_a_wallet_grants_its_keys() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("own-deposit");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing: Existing::default(), ..network_file(net).unwrap() }).unwrap();
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
    let d = file.deployment.unwrap();

    let n = crate::testchain::node("own-deposit");
    n.chain.start().await.expect("the node on its live chain");
    let me = owner_address(n.keys.as_ref()).unwrap();
    // Every key pays from the owner's wallet, as once its grant is taken.
    let a = crate::agents::ensure_first(n.keys.as_ref(), 0).unwrap().unwrap();
    crate::agents::set_payer(a.index, 0, Some(Address::repeat_byte(0xa1))).unwrap();
    anvil.fund(me).await;
    async fn send_usdc(operator: &unbrowse_core::MemoryStore, d: &Deployment, to: Address, amount: f64) -> Result<(), String> {
        let p = as_signer(owner_signer(operator)?).await?;
        let _ = crate::rpc::mined!(USDC::new(d.usdc, &p).faucet(to, d.usdc_units(amount)), "the faucet's USDC");
        Ok(())
    }
    send_usdc(&operator, &d, me, 1.0).await.unwrap();
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    assert!(crate::top_up(&n).await, "the node's own deposit is filled though the wallet grants every key");
    let s = LeanSettlement::new(d.settlement, &p);
    assert_eq!(s.account(me).call().await.unwrap().balance, d.usdc_units(store::DEPOSIT_FLOOR_USDC));
    forget_live();
}

/// On a copy of Arc mainnet, `chain deploy` with UNB and its v4 pool named on the operator's machine puts the
/// adapter over UNB's real pool and builds Settlement on it, and a buy through the adapter pays its quote to the
/// unit, through the pool's hook. Every address comes from the environment (`UNBROWSE_ARC_MAINNET_RPC`, `_UNB` and
/// the `_V4_*` variables), never from the repo; the test says so and passes without them. Arc's USDC moves the
/// native balance through a precompile Anvil lacks, so a 6-decimal stand-in takes its address, holding what the real
/// one held for the manager. `cargo test -p unbrowse-node-app a_mainnet_deploy_builds -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil and Arc mainnet's RPC to fork"]
async fn a_mainnet_deploy_builds_settlement_on_unbs_v4_pool() {
    let net = &arc::ARC_MAINNET;
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let (Some(rpc), Some(unb), Ok(Some(v4))) = (var("UNBROWSE_ARC_MAINNET_RPC"), var(&existing_var(net, "unb")), v4_pool(net, |k| var(k))) else {
        eprintln!("skipped: set UNBROWSE_ARC_MAINNET_RPC, {} and the {} variables", existing_var(net, "unb"), existing_var(net, "v4_*"));
        return;
    };
    let unb: Address = unb.parse().unwrap();
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("v4-deploy");
    let anvil = crate::testchain::Anvil::fork(net.chain_id, &rpc).await;
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    let held = USDC::new(net.usdc, &p).balanceOf(v4.manager).call().await.unwrap();
    let usdc_owner = stand_in_usdc(&anvil.url(), net.usdc, 6).await;
    let minter = ProviderBuilder::new().wallet(usdc_owner.clone()).connect_http(anvil.url().parse().unwrap());
    assert!(USDC::new(net.usdc, &minter).faucet(v4.manager, held).send().await.unwrap().get_receipt().await.unwrap().status());
    let multisig = Address::repeat_byte(0x5a);
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-mainnet".into()), ("UNBROWSE_RPC", anvil.url()), ("UNBROWSE_ARC_MAINNET_PLATFORM", format!("{multisig:#x}"))]);

    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-mainnet") };
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed on UNB's v4 pool");
    let d = file.deployment.unwrap();
    assert_eq!((d.usdc, d.usdc_decimals, d.unb), (net.usdc, 6, unb), "Arc's USDC and the live UNB");
    let s = LeanSettlement::new(d.settlement, &p);
    assert_eq!(s.pool().call().await.unwrap(), d.pool, "Settlement swaps through the adapter");
    let a = V4UnbPool::new(d.pool, &p);
    assert_eq!((a.usdc().call().await.unwrap(), a.unb().call().await.unwrap(), a.manager().call().await.unwrap()), (net.usdc, unb, v4.manager));
    assert!(a.reserveUsdc().call().await.unwrap() > U256::ZERO, "the pool has depth at its price");
    assert_eq!(file.existing, network_file(net).unwrap().existing, "the file keeps only what the build ships: no UNB, no pool");

    // A buy of 1 USDC through the adapter, at its quote, from a payer of its own.
    let payer = PrivateKeySigner::random();
    anvil.fund(payer.address()).await;
    assert!(USDC::new(net.usdc, &minter).faucet(payer.address(), U256::from(1_000_000u64)).send().await.unwrap().get_receipt().await.unwrap().status());
    let pp = ProviderBuilder::new().wallet(payer.clone()).connect_http(anvil.url().parse().unwrap());
    let quote = a.quoteUnbOut(U256::from(1_000_000u64)).call().await.unwrap();
    assert!(quote > U256::ZERO);
    assert!(USDC::new(net.usdc, &pp).approve(d.pool, U256::from(1_000_000u64)).send().await.unwrap().get_receipt().await.unwrap().status());
    let bought = V4UnbPool::new(d.pool, &pp).swapUsdcForUnb(U256::from(1_000_000u64), quote, payer.address()).send().await.unwrap().get_receipt().await.unwrap();
    assert!(bought.status(), "the buy went through the hook");
    println!("the buy took {} gas", bought.gas_used);
    let got = UNB::new(unb, &p).balanceOf(payer.address()).call().await.unwrap();
    assert_eq!(got, quote, "the buy paid its quote to the unit");
    assert_eq!(USDC::new(net.usdc, &p).balanceOf(payer.address()).call().await.unwrap(), U256::ZERO, "and took exactly the USDC named");
    println!("1 USDC bought {got} UNB-units through the hook (adapter {:#x} on the fork)", d.pool);
    forget_live();
}

/// USDC an owner sends on the network's own USDC, 6 decimals at its fixed address: one native amount, here 0.75,
/// is the node's gas and its deposit at once. The node moves 0.5 into the deposit and keeps 0.25 for gas. Anvil
/// keeps the native balance apart from the stand-in token, so 0.75 of each is given, standing in for the one
/// balance: the token side shows the split, and the native side that the deposit left the gas the reserve.
/// `cargo test -p unbrowse-node-app top_up -- --ignored` (needs Anvil).
#[tokio::test]
#[ignore = "needs Anvil"]
async fn a_top_up_on_the_networks_own_usdc_keeps_its_gas_and_deposits_the_rest() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("top-up-native");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    let circle = stand_in_usdc(&anvil.url(), net.usdc, 6).await;
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    mint_stand_in(&anvil.url(), &circle, net.usdc, owner_address(&operator).unwrap(), 1_000.0).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, Some(PoolSeed { usdc: 1_000.0, unb: 1_000.0 }), &DEVNET_OPEN).await.expect("deployed");
    let d = file.deployment.unwrap();
    assert_eq!((d.usdc, d.usdc_decimals), (net.usdc, 6));
    assert!(gas_is_usdc(net, &d));

    let node = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&node).unwrap();
    let me = owner_address(&node).unwrap();
    let chain = Chain::default();
    chain.start().await.expect("the node on its live chain");

    // The owner sends 0.75 USDC, one native amount.
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    let _: serde_json::Value = p.raw_request("anvil_setBalance".into(), (me, gas_units(0.75))).await.unwrap();
    mint_stand_in(&anvil.url(), &circle, net.usdc, me, 0.75).await;
    assert_eq!(top_up(&chain, &node, 0.5, 0.25).await.unwrap(), Some(0.5), "0.5 deposited");
    let s = LeanSettlement::new(d.settlement, &p);
    assert_eq!(s.account(me).call().await.unwrap().balance, U256::from(500_000u64), "0.5 USDC, in 6 decimals");
    assert_eq!(USDC::new(d.usdc, &p).balanceOf(me).call().await.unwrap(), U256::from(250_000u64), "0.25 kept for gas");
    let gas = gas_f(p.get_balance(me).await.unwrap());
    assert!(gas > 0.74 && gas < 0.75, "the approve and the deposit paid their gas from it: {gas}");
    println!("after the top-up: deposit 0.5, wallet 0.25 USDC; the two writes took {} of gas", 0.75 - gas);
    // Nothing above the reserve is left to move, even toward a higher floor.
    assert_eq!(top_up(&chain, &node, 1.0, 0.25).await.unwrap(), None, "the reserve stays for gas");
    forget_live();
}

/// A new node on a network whose USDC is its gas starts at nothing: Money says how much starts it and where to add
/// it. Once that lands at its address, the node registers its identity and deposits from it by itself, and Money
/// shows the balance with nothing more needed. The answer is the `Money` the manifest names.
/// `cargo test -p unbrowse-node-app an_empty_node_is_told -- --ignored` (needs Anvil).
#[tokio::test]
#[ignore = "needs Anvil"]
async fn an_empty_node_is_told_what_starts_it_then_registers_deposits_and_shows_its_balance() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("money-start");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    anvil.with_registry().await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    // Registrations are read from this chain's first block: a fresh Anvil is nowhere near the real one's.
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { registry_from: Some(0), ..network_file(net).unwrap() }).unwrap();
    let circle = stand_in_usdc(&anvil.url(), net.usdc, 6).await;
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    mint_stand_in(&anvil.url(), &circle, net.usdc, owner_address(&operator).unwrap(), 1_000.0).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, Some(PoolSeed { usdc: 1_000.0, unb: 1_000.0 }), &DEVNET_OPEN).await.expect("deployed");
    assert!(gas_is_usdc(net, &file.deployment.unwrap()));

    let n = crate::testchain::node("money-start");
    n.chain.start().await.expect("the node on its live chain");
    crate::agents::ensure_first(n.keys.as_ref(), 0).unwrap();
    let me = owner_address(n.keys.as_ref()).unwrap();
    let types = crate::apischema::types();
    let said = |m: &crate::money::Money| {
        let v = serde_json::to_value(m).unwrap();
        crate::apischema::check(&crate::apischema::r("Money"), &v, &types).unwrap_or_else(|e| panic!("money against its type: {e}"));
        v
    };

    // Empty: the registration, the deposit floor and the fees it keeps, in one figure.
    let empty = said(&crate::money::of(&n).await.unwrap());
    assert_eq!((empty["payments"].as_str(), empty["balance"].as_str()), (Some("open"), Some("0.00")));
    let need: f64 = empty["needed_to_start"].as_str().unwrap().parse().unwrap();
    let floor = store::load_settings().deposit_floor_usdc;
    assert!(need >= link_identity() + floor + store::GAS_RESERVE_USDC - 1e-9, "registration, deposit and fees: {need}");
    let url = empty["add_funds_url"].as_str().unwrap();
    assert!(url.contains(&format!("#node={me:#x}&chain={}&min={}&nonce=", net.chain_id, empty["needed_to_start"].as_str().unwrap())), "{url}");
    assert_eq!((empty["agents"][0]["daily_limit"].as_str(), empty["agents"][0]["spent_today"].as_str()), (Some("5.00"), Some("0.00")));

    // That much lands at its address (Anvil keeps the native gas apart from the stand-in token: both are given).
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    let _: serde_json::Value = p.raw_request("anvil_setBalance".into(), (me, gas_units(need))).await.unwrap();
    mint_stand_in(&anvil.url(), &circle, net.usdc, me, need).await;
    // The node registers its identity (as it joins the network once it can pay) and deposits, by itself.
    crate::erc8004::ensure(&n.chain, n.keys.as_ref(), "money-start").await.expect("registered from the top-up");
    assert!(crate::top_up(&n).await, "the top-up deposits");
    let started = said(&crate::money::of(&n).await.unwrap());
    assert_eq!(started["needed_to_start"].as_str(), Some("0.00"), "{started}");
    assert_eq!(started["balance"].as_str().map(|b| b.parse::<f64>().unwrap()), Some(need), "the whole top-up is the balance: {started}");
    assert_eq!(started["parts"]["deposit"].as_str(), Some("0.50"));
    assert!(started["available_to_spend"].as_str().unwrap().parse::<f64>().unwrap() >= floor - 1e-9);
    assert!(crate::erc8004::identity_of(&n.chain, me).await.unwrap().is_some(), "registered");
    forget_live();
}

fn link_identity() -> f64 {
    crate::link::IDENTITY_USDC
}

/// Arc testnet's gas price on 30 October 2026: its 20 gwei base fee floor and a 5 gwei tip.
const ARC_PRICE: u128 = 25_000_000_000;

#[test]
fn a_line_too_small_to_pay_for_its_claim_waits() {
    // One 0.01 USDC line: its claim's gas is about what the line pays, far past a tenth of it.
    assert!(!claim_due(1, 2, 0.01, ARC_PRICE, CLAIM_GAS_SHARE, false));
    assert!(!claim_due(CLAIM_BATCH - 1, 2, 0.01 * (CLAIM_BATCH - 1) as f64, ARC_PRICE, CLAIM_GAS_SHARE, false), "nor a batch short of full");
    assert!(!claim_due(0, 0, 0.0, ARC_PRICE, CLAIM_GAS_SHARE, true), "and no lines are never a claim");
}

#[test]
fn lines_go_once_they_pay_for_their_gas() {
    // Lines of 0.05 USDC: a claim of one costs more than a tenth of it; enough of them carry the call's part.
    let wait = |n: usize| !claim_due(n, 2, 0.05 * n as f64, ARC_PRICE, CLAIM_GAS_SHARE, false);
    assert!(wait(1));
    let first = (1..CLAIM_BATCH).find(|&n| !wait(n)).expect("some batch short of full pays for itself");
    assert!(first > 1 && (first..CLAIM_BATCH).all(|n| !wait(n)), "from {first} lines on, every claim goes");
    let gas = gas_f(U256::from(ARC_PRICE) * U256::from(CLAIM_GAS.of(first, 2)));
    assert!(gas <= CLAIM_GAS_SHARE * 0.05 * first as f64, "and its gas is within the share: {gas}");
    assert!(claim_due(1, 2, 1.0, ARC_PRICE, CLAIM_GAS_SHARE, false), "a dear line goes alone");
    assert!(!claim_due(10, 20, 0.5, ARC_PRICE, CLAIM_GAS_SHARE, false), "a line goes later when it pays many wallets: each costs the claim gas");
    assert!(!claim_due(1, 2, 1.0, ARC_PRICE * 100, CLAIM_GAS_SHARE, false), "unless gas is dear too: the price is the chain's");
}

#[test]
fn a_closed_stream_goes_however_little_it_pays() {
    // Its epoch is over, so no more lines join it and waiting can't make it cheaper: it goes before its window.
    assert!(claim_due(1, 2, 0.0001, ARC_PRICE * 100, CLAIM_GAS_SHARE, true));
    assert!(claim_due(1, 2, 0.0001, ARC_PRICE, 0.0, true), "whatever share the owner set");
}

#[test]
fn a_full_batch_goes_whatever_it_pays() {
    assert!(claim_due(CLAIM_BATCH, 2, 0.0001, ARC_PRICE, CLAIM_GAS_SHARE, false));
    assert!(claim_due(CLAIM_BATCH * 3, 2, 0.0001, ARC_PRICE, 0.0, false));
}

#[test]
fn a_short_balance_sends_a_smaller_batch() {
    let two = |_: usize| 2;
    let pays_for = |lines: usize| U256::from(ARC_PRICE) * U256::from(2u64) * U256::from(CLAIM_GAS.limit(lines, 2));
    assert_eq!(claim_fits(pays_for(CLAIM_BATCH) * U256::from(5u64), ARC_PRICE, two), CLAIM_BATCH, "never past a full batch");
    assert_eq!(claim_fits(pays_for(7), ARC_PRICE, two), 7);
    assert_eq!(claim_fits(pays_for(7) - U256::from(1u64), ARC_PRICE, two), 6);
    assert_eq!(claim_fits(pays_for(1), ARC_PRICE, two), 1, "down to one line");
    assert_eq!(claim_fits(pays_for(1) - U256::from(1u64), ARC_PRICE, two), 0, "and none it can't pay for");
    assert_eq!(claim_fits(claim_reserve(ARC_PRICE), ARC_PRICE, two), CLAIM_BATCH, "the gas a deposit keeps pays a full batch");
    assert!(claim_fits(pays_for(7), ARC_PRICE, |n| 2 * n) < 7, "fewer when each line pays wallets of its own");
}

/// A claim calls the coin contracts once for each entry its lines pay (Settlement gathers a call's lines by entry and
/// payer), whoever served them: servers are paid nothing.
#[test]
fn a_batch_counts_each_entry_it_pays_once() {
    let (a, b) = (FixedBytes::repeat_byte(1), FixedBytes::repeat_byte(2));
    let line = |entry, holders: Vec<Address>| LeanSettlement::Line { index: U256::ZERO, entryId: entry, amount: U256::ZERO, passed: true, holders, bounty: U256::ZERO };
    let server = Address::repeat_byte(9);
    assert_eq!(earners(&[line(a, vec![]), line(a, vec![])]), 1, "one entry, one coin leg");
    assert_eq!(earners(&[line(a, vec![server]), line(a, vec![server]), line(b, vec![server])]), 2, "a server adds no leg");
    assert_eq!(CLAIM_GAS.of(0, 0), CLAIM_GAS.call, "no lines, no leg");
    assert_eq!(CLAIM_GAS.of(1, 0), CLAIM_GAS.call + CLAIM_GAS.line + CLAIM_GAS.earner, "a line always makes a leg");
}

/// Each payee claims its own lines (R3.22): the payer's claim waits for them through half the last epoch of the
/// window, and then claims what they left, with half an epoch still to go.
#[test]
fn a_payers_claim_waits_for_its_payees_through_half_its_last_epoch() {
    let (e, length) = (20_000, 172_800);
    let window_ends = (e + 1 + 1) * length;
    assert!(!backstop_due(e, e * length + 1, length), "not in its own epoch, when its payees claim");
    assert!(!backstop_due(e, (e + 1) * length, length), "nor as it closes");
    assert!(backstop_due(e, (e + 1) * length + backstop_wait(length), length), "half way through the last epoch of its window");
    assert!(window_ends - ((e + 1) * length + backstop_wait(length)) >= length / 2, "with half an epoch left to claim it");
}

#[test]
fn a_claim_gas_share_is_a_number_zero_or_more() {
    assert_eq!(store::check_claim_gas_share(0.25), Ok(0.25));
    assert_eq!(store::check_claim_gas_share(0.0), Ok(0.0));
    assert!(store::check_claim_gas_share(-0.1).is_err() && store::check_claim_gas_share(f64::NAN).is_err());
    let hand_edited = store::Settings { claim_gas_share: f64::INFINITY, ..Default::default() };
    assert_eq!(hand_edited.claim_gas_share(), CLAIM_GAS_SHARE, "one the node can't read is the default");
    let old: store::Settings = serde_json::from_str(r#"{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[]}"#).unwrap();
    assert_eq!(old.claim_gas_share, CLAIM_GAS_SHARE, "a settings file from before it reads the default");
}

#[test]
fn a_signer_without_gas_is_told_where_to_get_it() {
    let who = Address::repeat_byte(0xab);
    let m = needs_gas(&arc::ARC_TESTNET, who, U256::ZERO, gas_units(0.05));
    assert!(m.contains(&format!("{who:#x}")) && m.contains("arc-testnet USDC") && m.contains("https://faucet.circle.com"), "{m}");
    assert!(m.contains("about 0.05"), "{m}");
    let m = needs_gas(&arc::ARC_MAINNET, who, U256::ZERO, gas_units(0.05));
    assert!(m.contains(&format!("send USDC (its gas) to {who:#x} on arc-mainnet")) && !m.contains("faucet"), "{m}");
}

async fn answering(p: &impl Provider) {
    for _ in 0..100 {
        if p.get_chain_id().await.is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Anvil didn't start");
}

/// The live path end to end, with a local Anvil standing in for Arc testnet (its chain ID, nothing forked, no
/// network): a node starts with no Settlement recorded and runs without it; an owner with no gas is told where to
/// get it and nothing is sent; the owner deploys on the network's own USDC, which writes the owner's network file;
/// a restarted node reads it, pays its own gas, and settles in that USDC's 6 decimals; and an RPC that is another
/// chain is refused.
///
/// Arc's USDC is its gas: the ERC-20 at `arc::Network::usdc` reads and moves the native balance, in 6 decimals
/// where the native level has 18. Anvil has no such token, so a 6-decimal test USDC is put at that address
/// (`stand_in_usdc`) and the native balance stays its own. The test stands in for the one balance by giving the
/// owner as much of each, and by checking each side in its own decimals: the token's amounts in 6, the gas in 18.
/// What it can't show: that a deposit or a claim lowers the gas (on Arc it does, here only the token moves), and
/// that gas spent lowers the token balance; the deposit's gas reserve is checked against the native balance alone.
/// `cargo test -p unbrowse-node-app a_live_network -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_live_network_runs_on_the_contracts_its_file_records() {
    let scratch = std::env::temp_dir().join(format!("unbrowse-live-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::env::set_var("UNBROWSE_HOME", &scratch);
    let (port, other_port) = ("8594", "8595");
    let net = &arc::ARC_TESTNET;
    let mut stand_in = Reaped::spawn(
        Command::new(anvil_bin())
            .args(["--host", "127.0.0.1", "--port", port, "--silent", "--chain-id", &net.chain_id.to_string(), "--base-fee", &arc::BASE_FEE_FLOOR.to_string()])
            .args(["--slots-in-an-epoch", "0"]),
    );
    let mut other_chain = Reaped::spawn(Command::new(anvil_bin()).args(["--host", "127.0.0.1", "--port", other_port, "--silent"]));
    let rpc = format!("http://127.0.0.1:{port}");
    let probe = ProviderBuilder::new().connect_http(rpc.parse().unwrap());
    answering(&probe).await;
    answering(&ProviderBuilder::new().connect_http(format!("http://127.0.0.1:{other_port}").parse().unwrap())).await;
    // The network's own USDC, at its fixed address, in its 6 decimals; the test is its faucet.
    assert_eq!(network_file(net).unwrap().existing.usdc, Some(net.usdc), "the built-in file names it");
    let circle = stand_in_usdc(&rpc, net.usdc, 6).await;
    std::env::set_var("UNBROWSE_CHAIN", net.name);
    std::env::set_var("UNBROWSE_RPC", &rpc);
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    let owner = owner_address(&keys).unwrap();

    // No deployment recorded: the node starts, has no Anvil of its own, and says why Settlement can't be used. The
    // owner's copy of the network's file says so, whatever the built-in one has come to record since.
    let mut unrecorded = network_file(net).unwrap();
    unrecorded.deployment = None;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &unrecorded).unwrap();
    let chain = Chain::default();
    assert!(chain.start().await.expect("the node starts on arc-testnet").is_none());
    assert!(chain.anvil.locked().is_none(), "no Anvil started");
    assert_eq!(url().as_str(), format!("{rpc}/"), "every provider uses the network's RPC");
    assert_eq!(chain.deployed().unwrap_err(), not_deployed("arc-testnet"));
    assert_eq!(deposit(&chain, &keys, 1.0).await.unwrap_err(), not_deployed("arc-testnet"));
    assert!(not_deployed("arc-testnet").contains("no route-coin contracts") && not_deployed("arc-testnet").contains("sends no transaction"));
    assert_eq!(crate::erc8004::registry_of(&chain).map(|n| n.name), Some(net.name));
    assert_eq!(chain.registry_from().unwrap(), network_file(net).unwrap().registry_from.unwrap());
    // A chain that only says it is Arc testnet has no registry there: nothing is registered or sent.
    let e = crate::erc8004::ensure(&chain, &keys, "a node").await.unwrap_err();
    assert!(e.contains("no ERC-8004 registry"), "{e}");

    // Gas is the owner's own: with none, the deployment is refused before anything is sent, and no cheat pays it.
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let seed = PoolSeed { usdc: 1_000.0, unb: 1_000.0 };
    let e = deploy_shared(&l, &keys, Some(seed), &DEVNET_OPEN).await.unwrap_err();
    assert!(e.contains(&format!("{owner:#x}")) && e.contains("faucet"), "{e}");
    assert_eq!(probe.get_balance(owner).await.unwrap(), U256::ZERO);
    assert_eq!(probe.get_transaction_count(owner).await.unwrap(), 0);

    // With gas, a pool beside the network's own USDC is never seeded with an amount nobody set, nor with USDC the
    // owner doesn't hold: both are refused before anything is sent.
    let funded = gas_units(10_000.0);
    let _: serde_json::Value = probe.raw_request("anvil_setBalance".into(), (owner, funded)).await.unwrap();
    let e = deploy_shared(&l, &keys, None, &DEVNET_OPEN).await.unwrap_err();
    assert!(e.contains("say how much USDC and UNB"), "{e}");
    let e = deploy_shared(&l, &keys, Some(seed), &DEVNET_OPEN).await.unwrap_err();
    assert!(e.contains("holds 0 USDC and the pool's seed is 1000"), "{e}");
    assert_eq!(probe.get_transaction_count(owner).await.unwrap(), 0, "nothing sent");

    // The owner gets USDC from the network's faucet, as much as it has gas, and deploys: Settlement on the
    // network's own USDC, the test UNB, and a pool seeded from the owner's USDC and minted UNB.
    mint_stand_in(&rpc, &circle, net.usdc, owner, 10_000.0).await;
    let (path, file) = deploy_shared(&l, &keys, Some(seed), &DEVNET_OPEN).await.expect("the owner deploys");
    assert_eq!(path, scratch.join("networks").join("arc-testnet.json"));
    let d = file.deployment.clone().unwrap();
    assert_eq!((d.chain_id, file.chain_id, file.registry_from), (net.chain_id, net.chain_id, network_file(net).unwrap().registry_from));
    assert_eq!((d.usdc, d.usdc_decimals), (net.usdc, 6), "the network's own USDC, its decimals recorded");
    println!("deployed UNB {:#x} Settlement {:#x} in block {} for {} USDC of gas", d.unb, d.settlement, d.block, gas_f(funded - probe.get_balance(owner).await.unwrap()));
    assert_eq!(network_file(net).unwrap().deployment.map(|f| f.settlement), Some(d.settlement), "the owner's file is read over the built-in one");
    assert!(deploy_shared(&l, &keys, Some(seed), &DEVNET_OPEN).await.unwrap_err().contains("already deployed"), "never a second Settlement");
    assert!(chain.deployed().is_err(), "a running node takes the deployment at its next start");
    let usdc = USDC::new(net.usdc, &probe);
    assert_eq!(usdc.balanceOf(owner).call().await.unwrap(), usdc_units(9_000.0, 6), "the seed came from the owner's USDC");

    // Restarted, the node reads it. Writes pay their own gas; the owner deployed UNB, so its faucet is theirs, and
    // the network's own USDC is never minted.
    drop(chain);
    let chain = Chain::default();
    assert_eq!(chain.start().await.unwrap().map(|d| (d.settlement, d.usdc_decimals)), Some((d.settlement, 6)));
    faucet(&chain, &keys, 300_000.0).await.unwrap();
    assert_eq!(usdc.balanceOf(owner).call().await.unwrap(), usdc_units(9_000.0, 6), "the faucet minted UNB alone");
    deposit(&chain, &keys, 1_000.0).await.unwrap();
    set_fee(&chain, &keys, 0.5, None).await.unwrap();
    // A listing is signed under the owner's ERC-8004 identity (spec §76.1), registered the first time: the stand-in
    // registry goes where Arc testnet's is, as on Arc, and the owner pays its gas.
    let registry: Bytes = include_str!("../../tests/fixtures/erc8004/Erc8004StandIn.runtime.hex").trim().parse().unwrap();
    let _: serde_json::Value = probe.raw_request("anvil_setCode".into(), (net.identity, registry)).await.unwrap();
    list_entry(&chain, &keys, "route-a", "news.example", "Search news").await.unwrap();
    let w = wallet(&chain, &keys).await.unwrap();
    assert_eq!((w.chain_id, w.deposit, w.held), (net.chain_id, 1_000.0, 8_000.0));
    let s = LeanSettlement::new(d.settlement, &probe);
    assert_eq!(s.account(owner).call().await.unwrap().balance, U256::from(1_000_000_000u64), "a thousand USDC, in 6 decimals");
    assert_eq!(s.feeOf(owner).call().await.unwrap(), U256::from(500_000u64));
    assert_eq!(entry(&chain, "route-a").await.unwrap().unwrap().fee, 0.5);
    assert!(advance_day(&chain).await.unwrap_err().contains("keeps real time"));

    // A deposit never takes the gas the node keeps: the token here is the gas on Arc, so it is checked against
    // the gas the owner has left.
    let all_the_gas = gas_f(probe.get_balance(owner).await.unwrap());
    let e = deposit(&chain, &keys, all_the_gas).await.unwrap_err();
    assert!(e.contains("which is its gas too") && e.contains("it can deposit at most"), "{e}");

    // An agent key's cap, the receipt line it signs and the claim are all in the USDC's 6 decimals.
    authorize(&chain, &keys, 0, 10.0, 0).await.unwrap();
    assert_eq!(s.agentOf(owner, agent_signer(&keys, 0).unwrap().address()).call().await.unwrap().capPerEpoch, U256::from(10_000_000u64));
    let epoch = current_epoch(&chain).await.unwrap();
    add_receipt(0, epoch, "route-a", 0.5, true, 0.0, 10.0, 1_000.0).unwrap();
    claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("the line is claimed");
    let paid = s.claimedOf(owner, agent_signer(&keys, 0).unwrap().address(), epoch).call().await.unwrap();
    assert_eq!(paid, U256::from(500_000u64), "the fee's units, exactly");
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, 999.5);

    // Gas to send a claim of three lines, not of all ten waiting: the node sends batches no bigger than its gas
    // covers, sized again from what is left after each, rather than one it can't pay for or none.
    let price = probe.get_gas_price().await.unwrap();
    let few = U256::from(price) * U256::from(2u64) * U256::from(CLAIM_GAS.limit(3, 1));
    let _: serde_json::Value = probe.raw_request("anvil_setBalance".into(), (owner, few)).await.unwrap();
    for _ in 0..10 {
        add_receipt(0, epoch, "route-a", 0.5, true, 0.0, 10.0, 1_000.0).unwrap();
    }
    let open = || receipts(0, epoch).unwrap().iter().filter(|r| r.passed && !r.claimed).count();
    let sent = probe.get_transaction_count(owner).await.unwrap();
    claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("smaller batches are claimed");
    let (paid_lines, txs) = (10 - open(), (probe.get_transaction_count(owner).await.unwrap() - sent) as usize);
    assert!(paid_lines > 0, "the gas pays for some");
    // A balance that covers a three-line claim's sending limit sends batches of at most three: the node never sends a
    // batch whose limit its balance can't cover. The limit is far above what a claim uses (Settlement wants a coin
    // leg's gas in hand before it starts one, `LEG_RESERVE`), so what a batch leaves can cover a smaller one after it;
    // it never covers all ten.
    assert!(paid_lines < 10 && txs >= paid_lines.div_ceil(3), "no batch carried more than the balance covered: {paid_lines} lines in {txs} claims");
    let paid = d.usdc_f(s.claimedOf(owner, agent_signer(&keys, 0).unwrap().address(), epoch).call().await.unwrap());
    assert!((paid - 0.5 * (1 + paid_lines) as f64).abs() < 1e-9, "what was claimed was paid: {paid}");
    // With gas for no line, the owner is told where to get it and nothing is sent.
    add_receipt(0, epoch, "route-a", 0.5, true, 0.0, 10.0, 1_000.0).unwrap();
    let left = open();
    let _: serde_json::Value = probe.raw_request("anvil_setBalance".into(), (owner, U256::from(price))).await.unwrap();
    let sent = probe.get_transaction_count(owner).await.unwrap();
    let e = claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap_err();
    assert!(e.contains("for gas") && e.contains("faucet"), "{e}");
    assert_eq!((open(), probe.get_transaction_count(owner).await.unwrap()), (left, sent), "nothing sent");
    let _: serde_json::Value = probe.raw_request("anvil_setBalance".into(), (owner, funded)).await.unwrap();
    claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("with gas, the rest");
    assert_eq!(open(), 0);
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, 994.0, "every line paid, once");

    // Another owner: UNB's faucet isn't theirs, and with no gas a write is refused and nothing pays it.
    let other = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&other).unwrap();
    let them = owner_address(&other).unwrap();
    assert!(faucet(&chain, &other, 1.0).await.unwrap_err().contains("minted only by"));
    let e = deposit(&chain, &other, 1.0).await.unwrap_err();
    assert!(e.contains(&format!("{them:#x}")) && e.contains("arc-testnet USDC"), "{e}");
    assert_eq!(probe.get_balance(them).await.unwrap(), U256::ZERO, "no cheat paid its gas");

    // The deploy stood up a pool of the network's USDC and the test UNB, seeded as the owner said, and Settlement
    // swaps through it.
    assert_eq!(s.pool().call().await.unwrap(), d.pool);
    let pool = UnbPool::new(d.pool, &probe);
    assert_eq!((pool.usdc().call().await.unwrap(), pool.unb().call().await.unwrap()), (d.usdc, d.unb));
    // Seeded with 1,000 of each. A claim buys UNB through it only for a fetch's buy of the entry's coin (route-a has
    // none, so its route share is owed to its contributor), never to burn in the claim: USDC goes in and UNB comes out.
    let (in_usdc, in_unb) = (pool.reserveUsdc().call().await.unwrap(), pool.reserveUnb().call().await.unwrap());
    assert!(in_usdc >= usdc_units(1_000.0, 6) && in_unb <= unb_units(1_000.0), "seeded with 1,000 of each: {in_usdc} USDC units, {in_unb} UNB units");
    let fetch = CoinFetch::new(d.coins.coin_fetch, &probe);
    assert!(fetch.owedOf(owner).call().await.unwrap() > U256::ZERO, "an entry with no coin: its route share is owed to its contributor (`coin.split`)");
    assert!(s.burnBuffer().call().await.unwrap() > U256::ZERO, "the claims' burn share waits in the buffer for burnBatch");

    // A network whose file names its pool builds Settlement on it: the tokens are the pool's, and nothing but the
    // domain proofs, the coin set and Settlement are deployed. One that names a token the pool doesn't trade
    // is refused before anything is sent.
    let mut named = network_file(net).unwrap();
    named.deployment = None;
    named.existing = Existing { usdc: Some(d.unb), pool: Some(d.pool), ..Default::default() };
    store::write_json(&path, &unbrowse_files::NETWORK, &named).unwrap();
    let sent = probe.get_transaction_count(owner).await.unwrap();
    let e = deploy_shared(&l, &keys, None, &DEVNET_OPEN).await.unwrap_err();
    assert!(e.contains("its pool trades"), "{e}");
    assert_eq!(probe.get_transaction_count(owner).await.unwrap(), sent, "nothing sent");
    named.existing = Existing { pool: Some(d.pool), ..Default::default() };
    store::write_json(&path, &unbrowse_files::NETWORK, &named).unwrap();
    let (_, on_pool) = deploy_shared(&l, &keys, None, &DEVNET_OPEN).await.expect("Settlement on the named pool");
    let d2 = on_pool.deployment.unwrap();
    assert_eq!((d2.usdc, d2.usdc_decimals, d2.unb, d2.pool), (d.usdc, 6, d.unb, d.pool), "the pool's own pair");
    assert_ne!(d2.settlement, d.settlement);
    assert_eq!(probe.get_transaction_count(owner).await.unwrap(), sent + 6, "only the domain proofs, the four coin contracts and Settlement were sent");
    assert_eq!(on_pool.existing, named.existing, "the file keeps what it named");

    // An RPC that answers as another chain is never taken for the network.
    std::env::set_var("UNBROWSE_RPC", format!("http://127.0.0.1:{other_port}"));
    let e = Chain::default().start().await.unwrap_err();
    assert!(e.contains("is chain 31337, not arc-testnet"), "{e}");

    for c in [&mut stand_in, &mut other_chain] {
        let _ = c.kill();
        let _ = c.wait();
    }
    std::env::remove_var("UNBROWSE_CHAIN");
    std::env::remove_var("UNBROWSE_RPC");
    set_live(None);
    let _ = std::fs::remove_dir_all(&scratch);
}

/// A node on Arc testnet itself, read only: the RPC answers as Arc testnet, the registry is there, and the node
/// starts whether or not the built-in file records Settlement yet. Nothing is signed or sent. Needs the network:
/// `cargo test -p unbrowse-node-app a_node_starts_on_arc_testnet -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the network"]
async fn a_node_starts_on_arc_testnet() {
    let scratch = std::env::temp_dir().join(format!("unbrowse-arc-testnet-test-{}", std::process::id()));
    std::env::set_var("UNBROWSE_HOME", &scratch);
    std::env::set_var("UNBROWSE_CHAIN", "arc-testnet");
    std::env::remove_var("UNBROWSE_RPC");
    let chain = Chain::default();
    let d = chain.start().await.expect("Arc testnet answers as itself");
    match network_file(&arc::ARC_TESTNET).unwrap().deployment {
        Some(f) => assert_eq!(d.map(|d| d.settlement), Some(f.settlement)),
        None => assert_eq!(chain.deployed().unwrap_err(), not_deployed("arc-testnet")),
    }
    let net = crate::erc8004::registry_of(&chain).expect("the registry, by chain ID");
    let p = ProviderBuilder::new().connect_http(url());
    assert!(!p.get_code_at(net.identity).await.unwrap().is_empty(), "the real IdentityRegistry");
    assert!(chain.registry_from().unwrap() <= p.get_block_number().await.unwrap());
    std::env::remove_var("UNBROWSE_CHAIN");
    set_live(None);
    let _ = std::fs::remove_dir_all(&scratch);
}

#[test]
fn a_devnet_mark_is_named_by_its_secret_alone() {
    let (a, x) = mark_of(&[1; 32]);
    assert_eq!((a, x), mark_of(&[1; 32]));
    let (b, y) = mark_of(&[2; 32]);
    assert!(a != b && x != y);
    assert!(x > U256::ZERO);
}

#[test]
fn a_single_leaf_is_its_own_root() {
    let a = keccak256(b"a");
    let (root, proofs) = merkle(&[a]);
    assert_eq!(root, a);
    assert!(proofs[0].is_empty());
}

#[test]
fn proofs_verify_against_the_root() {
    let leaves: Vec<_> = (0..5u8).map(|i| keccak256([i])).collect();
    let (root, proofs) = merkle(&leaves);
    for (leaf, proof) in leaves.iter().zip(&proofs) {
        let mut h = *leaf;
        for p in proof {
            h = if h <= *p { keccak256([h.as_slice(), p.as_slice()].concat()) } else { keccak256([p.as_slice(), h.as_slice()].concat()) };
        }
        assert_eq!(h, root);
    }
}

#[test]
fn a_log_read_longer_than_the_cap_pages() {
    assert_eq!(log_windows(5, 5), vec![(5, 5)]);
    assert_eq!(log_windows(0, 9_999), vec![(0, 9_999)]);
    assert_eq!(log_windows(0, 25_000), vec![(0, 9_999), (10_000, 19_999), (20_000, 25_000)]);
    assert!(log_windows(10, 9).is_empty(), "nothing to read before the start");
    for (a, b) in log_windows(123, 1_000_000) {
        assert!(b - a < LOG_WINDOW, "window {a}..={b} is wider than the RPC allows");
    }
    assert_eq!(log_windows(u64::MAX - 3, u64::MAX), vec![(u64::MAX - 3, u64::MAX)], "the last block ends the read");
}

/// Every agent's passed, unclaimed lines in epochs still claimable count against the deposit; failed, claimed
/// and lapsed lines don't.
#[test]
fn a_line_is_never_signed_past_the_payers_deposit() {
    let folder = std::env::temp_dir().join(format!("unbrowse-covers-test-{}", std::process::id()));
    let line = |amount: f64, passed: bool, claimed: bool| Receipt {
        index: 0,
        route_id: "r".into(),
        amount,
        passed,
        claimed,
        at: 0,
        entry: None,
        holders: None,
        bounty: None,
        lapsed: false,
        unwitnessed: false,
    };
    store::write_json(&folder.join("0-9.json"), &unbrowse_files::RECEIPTS, &vec![line(4.0, true, false), line(2.0, false, false), line(50.0, true, true)]).unwrap();
    store::write_json(&folder.join("1-10.json"), &unbrowse_files::RECEIPTS, &vec![line(3.0, true, false)]).unwrap();
    store::write_json(&folder.join("1-8.json"), &unbrowse_files::RECEIPTS, &vec![line(100.0, true, false)]).unwrap(); // its window has closed
    store::write_json(&folder.join("1-20764.json"), &unbrowse_files::RECEIPTS, &vec![line(100.0, true, false)]).unwrap(); // another deployment's epochs: R1.28
    let none = std::collections::BTreeMap::new();
    let all = |_: u32, _: u64| true;
    // The failed line of 2.0 is never charged, so it draws nothing.
    assert_eq!(unclaimed(&folder, 10, all), Ok(7.0));
    assert_eq!(unclaimed(&folder, 10, |a, _| a == 1), Ok(3.0), "one payer's streams");
    assert!(covered_by(&folder, 10, 3.0, 10.0, &none, all).is_ok());
    assert!(covered_by(&folder, 10, 3.5, 10.0, &none, all).is_err(), "7 already signed for, 3.5 more is past a deposit of 10");
    assert!(covered_by(&folder.join("none"), 10, 3.5, 3.5, &none, all).is_ok());
    // A call in flight holds its place against the deposit too, in any agent's stream still claimable.
    let places = std::collections::BTreeMap::from([((2, 10), 1.0), ((0, 3), 50.0)]);
    assert!(covered_by(&folder, 10, 2.5, 10.0, &places, all).is_err(), "7 signed and 1 held: 2.5 more is past 10");
    assert!(covered_by(&folder, 10, 2.0, 10.0, &places, all).is_ok(), "a place in a closed window holds nothing");
    assert!(covered_by(&folder, 10, 6.0, 10.0, &places, |a, _| a == 1).is_ok(), "another payer's place holds nothing either");
    // A receipt file that doesn't read is an error, never nothing signed.
    std::fs::write(folder.join("3-10.json"), "not json").unwrap();
    assert!(unclaimed(&folder, 10, all).is_err());
    assert!(covered_by(&folder, 10, 0.1, 1_000.0, &none, all).is_err());
    let _ = std::fs::remove_dir_all(&folder);
}

fn line(amount: f64, passed: bool, claimed: bool) -> Receipt {
    Receipt { index: 0, route_id: "r".into(), amount, passed, claimed, at: 0, entry: None, holders: Some(vec![]), bounty: None, lapsed: false, unwitnessed: false }
}

/// A receipt file written while lines carried a trial-credit flag still reads, and makes the line it always made:
/// every line it wrote was a paid one. So does a line a peer sends with the flag.
#[test]
fn a_receipt_or_line_that_names_credit_still_reads() {
    let old: Vec<Receipt> = serde_json::from_value(serde_json::json!([{ "index": 2, "route_id": "r", "amount": 0.01, "passed": true,
        "claimed": false, "at": 7, "holders": [], "credit": false }])).unwrap();
    assert_eq!((old[0].index, old[0].amount, old[0].passed), (2, 0.01, true));
    let l = line_of(&old[0], 6);
    assert_eq!((l.index, l.amount, l.holders.len()), (U256::from(2), U256::from(10_000u64), 0));
    let run = Running {
        voucher: LeanSettlement::Voucher { payer: Address::ZERO, agent: Address::ZERO, epoch: 1, cumulative: l.amount, lines: 1, passedLines: 1, receiptsRoot: line_leaf(&l) },
        sig: Bytes::new(),
        lines: vec![l],
        proofs: vec![vec![]],
    };
    let mut sent = serde_json::to_value(PaidLine::of(&run, 0).unwrap()).unwrap();
    sent.as_object_mut().unwrap().insert("credit".into(), serde_json::json!(false));
    let read: PaidLine = serde_json::from_value(sent).unwrap();
    assert_eq!(line_leaf(&read.line()), line_leaf(&line_of(&old[0], 6)));
}

/// The cap counts every passed line signed for the epoch, claimed or not, and every place a call in flight holds,
/// so a call the key's cap can't cover is refused before it fetches a body or reaches the site. Here the claim loop
/// has marked one line claimed while the contract's count read earlier still says 0: that line still counts.
#[test]
fn cap_is_checked_before_the_site_is_called() {
    let _home = store::scratch_home("cap-before-site");
    let (agent, epoch) = (901, 50_000);
    store::write_json(&receipts_path(agent, epoch), &unbrowse_files::RECEIPTS, &vec![line(0.4, true, true), line(0.4, true, false)]).unwrap();
    let refused = reserve(agent, epoch, 0.4, 0.0, 1.0, 100.0).expect_err("0.8 signed, 0.4 more passes a cap of 1");
    assert!(refused.contains("daily limit of $1.00"), "{refused}");
    let place = reserve(agent, epoch, 0.2, 0.0, 1.0, 100.0).expect("0.2 fits");
    assert!(reserve(agent, epoch, 0.1, 0.0, 1.0, 100.0).is_err(), "the place taken counts");
    // The contract paid more than this file shows (lines another device signed): that counts instead.
    assert!(reserve(agent + 1, epoch, 0.4, 0.7, 1.0, 100.0).is_err());
    drop(place);
    assert!(reserve(agent, epoch, 0.2, 0.0, 1.0, 100.0).is_ok(), "a call that ended without a line gave its place back");
}

/// Calls checked at once can't both take the last room under the cap: of ten calls of 0.3 against a cap of 1.0,
/// three get a place and the others are refused, and the lines they write sum to no more than the cap.
#[test]
fn no_passed_line_past_the_cap() {
    let home = store::scratch_home("no-line-past-cap");
    let (agent, epoch) = (902, 60_000);
    let places: Vec<_> = (0..10)
        .map(|_| {
            let home = home.clone();
            std::thread::spawn(move || {
                store::use_home(&home);
                reserve(agent, epoch, 0.3, 0.0, 1.0, 100.0).ok().map(|p| p.network_line(test_entry("route-a"), None, true).unwrap())
            })
        })
        .collect();
    let written: Vec<Receipt> = places.into_iter().filter_map(|t| t.join().unwrap()).collect();
    assert_eq!(written.len(), 3);
    let lines = receipts(agent, epoch).unwrap();
    assert!((lines.iter().map(|r| r.amount).sum::<f64>() - 0.9).abs() < 1e-9);
    let mut indexes: Vec<u64> = lines.iter().map(|r| r.index).collect();
    indexes.sort();
    assert_eq!(indexes, [0, 1, 2], "indexes stay dense and unique");
    // A failed use writes its line at its fee, and holds no room once written: it is never charged.
    let failed = reserve(agent, epoch, 0.1, 0.0, 1.0, 100.0).unwrap().network_line(test_entry("route-a"), None, false).unwrap();
    assert!(!failed.passed && (failed.amount - 0.1).abs() < 1e-9);
    let last = reserve(agent, epoch, 0.1, 0.0, 1.0, 100.0).expect("0.9 passed, so 0.1 more fits beside the failure");
    assert!(reserve(agent, epoch, 0.1, 0.0, 1.0, 100.0).is_err(), "the last place is taken: nothing more fits");
    drop(last);
}

/// A voucher counts every line and the passed ones (R3.13), and its total is the passed lines' amounts: the contract
/// charges only passed lines against it, and a failed line draws nothing.
#[test]
fn a_voucher_counts_its_lines_and_totals_its_passed_ones() {
    let l = |index: u64, amount: u64, passed: bool| LeanSettlement::Line { index: U256::from(index), entryId: test_entry("route-a"), amount: U256::from(amount), passed, holders: vec![], bounty: U256::ZERO };
    let lines = [l(0, 10, true), l(1, 5, false), l(2, 7, true), l(3, 3, false)];
    let v = voucher_over(Address::repeat_byte(1), Address::repeat_byte(2), 9, &lines, FixedBytes::repeat_byte(3));
    assert_eq!((v.lines, v.passedLines), (4, 2));
    assert_eq!(v.cumulative, U256::from(17u64), "the total is the passed lines', 10 and 7");
    let none = voucher_over(Address::ZERO, Address::ZERO, 9, &[], FixedBytes::ZERO);
    assert_eq!((none.lines, none.passedLines, none.cumulative), (0, 0, U256::ZERO));
}

/// The node signs the digest the contract checks: the EIP-712 hash of the voucher type with its counts, computed
/// here by hand from the contract's type string.
#[test]
fn the_voucher_digest_is_the_contracts() {
    use alloy::sol_types::SolValue;
    let d = Deployment { settlement: Address::repeat_byte(9), chain_id: 5042, ..Default::default() };
    let v = LeanSettlement::Voucher {
        payer: Address::repeat_byte(1),
        agent: Address::repeat_byte(2),
        epoch: 20_717,
        cumulative: U256::from(22u64),
        lines: 3,
        passedLines: 2,
        receiptsRoot: FixedBytes::repeat_byte(4),
    };
    let typehash = keccak256(b"Voucher(address payer,address agent,uint64 epoch,uint256 cumulative,uint64 lines,uint64 passedLines,bytes32 receiptsRoot)");
    let strukt = keccak256((typehash, v.payer, v.agent, v.epoch, v.cumulative, v.lines, v.passedLines, v.receiptsRoot).abi_encode_params());
    let dom = keccak256(
        (
            keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(b"Unbrowse Settlement"),
            keccak256(b"1"),
            U256::from(d.chain_id),
            d.settlement,
        )
            .abi_encode_params(),
    );
    assert_eq!(voucher_digest(&d, &v), keccak256([&b"\x19\x01"[..], dom.as_slice(), strukt.as_slice()].concat()));
    let mut fewer = v.clone();
    fewer.passedLines = 3;
    assert_ne!(voucher_digest(&d, &fewer), voucher_digest(&d, &v), "the counts are signed");
}

/// Every entry is a body's (`Listings.entryIdOf`), never a route's: two routes listing one body are one entry, and
/// the key a route is staked on is another namespace.
#[test]
fn an_entry_is_its_bodys() {
    let id = content_entry_id("sha256:ab");
    assert_eq!(id, keccak256(b"unbrowse/content/sha256:ab"));
    assert_ne!(id, entry_id("sha256:ab"), "a route key is another namespace");
}

/// A network's records outlive its deployments, and epochs count blocks (R1.28): an arc-testnet node comes to a new
/// deployment holding records from epoch 20,764 of the old timestamp count, when the chain says about 418.
#[test]
fn a_record_from_an_epoch_the_chain_hasnt_reached_is_another_deployments() {
    assert!(claimable(418, 418) && claimable(417, 418), "this epoch and the last");
    assert!(!claimable(416, 418), "its window has closed");
    assert!(!claimable(20_764, 418), "the old count, thousands of epochs ahead of the chain");
}

/// One epoch is the chain's own pace (R1.28), so a network that hasn't been measured can't be deployed on: nothing
/// stands in for its number, and the deploy fixes it for good.
#[test]
fn a_network_with_no_measured_epoch_cant_be_deployed_on() {
    let net = &arc::ARC_MAINNET;
    assert_eq!(epoch_blocks(net, Some(170_000)), Ok(170_000));
    assert!(epoch_blocks(net, None).unwrap_err().contains("epoch_blocks"));
    assert!(epoch_blocks(net, Some(0)).is_err(), "zero is none");
    let shipped: NetworkFile = serde_json::from_str(net.file).unwrap();
    assert_eq!(shipped.epoch_blocks, None, "mainnet's is the owner's to measure");
}

/// What the wallet says is left of the day is the blocks left, at a day's pace; never a rule, and never negative.
#[test]
fn the_end_of_an_epoch_is_read_from_the_blocks_left() {
    let length = 172_800;
    assert_eq!(epoch_ends_in(10, 10 * length, length), EPOCH, "a whole epoch to go");
    assert_eq!(epoch_ends_in(10, 10 * length + length / 2, length), EPOCH / 2, "half");
    assert_eq!(epoch_ends_in(10, 11 * length, length), 0, "none at the boundary");
    assert_eq!(epoch_ends_in(10, 12 * length, length), 0, "and none past it");
}

/// The escrow wait is a deploy-time choice: the network's file, else `UNBROWSE_ESCROW_WAIT`, else 14 epochs.
/// The open value (R10.11) has no default: it is checked before a deploy sends anything, as the contract checks it.
#[test]
fn the_open_values_are_the_deployers_and_never_zero() {
    // Nothing is left to name at deployment: the witnesses' values went with them (owner, 11 November 2026), the juror
    // stake with the fraud court.
    for open in [DEVNET_OPEN, OpenValues::default()] {
        assert!(open.units().is_ok(), "{open:?} asks nothing");
    }
}

#[test]
fn the_escrow_wait_is_the_deploys_choice() {
    assert_eq!(escrow_wait(Some(3)).unwrap(), 3);
    if std::env::var_os("UNBROWSE_ESCROW_WAIT").is_none() {
        assert_eq!(escrow_wait(None).unwrap(), ESCROW_WAIT);
    }
}

/// A line is filed under the voucher epoch its place was taken in, the one its cap was read for, never under an
/// epoch the call guessed after the fact (epoch 0 when the chain didn't answer).
#[test]
fn passed_lines_are_filed_under_their_real_epoch() {
    let _home = store::scratch_home("line-epoch");
    let (agent, epoch) = (903, 70_000);
    let place = reserve(agent, epoch, 0.5, 0.0, 10.0, 100.0).unwrap();
    place.network_line(test_entry("route-a"), None, true).unwrap();
    assert_eq!(receipts(agent, epoch).unwrap().len(), 1);
    assert!(!receipts_path(agent, 0).exists(), "nothing under epoch 0");
}

/// A receipt file that is there and doesn't read stops paid calls for that agent: no place is taken, no line is
/// written, and the file is never written over with a shorter ledger.
#[test]
fn receipt_ledger_never_shrinks() {
    let _home = store::scratch_home("ledger-never-shrinks");
    let (agent, epoch) = (904, 80_000);
    let path = receipts_path(agent, epoch);
    store::write_json(&path, &unbrowse_files::RECEIPTS, &vec![line(1.0, true, false), line(1.0, true, false), line(1.0, true, false)]).unwrap();
    let kept = std::fs::read(&path).unwrap();
    let mut torn = kept.clone();
    torn.truncate(kept.len() / 2);
    std::fs::write(&path, &torn).unwrap();
    assert!(receipts(agent, epoch).is_err(), "a file that doesn't read is an error, not an empty ledger");
    assert!(reserve(agent, epoch, 1.0, 0.0, 10.0, 100.0).is_err());
    assert!(add_receipt(agent, epoch, "route-a", 1.0, true, 0.0, 10.0, 100.0).is_err());
    assert!(add_receipt(agent, epoch, "route-a", 1.0, false, 0.0, 10.0, 100.0).is_err(), "a failed line isn't written over it either");
    assert_eq!(std::fs::read(&path).unwrap(), torn, "nothing wrote over the file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, &kept).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = std::fs::read(&path).is_err();
        if unreadable {
            assert!(add_receipt(agent, epoch, "route-a", 1.0, true, 0.0, 10.0, 100.0).is_err(), "an unreadable file is an error too");
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(receipts(agent, epoch).unwrap().len(), 3, "the three signed lines are all still there");
    }
}

/// Each token's sums come back as the units they went in as: USDC in its deployment's decimals (Arc's 6, a
/// devnet's 18), UNB and the native gas in 18.
#[test]
fn amounts_carry_their_tokens_decimals() {
    let e = |d: u64| U256::from(10u64).pow(U256::from(d));
    for d in [6u8, 18] {
        assert_eq!(usdc_f(usdc_units(1234.567891, d), d), 1234.567891, "{d} decimals");
        assert_eq!(usdc_units(1.0, d), e(u64::from(d)));
        // Written as a decimal, never multiplied as a float: 0.29 is 0.29, not a unit under it.
        assert_eq!(usdc_units(0.29, d), U256::from(29u64) * e(u64::from(d) - 2));
        assert_eq!(usdc_units(0.0, d), U256::ZERO);
        assert_eq!((usdc_units(-1.0, d), usdc_units(f64::NAN, d)), (U256::ZERO, U256::ZERO), "nothing that isn't a sum");
    }
    assert_eq!(usdc_units(1.0, 6), U256::from(1_000_000u64));
    assert_eq!(usdc_f(U256::from(631_026_622u64), 6), 631.026622);
    assert_eq!((unb_units(1.0), gas_units(1.0)), (e(18), e(18)));
    assert_eq!(unb_f(e(18) * U256::from(250_000u64)), 250_000.0);
    assert_eq!(gas_f(U256::from(25u64) * e(9) * U256::from(2_000_000u64)), 0.05, "a write's reserve at 25 gwei");
    assert_eq!(whole(U256::from(7u64), 0), 7.0);
}

/// A sum finer than a USDC's smallest unit never rounds in the payer's favour past what the owner set: a fee
/// rounds up, so its contributor is paid at least it, and a deposit or a key's cap rounds down, so no more is
/// moved or allowed than the owner said. A fee read back from the chain turns into its own units again.
#[test]
fn a_sum_finer_than_a_unit_rounds_against_the_payer_never_past_the_setting() {
    assert_eq!(usdc_fee_units(0.0000015, 6), U256::from(2u64), "a fee rounds up");
    assert_eq!(usdc_units(0.0000015, 6), U256::from(1u64), "a cap or a deposit rounds down");
    assert_eq!(usdc_fee_units(0.0000001, 6), U256::from(1u64), "a fee above zero is never free");
    assert_eq!(usdc_fee_units(0.01, 6), U256::from(10_000u64), "a whole number of units stays as it is");
    for units in [1u64, 10_000, 123_456, 50_000_000, 1_000_000_000_007] {
        let u = U256::from(units);
        assert_eq!(usdc_fee_units(usdc_f(u, 6), 6), u, "{units}");
        assert_eq!(usdc_units(usdc_f(u, 6), 6), u, "{units}");
    }
}

/// A receipt file an 18-decimal devnet kept before decimals were recorded makes the same lines and voucher total
/// it always did: its amounts were whole USDC as the chain said them, never finer than a millionth, and an 18-
/// decimal deployment turns them into the units the node used to send.
#[test]
fn an_old_receipt_on_an_18_decimal_devnet_makes_the_same_lines() {
    let old_units = |x: f64| U256::from((x * 1e6).round() as u128) * U256::from(1_000_000_000_000u64);
    let old: Vec<Receipt> = serde_json::from_str(
        r#"[{"index":0,"route_id":"r","amount":0.5,"passed":true,"claimed":true,"at":1},
            {"index":1,"route_id":"r","amount":0.0,"passed":false,"claimed":false,"at":2},
            {"index":2,"route_id":"r","amount":0.29,"passed":true,"claimed":false,"at":3},
            {"index":3,"route_id":"r","amount":0.000123,"passed":true,"claimed":false,"at":4}]"#,
    )
    .unwrap();
    let old_deployment: Deployment = serde_json::from_str(
        r#"{"usdc":"0x0000000000000000000000000000000000000003","unb":"0x0000000000000000000000000000000000000001","settlement":"0x0000000000000000000000000000000000000002","chain_id":31337,"block":1}"#,
    )
    .unwrap();
    assert_eq!(old_deployment.usdc_decimals, 18, "a deployment that recorded none was an 18-decimal test USDC");
    for r in &old {
        assert_eq!(line_of(r, old_deployment.usdc_decimals).amount, old_units(r.amount), "line {}", r.index);
    }
    let total = old.iter().filter(|r| r.passed).fold(U256::ZERO, |t, r| t + line_of(r, 18).amount);
    assert_eq!(total, old_units(0.5 + 0.29 + 0.000123), "the voucher's total, as it was");
    // The same file on a 6-decimal deployment: the same fees, in its units.
    assert_eq!(line_of(&old[2], 6).amount, U256::from(290_000u64));
    assert_eq!(line_of(&old[3], 6).amount, U256::from(123u64));
}

/// A new devnet forks Arc testnet: the chain is Arc testnet's, the real ERC-8004 IdentityRegistry and USDC are at
/// their real addresses, and the contracts are deployed by the devnet's own key, never one of Anvil's public
/// accounts. Needs the network:
/// `cargo test -p unbrowse-node-app a_new_devnet_forks_arc -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the network"]
async fn a_new_devnet_forks_arc_testnet() {
    let scratch = std::env::temp_dir().join(format!("unbrowse-fork-test-{}", std::process::id()));
    std::env::set_var("UNBROWSE_HOME", &scratch);
    std::env::set_var("UNBROWSE_DEVNET_PORT", "8597");
    let chain = Chain::default();
    let d = chain.start().await.expect("chain").expect("the devnet's contracts");
    let p = ProviderBuilder::new().connect_http(url());
    assert_eq!(d.chain_id, arc::ARC_TESTNET.chain_id);
    assert!(!p.get_code_at(arc::ARC_TESTNET.identity).await.unwrap().is_empty(), "the real IdentityRegistry");
    assert!(!p.get_code_at(arc::ARC_TESTNET.usdc).await.unwrap().is_empty(), "the real USDC");
    let me = deployer().unwrap().address();
    assert_ne!(me, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266".parse::<Address>().unwrap(), "not Anvil's account #0");
    assert!(!p.get_code_at(d.settlement).await.unwrap().is_empty(), "Settlement deployed on the fork");
    drop(chain);
    let _ = std::fs::remove_dir_all(&scratch);
}

/// The whole money path on a real Anvil chain, in a scratch folder: faucet, deposit, pledge, list, authorise an
/// agent, two paid fetches and a failed one, a claim that splits on chain, then a withdrawal across epochs.
/// `cargo test -p unbrowse-node-app chain -- --ignored --nocapture`
/// A chain the node didn't start, already on the devnet's port, is never taken for its devnet; its own devnet,
/// left running, is. `UNBROWSE_DEVNET_FORK=none cargo test -p unbrowse-node-app devnet -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn a_chain_the_node_did_not_start_is_never_taken_for_its_devnet() {
    let scratch = std::env::temp_dir().join(format!("unbrowse-devnet-mark-test-{}", std::process::id()));
    std::env::set_var("UNBROWSE_HOME", &scratch);
    std::env::set_var("UNBROWSE_DEVNET_PORT", "8597");
    let mut other = Reaped::spawn(Command::new(anvil_bin()).args(["--host", "127.0.0.1", "--port", "8597", "--silent"]));
    let probe = ProviderBuilder::new().connect_http(url());
    for _ in 0..100 {
        if probe.get_chain_id().await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let refused = Chain::default().start().await;
    let _ = other.kill();
    let _ = other.wait();
    assert!(refused.is_err(), "a listener without the devnet's mark");
    for _ in 0..50 {
        if probe.get_chain_id().await.is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let own = Chain::default();
    own.start().await.expect("the node's own devnet");
    // A second node on the same devnet finds it running and knows it by its mark.
    Chain::default().start().await.expect("the devnet, found running");
    drop(own);
    let _ = std::fs::remove_dir_all(&scratch);
}
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pays_and_claims_on_a_local_chain() {
    pays_and_claims(18).await;
}

/// The same on a devnet whose test USDC counts in 6 decimals, as Arc's own does, beside UNB's 18: every fee,
/// line, voucher, cap and claim in its units. `UNBROWSE_DEVNET_FORK=none cargo test -p unbrowse-node-app
/// pays_and_claims -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pays_and_claims_on_a_local_chain_with_a_6_decimal_usdc() {
    pays_and_claims(6).await;
}

/// On a free port: a fixed one collides with another worktree's chain running the same test.
async fn pays_and_claims(decimals: u8) {
    let port = crate::testchain::free_port().to_string();
    let _one = crate::testchain::one_at_a_time().await;
    let scratch = std::env::temp_dir().join(format!("unbrowse-chain-test-{}-{decimals}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::env::set_var("UNBROWSE_HOME", &scratch);
    // A devnet of its own, forking nothing: it mines epochs, which a fork of a live network makes block by block against
    // that network's RPC, past the node's request bound.
    let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", port), ("UNBROWSE_DEVNET_USDC_DECIMALS", decimals.to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    let chain = Chain::default();
    let d = chain.start().await.expect("chain").expect("the devnet's contracts");
    println!("deployed UNB {:#x} Settlement {:#x}, USDC of {} decimals", d.unb, d.settlement, d.usdc_decimals);
    assert_eq!(d.usdc_decimals, decimals);
    {
        let p = ProviderBuilder::new().connect_http(url());
        assert_eq!(USDC::new(d.usdc, &p).decimals().call().await.unwrap(), decimals, "the test USDC counts as the deployment says");
        assert_eq!(UnbPool::new(d.pool, &p).reserveUsdc().call().await.unwrap(), d.usdc_units(POOL_SEED as f64), "the pool's USDC, in its units");
        assert_eq!(UnbPool::new(d.pool, &p).reserveUnb().call().await.unwrap(), unb_units(POOL_SEED as f64));
    }

    // USDC for the deposit.
    faucet(&chain, &keys, 300_000.0).await.unwrap();
    deposit(&chain, &keys, 20_000.0).await.unwrap();
    set_fee(&chain, &keys, 0.5, None).await.unwrap();
    list_entry(&chain, &keys, "route-a", "hn.algolia.com", "Search stories").await.unwrap();
    assert_eq!(entry(&chain, "route-a").await.unwrap().unwrap().fee, 0.5, "the entry is priced at the node's fee");
    let w = wallet(&chain, &keys).await.unwrap();
    println!("held {} deposit {}", w.held, w.deposit);
    assert_eq!(w.deposit, 20_000.0);

    authorize(&chain, &keys, 0, 100.0, 0).await.unwrap();
    let epoch = current_epoch(&chain).await.unwrap();

    // The node hashes vouchers, lines and spent keys exactly as the contract does, so it can sign, prove and check
    // claims without asking the chain.
    {
        let p = ProviderBuilder::new().connect_http(url());
        let s = LeanSettlement::new(d.settlement, &p);
        let me = owner_address(&keys).unwrap();
        let agent = agent_signer(&keys, 0).unwrap().address();
        let v = LeanSettlement::Voucher { payer: me, agent, epoch, cumulative: d.fee_units(1.5), lines: 3, passedLines: 2, receiptsRoot: keccak256(b"receipts") };
        assert_eq!(voucher_digest(&d, &v), s.voucherDigest(v.clone()).call().await.unwrap(), "voucher digest");
        for holders in [vec![], vec![me], vec![me, agent]] {
            let l = LeanSettlement::Line { index: U256::from(3), entryId: test_entry("route-a"), amount: d.fee_units(0.5), passed: true, holders, bounty: U256::ZERO };
            assert_eq!(line_leaf(&l), s.lineLeaf(l.clone()).call().await.unwrap(), "line leaf with {} holder(s)", l.holders.len());
        }
    }
    // Lines paying route-a's entry, its body served by no node they name. The node never writes these for its own
    // agents' calls of its own route (those are free); the contract pays any line whose entry the payer lists as it
    // pays another's, which is what the split below checks.
    add_receipt(0, epoch, "route-a", 0.5, true, 0.0, 100.0, 20_000.0).unwrap();
    add_receipt(0, epoch, "route-a", 0.5, false, 0.0, 100.0, 20_000.0).unwrap();
    add_receipt(0, epoch, "route-a", 0.5, true, 0.0, 100.0, 20_000.0).unwrap();
    assert!(receipts(0, epoch).unwrap().iter().all(|r| r.entry == Some(test_entry("route-a")) && r.holders == Some(vec![])), "each line names its entry and its holders as it is written");
    assert!(add_receipt(0, epoch, "route-a", 200.0, true, 0.0, 100.0, 20_000.0).is_err(), "the cap is enforced before signing");
    assert!(add_receipt(0, epoch, "route-a", 0.5, true, 0.0, 100.0, 1.0).is_err(), "so is the deposit: 1 USDC is already signed for");
    let tx = claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("something to claim");
    println!("claimed in {tx}");
    assert!(claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().is_none(), "nothing left to claim");

    let w = wallet(&chain, &keys).await.unwrap();
    println!("after claim: deposit {} earned entries {} to claim {} lines {}", w.deposit, w.earned.entries, w.to_claim, w.earned.lines);
    // Two passed lines of 0.5: 1.0 left the deposit. The failed line is never charged or sent. Of each
    // claimed line 65% is the route's (`coin.split`): route-a has no coin, so the fetch owes it to the entry's credited
    // contributor, this node, to take whole (no vesting); 30% went to the site escrow and 5% to the burn buffer. The USDC
    // balance is just faucet − deposit.
    assert!((w.deposit - 19_999.0).abs() < 1e-9);
    assert!((w.held - (300_000.0 - 20_000.0)).abs() < 1e-9, "held {} (the route share waits in the fetch, the contributor's to take)", w.held);
    assert!((w.to_claim - 0.65).abs() < 1e-9, "the route share of both lines, owed to the contributor: {}", w.to_claim);
    assert!((w.earned.entries - 0.65).abs() < 1e-9, "its entry's lines sent 0.65 to its route: {}", w.earned.entries);
    assert_eq!(w.earned.lines, 2);
    assert_eq!(paid_since(&chain, &keys, 0).await.unwrap().0, 2, "both passed lines count as demand");
    // The burn share waits in Settlement's burn buffer (R4.6): 5% of the 1.0 claimed. The pool the devnet was deployed
    // with is untouched until `burnBatch`: a route with no coin buys nothing.
    {
        let p = ProviderBuilder::new().connect_http(url());
        let s = LeanSettlement::new(d.settlement, &p);
        assert_eq!(s.pool().call().await.unwrap(), d.pool);
        assert_eq!(d.usdc_f(s.burnBuffer().call().await.unwrap()), 0.05, "the burn share is in the buffer");
        let reserve = UnbPool::new(d.pool, &p).reserveUsdc().call().await.unwrap();
        assert_eq!(reserve, d.usdc_units(POOL_SEED as f64), "no claim swapped");
        // The node runs this epoch's burn batch: the buffer, less the caller's repayment, buys UNB through the pool
        // and burns it, and the batch can't run again until the next epoch.
        let unb = UNB::new(d.unb, &p);
        let supply = unb.totalSupply().call().await.unwrap();
        assert!(burn_batch(&chain, &keys, ClaimWhen::Now).await.unwrap().is_some(), "the batch is due");
        assert!(unb.totalSupply().call().await.unwrap() < supply, "the UNB it bought was burned");
        let swapped = UnbPool::new(d.pool, &p).reserveUsdc().call().await.unwrap() - reserve;
        let left = s.burnBuffer().call().await.unwrap();
        assert!(swapped > U256::ZERO && swapped + left <= d.usdc_units(0.05), "the buffer paid the swap and the repayment");
        assert_eq!(s.nextBurnEpoch().call().await.unwrap(), U256::from(epoch + 1));
        assert!(burn_batch(&chain, &keys, ClaimWhen::Now).await.unwrap().is_none(), "once an epoch");
    }

    // A use of another node's entry, whose body that node served, is paid from this node's deposit, to that node,
    // under this agent's running voucher: the serving node checks the line and claims it.
    let server = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&server).unwrap();
    let s_addr = owner_address(&server).unwrap();
    faucet(&chain, &server, 300_000.0).await.unwrap();
    set_fee(&chain, &server, 0.25, None).await.unwrap();
    list_entry(&chain, &server, "route-r", "news.example", "Search news").await.unwrap();
    let s_held = wallet(&chain, &server).await.unwrap().held;
    let deposit_before = wallet(&chain, &keys).await.unwrap().deposit;

    let line = add_network_receipt(0, epoch, test_entry("route-r"), Some(s_addr), 0.25, true, 0.0, 100.0, 20_000.0).unwrap();
    let run = running_voucher(&chain, &keys, 0, epoch).await.unwrap().unwrap();
    let paid = PaidLine::of(&run, line.index as usize).unwrap();
    let mut raised = paid.clone();
    raised.amount = d.fee_units(2.5);
    assert!(crate::network::accept_receipt(&chain, &server, &raised).await.is_err(), "a line whose amount was changed");
    let others = PaidLine::of(&run, 0).unwrap();
    assert!(crate::network::accept_receipt(&chain, &server, &others).await.is_err(), "a line for another node's entry");
    assert!(crate::network::accept_receipt(&chain, &server, &paid).await.is_err(), "a line for a body the node never served");
    let body = format!("sha256:{}", "ab".repeat(32));
    let fetch = crate::network::sign_body_voucher(&keys, 0, &domain(&d), owner_address(&keys).unwrap(), test_entry("route-r"), &body, d.fee_units(0.25), epoch).unwrap();
    crate::network::reserve_served(owner_address(&keys).unwrap(), &fetch, true).unwrap();
    assert!(crate::network::accept_receipt(&chain, &server, &paid).await.is_err(), "another node served that body");
    crate::network::reserve_served(s_addr, &fetch, true).unwrap();
    crate::network::accept_receipt(&chain, &server, &paid).await.unwrap();
    crate::network::accept_receipt(&chain, &server, &paid).await.unwrap();
    claim_owed(&chain, &server, ClaimWhen::Now).await.unwrap().expect("the served call is claimed");
    assert!(claim_owed(&chain, &server, ClaimWhen::Now).await.unwrap().is_none(), "a line is kept once and claimed once");

    let s_after = wallet(&chain, &server).await.unwrap();
    // 0.25 from the payer: 65% is route-r's, which has no coin, so the fetch owes it to the serving node, its credited
    // contributor (`coin.split`); nobody is paid for serving (`fees.server` = 0); 30% escrow, 5% burned.
    assert!((s_after.held - s_held).abs() < 1e-9, "owed by the fetch, not yet in the wallet: {} then {}", s_held, s_after.held);
    assert!((s_after.to_claim - 0.1625).abs() < 1e-9, "the route share owed: {}", s_after.to_claim);
    assert!((wallet(&chain, &keys).await.unwrap().deposit - (deposit_before - 0.25)).abs() < 1e-9, "paid from the caller's deposit");
    // Paid whole: the contributor takes it at once, in USDC, and a second take finds nothing.
    let taken = crate::earnings::collect_all(&chain, &server).await.unwrap();
    assert_eq!(taken.len(), 1, "one take of what the fetch owes");
    let drawn = wallet(&chain, &server).await.unwrap();
    assert!((drawn.held - (s_held + 0.1625)).abs() < 1e-9, "the route share paid out: {} then {}", s_held, drawn.held);
    assert_eq!(drawn.to_claim, 0.0, "nothing left to take");
    assert!(crate::earnings::collect_all(&chain, &server).await.unwrap().is_empty(), "nothing sent for nothing");
    assert!(claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().is_none(), "the payer's own claim skips the line its payee claimed");
    assert!(receipts(0, epoch).unwrap()[line.index as usize].claimed, "and marks it claimed");

    request_withdraw(&chain, &keys, 999.0).await.unwrap();
    assert!(withdraw_to(&chain, &keys, None).await.is_err(), "not before two epochs");
    advance_day(&chain).await.unwrap();
    advance_day(&chain).await.unwrap();
    withdraw_to(&chain, &keys, None).await.unwrap();
    let w = wallet(&chain, &keys).await.unwrap();
    assert!((w.deposit - (19_000.0 - 0.25)).abs() < 1e-9, "999 withdrawn after the served call's 0.25");
    let board = board(&chain).await.unwrap();
    println!("board: {} contributor(s), top {} lines {:.2} USDC", board.len(), board[0].lines, board[0].earned);

    // One unpayable line never blocks the rest. Three lines of 4 under a cap of 10 (one slipped past the cap, as
    // lines another device signed would): the contract refuses the three together, so the claim pays the two that
    // fit, tells the third, and keeps it unclaimed.
    let now = current_epoch(&chain).await.unwrap();
    let written = |agent: u32, n: usize, amount: f64| {
        let lines: Vec<Receipt> = (0..n)
            .map(|i| Receipt { index: i as u64, route_id: "route-a".into(), amount, passed: true, claimed: false, at: 0, entry: Some(test_entry("route-a")), holders: None, bounty: None, lapsed: false, unwitnessed: false })
            .collect();
        store::write_json(&receipts_path(agent, now), &unbrowse_files::RECEIPTS, &lines).unwrap();
    };
    authorize(&chain, &keys, 1, 10.0, 0).await.unwrap();
    written(1, 3, 4.0);
    claim(&chain, &keys, 1, now, ClaimWhen::Now).await.unwrap().expect("the lines that fit are paid");
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let me = owner_address(&keys).unwrap();
    let claimed_of = |agent: Address| s.claimedOf(me, agent, now);
    assert_eq!(d.usdc_f(claimed_of(agent_signer(&keys, 1).unwrap().address()).call().await.unwrap()), 8.0);
    let left: Vec<bool> = receipts(1, now).unwrap().iter().map(|r| r.claimed).collect();
    assert_eq!(left, [true, true, false], "the line past the cap waits, told, and blocks nothing");
    assert!(claim(&chain, &keys, 1, now, ClaimWhen::Now).await.unwrap().is_none(), "and isn't sent again");

    // A backlog longer than one batch is paid in several transactions, every line of it.
    authorize(&chain, &keys, 2, 1_000.0, 0).await.unwrap();
    written(2, CLAIM_BATCH * 2 + 10, 0.01);
    claim(&chain, &keys, 2, now, ClaimWhen::Now).await.unwrap().expect("the backlog is paid");
    assert!(receipts(2, now).unwrap().iter().all(|r| r.claimed), "every line of the backlog is claimed");
    let paid = d.usdc_f(claimed_of(agent_signer(&keys, 2).unwrap().address()).call().await.unwrap());
    assert!((paid - 0.01 * (CLAIM_BATCH * 2 + 10) as f64).abs() < 1e-9, "{paid}");
    drop(chain);
    let _ = std::fs::remove_dir_all(&scratch);
}

/// A devnet of the test's own, forking nothing, and a payer on it: a deposit, a fee of `fee`, one listed route and
/// `agents` agent keys. Its home, chain and keys; the guards stay held while the test runs.
async fn payer_on_a_devnet(name: &str, fee: f64, agents: u32) -> (PathBuf, crate::testchain::Env, Chain, unbrowse_core::MemoryStore) {
    let home = crate::testchain::home(name);
    let env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    let chain = Chain::default();
    chain.start().await.expect("chain").expect("the devnet's contracts");
    faucet(&chain, &keys, 10_000.0).await.unwrap();
    deposit(&chain, &keys, 1_000.0).await.unwrap();
    set_fee(&chain, &keys, fee, None).await.unwrap();
    list_entry(&chain, &keys, "route-a", "news.example", "Search news").await.unwrap();
    for a in 0..agents {
        authorize(&chain, &keys, a, 100.0, 0).await.unwrap();
    }
    (home, env, chain, keys)
}

/// A write of the node's on a chain is proven against its block: its header rehashes here, its bytes are among the
/// block's transactions, and the block's receipts say it ran and what it took, so nothing about it rests on the RPC's
/// word. `cargo test -p unbrowse-node-app a_write_of_the_nodes_is_proven -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_write_of_the_nodes_is_proven_against_its_block() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("proven-write", 0.01, 1).await;
    let tx: FixedBytes<32> = deposit(&chain, &keys, 5.0).await.unwrap().parse().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let r = p.get_transaction_receipt(tx).await.unwrap().unwrap();
    match crate::proof::prove_on(&p, tx, r.block_number.unwrap(), None).await.unwrap() {
        crate::proof::Inclusion::Proven(proven) => {
            assert!(proven.ran && proven.gas_used == r.gas_used, "{proven:?} against {r:?}");
            assert_eq!(proven.block_hash, r.block_hash.unwrap());
        }
        other => panic!("a devnet's own block proves its writes: {other:?}"),
    }
    assert!(crate::rpc::halted().is_none(), "and nothing stopped the writes");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// An allowance lasts its one write: after a bounty post, the bounties' allowance of the wallet's UNB reads nothing at
/// the final block, and nothing is left owed. `cargo test -p unbrowse-node-app an_allowance_reads_nothing -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn an_allowance_reads_nothing_after_the_write_it_was_for() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("allowance-after", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let me = owner_address(&keys).unwrap();
    bounty_post(&chain, &keys, "news.example", 100.0, None, 86_400).await.unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let left = UNB::new(d.unb, &p).allowance(me, d.coins.coin_bounties).block(crate::rpc::SETTLED).call().await.unwrap();
    assert_eq!(left, U256::ZERO, "nothing left to pull");
    assert!(pending_resets().unwrap().is_empty(), "and nothing owed");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// Epochs count blocks, never timestamps (R1.28): a jump of the chain's clock moves no epoch, and a day on a devnet is
/// an epoch of blocks, which moves it by one and the clock with it. `cargo test -p unbrowse-node-app
/// a_clock_jump_moves_no_epoch -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_clock_jump_moves_no_epoch_and_a_day_of_blocks_moves_one() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, _keys) = payer_on_a_devnet("epoch-blocks", 0.01, 1).await;
    let p = ProviderBuilder::new().connect_http(url());
    let clock = async || p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.unwrap().unwrap().header.timestamp;
    let start = current_epoch(&chain).await.unwrap();
    assert!(start > 0, "a devnet starts past epoch 0, as every chain Settlement runs on is");

    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (40 * EPOCH,)).await.unwrap();
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    assert_eq!(current_epoch(&chain).await.unwrap(), start, "forty days of clock, one block");

    let before = clock().await;
    advance_day(&chain).await.unwrap();
    assert_eq!(current_epoch(&chain).await.unwrap(), start + 1, "a day of blocks");
    assert!(clock().await >= before + EPOCH, "and the clock with it, for what is wall time on any chain");
    let _ = std::fs::remove_dir_all(home);
}

/// A deposit's EIP-3009 authorisation is timed by the chain's clock, which USDC judges it by: once `advance_day`
/// has moved a devnet's clock past this machine's, a deposit still goes in. `cargo test -p unbrowse-node-app
/// a_deposit_goes_in -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_deposit_goes_in_after_the_devnet_clock_moves_on() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("deposit-clock", 0.01, 1).await;
    let before = wallet(&chain, &keys).await.unwrap().deposit;
    advance_day(&chain).await.unwrap();
    advance_day(&chain).await.unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let clock = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.unwrap().unwrap().header.timestamp;
    assert!(clock > store::now() + DEPOSIT_AUTH_SECS, "the devnet's clock is past this machine's");
    deposit(&chain, &keys, 5.0).await.expect("valid by the chain's clock");
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, before + 5.0);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// The node never claims a failed line (`decide.failed-fetch-always-free`): it pays nobody and takes nothing from the
/// deposit or the key's cap, however many of the payer's lines fail. Only the passed lines are sent, and the failed
/// ones stay unclaimed. `cargo test -p unbrowse-node-app a_failed_line_is_never_claimed -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_failed_line_is_never_claimed_on_a_local_chain() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("failed-lines", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let me = owner_address(&keys).unwrap();
    let a = agent_signer(&keys, 0).unwrap().address();
    let epoch = current_epoch(&chain).await.unwrap();
    let claimed_on_chain = || async { d.usdc_f(s.claimedOf(me, a, epoch).call().await.unwrap()) };
    let settled = || receipts(0, epoch).unwrap().iter().filter(|r| r.claimed).map(|r| r.index).collect::<Vec<_>>();
    let before = s.account(me).call().await.unwrap().balance;
    for passed in [true, false, false, false, false, false, false, true] {
        add_receipt(0, epoch, "route-a", 0.01, passed, 0.0, 100.0, 1_000.0).unwrap();
    }
    claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    assert!((claimed_on_chain().await - 0.02).abs() < 1e-9, "the two passed lines, and no failed one");
    assert_eq!(settled(), [0, 7]);
    assert_eq!(before - s.account(me).call().await.unwrap().balance, d.fee_units(0.01) * U256::from(2u64), "only the passed lines left the deposit");
    assert!(claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().is_none(), "the failed lines are never sent");
    // A stream of failures alone sends nothing.
    add_receipt(0, epoch, "route-a", 0.01, false, 0.0, 100.0, 1_000.0).unwrap();
    assert!(claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().is_none());
    assert!((claimed_on_chain().await - 0.02).abs() < 1e-9);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A node set to a network whose RPC isn't answering waits on that network: its lines, its folder and its RPC are that
/// network's, never the devnet's, while it waits.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "sets the process's chain, which the tests beside it read"]
async fn a_node_waiting_on_its_network_reads_that_networks_folder() {
    let _one = crate::testchain::one_at_a_time().await;
    let home = crate::testchain::home("rpc-down");
    let rpc = format!("http://127.0.0.1:{}", crate::testchain::free_port());
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", arc::ARC_TESTNET.name.into()), ("UNBROWSE_RPC", rpc.clone())]);
    forget_live();
    let chain = Chain::default();
    assert!(chain.start().await.is_err(), "nothing answers there");
    let (folder, at) = (dir(), url());
    forget_live();
    assert_eq!(folder, home.join(arc::ARC_TESTNET.name));
    assert_eq!(at.as_str(), format!("{rpc}/"));
    let _ = std::fs::remove_dir_all(&home);
}

/// A server with a listing of its own: what the tests of served lines start from.
async fn a_server_of(chain: &Chain, route: &str) -> (unbrowse_core::MemoryStore, Address) {
    let server = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&server).unwrap();
    faucet(chain, &server, 300_000.0).await.unwrap();
    set_fee(chain, &server, 0.25, None).await.unwrap();
    list_entry(chain, &server, route, "news.example", "Search news").await.unwrap();
    let addr = owner_address(&server).unwrap();
    (server, addr)
}

/// A server never claims a failed line it holds (`decide.failed-fetch-always-free`): it keeps it only for the counts
/// its stream signs while the stream's window is open, sends only the passed ones, and lets the failed one go once the
/// window closes. `cargo test -p unbrowse-node-app a_server_never_claims_a_failed_line -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_server_never_claims_a_failed_line() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("server-failed-line", 0.25, 2).await;
    let (server, s_addr) = a_server_of(&chain, "route-r").await;
    let d = chain.deployed().unwrap();
    let epoch = current_epoch(&chain).await.unwrap();
    let entry = test_entry("route-r");
    let failed = add_network_receipt(0, epoch, entry, Some(s_addr), 0.25, false, 0.0, 100.0, 20_000.0).unwrap();
    let passed = add_network_receipt(1, epoch, entry, Some(s_addr), 0.25, true, 0.0, 100.0, 20_000.0).unwrap();
    let (run0, run1) = (running_voucher(&chain, &keys, 0, epoch).await.unwrap().unwrap(), running_voucher(&chain, &keys, 1, epoch).await.unwrap().unwrap());
    owe(PaidLine::of(&run0, failed.index as usize).unwrap(), || true).unwrap();
    assert!(claim_owed(&chain, &server, ClaimWhen::Now).await.unwrap().is_none(), "a failed line alone sends nothing");
    owe(PaidLine::of(&run1, passed.index as usize).unwrap(), || true).unwrap();
    claim_owed(&chain, &server, ClaimWhen::Now).await.unwrap().expect("the passed line goes");
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let me = owner_address(&keys).unwrap();
    let (a0, a1) = (agent_signer(&keys, 0).unwrap().address(), agent_signer(&keys, 1).unwrap().address());
    assert!(s.claimedOf(me, a0, epoch).call().await.unwrap().is_zero(), "the failed line was never charged");
    assert!((d.usdc_f(s.claimedOf(me, a1, epoch).call().await.unwrap()) - 0.25).abs() < 1e-9, "the passed line was paid");
    assert_eq!(owed_of(me).len(), 1, "the failed line is kept while its window is open");
    // Once its window closes it is let go, with nothing claimed, though no passed line is left to claim.
    let length = d.blocks_per_epoch();
    let head = p.get_block_number().await.unwrap();
    let _: serde_json::Value = p.raw_request("anvil_mine".into(), (U256::from((epoch + 2) * length + 1 - head.min((epoch + 2) * length)),)).await.unwrap();
    assert!(claim_owed(&chain, &server, ClaimWhen::Worth(CLAIM_GAS_SHARE)).await.unwrap().is_none(), "nothing sent");
    assert!(owed_of(me).is_empty(), "the stale failed line is let go");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A payer refused for a backstop it was late with stops being refused once the line is paid, whoever paid it: towers
/// claim in the last quarter of the window, after a server stops waiting, and the line is then paid in full. A window
/// that closes unpaid stays a refusal. `cargo test -p unbrowse-node-app a_late_backstop -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_late_backstop_paid_by_a_tower_ends_the_refusal() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("late-backstop", 0.25, 1).await;
    let (_server, s_addr) = a_server_of(&chain, "route-r").await;
    let d = chain.deployed().unwrap();
    let epoch = current_epoch(&chain).await.unwrap();
    let entry = test_entry("route-r");
    let line = add_network_receipt(0, epoch, entry, Some(s_addr), 0.25, true, 0.0, 100.0, 20_000.0).unwrap();
    let run = running_voucher(&chain, &keys, 0, epoch).await.unwrap().unwrap();
    let paid = PaidLine::of(&run, line.index as usize).unwrap();
    owe(paid.clone(), || true).unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    // Blocks, not the clock, move the epoch (R1.28): mined to just past the backstop and the server's grace after it.
    let length = d.blocks_per_epoch();
    let at = (epoch + 1) * length + backstop_wait(length) + backstop_grace(length) + 1;
    let head = p.get_block_number().await.unwrap();
    let _: serde_json::Value = p.raw_request("anvil_mine".into(), (U256::from(at.saturating_sub(head)),)).await.unwrap();
    let now = current_epoch(&chain).await.unwrap();
    let me = owner_address(&keys).unwrap();
    let body = format!("sha256:{}", "ab".repeat(32));
    let ask = crate::network::sign_body_voucher(&keys, 0, &domain(&d), me, entry, &body, d.fee_units(0.25), now).unwrap();
    let refused = crate::network::verify_body_voucher(&chain, &ask, entry, &body, d.fee_units(0.25), witness_epoch(&chain).await.unwrap(), &follow_head(&chain).await.unwrap()).await.unwrap_err();
    assert!(refused.contains("overdue"), "the backstop is late: {refused}");
    // The tower's claim, sent from a node that isn't this server.
    let tower = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&tower).unwrap();
    faucet(&chain, &tower, 1_000.0).await.unwrap();
    let done = claim_for_others(&chain, &tower, vec![paid]).await.unwrap();
    assert_eq!(done.claimed.len(), 1, "the tower's claim paid the line");
    let ask = crate::network::sign_body_voucher(&keys, 0, &domain(&d), me, entry, &body, d.fee_units(0.25), now).unwrap();
    crate::network::verify_body_voucher(&chain, &ask, entry, &body, d.fee_units(0.25), witness_epoch(&chain).await.unwrap(), &follow_head(&chain).await.unwrap()).await.expect("a payer whose line was paid is served");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A poster's line on an entry claimed before its bounty was posted doesn't let it confirm (`NotUsedByPoster`), and the
/// node's rule reads it the same way: a call is due to be paid (`autobounty::confirm_line_due`). After one paid line,
/// unclaimed, nothing more is due; once it is claimed the chain counts it (`lastCounted`), so still nothing is, and the
/// bounty confirms. The devnet's clock runs ahead of this machine's: the rule never compares the two.
/// `cargo test -p unbrowse-node-app a_poster_pays_once_to_confirm -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_poster_pays_once_to_confirm_on_a_local_chain() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, poster) = payer_on_a_devnet("bounty-line", 0.01, 1).await;
    let me = owner_address(&poster).unwrap();
    let lister = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&lister).unwrap();
    let b_addr = owner_address(&lister).unwrap();
    faucet(&chain, &lister, 1_000.0).await.unwrap();
    set_fee(&chain, &lister, 0.01, None).await.unwrap();
    list_entry(&chain, &lister, "route-b", "news.example", "Search news").await.unwrap();
    let entry = test_entry("route-b");
    let site = format!("{:#x}", domain_hash("news.example"));
    // The poster's call on the entry, the one its kept body came from, claimed before any bounty.
    let epoch = current_epoch(&chain).await.unwrap();
    add_network_receipt(0, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    claim(&chain, &poster, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let posted = bounty_post(&chain, &poster, "news.example", 50.0, None, 2 * 86_400).await.expect("posted");
    let receipts = dir().join("receipts");
    // As the node's pass and `autobounty::line_due` read it: the board, this machine's time after it, what the chain
    // says of the poster's last counting line, and the poster's own receipts.
    let due = async || {
        let board = bounty_board(&chain, me).await.unwrap().expect("a board");
        let read_at = store::now();
        let last = bounty_last_counted(&chain, entry, me).await.unwrap();
        let since = counted_line_since(&receipts, entry, read_at, |_, _| true);
        crate::autobounty::confirm_line_due(Some(&board), &site, false, store::now(), |id| since || board.bounties.iter().any(|b| b.id == id && last > b.posted_at))
    };
    assert_eq!(due().await, Some(posted.id), "the line from before the post doesn't count");
    assert!(bounty_confirm(&chain, &poster, posted.id, entry, None).await.is_err(), "and the contract agrees");
    // The one paid call: its line, unclaimed, will count once claimed, so nothing more is due.
    let epoch = current_epoch(&chain).await.unwrap();
    add_network_receipt(0, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    assert_eq!(due().await, None, "one paid line is enough");
    // The devnet's clock stands still between these writes; a live chain's moves on between a post and a claim. The
    // chain says a claim's second only, so one in the post's own second is read as not counted: one more fee at worst,
    // never a bounty that can't be confirmed.
    let p = ProviderBuilder::new().connect_http(url());
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (1u64,)).await.unwrap();
    claim(&chain, &poster, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    assert!(bounty_last_counted(&chain, entry, me).await.unwrap() > bounty_show(&chain, &poster, posted.id).await.unwrap().posted_at);
    assert_eq!(due().await, None, "claimed after the post, it counts");
    // A bounty never launches a coin: the lister launches, and the confirmation waits out the snipe window.
    coins::launch(&chain, &lister, entry, 10.0).await.expect("the lister launches");
    let window = CoinFetch::new(chain.deployed().unwrap().coins.coin_fetch, &p).WINDOW().call().await.unwrap().to::<u64>();
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (window + 1,)).await.unwrap();
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    bounty_confirm(&chain, &poster, posted.id, entry, None).await.expect("confirmed after one paid call");
    assert_eq!(due().await, None);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A new deployment restarts the chain's ids and counts, so what a node remembers of the last one mustn't read as this
/// one's: a bounty id of the old bounties would match a new bounty, and the node would confirm one its owner never
/// allowed. Lines signed for the old contracts leave the sums too. What was kept is set aside, not lost, and
/// the keys of the chain itself stay. `cargo test -p unbrowse-node-app a_new_deployment_inherits -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_new_deployment_inherits_nothing_from_the_last() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("redeploy", 0.01, 1).await;
    let me = owner_address(&keys).unwrap();
    let epoch = current_epoch(&chain).await.unwrap();
    add_receipt(0, epoch, "route-a", 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    let said = serde_json::json!({"said": {"1 0x01": {"does": true, "by": "an agent", "at": 1}}, "approved": ["1 0x01"]});
    let memory = dir().join(format!("bounty-auto-{me:#x}.json"));
    store::write_json(&memory, &unbrowse_files::BOUNTY_AUTO, &said).unwrap();
    assert!(!crate::autobounty::load(me).unwrap().approved.is_empty(), "the old deployment's word on bounty 1");

    // The contracts change, and the next start deploys them.
    let path = dir().join("deployment.json");
    let mut old: Deployment = store::read_json_opt(&path, &unbrowse_files::DEPLOYMENT).unwrap();
    old.code = "older contracts".into();
    store::write_json(&path, &unbrowse_files::DEPLOYMENT, &old).unwrap();
    let next = Chain::default();
    let d = next.start().await.unwrap().unwrap();
    assert_ne!(d.settlement, old.settlement, "a new Settlement");

    assert!(crate::autobounty::load(me).unwrap().approved.is_empty(), "no word on a bounty this deployment never showed");
    assert!(receipts(0, epoch).unwrap().is_empty(), "no line of the old contracts in the sums");
    assert!(dir().join("deployer.key").exists() && dir().join("state.json").exists(), "the chain's own files stay");
    // The deployment before this one's files are set aside, not lost: in the folder named for its Settlement (a first
    // start may set aside an unrecorded folder too, of what the deploy's own writes left before it was recorded).
    let aside = std::fs::read_dir(dir()).unwrap().flatten().filter(|f| f.file_name().to_string_lossy().starts_with(&format!("before-{:#x}", old.settlement))).collect::<Vec<_>>();
    assert_eq!(aside.len(), 1, "the old deployment's files are kept, once");
    assert!(aside[0].path().join(memory.file_name().unwrap()).exists(), "set aside, not lost");

    // Starting again on the same deployment moves nothing.
    add_receipt(0, epoch, "route-a", 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    Chain::default().start().await.unwrap();
    assert_eq!(receipts(0, epoch).unwrap().len(), 1, "this deployment's lines stay");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// The cap and the deposit are judged in the token's units, each line rounded up as its voucher carries it: with a
/// 6-decimal USDC two lines of 0.0000001 each go on chain as a unit each, so a cap of one unit takes one, though their
/// whole-token sum is under it.
#[test]
fn caps_and_deposits_compare_in_token_units() {
    let _home = store::scratch_home("token-units");
    let line = |amount: f64| Receipt { index: 0, route_id: "r".into(), amount, passed: true, claimed: false, at: 0, entry: None, holders: None, bounty: None, lapsed: false, unwitnessed: false };
    let one_unit = 0.000001;
    assert!(within_cap_in(6, &[], 0.0, one_unit, 0.0000001).is_ok(), "the first line is one unit");
    assert!(within_cap_in(6, &[line(0.0000001)], 0.0, one_unit, 0.0000001).is_err(), "the second is a unit past the cap");
    assert!(within_cap_in(18, &[line(0.0000001)], 0.0, one_unit, 0.0000001).is_ok(), "where units are finer, both fit");
    let folder = store::home().join("units-receipts");
    std::fs::create_dir_all(&folder).unwrap();
    store::write_json(&folder.join("0-10.json"), &unbrowse_files::RECEIPTS, &vec![line(0.0000001)]).unwrap();
    let none = Default::default();
    assert!(covered_by_in(6, &folder, 10, 0.0000001, one_unit, &none, |_, _| true).is_err(), "a deposit of one unit covers one line");
    assert!(covered_by_in(6, &folder, 10, 0.0000001, 2.0 * one_unit, &none, |_, _| true).is_ok());
}

/// A live network's file naming another Settlement moves the folder on, as a devnet's deploying does. A folder with no
/// record can't say whose its state is, so it moves on too; the same Settlement moves nothing.
#[test]
fn a_folder_moves_on_when_its_settlement_changes() {
    let _home = store::scratch_home("own-folder");
    std::fs::create_dir_all(dir()).unwrap();
    let on = |byte: u8| Deployment { settlement: Address::repeat_byte(byte), ..Deployment::default() };
    let kept = dir().join("owed.json");
    std::fs::write(&kept, "[]").unwrap();
    own_folder(&on(1), false).unwrap();
    assert!(!kept.exists(), "no record says it is this deployment's");
    std::fs::write(&kept, "[]").unwrap();
    own_folder(&on(1), false).unwrap();
    assert!(kept.exists(), "the same Settlement");
    own_folder(&on(2), false).unwrap();
    assert!(!kept.exists(), "another Settlement");
    let record: Deployment = store::read_json_opt(&dir().join("deployment.json"), &unbrowse_files::DEPLOYMENT).unwrap();
    assert_eq!(record.settlement, Address::repeat_byte(2), "and the folder says whose it is now");
}

/// A receipt line written before a folder recorded its deployment (a node that ran before the record was kept) is
/// never signed into the voucher of the deployment it records next: lines another Settlement already paid would be
/// paid again from this one's deposit.
#[test]
fn a_voucher_never_covers_a_line_written_under_another_settlement() {
    let _home = store::scratch_home("unrecorded-receipts");
    std::fs::create_dir_all(dir().join("receipts")).unwrap();
    add_receipt(0, 7, "route-a", 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    edit_receipts(0, 7, |all| {
        all[0].claimed = true;
        Ok(())
    })
    .unwrap();
    own_folder(&Deployment { settlement: Address::repeat_byte(3), ..Deployment::default() }, false).unwrap();
    assert!(receipts(0, 7).unwrap().is_empty(), "the old deployment's line, claimed there, is no line of this one's");
}

/// What stays in a chain's folder over a deployment is what belongs to the chain, whatever new file a deployment's
/// state comes to be kept in. A dev build's root key lives in the devnet's folder (`root.key`): it is the node's
/// identity, never a deployment's state (audit 1118 N3).
#[test]
fn only_the_chains_own_files_outlast_a_deployment() {
    for f in ["root.key", "deployer.key", "mark.key", "deployment.json", "network.json", "state.json", "sending.json", "before-0xab-1", "node.lock", "sending.lock"] {
        assert!(outlasts_a_deployment(f), "{f}");
    }
    for f in ["owed.json", "served.json", "refused-payers.json", "watching.json", "handed.json", "receipts", "bounty-auto-0xab.json", "anything-new.json"] {
        assert!(!outlasts_a_deployment(f), "{f}");
    }
}

/// The claim loop's pass over one agent, as `claim_all` makes it: the last epoch's lines and this one's, each
/// once worth sending.
async fn loop_pass(chain: &Chain, keys: &unbrowse_core::MemoryStore, agent: u32) {
    let now = current_epoch(chain).await.unwrap();
    for e in [now.saturating_sub(1), now] {
        claim(chain, keys, agent, e, ClaimWhen::Worth(CLAIM_GAS_SHARE)).await.unwrap();
    }
}

/// Lines each paying far less than their claim's gas (as 0.01 USDC lines do at Arc's gas price; the devnet's gas
/// is cheaper, so the lines are priced from its own) wait while their epoch runs and go together on the loop's
/// first pass after it, a whole epoch before their window closes: over several days, every line is paid on chain
/// and none is left past its window. The owner's claim sends what the loop waits on, and a line dear enough to pay
/// for its own claim goes at once. `cargo test -p unbrowse-node-app claims_wait -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn claims_wait_until_worth_it_and_no_line_outlives_its_window() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("claims-wait", 0.01, 3).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let s = LeanSettlement::new(d.settlement, &p);
    let me = owner_address(&keys).unwrap();
    // A claim of one line, at the gas price now: the chain's price only falls while the lines wait, since a block
    // is made only when something is sent.
    let one = gas_f(U256::from(p.get_gas_price().await.unwrap()) * U256::from(CLAIM_GAS.of(1, 1)));
    let (small, dear) = (one / 20.0, one * 50.0);
    let (d, s) = (&d, &s);
    let claimed_on_chain = |agent: u32, e: u64| {
        let a = agent_signer(&keys, agent).unwrap().address();
        async move { d.usdc_f(s.claimedOf(me, a, e).call().await.unwrap()) }
    };
    let paid = |got: f64, want: f64| (got - want).abs() <= want * 1e-6;
    let open = |agent: u32, e: u64| receipts(agent, e).unwrap().iter().filter(|r| r.passed && !r.claimed).count();
    // The chain's clock moved to just past the backstop of a stream of epoch `e`.
    let past_the_backstop = |e: u64| {
        let p = ProviderBuilder::new().connect_http(url());
        async move {
            let at = (e + 1) * DEVNET_EPOCH_BLOCKS + backstop_wait(DEVNET_EPOCH_BLOCKS) + 1;
            let head = p.get_block_number().await.unwrap();
            let _: serde_json::Value = p.raw_request("anvil_mine".into(), (U256::from(at.saturating_sub(head)),)).await.unwrap();
        }
    };

    let start = current_epoch(&chain).await.unwrap();
    let days = 4u64;
    for day in 0..days {
        let now = current_epoch(&chain).await.unwrap();
        assert_eq!(now, start + day);
        // A light day: a fetch now and then, a pass of the loop after each.
        for _ in 0..3 {
            add_receipt(0, now, "route-a", small, true, 0.0, 100.0, 1_000.0).unwrap();
            loop_pass(&chain, &keys, 0).await;
        }
        assert_eq!(open(0, now), 3, "day {day}: lines too small to pay for their claim wait");
        assert_eq!(claimed_on_chain(0, now).await, 0.0);
        // The payer's claim is the backstop (R3.22): it waits for the payees through half the window's last epoch,
        // then claims what they left, with half an epoch to go.
        past_the_backstop(now).await;
        loop_pass(&chain, &keys, 0).await;
        assert_eq!(open(0, now), 0, "day {day}: the day's lines went on the first pass past their backstop");
        assert!(paid(claimed_on_chain(0, now).await, 3.0 * small), "and were paid on chain");
    }
    loop_pass(&chain, &keys, 0).await;
    for e in start..start + days {
        assert_eq!(open(0, e), 0, "epoch {e}: no line left");
        assert!(paid(claimed_on_chain(0, e).await, 3.0 * small), "epoch {e}: every line paid inside its window");
    }

    // The owner's claim overrides the wait.
    let now = current_epoch(&chain).await.unwrap();
    add_receipt(1, now, "route-a", small, true, 0.0, 100.0, 1_000.0).unwrap();
    assert!(claim(&chain, &keys, 1, now, ClaimWhen::Worth(CLAIM_GAS_SHARE)).await.unwrap().is_none(), "the loop waits");
    claim(&chain, &keys, 1, now, ClaimWhen::Now).await.unwrap().expect("the owner's claim goes now");
    assert_eq!(open(1, now), 0);
    assert!(paid(claimed_on_chain(1, now).await, small));

    // A line that pays well past its claim's gas is its payees' to claim first: the payer's loop leaves it until the
    // backstop, then sends it.
    add_receipt(2, now, "route-a", dear, true, 0.0, 100.0, 1_000.0).unwrap();
    loop_pass(&chain, &keys, 2).await;
    assert_eq!(open(2, now), 1, "a dear line waits for its payees too");
    past_the_backstop(now).await;
    loop_pass(&chain, &keys, 2).await;
    assert_eq!(open(2, now), 0, "and goes at the backstop");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A chain whose blocks become final two blocks after they are made (Anvil with one slot an epoch), and a task
/// that makes a block every 100ms while `mining` is set: blocks are made only when the test lets them, so a block
/// is held short of final for as long as the test needs.
fn mined_while(mining: std::sync::Arc<std::sync::atomic::AtomicBool>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let p = ProviderBuilder::new().connect_http(url());
        loop {
            if mining.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = p.raw_request::<_, serde_json::Value>("evm_mine".into(), ()).await;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
}

/// Finality before a claim counts, on a chain whose blocks become final two blocks after they are made. A claim
/// whose block a reorg drops before it is final fails rather than counting: its lines aren't marked claimed, the
/// chain paid nothing, and the next pass claims them again. A claim spent on the chain in a block that isn't final
/// yet, sent by anyone, isn't marked by a pass either, nor sent again; once a reorg drops it, it is claimed again.
/// A claim whose block is final is never sent again. `cargo test -p unbrowse-node-app reorg -- --ignored
/// --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_claim_a_reorg_dropped_is_claimed_again_and_a_final_one_never_again() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let _one = crate::testchain::one_at_a_time().await;
    let home = crate::testchain::home("reorg");
    let _env = crate::testchain::Env::set(&[
        ("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()),
        ("UNBROWSE_DEVNET_FORK", "none".into()),
        ("UNBROWSE_DEVNET_EPOCH_SLOTS", "1".into()),
    ]);
    let mining = std::sync::Arc::new(AtomicBool::new(true));
    let miner = mined_while(mining.clone());
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    let chain = Chain::default();
    let d = chain.start().await.expect("chain").expect("the devnet's contracts");
    faucet(&chain, &keys, 10_000.0).await.unwrap();
    deposit(&chain, &keys, 1_000.0).await.unwrap();
    set_fee(&chain, &keys, 0.5, None).await.unwrap();
    list_entry(&chain, &keys, "route-a", "news.example", "Search news").await.unwrap();
    authorize(&chain, &keys, 0, 100.0, 0).await.unwrap();
    authorize(&chain, &keys, 1, 100.0, 0).await.unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let me = owner_address(&keys).unwrap();
    let s = LeanSettlement::new(d.settlement, &p);
    let epoch = current_epoch(&chain).await.unwrap();
    let paid = |agent: u32| {
        let (d, s, a) = (&d, &s, agent_signer(&keys, agent).unwrap().address());
        async move { d.usdc_f(s.claimedOf(me, a, epoch).call().await.unwrap()) }
    };
    let marked = |agent: u32| receipts(agent, epoch).unwrap().iter().filter(|r| r.claimed).count();
    // The chain makes no block of its own until `mining` is set again; the claim's write makes one.
    let hold = || async {
        mining.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(300)).await;
        p.get_block_number().await.unwrap()
    };
    let made_after = |before: u64| {
        let p = &p;
        async move {
            for _ in 0..600 {
                let now = p.get_block_number().await.unwrap();
                if now > before {
                    return now;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("no block made after {before}");
        }
    };
    let reorg = || async {
        let _: serde_json::Value = p.raw_request("anvil_reorg".into(), (1u64, Vec::<serde_json::Value>::new())).await.unwrap();
    };

    // The node's own claim is mined, and a reorg drops its block before it is final.
    for _ in 0..2 {
        add_receipt(0, epoch, "route-a", 0.5, true, 0.0, 100.0, 1_000.0).unwrap();
    }
    let before = hold().await;
    let (claimed, ()) = tokio::join!(claim(&chain, &keys, 0, epoch, ClaimWhen::Now), async {
        let at = made_after(before).await;
        let block = p.get_block_by_number(at.into()).await.unwrap().unwrap();
        assert_eq!(block.transactions.len(), 1, "the claim's block");
        // The node has its receipt by now (a local RPC is polled every 250ms) and waits for the block to be final,
        // which it can't be while no block follows it.
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(p.get_block_by_number(alloy::eips::BlockNumberOrTag::Finalized).await.unwrap().unwrap().header.number < at, "and not final");
        reorg().await;
        mining.store(true, Ordering::SeqCst);
    });
    let err = claimed.expect_err("a claim whose block was dropped doesn't count");
    assert!(err.contains("reorg"), "{err}");
    assert_eq!(marked(0), 0, "its lines aren't marked claimed");
    assert_eq!(paid(0).await, 0.0, "and the chain paid nothing");
    claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed again");
    assert_eq!(marked(0), 2);
    assert_eq!(paid(0).await, 1.0);

    // Lines spent by a claim whose block isn't final yet, sent past the node: a pass neither marks them nor sends
    // them again; once a reorg drops that block, the next pass claims them.
    for _ in 0..2 {
        add_receipt(1, epoch, "route-a", 0.5, true, 0.0, 100.0, 1_000.0).unwrap();
    }
    let run = running_voucher(&chain, &keys, 1, epoch).await.unwrap().unwrap();
    let signer = as_signer(owner_signer(&keys).unwrap()).await.unwrap();
    let mine = LeanSettlement::new(d.settlement, &signer);
    let batch = mine.claimBatch(
        run.lines.iter().map(|_| run.voucher.clone()).collect(),
        run.lines.iter().map(|_| run.sig.clone()).collect(),
        run.lines.clone(),
        run.proofs.clone(),
    );
    hold().await;
    assert!(batch.send().await.unwrap().get_receipt().await.unwrap().status(), "mined, not final");
    assert_eq!(paid(1).await, 1.0, "spent on the chain's head");
    let nonce = p.get_transaction_count(me).await.unwrap();
    assert!(claim(&chain, &keys, 1, epoch, ClaimWhen::Now).await.unwrap().is_none(), "nothing sent");
    assert_eq!(p.get_transaction_count(me).await.unwrap(), nonce);
    assert_eq!(marked(1), 0, "and nothing marked while its block may still be dropped");
    reorg().await;
    mining.store(true, Ordering::SeqCst);
    assert_eq!(paid(1).await, 0.0, "the reorg dropped it");
    claim(&chain, &keys, 1, epoch, ClaimWhen::Now).await.unwrap().expect("claimed again");
    assert_eq!((marked(1), paid(1).await), (2, 1.0));

    // A final claim is never sent again, however many blocks follow it.
    let nonce = p.get_transaction_count(me).await.unwrap();
    for agent in [0, 1] {
        assert!(claim(&chain, &keys, agent, epoch, ClaimWhen::Now).await.unwrap().is_none());
    }
    let _: serde_json::Value = p.raw_request("anvil_mine".into(), ("0x10",)).await.unwrap();
    for agent in [0, 1] {
        assert!(claim(&chain, &keys, agent, epoch, ClaimWhen::Now).await.unwrap().is_none());
    }
    assert_eq!(p.get_transaction_count(me).await.unwrap(), nonce, "no claim sent again");
    assert_eq!((paid(0).await, paid(1).await), (1.0, 1.0));
    miner.abort();
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// What claims take in gas, read from the receipts of claims the node sends, against `CLAIM_GAS`, which the node
/// sizes its batches, its claims' worth and its gas reserve by: 1 to 40 lines on one entry whose coin trades, so each
/// claim's route share pays the coin's earlier stake, is swapped to UNB and buys and stakes the coin for the payer
/// (`coin.fetch-pays`), each line naming a server other than the payer, so it is a check; then lines on ten entries,
/// ten legs. No claim takes more than the model says, and the model is never far above what one took. An entry's first
/// claims (its credit shown, the payer's first stake in its coin) are shown apart: the model leaves them out, and the
/// write's own estimate guards them. `cargo test -p unbrowse-node-app claim_gas -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn claim_gas_is_a_call_plus_its_lines() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("claim-gas", 0.01, 1).await;
    let mut entries = Vec::new();
    let mut contributors = Vec::new();
    for i in 0..10 {
        let c = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&c).unwrap();
        faucet(&chain, &c, 10_000.0).await.unwrap();
        set_fee(&chain, &c, 0.01, None).await.unwrap();
        list_entry(&chain, &c, &format!("route-c{i}"), &format!("site{i}.example"), "Search").await.unwrap();
        entries.push(test_entry(&format!("route-c{i}")));
        contributors.push(c);
    }
    let server = Address::repeat_byte(0x5e);
    let p = ProviderBuilder::new().connect_http(url());
    let claimed = |lines: Vec<FixedBytes<32>>| {
        let (chain, keys, p) = (&chain, &keys, &p);
        async move {
            let epoch = current_epoch(chain).await.unwrap();
            for e in &lines {
                add_network_receipt(0, epoch, *e, Some(server), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
            }
            let tx = claim(chain, keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
            p.get_transaction_receipt(tx.parse().unwrap()).await.unwrap().expect("its receipt").gas_used
        }
    };
    // Each entry's first claim credits it (its listing shown, R2.18); its contributor then launches its coin, and a day
    // passes, so every coin is older than the fetch's price window and the payer's stakes earn.
    let first = claimed(entries.clone()).await;
    println!("the first claim of ten entries, crediting each, no coin yet: {first} gas");
    for (c, e) in contributors.iter().zip(&entries) {
        coins::launch(&chain, c, *e, 1_000.0).await.expect("its contributor launches its coin");
    }
    advance_day(&chain).await.unwrap();
    let buys = claimed(vec![entries[0]]).await;
    println!("the payer's first buy and stake in a coin, 1 line: {buys} gas");
    claimed(entries[1..].to_vec()).await; // the payer's first stake in each other coin
    // A buy leaves a coin with no price reference a window old until the fetch's anchors age (`CoinFetch.referenceOf`):
    // within the window a fetch parks. So the window passes, one claim marks every coin's anchors on, and the claims
    // measured after it buy against a mean read from those anchors, the dearest way a fetch buys.
    let d = chain.deployed().unwrap();
    let fetch = CoinFetch::new(d.coins.coin_fetch, &p);
    let window = fetch.WINDOW().call().await.unwrap().to::<u64>();
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (window + 1,)).await.unwrap();
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    claimed(entries.clone()).await;
    let mut shapes: Vec<(usize, usize, u64)> = Vec::new();
    for n in [1usize, 2, 5, 10, 20, 40] {
        shapes.push((n, 1, claimed(vec![entries[0]; n]).await));
    }
    shapes.push((10, 10, claimed(entries.clone()).await));
    let me = owner_address(&keys).unwrap();
    for e in &entries {
        let parked = fetch.parked(coins::coin_address(d.coins.route_coins, d.coins.route_coin_implementation, *e), me).call().await.unwrap();
        assert_eq!(parked, U256::ZERO, "every fetch bought: the model is a buying claim's");
    }
    // Every shape is printed before any is judged, so a model that drifts shows all it is off by at once.
    for &(n, legs, used) in &shapes {
        let model = CLAIM_GAS.of(n, legs);
        println!("{n:>2} line(s) over {legs:>2} entr(ies): {used:>9} gas; the model says {model:>9} ({:.2}x)", model as f64 / used as f64);
    }
    for (n, legs, used) in shapes {
        let model = CLAIM_GAS.of(n, legs);
        assert!(used <= model, "{n} lines took {used} gas, past the model's {model}");
        assert!((model as f64) < used as f64 * 1.15, "the model is far above what {n} lines took: {model} for {used}");
    }
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A process a test started, stopped when the test ends however it ends. A test that panics before its own kill would
/// otherwise leave it running, holding the output of whatever ran the tests open: a run piped through a filter then
/// never finishes (2026-11-06: `cargo test -- --ignored | grep` waited 90 minutes on two Anvils). Its output goes
/// nowhere, for the same reason.
struct Reaped(std::process::Child);

impl Reaped {
    fn spawn(cmd: &mut Command) -> Reaped {
        Reaped(cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().expect("Anvil (~/.foundry/bin/anvil)"))
    }
}

impl std::ops::Deref for Reaped {
    type Target = std::process::Child;
    fn deref(&self) -> &std::process::Child {
        &self.0
    }
}

impl std::ops::DerefMut for Reaped {
    fn deref_mut(&mut self) -> &mut std::process::Child {
        &mut self.0
    }
}

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Stops the test's Anvil mining, so a write sits in its pool as one does past `rpc::RECEIPT_TIMEOUT`.
async fn stop_mining(p: &impl Provider) {
    let _: serde_json::Value = p.raw_request("evm_setAutomine".into(), (false,)).await.unwrap();
}

/// Mines what is in the pool and goes back to mining each write.
async fn mine_and_go_on(p: &impl Provider) {
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    let _: serde_json::Value = p.raw_request("evm_setAutomine".into(), (true,)).await.unwrap();
}

/// Long enough for a write to leave the node and not long enough for it to be mined: what a node that stopped, or a pass
/// past its receipt timeout, leaves behind.
const GIVES_UP: std::time::Duration = std::time::Duration::from_secs(3);

/// The chain takes a second deposit as a second. A deposit out of the node's sight and still in the pool shows in no
/// balance, so asking again sends nothing, and asking once it landed is that deposit.
/// `cargo test -p unbrowse-node-app a_deposit_that_may_still_land -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_deposit_that_may_still_land_is_not_sent_again() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("deposit-once", 0.01, 1).await;
    let before = wallet(&chain, &keys).await.unwrap().deposit;
    let p = ProviderBuilder::new().connect_http(url());
    stop_mining(&p).await;
    assert!(tokio::time::timeout(GIVES_UP, deposit(&chain, &keys, 5.0)).await.is_err(), "the write waits to be mined");
    let again = tokio::time::timeout(GIVES_UP, deposit(&chain, &keys, 5.0)).await;
    mine_and_go_on(&p).await;
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, before + 5.0, "one deposit went in: {again:?}");
    deposit(&chain, &keys, 5.0).await.expect("the deposit that landed answers the same ask");
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, before + 5.0);
    deposit(&chain, &keys, 5.0).await.expect("with nothing out, a deposit is a deposit");
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, before + 10.0);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A top-up is sent by a pass that reads the balance, so a top-up still in the pool is the case that repeats by itself:
/// each pass reads the deposit short and would send it again. `cargo test -p unbrowse-node-app a_top_up_still_in -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_top_up_still_in_the_pool_is_not_sent_again() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("top-up-once");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing: Existing::default(), ..network_file(net).unwrap() }).unwrap();
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
    let d = file.deployment.unwrap();
    let node = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&node).unwrap();
    let me = owner_address(&node).unwrap();
    anvil.fund(me).await;
    let chain = Chain::default();
    chain.start().await.expect("the node on its live chain");
    async fn send_usdc(operator: &unbrowse_core::MemoryStore, d: &Deployment, to: Address, amount: f64) -> Result<(), String> {
        let p = as_signer(owner_signer(operator)?).await?;
        let _ = crate::rpc::mined!(USDC::new(d.usdc, &p).faucet(to, d.usdc_units(amount)), "the faucet's USDC");
        Ok(())
    }
    send_usdc(&operator, &d, me, 2.0).await.unwrap();
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    stop_mining(&p).await;
    assert!(tokio::time::timeout(GIVES_UP, top_up(&chain, &node, 0.5, 0.25)).await.is_err(), "the top-up waits to be mined");
    let again = tokio::time::timeout(GIVES_UP, top_up(&chain, &node, 0.5, 0.25)).await;
    mine_and_go_on(&p).await;
    let s = LeanSettlement::new(d.settlement, &p);
    assert_eq!(s.account(me).call().await.unwrap().balance, d.usdc_units(0.5), "up to the floor and no more: {again:?}");
    forget_live();
}

/// An owner has one identity, ever. A registration still in the pool shows in no balance, so a second `ensure` waits for
/// it instead of registering again, and reads the identity it made once it lands.
/// `cargo test -p unbrowse-node-app a_registration_that_may_still_land -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_registration_that_may_still_land_is_not_made_again() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("register-once");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    anvil.with_registry().await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { registry_from: Some(0), ..network_file(net).unwrap() }).unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    let me = owner_address(&keys).unwrap();
    anvil.fund(me).await;
    let chain = Chain::default();
    let _ = chain.start().await;
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    stop_mining(&p).await;
    assert!(tokio::time::timeout(GIVES_UP, crate::erc8004::ensure(&chain, &keys, "a node")).await.is_err(), "the registration waits to be mined");
    let again = tokio::time::timeout(GIVES_UP, crate::erc8004::ensure(&chain, &keys, "a node")).await;
    mine_and_go_on(&p).await;
    assert_eq!(p.get_transaction_count(me).await.unwrap(), 1, "one registration went out: {again:?}");
    let r = crate::erc8004::ensure(&chain, &keys, "a node").await.expect("the one that landed");
    assert_eq!(p.get_transaction_count(me).await.unwrap(), 1, "and it is read, not made again");
    assert!(!r.agent_id.is_empty());
    forget_live();
}

/// Allows `spender` exactly `amount` of UNB ahead of a write, as `approve` would just before it, so a test can hold
/// back the write itself: an allowance is for one write and goes back after it (CHAIN-1).
async fn allow_ahead(chain: &Chain, keys: &(dyn KeyStore + Sync), spender: Address, amount: f64) {
    let d = chain.deployed().unwrap();
    let signer = owner_signer(keys).unwrap();
    let me = signer.address();
    let p = as_signer(signer).await.unwrap();
    approve(&p, &d, spender, d.unb, me, unb_units(amount)).await.unwrap();
}

/// A bounty post is a write the chain takes twice as two: asked again while the first may still land, nothing more is
/// sent; once it landed, the node says so rather than post again on the same ask.
/// `cargo test -p unbrowse-node-app a_bounty_post_that_may_still_land -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_bounty_post_that_may_still_land_is_not_sent_again() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("bounty-once", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let me = owner_address(&keys).unwrap();
    // The post's allowance set ahead, so the write that waits is the post itself.
    allow_ahead(&chain, &keys, d.coins.coin_bounties, 1_000.0).await;
    let p = ProviderBuilder::new().connect_http(url());
    let before = UNB::new(d.unb, &p).balanceOf(me).call().await.unwrap();
    stop_mining(&p).await;
    assert!(tokio::time::timeout(GIVES_UP, bounty_post(&chain, &keys, "news.example", 1_000.0, None, 86_400)).await.is_err(), "the post waits to be mined");
    let again = tokio::time::timeout(GIVES_UP, bounty_post(&chain, &keys, "news.example", 1_000.0, None, 86_400)).await;
    mine_and_go_on(&p).await;
    let after = UNB::new(d.unb, &p).balanceOf(me).call().await.unwrap();
    assert_eq!(before - after, unb_units(1_000.0), "one post went on: {again:?}");
    let landed = bounty_post(&chain, &keys, "news.example", 1_000.0, None, 86_400).await.unwrap_err();
    assert!(landed.contains("landed"), "the post that landed is said, not sent again: {landed}");
    assert_eq!(UNB::new(d.unb, &p).balanceOf(me).call().await.unwrap(), after, "and nothing more went on");
    assert_eq!(CoinBounties::new(d.coins.coin_bounties, &p).bountyCount().call().await.unwrap(), U256::from(1u8));
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A write priced under the chain's fee stops every write after it. The no-op that takes its nonce clears the way, the
/// write it replaced can't land, and a kept one reads as gone, since the node's own no-op is final at its nonce, and
/// goes again, once.
/// `cargo test -p unbrowse-node-app a_stuck_write_gives_way -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_stuck_write_gives_way_and_a_kept_one_goes_again_once() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("stuck-write", 0.01, 1).await;
    let before = wallet(&chain, &keys).await.unwrap().deposit;
    let me = owner_address(&keys).unwrap();
    let p = as_signer(owner_signer(&keys).unwrap()).await.unwrap();
    stop_mining(&p).await;
    assert!(tokio::time::timeout(GIVES_UP, deposit(&chain, &keys, 5.0)).await.is_err(), "the write waits to be mined");
    let nonce = p.get_transaction_count(me).latest().await.unwrap();
    assert_eq!(p.get_transaction_count(me).pending().await.unwrap(), nonce + 1, "the write holds the next nonce");
    assert!(tokio::time::timeout(GIVES_UP, crate::rpc::replace(&p, nonce)).await.is_err(), "the replacement waits to be mined");
    mine_and_go_on(&p).await;
    assert_eq!(p.get_transaction_count(me).latest().await.unwrap(), nonce + 1, "the replacement took the nonce");
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, before, "and the deposit never landed");
    deposit(&chain, &keys, 5.0).await.expect("the node's own no-op took its nonce, so it is gone and goes again");
    assert_eq!(wallet(&chain, &keys).await.unwrap().deposit, before + 5.0);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A server keeps what a claim would pay (CHAIN-16): a key revoked in epoch 9 has `revokedAt` 10, and a line under a
/// voucher of epoch 9 or earlier stays good, as does one of the epoch a key expires in.
#[test]
fn a_voucher_key_is_judged_at_its_vouchers_epoch() {
    let (cap, day) = (U256::from(1u8), 100);
    assert_eq!(voucher_refused(U256::ZERO, 0, 0, 9, day), Some("the agent isn't authorized by the payer"));
    assert_eq!(voucher_refused(cap, 10, 0, 9, day), None, "the revoking epoch's vouchers stay claimable");
    assert_eq!(voucher_refused(cap, 10, 0, 10, day), Some("the agent has been revoked"));
    assert_eq!(voucher_refused(cap, 0, 950, 9, day), None, "expires inside the voucher's epoch");
    assert_eq!(voucher_refused(cap, 0, 900, 9, day), Some("the agent's key has expired"));
    assert_eq!(voucher_refused(cap, 0, 0, 9, day), None);
}

/// A coin launch is the coin's first buy, made once: asked again while the first may still land, nothing more is sent,
/// and once it landed the entry has its coin and the node says so. `cargo test -p unbrowse-node-app
/// a_launch_that_may_still_land -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_launch_that_may_still_land_is_not_sent_again() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("launch-once", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let me = owner_address(&keys).unwrap();
    // A first claim credits the entry to its lister (R2.18); only then may it launch its coin.
    let epoch = current_epoch(&chain).await.unwrap();
    add_receipt(0, epoch, "route-a", 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    claim(&chain, &keys, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    let entry = test_entry("route-a");
    allow_ahead(&chain, &keys, d.coins.route_coins, 100.0).await;
    let p = ProviderBuilder::new().connect_http(url());
    let before = UNB::new(d.unb, &p).balanceOf(me).call().await.unwrap();
    stop_mining(&p).await;
    assert!(tokio::time::timeout(GIVES_UP, coins::launch(&chain, &keys, entry, 100.0)).await.is_err(), "the launch waits to be mined");
    let again = tokio::time::timeout(GIVES_UP, coins::launch(&chain, &keys, entry, 100.0)).await;
    mine_and_go_on(&p).await;
    assert_eq!(before - UNB::new(d.unb, &p).balanceOf(me).call().await.unwrap(), unb_units(100.0), "one launch went on: {again:?}");
    let rc = RouteCoins::new(d.coins.route_coins, &p);
    assert_eq!(rc.coinOf(entry).call().await.unwrap(), coins::coin_address(d.coins.route_coins, d.coins.route_coin_implementation, entry), "at its predicted address");
    let e = coins::launch(&chain, &keys, entry, 100.0).await.unwrap_err();
    assert!(e.contains("landed") || e.contains("already has its coin"), "{e}");
    assert!(coins::verify_coin(&p, &d, entry).await.is_ok(), "the coin is its entry's clone");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A contributor holding `unb` test UNB (none for 0), with route `route` listed for it, and the payer's paid line on it
/// claimed, which credits it the entry (R2.18).
async fn credited_lister(chain: &Chain, payer: &(dyn KeyStore + Sync), route: &str, unb: f64) -> (unbrowse_core::MemoryStore, FixedBytes<32>) {
    let lister = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&lister).unwrap();
    if unb > 0.0 {
        faucet(chain, &lister, unb).await.unwrap();
    }
    set_fee(chain, &lister, 0.01, None).await.unwrap();
    list_entry(chain, &lister, route, "shop.example", "Search items").await.unwrap();
    let e = test_entry(route);
    let epoch = current_epoch(chain).await.unwrap();
    add_network_receipt(0, epoch, e, Some(owner_address(&lister).unwrap()), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    claim(chain, payer, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    (lister, e)
}

/// The listing's first buy, on by default (`decide.dev-buy-default-on`): once its entry is credited, the lister's node
/// launches the coin with 1% of the UNB its wallet holds, exactly, quoted and bounded as every trade is, stakes every
/// coin it bought for the lister, takes back both allowances, tells the owner, and keeps the record Money shows. The
/// next pass sends nothing. `cargo test -p unbrowse-node-app the_listings_first_buy -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn the_listings_first_buy_launches_and_stakes_one_percent_of_the_wallets_unb_on_a_local_chain() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, payer) = payer_on_a_devnet("first-buy", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    assert_eq!(store::load_settings().coin_dev_buy_bps, store::COIN_DEV_BUY_BPS, "on by default");
    let (lister, e) = credited_lister(&chain, &payer, "route-f", 10_000.0).await;
    let me = owner_address(&lister).unwrap();
    let unb = UNB::new(d.unb, &p);
    let held = unb.balanceOf(me).call().await.unwrap();
    let sent = coins::launch_listed(&chain, &lister).await.expect("launched");
    assert_eq!(sent.len(), 2, "the launch and the stake: {sent:?}");
    assert_eq!(held - unb.balanceOf(me).call().await.unwrap(), coins::first_buy_units(held, 100), "1% of what the wallet held, exactly");
    let coin = RouteCoins::new(d.coins.route_coins, &p).coinOf(e).call().await.unwrap();
    assert_eq!(coin, coins::coin_address(d.coins.route_coins, d.coins.route_coin_implementation, e));
    let b = coins::first_buys();
    assert_eq!(b.len(), 1, "{b:?}");
    let units: U256 = b[0].units.parse().unwrap();
    assert!(!units.is_zero() && b[0].bps == 100, "{b:?}");
    assert_eq!((b[0].launch_tx.as_deref(), b[0].stake_tx.as_deref()), (Some(sent[0].as_str()), Some(sent[1].as_str())));
    // Every coin it bought is staked for the lister, in the lot of its fetch delay.
    assert_eq!(UNB::new(coin, &p).balanceOf(me).call().await.unwrap(), U256::ZERO, "none left unstaked");
    let lots = CoinStakes::new(d.coins.coin_stakes, &p).lotsOf(coin, me).call().await.unwrap();
    assert_eq!(lots.iter().fold(U256::ZERO, |a, l| a + l.earning + l.pending), units);
    assert!(lots.iter().all(|l| l.delay == b[0].delay), "in the lot of its fetch delay, {} s", b[0].delay);
    assert_eq!(unb.allowance(me, d.coins.route_coins).call().await.unwrap(), U256::ZERO, "no allowance outlives the launch");
    assert_eq!(UNB::new(coin, &p).allowance(me, d.coins.coin_stakes).call().await.unwrap(), U256::ZERO, "nor the stake");
    assert!(store::read_activity(50).iter().any(|a| a.note.as_deref().is_some_and(|n| n.contains("Your listing's first buy"))), "the owner is told");
    crate::apischema::check(&crate::apischema::r("FirstBuy"), &serde_json::to_value(&b[0]).unwrap(), &crate::apischema::types()).unwrap();
    assert!(coins::launch_listed(&chain, &lister).await.unwrap().is_empty(), "never twice");
    assert_eq!(coins::first_buys().len(), 1);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A wallet with no UNB launches nothing and the route stays listed; at a share of 0 the first buy is off; turned back
/// on at its default, it launches once the wallet holds UNB. `cargo test -p unbrowse-node-app the_listings_first_buy
/// -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn the_listings_first_buy_launches_nothing_from_a_wallet_with_no_unb_or_at_a_share_of_zero() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, payer) = payer_on_a_devnet("first-buy-none", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let rc = RouteCoins::new(d.coins.route_coins, &p);
    let (lister, e) = credited_lister(&chain, &payer, "route-n", 0.0).await;
    assert!(coins::launch_listed(&chain, &lister).await.unwrap().is_empty(), "no UNB: nothing launched, nothing said");
    assert_eq!(rc.coinOf(e).call().await.unwrap(), Address::ZERO);
    assert!(coins::first_buys().is_empty());
    assert!(entry(&chain, "route-n").await.unwrap().is_some_and(|x| x.live), "the route still lists");
    faucet(&chain, &lister, 1_000.0).await.unwrap();
    let mut s = store::load_settings();
    s.coin_dev_buy_bps = 0;
    store::save_settings(&s).unwrap();
    assert!(coins::launch_listed(&chain, &lister).await.unwrap().is_empty(), "a share of 0: off");
    assert_eq!(rc.coinOf(e).call().await.unwrap(), Address::ZERO);
    s.coin_dev_buy_bps = store::COIN_DEV_BUY_BPS;
    store::save_settings(&s).unwrap();
    assert_eq!(coins::launch_listed(&chain, &lister).await.unwrap().len(), 2, "on again, it launches and stakes");
    assert_ne!(rc.coinOf(e).call().await.unwrap(), Address::ZERO);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A first buy that may still land is never sent again: asked again while it waits to be mined, nothing more goes; once
/// it lands, the next pass takes it up and stakes what it bought, and only one 1% was spent.
/// `cargo test -p unbrowse-node-app the_listings_first_buy -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn the_listings_first_buy_that_may_still_land_is_not_sent_again() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, payer) = payer_on_a_devnet("first-buy-once", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let (lister, e) = credited_lister(&chain, &payer, "route-o", 10_000.0).await;
    let me = owner_address(&lister).unwrap();
    let unb = UNB::new(d.unb, &p);
    let held = unb.balanceOf(me).call().await.unwrap();
    let units = coins::first_buy_units(held, store::COIN_DEV_BUY_BPS);
    // Its allowance set ahead, as a launch's is in `a_launch_that_may_still_land`: the write held up is the launch.
    {
        let ls = as_signer(owner_signer(&lister).unwrap()).await.unwrap();
        approve(&ls, &d, d.coins.route_coins, d.unb, me, units).await.unwrap();
    }
    stop_mining(&p).await;
    assert!(tokio::time::timeout(GIVES_UP, coins::launch_listed(&chain, &lister)).await.is_err(), "the launch waits to be mined");
    let again = tokio::time::timeout(GIVES_UP, coins::launch_listed(&chain, &lister)).await;
    assert!(again.as_ref().is_ok_and(|r| r.as_ref().is_ok_and(|v| v.is_empty())), "nothing more is sent: {again:?}");
    mine_and_go_on(&p).await;
    let after = coins::launch_listed(&chain, &lister).await.expect("the launch that landed is taken up");
    assert_eq!(after.len(), 1, "its stake: {after:?}");
    assert_eq!(held - unb.balanceOf(me).call().await.unwrap(), units, "one first buy");
    let coin = RouteCoins::new(d.coins.route_coins, &p).coinOf(e).call().await.unwrap();
    assert_ne!(coin, Address::ZERO);
    let b = coins::first_buys();
    assert!(b.len() == 1 && b[0].launch_tx.as_deref().is_some_and(|t| !t.is_empty()) && b[0].stake_tx.is_some(), "{b:?}");
    assert_eq!(UNB::new(coin, &p).balanceOf(me).call().await.unwrap(), U256::ZERO, "what it bought is staked");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A route coin end to end on a devnet: its contributor launches it, a paid fetch buys and stakes it for the payer by
/// itself, the payer and the serving contributor are checked, the entry ranks by the payer's stake (counted by its exit
/// delay), the payer's own failed call takes its stake out of the rank and a passed one puts it back, a stake whose
/// owner never paid a call on the entry never counts, an unstake request stops a stake at once, and a stake the owner
/// asks for goes on once. `cargo test -p unbrowse-node-app a_coin_is_launched -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_coin_is_launched_bought_by_a_fetch_staked_and_ranked_on_a_local_chain() {
    use crate::rank::coin::{exit_delay_weight, DEFAULT_EXIT_DELAY};
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, payer) = payer_on_a_devnet("coins", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let lister = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&lister).unwrap();
    let c_addr = owner_address(&lister).unwrap();
    faucet(&chain, &lister, 10_000.0).await.unwrap();
    set_fee(&chain, &lister, 0.01, None).await.unwrap();
    list_entry(&chain, &lister, "route-c", "shop.example", "Search items").await.unwrap();
    let entry = test_entry("route-c");
    // A paid line the lister served, claimed: it credits the entry (R2.18). No coin yet, so the route share is owed.
    let pay = |passed: bool| {
        let (chain, payer) = (&chain, &payer);
        async move {
            let epoch = current_epoch(chain).await.unwrap();
            add_network_receipt(0, epoch, entry, Some(c_addr), 0.01, passed, 0.0, 100.0, 1_000.0).unwrap();
            claim(chain, payer, 0, epoch, ClaimWhen::Now).await.unwrap()
        }
    };
    pay(true).await.expect("claimed");
    assert!(coins::launch(&chain, &payer, entry, 10.0).await.unwrap_err().contains("credited contributor"), "only the credited contributor launches");
    let launched = coins::launch(&chain, &lister, entry, 1_000.0).await.expect("the lister launches its coin");
    let coin: Address = launched.coin.parse().unwrap();
    assert!(launched.amount.is_some());
    advance_day(&chain).await.unwrap();

    // The payer's next paid call, served by the lister: the fetch buys the coin for the payer and stakes it, checked.
    pay(true).await.expect("claimed");
    coins::complete_own_buys(&chain, &payer).await.unwrap();
    let h = coins::holdings(&chain, &payer).await.unwrap();
    let held = h.coins.iter().find(|x| x.coin.parse::<Address>().ok() == Some(coin)).expect("the payer holds the coin");
    assert!(held.checked && held.latest_passed, "checked by its counting call, which passed: {held:?}");
    assert_eq!(held.parked_usdc, 0.0, "nothing left parked");
    let staked: f64 = held.lots.iter().map(|l| l.earning + l.pending).sum();
    assert!(staked > 0.0, "the fetch staked what it bought: {held:?}");
    assert_eq!(held.lots.iter().map(|l| l.delay).collect::<Vec<_>>(), vec![DEFAULT_EXIT_DELAY], "in the lot of the payer's fetch delay");
    // Beside its UNB value, an estimate of it in dollars, at the UNB pool's steady price (R1.30).
    let one = UnbPool::new(d.pool, &p).steadyQuoteUnbOut(d.usdc_units(1.0)).call().await.unwrap();
    assert_eq!(h.unb_usd, coins::usd_per_unb(unb_f(one)), "one UNB at the pool's steady quote");
    if let Some(usd) = h.unb_usd {
        assert!(held.value_usd.is_some_and(|v| (v - held.value_unb * usd).abs() <= 1e-9 * v.abs().max(1.0)), "{held:?}");
    }
    crate::apischema::check(&crate::apischema::r("Holdings"), &serde_json::to_value(&h).unwrap(), &crate::apischema::types()).unwrap();
    assert!(coins::holdings(&chain, &lister).await.unwrap().coins.iter().any(|x| x.checked), "the lister served a counting line: checked too");

    // Rank from the chain: only the payer's stake counts (the lister's coins are unstaked), weighed by its delay.
    async fn rank(chain: &Chain, entry: FixedBytes<32>) -> crate::rank::coin::Rank {
        coins::forget_ranks().await;
        coins::ranks(chain, &[entry], Duration::from_secs(120)).await.get(&entry).copied().unwrap_or_default()
    }
    let r = rank(&chain, entry).await;
    println!("rank {r:?}");
    assert!(r.score > 0.0 && r.market_cap > 0.0 && r.collateral > 0.0, "{r:?}");
    assert!((r.counted - staked * exit_delay_weight(DEFAULT_EXIT_DELAY)).abs() <= staked * 1e-9, "{} for {staked} staked", r.counted);

    // The payer marks its own latest call failed: its stake stops counting (`rank.counted-stake`).
    {
        let s = as_signer(owner_signer(&payer).unwrap()).await.unwrap();
        async { Ok::<_, String>(crate::rpc::mined!(CoinStakes::new(d.coins.coin_stakes, &s).reportFailed(entry), "reporting a failure")) }.await.unwrap();
    }
    assert_eq!(rank(&chain, entry).await.score, 0.0, "a stake whose latest call failed counts for nothing");
    pay(true).await.expect("claimed");
    assert!(rank(&chain, entry).await.score > 0.0, "a later passed call counts it again");

    // The lister stakes its launch coins for a week: checked, but it never paid a call on its own entry, so its stake
    // never counts (`rank.counted-stake`: its own latest paid call must have passed).
    let before = rank(&chain, entry).await.counted;
    let lister_coins = coins::holdings(&chain, &lister).await.unwrap().coins.iter().find(|x| x.coin.parse::<Address>().ok() == Some(coin)).unwrap().held;
    coins::stake(&chain, &lister, entry, lister_coins / 2.0, 7 * 86_400).await.expect("the lister stakes");
    assert!((rank(&chain, entry).await.counted - before).abs() <= before * 1e-9, "the lister's stake adds nothing it hasn't earned by a call of its own");

    // An unstake request stops the payer's stake at once.
    coins::request_unstake(&chain, &payer, entry, DEFAULT_EXIT_DELAY, staked).await.expect("asked back");
    assert_eq!(rank(&chain, entry).await.score, 0.0, "coins asked back count for nothing");
    let lots = coins::holdings(&chain, &payer).await.unwrap().coins.into_iter().find(|x| x.coin.parse::<Address>().ok() == Some(coin)).unwrap().lots;
    assert!(lots.iter().any(|l| l.unstaking > 0.0 && l.ready_at > 0), "waiting out its delay: {lots:?}");

    // A stake that may still land is never sent twice (`inflight`). Its allowance is set first, as `allow_ahead` sets a
    // launch's: the write held up is the stake alone.
    let s = ProviderBuilder::new().connect_http(url());
    let before = CoinStakes::new(d.coins.coin_stakes, &p).totalStaked(coin).call().await.unwrap();
    {
        let ls = as_signer(owner_signer(&lister).unwrap()).await.unwrap();
        let v = coins::verify_coin(&ls, &d, entry).await.unwrap();
        approve_coin(&ls, &d, d.coins.coin_stakes, &v, c_addr, unb_units(1.0)).await.unwrap();
    }
    stop_mining(&s).await;
    assert!(tokio::time::timeout(GIVES_UP, coins::stake(&chain, &lister, entry, 1.0, 7 * 86_400)).await.is_err(), "the stake waits to be mined");
    let again = tokio::time::timeout(GIVES_UP, coins::stake(&chain, &lister, entry, 1.0, 7 * 86_400)).await;
    mine_and_go_on(&s).await;
    let after = CoinStakes::new(d.coins.coin_stakes, &p).totalStaked(coin).call().await.unwrap();
    assert_eq!(after - before, unb_units(1.0), "one stake went on: {again:?}");
    assert!(coins::stake(&chain, &lister, entry, 1.0, 7 * 86_400).await.unwrap_err().contains("landed"), "the one that landed is said");
    assert_eq!(UNB::new(coin, &p).allowance(c_addr, d.coins.coin_stakes).call().await.unwrap(), U256::ZERO, "no allowance outlives its stake");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A bounty end to end on a devnet: posted for a site as a limit order, confirmed by its poster for an entry of that site
/// once its own paid call on the entry was claimed as a counting line and the entry's coin is launched (refused before
/// either, with nothing spent: a bounty never launches a coin), which buys the entry's coin with the bounty and stakes
/// half for the lister and half for the poster, never twice; and a second bounty, unconfirmed, settled after its
/// deadline and released by the use another wallet made of the site: the entry with a coin buys it, the entry with none
/// gives its share to the poster, and the rest is taken back. `cargo test -p unbrowse-node-app a_bounty_is_posted -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_bounty_is_posted_confirmed_released_by_use_and_refunded_on_a_local_chain() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, poster) = payer_on_a_devnet("bounties", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let me = owner_address(&poster).unwrap();
    let lister = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&lister).unwrap();
    let b_addr = owner_address(&lister).unwrap();
    faucet(&chain, &lister, 1_000.0).await.unwrap();
    set_fee(&chain, &lister, 0.01, None).await.unwrap();
    let posted = bounty_post(&chain, &poster, "https://www.news.example/", 500.0, None, 2 * 86_400).await.expect("posted");
    assert_eq!(posted.id, 0);
    let b = bounty_show(&chain, &poster, 0).await.unwrap();
    assert_eq!((b.mine, b.amount, b.state.as_str(), b.site.as_str()), (true, 500.0, "open", format!("{:#x}", domain_hash("news.example")).as_str()), "{b:?}");
    list_entry(&chain, &lister, "route-b", "news.example", "Search news").await.unwrap();
    let entry = test_entry("route-b");
    // Before the poster's own call on the entry is claimed, a confirmation is refused, and nothing is spent.
    assert!(bounty_confirm(&chain, &poster, 0, entry, None).await.is_err(), "no counting line of the poster's yet");
    let epoch = current_epoch(&chain).await.unwrap();
    add_network_receipt(0, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    claim(&chain, &poster, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    let rc = RouteCoins::new(d.coins.route_coins, &p);
    assert!(bounty_confirm(&chain, &poster, 0, entry, None).await.unwrap_err().contains("can't be confirmed"), "no coin yet: a bounty never launches one");
    assert_eq!(rc.coinOf(entry).call().await.unwrap(), Address::ZERO, "nothing launched");
    // The lister launches its coin, and the snipe window passes.
    coins::launch(&chain, &lister, entry, 10.0).await.expect("the lister launches");
    let coin = rc.coinOf(entry).call().await.unwrap();
    assert_ne!(coin, Address::ZERO);
    let window = CoinFetch::new(d.coins.coin_fetch, &p).WINDOW().call().await.unwrap().to::<u64>();
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (window + 1,)).await.unwrap();
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    let amount = coins::CoinBounties::new(d.coins.coin_bounties, &p).bountyOf(U256::ZERO).call().await.unwrap().amount;
    let done = bounty_confirm(&chain, &poster, 0, entry, None).await.expect("confirmed");
    assert_eq!(done.id, 0);
    assert_eq!(rc.coinOf(entry).call().await.unwrap(), coin, "the confirmation bought the lister's coin");
    // What the node sent as the most it pays a coin: the curve's quote for the whole bounty, read the block before the
    // confirmation, with the trade slippage (`max_cost`; red L-2).
    {
        use alloy::consensus::Transaction as _;
        use alloy::sol_types::SolCall;
        let h: alloy::primitives::B256 = done.tx.parse().unwrap();
        let sent = p.get_transaction_by_hash(h).await.unwrap().expect("the confirmation");
        let call = coins::CoinBounties::confirmCall::abi_decode(sent.input()).unwrap();
        let at = p.get_transaction_receipt(h).await.unwrap().expect("mined").block_number.unwrap() - 1;
        let quoted = rc.quoteBuy(coin, amount).block(alloy::eips::BlockId::number(at)).call().await.unwrap().coinsOut;
        assert!(quoted > U256::ZERO);
        assert_eq!(call.maxCost, max_cost(amount, quoted), "the quote with the trade slippage");
    }
    for (who, keys) in [("poster", &poster), ("lister", &lister)] {
        let h = coins::holdings(&chain, keys).await.unwrap();
        let x = h.coins.iter().find(|x| x.coin.parse::<Address>().ok() == Some(coin)).unwrap_or_else(|| panic!("the {who} holds the coin"));
        assert!(x.lots.iter().map(|l| l.earning + l.pending).sum::<f64>() > 0.0, "staked for the {who}: {x:?}");
    }
    assert!(bounty_confirm(&chain, &poster, 0, entry, None).await.is_err(), "never twice");
    assert_eq!(bounty_show(&chain, &poster, 0).await.unwrap().state, "confirmed");

    // A second bounty, open an hour, unconfirmed: another wallet's counting lines on the site release a share by use,
    // on the entry with a coin and on a second entry of the site with none.
    list_entry(&chain, &lister, "route-c", "news.example", "Search news, again").await.unwrap();
    let coinless = test_entry("route-c");
    bounty_post(&chain, &poster, "news.example", 300.0, None, 3_600).await.expect("posted");
    let other = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&other).unwrap();
    faucet(&chain, &other, 1_000.0).await.unwrap();
    deposit(&chain, &other, 100.0).await.unwrap();
    authorize(&chain, &other, 1, 100.0, 0).await.unwrap();
    let epoch = current_epoch(&chain).await.unwrap();
    add_network_receipt(1, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 100.0).unwrap();
    add_network_receipt(1, epoch, coinless, Some(b_addr), 0.01, true, 0.01, 100.0, 100.0).unwrap();
    claim(&chain, &other, 1, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    assert!(bounty_settle(&chain, &poster, 1).await.is_err(), "not before its deadline");
    advance_day(&chain).await.unwrap();
    bounty_settle(&chain, &poster, 1).await.expect("settled after its deadline");
    let settled = bounty_show(&chain, &poster, 1).await.unwrap();
    assert!(settled.settled && settled.reserved > 0.0 && settled.use_usdc > 0.0, "{settled:?}");
    assert!(settled.reserved <= 300.0);
    let mut used: Vec<_> = bounty_used_entries(&chain, 1).await.unwrap().iter().map(|(e, _)| *e).collect();
    used.sort();
    let mut want = vec![entry, coinless];
    want.sort();
    assert_eq!(used, want);
    let cb = coins::CoinBounties::new(d.coins.coin_bounties, &p);
    let staked_before = CoinStakes::new(d.coins.coin_stakes, &p).totalStaked(coin).call().await.unwrap();
    // The lister's own node, with the bounty steps on, releases its entry with a coin and skips the one with none: no
    // release, so no gas, and no share handed to the poster (Amit, 14 Nov).
    let nonce = p.get_transaction_count(b_addr).await.unwrap();
    let (_, done) = crate::autobounty::tick(&chain, &lister, true).await.unwrap().expect("a board");
    assert_eq!(done.released, vec![(1, entry)], "only the entry with a coin is released");
    assert!(!cb.releasedFor(U256::from(1u8), coinless).call().await.unwrap(), "the coinless entry's share is untouched");
    assert_eq!(p.get_transaction_count(b_addr).await.unwrap(), nonce + 1, "one write: the release of the entry with a coin");
    assert!(CoinStakes::new(d.coins.coin_stakes, &p).totalStaked(coin).call().await.unwrap() > staked_before, "the share bought the entry's coin");
    assert!(bounty_release_by_use(&chain, &lister, 1, entry).await.is_err(), "once per entry");
    // The poster's own pass, steps on or off, releases its bounty's coinless entry, whose share is the poster's, and then
    // takes back everything that is its own (red L-3): nothing waits for someone to release that share by hand.
    let unb = UNB::new(d.unb, &p);
    let before = unb.balanceOf(me).call().await.unwrap();
    let held = unb.balanceOf(d.coins.coin_bounties).call().await.unwrap();
    assert!(bounty_show(&chain, &poster, 1).await.unwrap().refundable > 0.0, "what use didn't reserve is the poster's");
    let (_, done) = crate::autobounty::tick(&chain, &poster, false).await.unwrap().expect("a board");
    assert!(done.refunded.contains(&1), "taken back: {done:?}");
    assert!(cb.releasedFor(U256::from(1u8), coinless).call().await.unwrap(), "the poster's pass released the coinless entry");
    assert_eq!(rc.coinOf(coinless).call().await.unwrap(), Address::ZERO, "a release never launches a coin");
    // In units, as the contract has it: the views' whole UNB is a float and rounds.
    let left = cb.shareLeftOf(U256::from(1u8), entry).call().await.unwrap();
    assert_eq!(unb.balanceOf(d.coins.coin_bounties).call().await.unwrap(), left, "the bounties hold only what the entry with a coin may still fill");
    assert_eq!(unb.balanceOf(me).call().await.unwrap() - before, held - left, "exactly what was the poster's");
    assert_eq!(unb.allowance(me, d.coins.coin_bounties).call().await.unwrap(), U256::ZERO, "no allowance outlives a post");
    let mine = bounty_list(&chain, &poster, true).await.unwrap();
    assert_eq!(mine.iter().map(|b| b.id).collect::<Vec<_>>(), vec![1, 0], "the owner's, newest first");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// Red L-4 on a devnet: the most a confirmation pays a coin is fixed when the owner allows it, before the poster's line
/// on the entry is claimed. A wallet that buys the coin up after that, a block or more before the node's pass, can't
/// lift it: the confirmation fails for its price on that pass and the next, the cap kept as it was and nothing sent,
/// the owner told once ("price moved: wait, or post the bounty again with a limit"), and the buyer can't sell back at a profit.
/// `cargo test -p unbrowse-node-app a_confirm_keeps_its_cap -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_confirm_keeps_its_cap_when_the_price_is_pushed_on_a_local_chain() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, poster) = payer_on_a_devnet("bounty-cap", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let me = owner_address(&poster).unwrap();
    let lister = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&lister).unwrap();
    let b_addr = owner_address(&lister).unwrap();
    faucet(&chain, &lister, 1_000.0).await.unwrap();
    set_fee(&chain, &lister, 0.01, None).await.unwrap();
    list_entry(&chain, &lister, "route-b", "news.example", "Search news").await.unwrap();
    let entry = test_entry("route-b");
    // The poster's first call credits the entry; the lister launches its coin and the snipe window passes.
    let epoch = current_epoch(&chain).await.unwrap();
    add_network_receipt(0, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    claim(&chain, &poster, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    coins::launch(&chain, &lister, entry, 10.0).await.expect("the lister launches");
    let window = CoinFetch::new(d.coins.coin_fetch, &p).WINDOW().call().await.unwrap().to::<u64>();
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (window + 1,)).await.unwrap();
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    let posted = bounty_post(&chain, &poster, "news.example", 500.0, None, 2 * 86_400).await.expect("posted");
    let id = posted.id;

    // The owner allows the confirmation: its cap is read now, before the poster's line is claimed.
    crate::autobounty::allow(&chain, me, id, entry).await.unwrap();
    let cap = crate::autobounty::cap_of(me, id, &entry).expect("a cap kept with the owner's yes");

    // A wallet buys the coin up, and a block passes before the node's pass.
    let mallory = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&mallory).unwrap();
    let m_addr = owner_address(&mallory).unwrap();
    faucet(&chain, &mallory, 1_100_000.0).await.unwrap();
    let unb = UNB::new(d.unb, &p);
    let before = unb.balanceOf(m_addr).call().await.unwrap();
    // Against the curve's 30M virtual UNB, a 1M buy lifts the price several percent: well past the 1% slippage.
    coins::buy(&chain, &mallory, entry, 1_000_000.0).await.expect("mallory buys");
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    // The poster's counting line since the post is claimed: the confirmation can run.
    add_network_receipt(0, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (1u64,)).await.unwrap();
    claim(&chain, &poster, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    // The fresh bound is more than 2% above the cap: a confirmation sent with it would fill at the pushed price.
    let fresh = bounty_confirm_cap(&chain, id, entry).await.unwrap().expect("a quote");
    assert!(fresh > cap * U256::from(102u8) / U256::from(100u8), "the push lifted the fresh bound past the slippage: {fresh} vs {cap}");

    // The node's pass: the confirmation fails for its price, and the owner is told.
    let told = |acts: &[store::Activity]| acts.iter().filter(|a| a.note.as_deref().is_some_and(|n| n.contains(PRICE_MOVED))).count();
    crate::autobounty::tick(&chain, &poster, true).await.unwrap().expect("a board");
    assert!(!bounty_show(&chain, &poster, id).await.unwrap().confirmed, "not confirmed at the pushed price");
    assert_eq!(crate::autobounty::cap_of(me, id, &entry), Some(cap), "the cap is kept as it was");
    assert_eq!(told(&store::read_activity(200)), 1, "the owner is told");
    assert!(bounty_confirm(&chain, &poster, id, entry, Some(cap)).await.unwrap_err().contains(PRICE_MOVED), "the command says so too");

    // The price stays pushed: the next pass sends nothing and keeps the cap, and the owner isn't told again.
    let nonce = p.get_transaction_count(me).await.unwrap();
    crate::autobounty::tick(&chain, &poster, true).await.unwrap().expect("a board");
    assert!(!bounty_show(&chain, &poster, id).await.unwrap().confirmed);
    assert_eq!(p.get_transaction_count(me).await.unwrap(), nonce, "nothing sent");
    assert_eq!(crate::autobounty::cap_of(me, id, &entry), Some(cap), "still the same cap");
    assert_eq!(told(&store::read_activity(200)), 1, "told once");

    // The buyer sells back for less than it paid: the push bought it nothing.
    let coin = RouteCoins::new(d.coins.route_coins, &p).coinOf(entry).call().await.unwrap();
    let held = UNB::new(coin, &p).balanceOf(m_addr).call().await.unwrap();
    coins::sell(&chain, &mallory, entry, unb_f(held) * 0.999).await.expect("mallory sells"); // under the float's rounding
    assert!(unb.balanceOf(m_addr).call().await.unwrap() < before, "no profit from the push");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// Policy 1b on a devnet: the owner allows a confirmation before the entry has a coin, so no cap is kept from that yes.
/// The coin then launches and trades past its snipe window, and the poster's line is claimed: the node's pass sends
/// nothing, then or later, and tells the owner once that it needs a hand confirm or posting again with a limit. The
/// owner's own `bounty confirm` still works, on the fresh quote.
/// `cargo test -p unbrowse-node-app a_bounty_allowed_before_its_coin -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_bounty_allowed_before_its_coin_waits_for_a_hand_confirm_on_a_local_chain() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, poster) = payer_on_a_devnet("bounty-hand", 0.01, 1).await;
    let d = chain.deployed().unwrap();
    let p = ProviderBuilder::new().connect_http(url());
    let me = owner_address(&poster).unwrap();
    let lister = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&lister).unwrap();
    let b_addr = owner_address(&lister).unwrap();
    faucet(&chain, &lister, 1_000.0).await.unwrap();
    set_fee(&chain, &lister, 0.01, None).await.unwrap();
    list_entry(&chain, &lister, "route-b", "news.example", "Search news").await.unwrap();
    let entry = test_entry("route-b");
    let epoch = current_epoch(&chain).await.unwrap();
    add_network_receipt(0, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    claim(&chain, &poster, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    let id = bounty_post(&chain, &poster, "news.example", 500.0, None, 2 * 86_400).await.expect("posted").id;

    // The owner's yes, while the entry has no coin: nothing to fix a cap from.
    crate::autobounty::allow(&chain, me, id, entry).await.unwrap();
    assert_eq!(crate::autobounty::cap_of(me, id, &entry), None, "no cap without a coin");

    // The coin launches and trades past its snipe window; the poster's line since the post is claimed.
    coins::launch(&chain, &lister, entry, 10.0).await.expect("the lister launches");
    let window = CoinFetch::new(d.coins.coin_fetch, &p).WINDOW().call().await.unwrap().to::<u64>();
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (window + 1,)).await.unwrap();
    let _: serde_json::Value = p.raw_request("evm_mine".into(), ()).await.unwrap();
    add_network_receipt(0, epoch, entry, Some(b_addr), 0.01, true, 0.0, 100.0, 1_000.0).unwrap();
    let _: serde_json::Value = p.raw_request("evm_increaseTime".into(), (1u64,)).await.unwrap();
    claim(&chain, &poster, 0, epoch, ClaimWhen::Now).await.unwrap().expect("claimed");
    assert!(bounty_confirm_cap(&chain, id, entry).await.unwrap().is_some(), "the coin trades: a confirmation could run now");

    // The node's passes send nothing and keep no cap; the owner is told once.
    let told = |acts: &[store::Activity]| acts.iter().filter(|a| a.note.as_deref().is_some_and(|n| n.contains(NEEDS_HAND))).count();
    let nonce = p.get_transaction_count(me).await.unwrap();
    for _ in 0..2 {
        crate::autobounty::tick(&chain, &poster, true).await.unwrap().expect("a board");
    }
    assert!(!bounty_show(&chain, &poster, id).await.unwrap().confirmed, "not confirmed by the node on its own");
    assert_eq!(p.get_transaction_count(me).await.unwrap(), nonce, "nothing sent");
    assert_eq!(crate::autobounty::cap_of(me, id, &entry), None, "no cap taken after the yes");
    assert_eq!(told(&store::read_activity(200)), 1, "the owner is told once");

    // The owner's own confirmation works as before: no kept cap, so the fresh quote.
    bounty_confirm(&chain, &poster, id, entry, None).await.expect("confirmed by hand");
    assert!(bounty_show(&chain, &poster, id).await.unwrap().confirmed);
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A key the owner's wallet granted draws on that wallet's deposit, and a node's own key on the node's: what one payer's
/// agents signed is no claim on the other's. `cargo test -p unbrowse-node-app a_deposit_answers_only`
#[test]
fn a_deposit_answers_only_for_the_lines_of_its_own_payer() {
    let _home = store::scratch_home("per-payer");
    let own = crate::agents::Agent { index: 1, name: "own".into(), address: String::new(), cap_usdc: 100.0, expires: 0, created: 0, revoked: false, tx: None, salt: None, auto: false, cap_set: false, payers: vec![], gateway: None };
    let wallet = crate::agents::Agent { index: 2, name: "wallet's".into(), payers: vec![(0, Some(format!("{:#x}", Address::repeat_byte(0xaa))))], ..own.clone() };
    store::write_json(&store::home().join("agents.json"), &unbrowse_files::AGENTS, &vec![own, wallet]).unwrap();
    add_receipt(1, 10, "route-a", 8.0, true, 0.0, 100.0, 10.0).unwrap();
    assert!(reserve(2, 10, 5.0, 0.0, 100.0, 5.0).is_ok(), "the node's 8 are nothing to the wallet's deposit");
    assert!(reserve(1, 10, 5.0, 0.0, 100.0, 10.0).is_err(), "and they count against the node's own");
}

/// A call in flight was checked against its payer's deposit and will write its line under the stream's payer, so a
/// change of payer waits for the next stream, as it does for a line already written.
#[test]
fn a_call_in_flight_keeps_the_payer_it_was_checked_against() {
    let _home = store::scratch_home("payer-flip");
    assert_eq!(moving_payer(7, 10, |from| from), 10, "a stream that hasn't begun moves now");
    let place = reserve(7, 10, 1.0, 0.0, 100.0, 100.0).unwrap();
    assert_eq!(moving_payer(7, 10, |from| from), 11, "a call holding a place has begun it");
    drop(place);
    assert_eq!(moving_payer(7, 10, |from| from), 10, "and one that ended without a line hasn't");
    add_receipt(7, 10, "route-a", 1.0, true, 0.0, 100.0, 100.0).unwrap();
    assert_eq!(moving_payer(7, 10, |from| from), 11, "a line has");
    std::fs::write(receipts_path(8, 10), "not json").unwrap();
    assert_eq!(moving_payer(8, 10, |from| from), 11, "a file that doesn't read may hold lines");
}

/// A line's window is its epoch and the next, and what is left unpaid is what the chain says, not this node's marks: a
/// watchtower pays lines the node never saw go.
#[test]
fn a_closed_window_leaves_what_the_chain_did_not_pay() {
    assert!(!window_closed(9, 9) && !window_closed(9, 10), "still open");
    assert!(window_closed(9, 11));
    let lines = [line(4.0, true, false), line(1.0, true, true), line(9.0, false, false)];
    assert_eq!(left_unpaid(&lines, 0.0), 5.0, "a failed line owes nothing");
    assert_eq!(left_unpaid(&lines, 1.0), 4.0);
    assert_eq!(left_unpaid(&lines, 5.0), 0.0, "a tower paid them all");
}

/// A node away through a whole window never visits it again: the owner hears what it left unpaid, once.
/// `cargo test -p unbrowse-node-app a_line_whose_window_closed -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_line_whose_window_closed_is_said_once() {
    let _one = crate::testchain::one_at_a_time().await;
    let (home, _env, chain, keys) = payer_on_a_devnet("lapsed-line", 0.01, 1).await;
    let a = crate::agents::create(&keys, "away", 10.0, 30, 0).unwrap().0;
    let epoch = current_epoch(&chain).await.unwrap();
    add_receipt(a.index, epoch, "route-a", 0.01, true, 0.0, 10.0, 100.0).unwrap();
    for _ in 0..3 {
        advance_day(&chain).await.unwrap();
    }
    let now = current_epoch(&chain).await.unwrap();
    assert!(window_closed(epoch, now));
    tell_lapsed(&chain, &keys, now).await.unwrap();
    assert!(receipts(a.index, epoch).unwrap()[0].lapsed, "the line says so");
    let told = || store::read_activity(50).into_iter().filter(|e| e.what.contains("never claimed")).count();
    assert_eq!(told(), 1);
    tell_lapsed(&chain, &keys, now + 1).await.unwrap();
    assert_eq!(told(), 1, "once");
    drop(chain);
    let _ = std::fs::remove_dir_all(&home);
}

/// A top-up fills the deposit to its floor from the USDC the wallet holds, never from what was paid out to it.
#[test]
fn a_top_up_never_takes_what_was_paid_out_to_the_node() {
    let u = U256::from;
    assert_eq!(to_deposit(u(0), u(100), u(250), u(0)), u(100), "up to the floor");
    assert_eq!(to_deposit(u(40), u(100), u(250), u(0)), u(60));
    assert_eq!(to_deposit(u(0), u(100), u(100), u(100)), u(0), "all of it paid out here: none moves");
    assert_eq!(to_deposit(u(0), u(100), u(130), u(100)), u(30), "the owner's fresh USDC beside it does");
    assert_eq!(to_deposit(u(0), u(100), u(60), u(100)), u(0), "gas spent some of it: still none");
    assert_eq!(to_deposit(u(120), u(100), u(250), u(0)), u(0), "over the floor");
}

/// A withdrawal with no linked wallet is paid to the node's own address. The top-up used to move it straight back into
/// the deposit, and nothing could send it anywhere else; now it stays until the owner sends it on, and the top-up
/// leaves it alone. `cargo test -p unbrowse-node-app a_withdrawal_paid_to_the_node -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_withdrawal_paid_to_the_node_stays_there_until_the_owner_sends_it_on() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("paid-out-stays");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing: Existing::default(), ..network_file(net).unwrap() }).unwrap();
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
    let d = file.deployment.unwrap();
    let node = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&node).unwrap();
    let me = owner_address(&node).unwrap();
    anvil.fund(me).await;
    let chain = Chain::default();
    chain.start().await.expect("the node on its live chain");
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    let faucet = async |amount: f64| {
        let op = as_signer(owner_signer(&operator).unwrap()).await.unwrap();
        let _ = crate::rpc::mined!(USDC::new(d.usdc, &op).faucet(me, d.usdc_units(amount)), "the faucet's USDC");
        Ok::<(), String>(())
    };
    let held = async || d.usdc_f(USDC::new(d.usdc, &p).balanceOf(me).call().await.unwrap());
    faucet(1.0).await.unwrap();
    assert_eq!(top_up(&chain, &node, 1.0, 0.25).await.unwrap(), Some(1.0));
    request_withdraw(&chain, &node, 1.0).await.unwrap();
    mine_epochs(&p, d.blocks_per_epoch(), 2).await.unwrap();
    withdraw_to(&chain, &node, None).await.unwrap();
    assert_eq!(held().await, 1.0, "paid to the node's own address");
    assert_eq!(top_up(&chain, &node, 1.0, 0.25).await.unwrap(), None, "and left there");
    let mine = Address::repeat_byte(0x42);
    send_usdc(&chain, &node, mine, 0.6).await.unwrap();
    assert_eq!(d.usdc_f(USDC::new(d.usdc, &p).balanceOf(mine).call().await.unwrap()), 0.6, "sent on to the owner's address");
    assert!(send_usdc(&chain, &node, mine, 0.6).await.is_err(), "no more than the node holds");
    faucet(0.5).await.unwrap();
    let topped = top_up(&chain, &node, 1.0, 0.25).await.unwrap().expect("the owner's fresh USDC goes in");
    assert!((topped - 0.5).abs() < 1e-9, "that alone, and not the 0.4 still paid out here: {topped}");
    assert!((held().await - 0.4).abs() < 1e-9);
    forget_live();
}

/// What the node's lines can be drawn on is the deposit less a withdrawal asked for, the figure Money shows, so that is what
/// a top-up fills. Read as the balance, a partial withdrawal leaves agents short with the USDC to pay them in the wallet.
/// `cargo test -p unbrowse-node-app a_top_up_fills_what -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn a_top_up_fills_what_a_withdrawal_leaves_spendable() {
    let _one = crate::testchain::one_at_a_time().await;
    crate::testchain::home("top-up-spendable");
    let anvil = crate::testchain::Anvil::start(arc::ARC_TESTNET.chain_id).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_CHAIN", "arc-testnet".into()), ("UNBROWSE_RPC", anvil.url())]);
    let net = &arc::ARC_TESTNET;
    store::write_json(&home_network_file(net), &unbrowse_files::NETWORK, &NetworkFile { existing: Existing::default(), ..network_file(net).unwrap() }).unwrap();
    let operator = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&operator).unwrap();
    anvil.fund(owner_address(&operator).unwrap()).await;
    let Ok(Mode::Live(l)) = chosen() else { panic!("arc-testnet") };
    let (_, file) = deploy_shared(&l, &operator, None, &DEVNET_OPEN).await.expect("deployed");
    let d = file.deployment.unwrap();
    let node = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&node).unwrap();
    let me = owner_address(&node).unwrap();
    anvil.fund(me).await;
    let chain = Chain::default();
    chain.start().await.expect("the node on its live chain");
    async fn send_usdc(operator: &unbrowse_core::MemoryStore, d: &Deployment, to: Address, amount: f64) -> Result<(), String> {
        let p = as_signer(owner_signer(operator)?).await?;
        let _ = crate::rpc::mined!(USDC::new(d.usdc, &p).faucet(to, d.usdc_units(amount)), "the faucet's USDC");
        Ok(())
    }
    send_usdc(&operator, &d, me, 2.0).await.unwrap();
    assert_eq!(top_up(&chain, &node, 1.0, 0.25).await.unwrap(), Some(1.0));
    request_withdraw(&chain, &node, 0.9).await.unwrap();
    let topped = top_up(&chain, &node, 0.5, 0.25).await.unwrap().expect("0.1 spendable is under the floor, with USDC in the wallet");
    assert!((topped - 0.4).abs() < 1e-9, "up to the floor: {topped}");
    let p = ProviderBuilder::new().connect_http(anvil.url().parse().unwrap());
    assert_eq!(LeanSettlement::new(d.settlement, &p).account(me).call().await.unwrap().pending, d.usdc_units(0.9), "the withdrawal stands");
    forget_live();
}

/// A held line of `payer`'s stream (agent `agent`, epoch 9) under a voucher totalling `cumulative`.
fn held_line(payer: u8, agent: u8, index: u64, cumulative: u64, amount: u64, passed: bool) -> PaidLine {
    PaidLine {
        payer: Address::repeat_byte(payer),
        agent: Address::repeat_byte(agent),
        epoch: 9,
        cumulative: U256::from(cumulative),
        lines: index + 1,
        passed_lines: index + 1,
        receipts_root: FixedBytes::ZERO,
        signature: Default::default(),
        index: U256::from(index),
        entry_id: FixedBytes::ZERO,
        amount: U256::from(amount),
        passed,
        holders: vec![],
        bounty: U256::ZERO,
        proof: vec![],
    }
}

/// A server's lines of one payer, by stream: the highest total each stream's vouchers signed and what the passed lines
/// owe it. Another payer's lines, a failed line, and a stream whose window has closed aren't counted (issue #181).
#[test]
fn a_payers_streams_are_what_its_held_vouchers_signed() {
    let held = vec![held_line(1, 2, 0, 5, 1, true), held_line(1, 2, 3, 9, 2, true), held_line(1, 2, 4, 9, 3, false), held_line(1, 3, 0, 4, 4, true), held_line(7, 2, 0, 50, 5, true)];
    let streams = streams_of(Address::repeat_byte(1), &held, None, 10);
    let a = streams.iter().find(|(k, _)| k.0 == Address::repeat_byte(2)).unwrap().1;
    assert_eq!((a.cumulative, a.owed), (U256::from(9), U256::from(3)), "the highest total, and the passed lines owed");
    assert_eq!(streams.len(), 2, "another payer's stream isn't this payer's");
    assert!(streams_of(Address::repeat_byte(1), &held, None, 11).is_empty(), "epoch 9 can't be claimed in 11");
    let also = streams_of(Address::repeat_byte(1), &[], Some((Address::repeat_byte(4), 10)), 10);
    assert_eq!(also, vec![((Address::repeat_byte(4), 10), Exposure::default())]);
}

/// A server releases a body only if the payer's deposit covers the body's stream in full, with what its other streams
/// owe this server, and the key's cap covers the stream (issue #181): a deposit pays the first claims made on it, so
/// covering one fee is not enough.
#[test]
fn a_body_is_refused_when_the_deposit_cannot_cover_its_stream_and_what_is_owed() {
    let u = U256::from;
    let (a, b) = ((Address::repeat_byte(2), 9), (Address::repeat_byte(3), 9));
    let streams = vec![(a, Exposure { cumulative: u(8), claimed: u(2), owed: u(3) }), (b, Exposure { cumulative: u(4), claimed: u(0), owed: u(4) })];
    // Stream a still needs 8 - 2 + 1 = 7, and b owes 4: 11 against a deposit of 11.
    assert!(covers(u(11), u(100), &streams, a, u(1)).is_ok());
    assert!(covers(u(10), u(100), &streams, a, u(1)).unwrap_err().contains("deposit"));
    assert!(covers(u(11), u(6), &streams, a, u(1)).unwrap_err().contains("cap"), "7 to pay, 6 left under the cap");
    // A stream this server holds nothing of: the body's fee beside what the others owe.
    let fresh = (Address::repeat_byte(5), 9);
    assert!(covers(u(13), u(100), &streams, fresh, u(6)).is_ok(), "6 + 3 + 4");
    assert!(covers(u(12), u(100), &streams, fresh, u(6)).is_err());
    assert!(covers(u(5), u(5), &[], fresh, u(5)).is_ok(), "nothing owed: the fee alone");
}

/// A bounty counts a line of the poster's on its entry once it is claimed after the bounty was posted: so a passed
/// line still unclaimed counts, as does one written after the board was read (on this machine's clock, as the line's
/// own time); a claimed one from before, a failed one, a lapsed one, another entry's or another payer's stream
/// doesn't. A ledger that doesn't read says yes, so nothing is paid on a doubt.
#[test]
fn a_bounty_counts_a_passed_line_claimed_after_it_was_posted() {
    let folder = std::env::temp_dir().join(format!("unbrowse-counted-since-{}", std::process::id()));
    let entry = test_entry("route-a");
    let at = |at: u64, passed: bool, claimed: bool| Receipt { at, entry: Some(entry), ..line(0.1, passed, claimed) };
    let write = |name: &str, lines: Vec<Receipt>| store::write_json(&folder.join(name), &unbrowse_files::RECEIPTS, &lines).unwrap();
    let mine = |a: u32, _: u64| a == 0;
    write("0-9.json", vec![at(5, true, true), at(50, false, false), Receipt { lapsed: true, ..at(5, true, false) }, Receipt { entry: Some(test_entry("route-b")), ..at(50, true, false) }]);
    write("1-9.json", vec![at(50, true, false)]);
    assert!(!counted_line_since(&folder, entry, 10, mine), "claimed before, failed, lapsed, another entry, another payer");
    write("0-10.json", vec![at(5, true, false)]);
    assert!(counted_line_since(&folder, entry, 10, mine), "unclaimed: its claim comes after the post");
    write("0-10.json", vec![at(20, true, true)]);
    assert!(counted_line_since(&folder, entry, 10, mine), "written after the board was read");
    assert!(!counted_line_since(&folder.join("none"), entry, 10, mine), "no ledger, no line");
    std::fs::write(folder.join("0-11.json"), "not a ledger").unwrap();
    assert!(counted_line_since(&folder, entry, 10, mine), "a ledger that doesn't read");
    let _ = std::fs::remove_dir_all(&folder);
}

/// A key with a cap of 1.00 makes four fetches of 0.25 from one server, and all four fail: the chain charged nothing,
/// and the voucher's total leaves the failures out (`voucher_over`), so the server holding those lines still releases
/// the fifth body under the cap and the deposit.
#[test]
fn four_failures_worth_the_cap_leave_the_fifth_body_served() {
    let u = U256::from;
    let l = |index: u64| LeanSettlement::Line { index: U256::from(index), entryId: test_entry("route-a"), amount: u(25), passed: false, holders: vec![], bounty: U256::ZERO };
    let lines: Vec<_> = (0..4).map(l).collect();
    let v = voucher_over(Address::repeat_byte(1), Address::repeat_byte(2), 9, &lines, FixedBytes::ZERO);
    assert!(v.cumulative.is_zero());
    let held: Vec<PaidLine> = (0..4).map(|i| held_line(1, 2, i, v.cumulative.to(), 25, false)).collect();
    let streams = streams_of(Address::repeat_byte(1), &held, Some((Address::repeat_byte(2), 9)), 9);
    let stream = (Address::repeat_byte(2), 9);
    assert_eq!(covers(u(100), u(100), &streams, stream, u(25)), Ok(()), "the fifth, under a cap of 100 cents with nothing charged");
    assert_eq!(covers(u(25), u(100), &streams, stream, u(25)), Ok(()), "and a deposit of just its fee");
    assert!(covers(u(100), u(20), &streams, stream, u(25)).unwrap_err().contains("cap"), "a cap the fee itself passes still refuses");
}

/// A server keeps a failed line only while its stream's window is open: once it closes the line is let go, with no
/// claim and whatever the passed lines beside it do. A stale failed line doesn't hurry a claim of a passed one, and a
/// server holding only failed lines has nothing worth a claim.
#[test]
fn a_servers_failed_lines_go_when_their_window_closes_and_hurry_no_claim() {
    let at = |epoch: u64, index: u64, passed: bool| PaidLine { epoch, ..held_line(1, 2, index, 0, 1_000_000_000_000_000, passed) };
    let held = vec![at(9, 0, false), at(10, 1, false), at(11, 2, false), at(9, 3, true)];
    let key = |o: &PaidLine| owed_key(o);
    assert!(stale_failures(&held, 10).is_empty(), "epoch 9 can still be claimed in 10");
    assert_eq!(stale_failures(&held, 11), vec![key(&held[0])], "the failed line of 9 goes in 11; the passed one is the claim's");
    assert_eq!(stale_failures(&held, 12), vec![key(&held[0]), key(&held[1])]);
    assert!(stale_failures(&[at(12, 0, false)], 11).is_empty(), "an epoch ahead of the chain's isn't closed");
    let usdc = |a: U256| a.to::<u128>() as f64 / 1e18;
    let price = 1_000_000_000_000u128;
    // One passed line of 0.001 in the current epoch isn't worth its gas at this price; a failed line of an older epoch
    // beside it changes nothing.
    let passed = at(11, 4, true);
    assert!(!owed_due(std::slice::from_ref(&passed), 11, price, 0.10, usdc));
    assert!(!owed_due(&[held[0].clone(), held[1].clone(), passed.clone()], 11, price, 0.10, usdc), "an old failure hurries nothing");
    assert!(owed_due(&[at(10, 5, true), passed], 11, price, 0.10, usdc), "an old passed line does");
    assert!(!owed_due(&held[..3], 12, price, 0.10, usdc), "failed lines alone are never worth a claim");
}

/// A server claims a payer's lines early once the deposit's headroom past every stream it holds falls below what the
/// payer owes it in all (issue #181), and waits while it doesn't.
#[test]
fn a_server_claims_early_when_a_payers_headroom_falls_below_what_it_is_owed() {
    let u = U256::from;
    let streams = [Exposure { cumulative: u(8), claimed: u(2), owed: u(3) }, Exposure { cumulative: u(4), claimed: u(0), owed: u(4) }];
    // Stream one: 20 + 2 - 8 - 4 = 10 to spare, owed 7; stream two: 20 - 4 - 3 = 13.
    assert!(!claim_early(u(20), &streams), "10 to spare against 7 owed");
    assert!(claim_early(u(16), &streams), "6 to spare against 7 owed");
    assert!(claim_early(u(5), &streams), "the deposit doesn't cover them at all");
    assert!(!claim_early(u(0), &[Exposure { cumulative: u(3), claimed: u(3), owed: u(0) }]), "nothing owed, nothing to claim");
}

/// R5-CHAIN-1: a claim whose receipt, or whose line read as spent, rests on the node's one RPC alone never becomes
/// local claim credit. The lines stay owed (counted, claimed again, handed to towers) until more than that one RPC's
/// word reads them spent; a line already claimed stays claimed.
#[test]
fn a_claim_proven_on_one_rpc_is_never_taken_as_paid() {
    assert!(!crate::anchor::Witness::One.agrees(), "one RPC on a chain over the network witnesses nothing");
    assert!(crate::anchor::Witness::Here.agrees() && crate::anchor::Witness::Second.agrees(), "a chain here, or a second RPC standing behind the head, does");
    let mut lines = vec![line(4.0, true, false), line(3.0, true, false)];
    mark_lines(&mut lines, &[0, 1], false);
    assert!(lines.iter().all(|r| !r.claimed && r.unwitnessed), "claimed on one RPC's word: unwitnessed, not claimed");
    let folder = std::env::temp_dir().join(format!("unbrowse-unwitnessed-test-{}", std::process::id()));
    store::write_json(&folder.join("0-10.json"), &unbrowse_files::RECEIPTS, &lines).unwrap();
    assert_eq!(unclaimed(&folder, 10, |_, _| true), Ok(7.0), "still owed against the deposit");
    let again: Vec<Receipt> = store::read_json_strict(&folder.join("0-10.json"), &unbrowse_files::RECEIPTS).unwrap();
    assert!(again.iter().all(|r| r.unwitnessed && !r.claimed), "kept on disk as unwitnessed");
    let _ = std::fs::remove_dir_all(&folder);
    mark_lines(&mut lines, &[0], true);
    assert!(lines[0].claimed && !lines[0].unwitnessed, "a witness settles it");
    assert!(!lines[1].claimed && lines[1].unwitnessed);
    mark_lines(&mut lines, &[0], false);
    assert!(lines[0].claimed && !lines[0].unwitnessed, "a line claimed stays claimed");
}

/// R5-CHAIN-1, served lines: a line only the node's one RPC says is past its window is set aside, never let go, and a
/// witness that hasn't read that far yet lets go of nothing.
#[test]
fn a_window_closed_on_one_rpcs_word_forgets_no_line() {
    assert_eq!(window_of(5, 6, None, false), Window::Open, "epoch 5's window is 5 and 6");
    assert_eq!(window_of(5, 9, None, false), Window::SetAside, "one RPC alone says it closed");
    assert_eq!(window_of(5, 9, Some(9), true), Window::Gone(9), "a witness reads it closed");
    assert_eq!(window_of(5, 9, Some(6), true), Window::Wait, "a witness reads it still open");
    assert_eq!(window_of(5, 9, None, true), Window::Wait, "a witness that hasn't answered yet");
    assert_eq!(window_of(9, 5, None, false), Window::SetAside, "an epoch ahead of the RPC's");
}

/// R6-CHAIN-2: a revoke owed is let go of only on a grant reading a witness stood behind. A first RPC that says the
/// key is revoked while a named, honest second reads it still paid leaves the revoke owed (and stops writes); a second
/// RPC merely named never stands in for the reading.
#[tokio::test]
async fn a_revoke_owed_is_cleared_only_by_a_witnessed_grant_read() {
    use crate::rpc::tests::scripted_rpc;
    let _one = crate::testchain::one_at_a_time().await;
    let home = crate::testchain::home("revoke-witnessed");
    let head = alloy::consensus::Header { number: 9, ..Default::default() };
    let block = serde_json::to_string(&alloy::rpc::types::Block::<alloy::rpc::types::Transaction>::new(alloy::rpc::types::Header::new(head), alloy::rpc::types::BlockTransactions::Hashes(vec![]))).unwrap();
    let ok = |v: &str| (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":{v}}}"#));
    let grant = |cap: u64, revoked: bool| {
        let r = LeanSettlement::agentOfReturn { capPerEpoch: U256::from(cap), expiry: 0, revoked, spentThisEpoch: U256::ZERO };
        format!("\"{}\"", alloy::primitives::hex::encode_prefixed(<LeanSettlement::agentOfCall as alloy::sol_types::SolCall>::abi_encode_returns(&r)))
    };
    let (settlement, payer, agent) = (Address::repeat_byte(1), Address::repeat_byte(2), Address::repeat_byte(3));
    // The first lies: revoked. The honest second reads the grant still paid.
    let (first, _) = scripted_rpc(vec![ok("\"0x539\""), ok(&block), ok(&grant(5, true))]).await;
    let (second, _) = scripted_rpc(vec![ok(&block), ok(&block), ok(&grant(5, false))]).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
    store::save_settings(&store::Settings { check_rpc: Some(second.to_string()), ..store::Settings::default() }).unwrap();
    let p = ProviderBuilder::new().connect_http(first.clone());
    let read = grant_pays_witnessed(&p, settlement, payer, agent).await;
    assert!(read.is_err(), "the two disagree: {read:?}");
    assert!(!crate::agents::revoke_settled(read), "the revoke stays owed");
    assert!(crate::rpc::halted().is_some(), "and writes stop");
    crate::rpc::unhalt();
    // Both read it revoked: settled.
    let (first, _) = scripted_rpc(vec![ok("\"0x539\""), ok(&block), ok(&grant(5, true))]).await;
    let (second, _) = scripted_rpc(vec![ok(&block), ok(&block), ok(&grant(5, true))]).await;
    let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
    store::save_settings(&store::Settings { check_rpc: Some(second.to_string()), ..store::Settings::default() }).unwrap();
    let p = ProviderBuilder::new().connect_http(first.clone());
    let read = grant_pays_witnessed(&p, settlement, payer, agent).await;
    assert_eq!(read, Ok(Some(false)));
    assert!(crate::agents::revoke_settled(read));
    // No witnessed reading, or one that says the key is still paid, settles nothing.
    assert!(!crate::agents::revoke_settled(Ok(None)));
    assert!(!crate::agents::revoke_settled(Ok(Some(true))));
    let _ = std::fs::remove_dir_all(&home);
}

/// R6-CHAIN-1: with no witnessed `claimedOf`, a closed stream's lines are marked neither lapsed nor paid: kept
/// unwitnessed, still picked by the next look; once a witness reads the stream, the same record settles.
#[test]
fn one_rpc_claimed_of_cannot_lapse_or_hide_paid_receipts() {
    let mut lines = vec![line(4.0, true, false), line(3.0, true, false), line(1.0, true, true)];
    settle_lapsed(&mut lines, None);
    assert!(lines[..2].iter().all(|r| !r.lapsed && !r.claimed && r.unwitnessed), "neither lapsed nor paid on one RPC's word");
    assert!(lines.iter().any(|r| r.passed && !r.claimed && !r.lapsed), "looked at again");
    let mut paid = lines.clone();
    settle_lapsed(&mut paid, Some(0.0));
    assert!(paid.iter().all(|r| r.claimed && !r.unwitnessed && !r.lapsed), "a witness reads them paid: claimed");
    settle_lapsed(&mut lines, Some(3.0));
    assert!(lines[..2].iter().all(|r| r.lapsed && !r.claimed), "a witness reads them unpaid: lapsed");
    assert!(lines[2].claimed && !lines[2].lapsed, "a claimed line is left alone");
}

/// R6-CHAIN-3: the served lines a node holds where only its one RPC can read them are bounded by taking on no more
/// (never by dropping one), and putting set-aside lines back is linear in them, each line once by its key.
#[test]
fn unwitnessed_ledger_has_a_hard_bound_and_restores_linearly() {
    assert!(ledger_has_room(MAX_HELD_LINES - 1, false));
    assert!(!ledger_has_room(MAX_HELD_LINES, false), "full: no more paid calls on one RPC");
    assert!(ledger_has_room(MAX_HELD_LINES * 10, true), "a witness settles them, so the books drain");
    let line = |epoch: u64, index: u64| PaidLine {
        payer: Address::repeat_byte(1),
        agent: Address::repeat_byte(2),
        epoch,
        cumulative: U256::from(100u64),
        lines: 0,
        passed_lines: 0,
        receipts_root: FixedBytes::ZERO,
        signature: Bytes::new(),
        index: U256::from(index),
        entry_id: FixedBytes::ZERO,
        amount: U256::from(1u64),
        passed: true,
        holders: vec![],
        bounty: U256::ZERO,
        proof: vec![],
    };
    let n = 40_000u64;
    let mut owed: Vec<PaidLine> = (0..n).map(|i| line(i % 97, i)).collect();
    let aside: Vec<PaidLine> = (n / 2..n + n / 2).map(|i| line(i % 97, i)).collect();
    let t = std::time::Instant::now();
    add_once(&mut owed, aside);
    assert!(t.elapsed() < std::time::Duration::from_secs(5), "linear, not a search a line: {:?}", t.elapsed());
    assert_eq!(owed.len() as u64, n + n / 2, "every line kept, each once");
    let keys: std::collections::HashSet<_> = owed.iter().map(owed_key).collect();
    assert_eq!(keys.len(), owed.len());
}

/// R10-CHAIN-2 and R11-CHAIN-3: reputation is read only up to the head the node followed, every log checked against
/// the second RPC's over the same blocks. A first RPC that adds a forged `Claimed(passed)` for an entry nobody used,
/// while an honest second (the devnet) has no such log, moves nothing: the ranking stays on the record read before and
/// the owner is told. Once the two agree again, the next read due goes on from there, with no restart. A disagreement
/// that lasts past `STALE_AFTER` sets the ranking aside: unavailable, and nothing stale presented as current.
/// `cargo test -p unbrowse-node-app forged -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs Anvil"]
async fn forged_logs_from_the_first_rpc_never_reach_the_ranking() {
    use alloy::sol_types::SolEvent;
    let _one = crate::testchain::one_at_a_time().await;
    let home = crate::testchain::home("forged-logs");
    let port = crate::testchain::free_port();
    let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", port.to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
    let chain = Chain::default();
    let d = chain.start().await.expect("chain").expect("the devnet's contracts");
    let before = reputation_history(&d).await.unwrap();
    let read_to = |r: &Option<super::reputation::UseRecord>| r.as_ref().map(|r| r.to);
    let kept_to = read_to(&*super::reputation::RECORD.lock().await);

    let real: reqwest::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
    let p = ProviderBuilder::new().connect_http(real.clone());
    let _: serde_json::Value = p.raw_request("anvil_mine".into(), (U256::from(20u64),)).await.unwrap();
    let at = p.get_block_number().await.unwrap();
    let forged = LeanSettlement::Claimed { payer: Address::repeat_byte(0x31), agent: Address::repeat_byte(0x32), entryId: test_entry("route-forged"), amount: d.usdc_units(1.0), index: U256::ZERO, passed: true };
    let data = forged.encode_log_data();
    let log = serde_json::json!({
        "address": d.settlement, "topics": data.topics(), "data": data.data, "blockNumber": format!("{at:#x}"),
        "blockHash": FixedBytes::<32>::repeat_byte(9), "transactionHash": FixedBytes::<32>::repeat_byte(8),
        "transactionIndex": "0x0", "logIndex": "0x0", "removed": false
    });
    let forge = std::sync::Arc::new(std::sync::Mutex::new(Some(log)));
    let first = crate::testchain::lying_rpc(real.clone(), std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)), forge.clone()).await;
    let _proxy = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
    store::save_settings(&store::Settings { check_rpc: Some(real.to_string()), ..store::load_settings() }).unwrap();

    let after = reputation_history(&d).await.expect("the ranking still reads, on the record read before");
    assert!(!after.uses.iter().any(|u| u.entry == test_entry("route-forged")), "the forged use never reaches the ranking");
    assert_eq!(after.uses.len(), before.uses.len());
    assert_eq!(read_to(&*super::reputation::RECORD.lock().await), kept_to, "the record isn't read on past the disagreement");
    assert!(ranking_disagrees().is_some_and(|w| w.contains("logs differ")), "reading on waits, and the owner is told");
    assert!(crate::rpc::halted().is_none(), "writes are another matter");
    // Not tried again before its backoff: still the record read before.
    reputation_history(&d).await.unwrap();
    assert_eq!(read_to(&*super::reputation::RECORD.lock().await), kept_to);

    // The two agree again: the next read due goes on, with no restart.
    *forge.lock().unwrap() = None;
    super::reputation::retry_now();
    let resumed = reputation_history(&d).await.expect("read on");
    assert!(ranking_disagrees().is_none(), "reading goes on once they agree");
    assert!(read_to(&*super::reputation::RECORD.lock().await) > kept_to, "the record is read on from where it stopped");
    assert!(!resumed.uses.iter().any(|u| u.entry == test_entry("route-forged")));
    let resumed_to = read_to(&*super::reputation::RECORD.lock().await);

    // They disagree again, for longer than the ranking is kept: it is set aside, not presented as current.
    *forge.lock().unwrap() = Some(serde_json::json!({
        "address": d.settlement, "topics": data.topics(), "data": data.data, "blockNumber": format!("{:#x}", at + 30),
        "blockHash": FixedBytes::<32>::repeat_byte(7), "transactionHash": FixedBytes::<32>::repeat_byte(6),
        "transactionIndex": "0x0", "logIndex": "0x0", "removed": false
    }));
    let _: serde_json::Value = p.raw_request("anvil_mine".into(), (U256::from(20u64),)).await.unwrap();
    reputation_history(&d).await.unwrap();
    assert!(ranking_disagrees().is_some());
    super::reputation::age_disagreement(super::reputation::STALE_AFTER);
    let why = standings(d.clone()).await.expect_err("past an hour of disagreement, no ranking");
    assert!(why.contains("unavailable"), "{why}");
    assert_eq!(read_to(&*super::reputation::RECORD.lock().await), resumed_to, "the last agreed record is kept");
    super::reputation::forget_disagreement();
    let _ = std::fs::remove_dir_all(&home);
}

/// R11-CHAIN-2: an `eth_getLogs` answer over the byte cap is never read: the window is halved and asked again, and
/// at the narrowest window the read gives up, so the caller keeps what it had. An answer within the caps on the halves
/// is read.
#[tokio::test]
async fn an_oversized_log_answer_is_never_read() {
    use crate::rpc::tests::scripted_rpc;
    let big = (200, format!(r#"{{"jsonrpc":"2.0","id":1,"result":["{}"]}}"#, "x".repeat(gas::MAX_LOG_BYTES + 1)));
    let none = (200, r#"{"jsonrpc":"2.0","id":1,"result":[]}"#.to_string());
    let filter = alloy::rpc::types::Filter::new().address(Address::repeat_byte(1));
    // Over the cap at 32 blocks, and again at 16, the narrowest window: given up, after two asks.
    let (url, asked) = scripted_rpc(vec![big.clone(), big.clone(), none.clone()]).await;
    let e = gas::window_logs(&url, &filter, 0, 31).await.unwrap_err();
    assert!(e.starts_with(gas::LOGS_OVER_CAP), "{e}");
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 2);
    // Over the cap at 32 blocks, within it on each half: read.
    let (url, asked) = scripted_rpc(vec![big, none.clone(), none]).await;
    assert!(gas::window_logs(&url, &filter, 0, 31).await.unwrap().is_empty());
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 3, "the window halved and each half asked");
    // Too many logs in one window counts as over the cap too.
    let log = serde_json::json!({"address": Address::repeat_byte(1), "topics": [], "data": "0x", "blockNumber": "0x1", "blockHash": FixedBytes::<32>::ZERO, "transactionHash": FixedBytes::<32>::ZERO, "transactionIndex": "0x0", "logIndex": "0x0", "removed": false});
    let many = (200, serde_json::json!({"jsonrpc": "2.0", "id": 1, "result": vec![log; gas::MAX_LOGS_PER_WINDOW + 1]}).to_string());
    let (url, _) = scripted_rpc(vec![many]).await;
    assert!(gas::window_logs(&url, &filter, 0, 15).await.unwrap_err().starts_with(gas::LOGS_OVER_CAP));
}

/// UNB-170: a log read turned away for the RPC's rate, as a public RPC does a fresh node reading its first windows
/// (-32005 in the answer, or HTTP 429), waits and asks again, and the logs are read: it doesn't fail the join.
#[tokio::test]
async fn a_log_read_waits_out_a_rate_limit() {
    use crate::rpc::tests::scripted_rpc;
    let limited = (200, r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"request rate exceeded"}}"#.to_string());
    let too_many = (429, r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Too Many Requests"}}"#.to_string());
    let log = serde_json::json!({"address": Address::repeat_byte(1), "topics": [], "data": "0x", "blockNumber": "0x1", "blockHash": FixedBytes::<32>::ZERO, "transactionHash": FixedBytes::<32>::ZERO, "transactionIndex": "0x0", "logIndex": "0x0", "removed": false});
    let one = (200, serde_json::json!({"jsonrpc": "2.0", "id": 1, "result": [log]}).to_string());
    let filter = alloy::rpc::types::Filter::new().address(Address::repeat_byte(1));
    let (url, asked) = scripted_rpc(vec![limited, too_many, one]).await;
    let logs = gas::window_logs(&url, &filter, 0, 9_999).await.expect("the read waits out the limit");
    assert_eq!(logs.len(), 1);
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 3, "asked again after each refusal");
}

/// A history read again on a live network asks the RPC only for the blocks past where it was read to, less
/// `LOGS_REREAD`, and still returns every log it held: each claim pass reads the coins' and Settlement's events from the
/// deployment's block five times or more, and each read was every window since. The devnet holds nothing.
#[tokio::test]
async fn a_history_read_again_asks_only_for_the_new_blocks() {
    use std::sync::{Arc, Mutex as StdMutex};
    let asked: Arc<StdMutex<Vec<(u64, u64)>>> = Arc::default();
    let seen = asked.clone();
    let hex = |v: &serde_json::Value| u64::from_str_radix(v.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16).unwrap();
    // One log, at block 5; every window asked for is noted.
    let url = rpc_replying(move |body| {
        let (a, b) = (hex(&body["params"][0]["fromBlock"]), hex(&body["params"][0]["toBlock"]));
        seen.lock().unwrap().push((a, b));
        let log = serde_json::json!({"address": Address::repeat_byte(9), "topics": [], "data": "0x", "blockNumber": "0x5", "blockHash": FixedBytes::<32>::ZERO, "transactionHash": FixedBytes::<32>::ZERO, "transactionIndex": "0x0", "logIndex": "0x0", "removed": false});
        let result = if a <= 5 && 5 <= b { vec![log] } else { vec![] };
        serde_json::json!({"jsonrpc": "2.0", "id": body["id"], "result": result})
    })
    .await;
    let url: reqwest_url::Url = url.parse().unwrap();
    let filter = alloy::rpc::types::Filter::new().address(Address::repeat_byte(9));
    // A chain no other test holds histories on.
    let chain = Some(0xC0FFEE_u64);

    let first = gas::held_logs(&url, chain, &filter, 0, 25_000).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(asked.lock().unwrap().drain(..).count(), 3, "the first read is every window");

    let again = gas::held_logs(&url, chain, &filter, 0, 25_100).await.unwrap();
    assert_eq!(again.len(), 1, "the log held from the first read is still there");
    assert_eq!(asked.lock().unwrap().clone(), vec![(25_000 - gas::LOGS_REREAD + 1, 25_100)], "only the blocks past the held history, and the last few again");
    asked.lock().unwrap().clear();

    let behind = gas::held_logs(&url, chain, &filter, 0, 1_000).await.unwrap();
    assert_eq!(behind.len(), 1, "a read to a block already held asks nothing");
    assert!(asked.lock().unwrap().is_empty());

    // Another start block is another history.
    gas::held_logs(&url, chain, &filter, 10, 25_100).await.unwrap();
    assert_eq!(asked.lock().unwrap().drain(..).count(), 3);

    // The devnet holds nothing: each read is every window.
    gas::held_logs(&url, None, &filter, 0, 25_000).await.unwrap();
    gas::held_logs(&url, None, &filter, 0, 25_000).await.unwrap();
    assert_eq!(asked.lock().unwrap().len(), 6);
}

/// A JSON-RPC endpoint on this machine that answers `eth_chainId` as `chain_id`, for as long as the test runs.
async fn rpc_answering(chain_id: u64) -> String {
    rpc_saying(move |id| serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": format!("{chain_id:#x}") })).await
}

/// A JSON-RPC endpoint on this machine that answers every call with what `reply` makes of its id.
async fn rpc_saying(reply: impl Fn(serde_json::Value) -> serde_json::Value + Send + Sync + 'static) -> String {
    rpc_replying(move |body| reply(body["id"].clone())).await
}

/// A JSON-RPC endpoint on this machine that answers every call with what `reply` makes of the whole request.
async fn rpc_replying(reply: impl Fn(&serde_json::Value) -> serde_json::Value + Send + Sync + 'static) -> String {
    let reply = std::sync::Arc::new(reply);
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut conn, _)) = listener.accept().await else { return };
            let reply = reply.clone();
            tokio::spawn(async move {
                let mut asked = Vec::new();
                let mut buf = [0u8; 4096];
                // The headers, then as much body as they say.
                loop {
                    let Ok(n) = conn.read(&mut buf).await else { return };
                    if n == 0 {
                        return;
                    }
                    asked.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&asked);
                    let Some(end) = text.find("\r\n\r\n") else { continue };
                    let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if asked.len() >= end + 4 + length {
                        let body: serde_json::Value = serde_json::from_slice(&asked[end + 4..end + 4 + length]).unwrap_or_default();
                        let reply = reply(&body).to_string();
                        let _ = conn.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await;
                        return;
                    }
                }
            });
        }
    });
    url
}

/// Unbrowse's gateway that doesn't answer (down, or its name doesn't resolve) is no reason for the chain not to start:
/// the node goes on with the network's public RPC, and isn't marked refused, so a renewed pass can take the gateway
/// again (UNB-222). A gateway that answers is used; an RPC that isn't the gateway and doesn't answer is the error it was.
#[tokio::test]
async fn a_gateway_that_doesnt_answer_leaves_the_node_on_the_public_rpc() {
    let public = rpc_answering(arc::ARC_TESTNET.chain_id).await;
    let net: &'static arc::Network = Box::leak(Box::new(arc::Network { rpc: Box::leak(public.clone().into_boxed_str()), ..arc::ARC_TESTNET }));
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let gateway: reqwest_url::Url = format!("http://127.0.0.1:{dead}/arc-testnet/0xabc.1.0xdef").parse().unwrap();

    let l = check_or_public_from(Live { net, rpc: gateway.clone() }, true).await.expect("the public RPC answers");
    assert_eq!(l.rpc.as_str(), public, "on the public RPC");
    assert_eq!(live().map(|l| l.rpc.to_string()), Some(public.clone()), "and every provider reads it");
    assert!(crate::gateway::refused().is_none(), "a gateway that is down hasn't refused the node");

    let answering: reqwest_url::Url = format!("{}arc-testnet/0xabc.1.0xdef", rpc_answering(arc::ARC_TESTNET.chain_id).await).parse().unwrap();
    let l = check_or_public_from(Live { net, rpc: answering.clone() }, true).await.expect("the gateway answers");
    assert_eq!(l.rpc, answering, "a gateway that answers is used");

    let e = check_or_public_from(Live { net, rpc: gateway.clone() }, false).await.unwrap_err();
    assert!(e.contains("doesn't answer"), "an RPC named by hand that is down stays the error: {e}");

    // Both down: the error names both, and the node still isn't refused, so the next try asks the gateway again.
    let nowhere: &'static arc::Network = Box::leak(Box::new(arc::Network { rpc: Box::leak(gateway.origin().ascii_serialization().into_boxed_str()), ..arc::ARC_TESTNET }));
    let e = check_or_public_from(Live { net: nowhere, rpc: gateway.clone() }, true).await.unwrap_err();
    assert!(e.contains("; and the public RPC: "), "{e}");
    assert!(crate::gateway::refused().is_none());

    // A gateway that refuses the node (not a member) is left for good, as before; when the public RPC is down too, its
    // error is the one said.
    let refusing: reqwest_url::Url = format!(
        "{}arc-testnet/0xabc.1.0xdef",
        rpc_saying(|id| serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": "this node isn't a member" } })).await
    )
    .parse()
    .unwrap();
    let l = check_or_public_from(Live { net, rpc: refusing.clone() }, true).await.expect("the public RPC answers");
    assert_eq!(l.rpc.as_str(), public);
    assert!(crate::gateway::refused().is_some_and(|why| why.contains("isn't a member")), "refused for good");
    let e = check_or_public_from(Live { net: nowhere, rpc: refusing }, true).await.unwrap_err();
    assert!(!e.contains("; and the public RPC: "), "the public RPC's own error: {e}");
    crate::gateway::forget_refusal();
    forget_live();
}

/// An HTTP server on this machine that gives every request the same `status` and JSON `body`: an RPC, or the gateway
/// refusing a node, for as long as the test runs.
async fn replying(status: u16, body: String) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let at = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            let body = body.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                let _ = s.read(&mut buf).await;
                let head = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(body.as_bytes()).await;
            });
        }
    });
    format!("http://{at}")
}

/// A node the gateway refused (its owner hadn't signed in yet) reads the public RPC; once the gateway answers as the
/// network (the owner signed in while the node ran), the node is taken back onto it, and while it still refuses the
/// node stays where it is. Seen 2026-11-18 on the production gateway: a node linked after it started read the public
/// RPC until it restarted, so it was never gassed.
#[tokio::test]
async fn a_node_the_gateway_refused_takes_it_again_once_it_answers() {
    let net = arc::by_name("arc-testnet").unwrap();
    let chain_id = format!(r#"{{"jsonrpc":"2.0","id":0,"result":"0x{:x}"}}"#, net.chain_id);
    let public = replying(200, chain_id.clone()).await;
    let on_public = Live { net, rpc: public.parse().unwrap() };

    let refusing = replying(403, r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"this node isn't a member"}}"#.into()).await;
    assert!(retaken(&on_public, &format!("{refusing}/arc-testnet/pass")).await.is_none(), "still refused: the node stays on the public RPC");

    let taking = replying(200, chain_id).await;
    let back = retaken(&on_public, &format!("{taking}/arc-testnet/pass")).await.expect("the gateway answers: back onto it");
    assert_eq!(back.rpc.as_str(), format!("{taking}/arc-testnet/pass"));
    assert_eq!(back.net.chain_id, net.chain_id);

    let wrong = replying(200, r#"{"jsonrpc":"2.0","id":0,"result":"0x1"}"#.into()).await;
    assert!(retaken(&on_public, &format!("{wrong}/arc-testnet/pass")).await.is_none(), "an answer as another chain is never taken");
}
