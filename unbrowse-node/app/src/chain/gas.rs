//! Paying for writes: signers, the gas a write needs, the owner told when the node can't pay, and reading logs in
//! windows an RPC accepts, and the activity line each write leaves.

use super::*;

/// About what one of the node's ordinary writes takes: the gas below which the owner is told the node can't pay for
/// its writes (`gas_short`). Each write is still checked against its own estimate as it is sent (`short_of`), and a
/// claim is sized to what the node holds (`claim_fits`).
pub(crate) const WRITE_GAS: u64 = 1_000_000;
/// The gas deploying the tokens, the pool, seeding it, the domain proofs, the four route-coin contracts and Settlement
/// (with the DNSSEC verifier and the listings their constructors make) take together, with room: six
/// contracts, the largest near EIP-170's size, about 4 million each. Re-measure with a devnet deploy (`a_deploy_run_again`).
pub(super) const DEPLOY_GAS: u64 = 45_000_000;

/// A provider that signs as `signer`, paying its own gas. Nothing is checked ahead: each write checks its own gas as
/// it is sent (`rpc::mined!`).
pub(crate) async fn as_signer(signer: PrivateKeySigner) -> Result<impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet> + Clone, String> {
    paying(signer, 0).await
}

/// The same, once the signer can pay for `gas` ahead of the writes it is for (a deploy's several). On the devnet
/// Anvil's own cheat tops it up when it runs low; on a live network the gas is real and the signer's own, so one that
/// can't pay is told where to get it, and nothing is sent.
pub(super) async fn paying(signer: PrivateKeySigner, gas: u64) -> Result<impl Provider + WalletProvider<Wallet = crate::rpc::NodeWallet> + Clone, String> {
    let me = signer.address();
    let p = ProviderBuilder::new().wallet(signer).connect_http(url());
    let bal = p.get_balance(me).await.map_err(|e| e.to_string())?;
    match live() {
        Some(l) => {
            // The node's fee estimates go up to twice the gas price, so the balance must cover that.
            let price = crate::chain::gas_price(&p).await?;
            let need = U256::from(price) * U256::from(gas) * U256::from(2u64);
            if bal < need {
                return Err(needs_gas(l.net, me, bal, need));
            }
        }
        // `UNBROWSE_DEVNET_NO_GAS=1` keeps the devnet from topping this node's key up: a wallet with no gas, as a test
        // of listing and earning without it (spec §76 item 2). Its writes then fail as they would on a live network.
        None if std::env::var("UNBROWSE_DEVNET_NO_GAS").is_ok_and(|v| v.trim() == "1") => {}
        None if bal < U256::from(10u64).pow(U256::from(17u64)) => {
            let _: serde_json::Value = p
                .raw_request("anvil_setBalance".into(), (me, U256::from(10u64).pow(U256::from(19u64))))
                .await
                .map_err(|e| e.to_string())?;
        }
        None => {}
    }
    Ok(p)
}

/// Run with each claim pass: a write of the owner's key that has held back every write after it is replaced
/// (`rpc::unstick`). The replacement's hash when there was one.
pub async fn unstick(keys: &(dyn KeyStore + Sync)) -> Result<Option<String>, String> {
    crate::rpc::unstick(&as_signer(owner_signer(keys)?).await?).await
}

/// Whether `me` can pay for the write `call` on a live network: its own estimate (or the gas it was set to send with,
/// if more), at the most the node signs a unit of gas for now (`rpc::priced`). Checked as each write is sent
/// (`rpc::mined!`), so a write is refused and the owner told where to get gas only when it is that write the node
/// can't pay for. A write whose estimate fails is left to fail as it is sent, with the chain's own reason. Nothing is
/// checked on the devnet, where Anvil tops the signer up. What the node is short of, said as the owner is told it; `None` when it can pay.
pub(crate) async fn short_of<P, D>(call: &alloy::contract::CallBuilder<P, D>, me: Address) -> Result<Option<String>, String>
where
    P: Provider + Clone,
    D: alloy::contract::CallDecoder + Clone,
{
    let Some(l) = live() else { return Ok(None) };
    let Ok(gas) = call.clone().from(me).estimate_gas().await else { return Ok(None) };
    let p = &call.provider;
    // What the chain holds the balance to: the write's gas at the most a unit costs, as the node signs it now
    // (`rpc::priced`), never a price held from before, which can be far from the one the write is signed at.
    let need = crate::rpc::priced(p, gas.max(call.as_ref().gas.unwrap_or(0))).await?.most();
    let have = p.get_balance(me).await.map_err(|e| e.to_string())?;
    crate::rpc::second_agrees_on_balance(p, me).await?;
    Ok((have < need).then(|| needs_gas(l.net, me, have, need)))
}

/// What the pool's first change in a block writes beyond a later change in the same block: the reserves the block
/// began with and the price's running sum and anchors (`UnbPool._snap`, `Twap.note`). An estimate is made against the
/// latest block, where the pool may already have changed, and the write lands in the next, where it may be the first:
/// a write that swaps through the pool (a claim's withholding, `stakeHeld`) is sent with this much more than its
/// estimate, or it runs out of gas once mined. Measured: a one-line claim estimated after a swap in the same block ran
/// out at its estimate of 455,218 (11 November 2026).
pub(crate) const FIRST_IN_BLOCK_GAS: u64 = 150_000;

/// The gas limit for a write that may swap through the pool: its estimate, an eighth more, and `FIRST_IN_BLOCK_GAS`;
/// `None` when the estimate fails, so the write goes out as it is and fails with the chain's own reason. Gas a write
/// doesn't use isn't paid.
pub(crate) async fn swap_limit<P, D>(call: &alloy::contract::CallBuilder<P, D>) -> Option<u64>
where
    P: Provider + Clone,
    D: alloy::contract::CallDecoder + Clone,
{
    let est = call.estimate_gas().await.ok()?;
    Some(est.saturating_add(est / 8).saturating_add(FIRST_IN_BLOCK_GAS))
}

/// Whether the write `call` would go out now: the node can pay for it.
pub(crate) async fn can_send<P, D>(call: &alloy::contract::CallBuilder<P, D>, me: Address) -> Result<(), String>
where
    P: Provider + Clone,
    D: alloy::contract::CallDecoder + Clone,
{
    match short_of(call, me).await? {
        None => Ok(()),
        Some(short) => Err(short),
    }
}

/// What the node's key can't pay, on a live network: the gas it has and about what one write needs, when it has less.
/// `None` on the devnet, where Anvil tops the key up, and whenever it can pay. The same test `paying` makes before a
/// write, asked ahead so the node can say it once and wait rather than fail write after write.
pub async fn gas_short(keys: &(dyn KeyStore + Sync)) -> Result<Option<GasShort>, String> {
    let Some(l) = live() else { return Ok(None) };
    let me = owner_signer(keys)?.address();
    let p = ProviderBuilder::new().connect_http(url());
    let have = p.get_balance(me).await.map_err(|e| e.to_string())?;
    let price = crate::chain::gas_price(&p).await?;
    let need = U256::from(price) * U256::from(WRITE_GAS) * U256::from(2u64);
    Ok((have < need).then(|| GasShort { have: gas_f(have), need: gas_f(need), why: needs_gas(l.net, me, have, need), chain_id: l.net.chain_id }))
}

/// A key that can't pay a write on a live network.
#[derive(Clone, Debug, Serialize)]
pub struct GasShort {
    pub have: f64,
    pub need: f64,
    /// What the owner is told: how much, and where to get more.
    pub why: String,
    pub chain_id: u64,
}

/// The words of `needs_gas` that say so, kept here so its message and whoever reads it can't drift apart.
const FOR_GAS: &str = "USDC for gas on";

/// Whether `error` is a write the node stopped itself because its key can't pay the gas (`needs_gas`): nothing was sent.
pub fn stopped_for_gas(error: &str) -> bool {
    error.contains(FOR_GAS)
}

/// What an address that can't pay a write's gas on a live network is told: how much it has, about how much the write
/// needs, and where it gets more. Arc's gas is USDC, 18 decimals at the native level.
pub(crate) fn needs_gas(net: &arc::Network, who: Address, have: U256, need: U256) -> String {
    let get = match net.faucet {
        Some(f) => format!("get {} USDC (its gas) for {who:#x} from {f}", net.name),
        None => format!("send USDC (its gas) to {who:#x} on {}", net.name),
    };
    format!("{who:#x} has {} {FOR_GAS} {} and a write needs about {}: {get}", gas_f(have), net.name, gas_f(need).max(0.000001))
}

/// The most blocks one `eth_getLogs` may span: Arc's RPC refuses a wider range, so a history longer than this is
/// read in windows of it.
pub(super) const LOG_WINDOW: u64 = 10_000;

/// Inclusive block windows covering `from..=to`, none wider than `LOG_WINDOW`.
pub(super) fn log_windows(from: u64, to: u64) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let mut start = from;
    while start <= to {
        let end = start.saturating_add(LOG_WINDOW - 1).min(to);
        out.push((start, end));
        if end == u64::MAX {
            break;
        }
        start = end + 1;
    }
    out
}

/// Every `event` the Settlement contract logged from block `from` to `to` (the head when `None`), read in windows
/// the RPC accepts.
pub(super) async fn settlement_logs(
    p: &impl Provider,
    d: &Deployment,
    event: FixedBytes<32>,
    from: u64,
    to: Option<u64>,
) -> Result<Vec<alloy::rpc::types::Log>, String> {
    logs(p, alloy::rpc::types::Filter::new().address(d.settlement).event_signature(event), from, to).await
}

/// The chain's gas price, read at most once every `GAS_PRICE_HOLD` on a live chain. Every claim pass, stake pass, gas
/// check and earnings view asked for it (22 of an idle node's 256 requests in four minutes), and Arc's price, in USDC,
/// barely moves; a public RPC's rate limit was spent on it. What it prices is an estimate or a threshold (whether a claim
/// is worth its gas, whether a write is affordable): a write itself is priced when it is sent. A devnet reads it every
/// time.
pub async fn gas_price(p: &impl Provider) -> Result<u128, String> {
    const GAS_PRICE_HOLD: Duration = Duration::from_secs(30);
    static HELD: std::sync::Mutex<Option<(u128, std::time::Instant)>> = std::sync::Mutex::new(None);
    let live = live().is_some();
    if live {
        if let Some((price, at)) = *HELD.locked() {
            if at.elapsed() < GAS_PRICE_HOLD {
                return Ok(price);
            }
        }
    }
    let price = p.get_gas_price().await.map_err(|e| e.to_string())?;
    if live {
        *HELD.locked() = Some((price, std::time::Instant::now()));
    }
    Ok(price)
}

/// The most bytes one `eth_getLogs` answer is read to (R11-CHAIN-2): a larger one is never decoded (`proof::fetch`).
pub(crate) const MAX_LOG_BYTES: usize = 8 << 20;
/// The most logs one window's answer may hold, and one read (every window of it) in all.
pub(crate) const MAX_LOGS_PER_WINDOW: usize = 10_000;
pub(crate) const MAX_LOGS_PER_READ: usize = 200_000;
/// The narrowest window an answer over the caps is split down to before the read gives up.
pub(crate) const MIN_LOG_SPAN: u64 = 16;
/// How an error begins when an RPC's logs are more than the node reads.
pub(crate) const LOGS_OVER_CAP: &str = "the RPC's logs are more than the node reads at once";

/// The logs `filter` matches in blocks `start..=end`, asked of the RPC at `url` and read within `MAX_LOG_BYTES` and
/// `MAX_LOGS_PER_WINDOW` (R11-CHAIN-2): an answer over either is never kept; the window is halved and each half asked
/// again, down to `MIN_LOG_SPAN` blocks, past which the read gives up with `LOGS_OVER_CAP`. A window refused because the
/// RPC hasn't caught up with the head is asked again after a backoff.
pub(crate) async fn window_logs(url: &crate::proof::Url, filter: &alloy::rpc::types::Filter, start: u64, end: u64) -> Result<Vec<alloy::rpc::types::Log>, String> {
    let mut out = Vec::new();
    let mut todo = vec![(start, end)];
    while let Some((a, b)) = todo.pop() {
        let f = filter.clone().from_block(a).to_block(b);
        let params = serde_json::json!([f]);
        let mut tries = 0u32;
        let got = loop {
            match crate::proof::fetch(url, "eth_getLogs", params.clone(), MAX_LOG_BYTES).await {
                Ok(crate::proof::Answer::Refused(e)) if tries < 3 && e.contains("-32014") => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(250 << tries)).await;
                }
                Ok(crate::proof::Answer::Value(v)) => {
                    let n = v.as_array().map_or(0, Vec::len);
                    break if n > MAX_LOGS_PER_WINDOW { None } else { Some(serde_json::from_value::<Vec<alloy::rpc::types::Log>>(v).map_err(|e| format!("eth_getLogs: {e}"))?) };
                }
                Ok(crate::proof::Answer::Null) => break Some(Vec::new()),
                Ok(crate::proof::Answer::Refused(e)) => return Err(format!("eth_getLogs: {e}")),
                Err(e) if e.contains("more than") => break None,
                Err(e) => return Err(e),
            }
        };
        match got {
            Some(logs) => out.extend(logs),
            None if b - a + 1 > MIN_LOG_SPAN => {
                let mid = a + (b - a) / 2;
                // The later half second, so the earlier is read first.
                todo.push((mid + 1, b));
                todo.push((a, mid));
            }
            None => return Err(format!("{LOGS_OVER_CAP}: over {MAX_LOG_BYTES} bytes or {MAX_LOGS_PER_WINDOW} logs in blocks {a} to {b}")),
        }
        if out.len() > MAX_LOGS_PER_WINDOW {
            return Err(format!("{LOGS_OVER_CAP}: over {MAX_LOGS_PER_WINDOW} logs in blocks {start} to {end}"));
        }
    }
    Ok(out)
}

/// Every log `filter` matches from block `from` to `to` (the head when `None`), read from the node's own RPC in windows
/// it accepts, each answer bounded (`window_logs`) and the read in all held to `MAX_LOGS_PER_READ` (R11-CHAIN-2).
pub(crate) async fn logs(
    p: &impl Provider,
    filter: alloy::rpc::types::Filter,
    from: u64,
    to: Option<u64>,
) -> Result<Vec<alloy::rpc::types::Log>, String> {
    let to = match to {
        Some(t) => t,
        None => p.get_block_number().await.map_err(|e| e.to_string())?,
    };
    logs_at(&crate::chain::url(), &filter, from, to).await
}

/// `logs` asked of the RPC at `url`.
pub(crate) async fn logs_at(url: &crate::proof::Url, filter: &alloy::rpc::types::Filter, from: u64, to: u64) -> Result<Vec<alloy::rpc::types::Log>, String> {
    let mut out = Vec::new();
    for (start, end) in log_windows(from, to) {
        out.extend(window_logs(url, filter, start, end).await?);
        if out.len() > MAX_LOGS_PER_READ {
            return Err(format!("{LOGS_OVER_CAP}: over {MAX_LOGS_PER_READ} logs in one read"));
        }
    }
    Ok(out)
}

/// How an error from `agreed_logs` begins when the second RPC's logs differ from the first's.
pub(crate) const LOGS_DISAGREE: &str = "the second RPC's logs differ from the first's";

/// `logs` from `from` to `to`, checked against the owner's second RPC over the same blocks when one is named
/// (R10-CHAIN-2): window by window, each answer bounded as `logs` bounds it, the same logs, each by its block, index,
/// transaction, address, topics and data, or an error that begins with `LOGS_DISAGREE`. With no second RPC, the first's
/// logs, on its word.
pub(crate) async fn agreed_logs(_p: &impl Provider, filter: alloy::rpc::types::Filter, from: u64, to: u64) -> Result<Vec<alloy::rpc::types::Log>, String> {
    let first = crate::chain::url();
    let Some(second) = crate::rpc::second_url()? else { return logs_at(&first, &filter, from, to).await };
    let mut out = Vec::new();
    for (start, end) in log_windows(from, to) {
        let ours = window_logs(&first, &filter, start, end).await?;
        let theirs = window_logs(&second, &filter, start, end).await.map_err(|e| if e.starts_with(LOGS_OVER_CAP) { e } else { format!("the second RPC didn't answer: {e}") })?;
        if !same_logs(&ours, &theirs) {
            return Err(format!("{LOGS_DISAGREE} over blocks {start} to {end} ({} against {})", ours.len(), theirs.len()));
        }
        out.extend(ours);
        if out.len() > MAX_LOGS_PER_READ {
            return Err(format!("{LOGS_OVER_CAP}: over {MAX_LOGS_PER_READ} logs in one read"));
        }
    }
    Ok(out)
}

/// Whether two RPCs gave the same logs, in whatever order.
pub(crate) fn same_logs(a: &[alloy::rpc::types::Log], b: &[alloy::rpc::types::Log]) -> bool {
    let keys = |ls: &[alloy::rpc::types::Log]| {
        let mut k: Vec<String> = ls
            .iter()
            .map(|l| serde_json::json!([l.block_number, l.block_hash, l.log_index, l.transaction_hash, l.inner.address, l.inner.data.topics(), l.inner.data.data]).to_string())
            .collect();
        k.sort();
        k
    };
    keys(a) == keys(b)
}

pub(crate) fn log(what: &str, kind: &str, unb_amount: Option<f64>, tx: &str, note: Option<String>) {
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: "Settlement".into(),
        what: what.into(),
        kind: kind.into(),
        result: "done".into(),
        ms: None,
        unb: unb_amount,
        tx: Some(tx.into()),
        note,
    });
}

#[cfg(test)]
mod gas_price_tests {
    use super::*;

    /// A devnet's gas price is read every time (its chain is driven by hand); only a live chain holds it.
    #[tokio::test]
    async fn a_devnet_reads_the_gas_price_every_time() {
        assert!(live().is_none(), "tests run on the devnet");
        let price = |p: u64| (200, format!(r#"{{"jsonrpc":"2.0","id":0,"result":"{p:#x}"}}"#));
        let (url, taken) = crate::rpc::tests::scripted_rpc(vec![price(7), price(9)]).await;
        let p = ProviderBuilder::new().connect_http(url);
        assert_eq!(gas_price(&p).await.unwrap(), 7);
        assert_eq!(gas_price(&p).await.unwrap(), 9, "not the one read before");
        assert_eq!(taken.load(std::sync::atomic::Ordering::SeqCst), 2);
    }
}
