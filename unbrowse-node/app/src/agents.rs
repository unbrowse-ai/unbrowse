//! Agent keys (PRD US-004, FR-2).
//!
//! Each agent gets its own key, derived from the root key by index, so nothing secret is stored: `agents.json` keeps
//! only the name, the limits and the index. The agent receives a setup string once (the node's address and its API
//! token, itself derived from the agent key) and authenticates every request with it.
//!
//! No call waits for the owner: what a key may spend is bounded by its cap, and what the node pays for one fetch by
//! the owner's maximum (`Settings::max_fetch_usdc`), both checked before anything is paid.

use serde::{Deserialize, Serialize};
use unbrowse_core::{KeyStore, RootKey};

use crate::store::{self, Activity};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(from = "AgentWire", into = "AgentWire")]
pub struct Agent {
    pub index: u32,
    pub name: String,
    pub address: String,
    /// The most this key may spend in one epoch (a day), in USDC.
    pub cap_usdc: f64,
    /// Seconds since the epoch after which the key is refused.
    pub expires: u64,
    pub created: u64,
    pub revoked: bool,
    /// The authorisation transaction on the chain, once made.
    pub tx: Option<String>,
    /// Drawn fresh for this key and part of its token: a key made again under the same index never shares a token
    /// with one made before it. None for a key made before salts.
    pub salt: Option<String>,
    /// Made by the node itself (`ensure_first`), not by the owner: the node renews its expiry (`keep_granted`).
    pub auto: bool,
    /// The owner set this key's cap (`set_cap`, under Advanced). A key the node made itself whose cap the owner never
    /// set takes the default (`AUTO_CAP_USDC`) at each renewal, so a node made when the default was higher comes down
    /// to it at its next renewal and keeps working until then.
    pub cap_set: bool,
    /// Whose deposit the key's vouchers draw on, from which voucher epoch: `(epoch, Some(wallet))` once the owner's
    /// wallet granted this key (`authorizeAgent` sent from the wallet, spec §76.1 item 1.7), so several nodes signed in
    /// with one wallet share its deposit, each with its own key and cap; `(epoch, None)` back to the node's own wallet.
    /// Empty: the node's own, as every key before. A stream already begun in an epoch keeps the payer it began under.
    pub payers: Vec<(u64, Option<String>)>,
}

/// An agent key as `agents.json` and the owner's API write it. The cap goes out under both names: `cap_usdc`, and
/// `cap_unb`, its name from before fees were USDC, kept so an older node reading this file, and a client reading the
/// API, still find it. Either reads back, `cap_usdc` first.
#[derive(Serialize, Deserialize)]
struct AgentWire {
    index: u32,
    name: String,
    address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cap_usdc: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cap_unb: Option<f64>,
    expires: u64,
    created: u64,
    revoked: bool,
    #[serde(default)]
    tx: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    auto: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    cap_set: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    payers: Vec<(u64, Option<String>)>,
}

impl From<AgentWire> for Agent {
    fn from(w: AgentWire) -> Self {
        let AgentWire { index, name, address, cap_usdc, cap_unb, expires, created, revoked, tx, salt, auto, cap_set, payers } = w;
        Agent { index, name, address, cap_usdc: cap_usdc.or(cap_unb).unwrap_or(0.0), expires, created, revoked, tx, salt, auto, cap_set, payers }
    }
}

impl From<Agent> for AgentWire {
    fn from(a: Agent) -> Self {
        let Agent { index, name, address, cap_usdc, expires, created, revoked, tx, salt, auto, cap_set, payers } = a;
        AgentWire { index, name, address, cap_usdc: Some(cap_usdc), cap_unb: Some(cap_usdc), expires, created, revoked, tx, salt, auto, cap_set, payers }
    }
}

impl Agent {
    /// The wallet whose deposit this key pays from in voucher epoch `epoch`, when it isn't the node's own.
    pub fn payer_at(&self, epoch: u64) -> Option<alloy::primitives::Address> {
        self.payers.iter().rev().find(|(from, _)| *from <= epoch).and_then(|(_, w)| w.as_deref()?.parse().ok())
    }

    /// The wallet it pays from from here on, when it isn't the node's own.
    pub fn pays_from(&self) -> Option<alloy::primitives::Address> {
        self.payers.last().and_then(|(_, w)| w.as_deref()?.parse().ok())
    }
}

/// The wallet agent `index`'s vouchers for `epoch` draw on, when it isn't the node's own (`Agent::payer_at`).
pub fn payer_at(index: u32, epoch: u64) -> Option<alloy::primitives::Address> {
    list().into_iter().find(|a| a.index == index).and_then(|a| a.payer_at(epoch))
}

/// Has key `index` pay from `wallet` (or the node's own wallet, `None`) from voucher epoch `from` on. A stream already
/// begun keeps its payer: `from` is the next epoch when the key has lines in the current one.
pub fn set_payer(index: u32, from: u64, wallet: Option<alloy::primitives::Address>) -> Result<(), String> {
    let _held = Held::take()?;
    let mut all = list_strict()?;
    let a = all.iter_mut().find(|a| a.index == index).ok_or("no such agent")?;
    if a.pays_from() == wallet {
        return Ok(());
    }
    a.payers.retain(|(e, _)| *e < from);
    a.payers.push((from, wallet.map(|w| w.to_checksum(None))));
    save(&all)
}

/// The first agent key's name, made by the node itself on its first run (`ensure_first`).
pub const FIRST: &str = "Your agents";
/// What a key the node makes for itself may spend, in USDC a voucher epoch (`agent.key_cap`, spec §76.1 item 2: 100
/// fetches at the default per-fetch maximum, so a stolen node spends at most that), and how long it lasts before the
/// node renews it. The owner can raise it under Advanced (`set_cap`). What the node pays for one fetch is still bounded
/// by `max_fetch_usdc`.
pub const AUTO_CAP_USDC: f64 = 5.0;
pub const AUTO_DAYS: u64 = 30;
/// A key's grant is renewed when it has less than this left.
pub const RENEW_BEFORE_SECS: u64 = 7 * 86_400;

fn path() -> std::path::PathBuf {
    store::home().join("agents.json")
}

/// The agents, for checking a token: a file that doesn't read lets no one in.
pub fn list() -> Vec<Agent> {
    store::read_json(&path(), &unbrowse_files::AGENTS)
}

/// The agents, for changing them: a file that is there and doesn't read is an error, never an empty list a new key
/// would be numbered from and saved over.
fn list_strict() -> Result<Vec<Agent>, String> {
    store::read_json_strict(&path(), &unbrowse_files::AGENTS)
}

fn save(all: &[Agent]) -> Result<(), String> {
    store::write_json(&path(), &unbrowse_files::AGENTS, all)
}

/// Held while `agents.json` is read and written back, across processes (the window's node and `agent new` in a
/// shell): two keys made at once never take one index, and a revoke is never lost under a create.
struct Held(std::fs::File);

impl Held {
    fn take() -> Result<Self, String> {
        let _ = std::fs::create_dir_all(store::home());
        let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(store::home().join("agents.lock")).map_err(|e| e.to_string())?;
        f.lock().map_err(|e| e.to_string())?;
        Ok(Held(f))
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// Agent `a`'s bearer token.
pub fn token_of(root: &RootKey, a: &Agent) -> String {
    root.agent(a.index).api_token_with(a.salt.as_deref())
}

/// Creates the next agent key and returns it with its one-time setup string.
pub fn create(keys: &dyn KeyStore, name: &str, cap_usdc: f64, days: u64, port: u16) -> Result<(Agent, String), String> {
    make(keys, name, cap_usdc, days, port, false)
}

/// The next agent key, `auto` when the node makes it for itself. Written whole in one go: a crash can't leave the node's
/// own key marked as the owner's, which nothing renews, so the only key lapses after its first 30 days.
fn make(keys: &dyn KeyStore, name: &str, cap_usdc: f64, days: u64, port: u16, auto: bool) -> Result<(Agent, String), String> {
    if name.trim().is_empty() {
        return Err("give the agent a name".into());
    }
    // A name that starts like a flag is a command line's option read as a name (`agent new --help`).
    if name.trim().starts_with('-') {
        return Err(format!("{} looks like an option, not a name: give the agent a name", name.trim()));
    }
    let root = RootKey::load(keys).map_err(|e| e.to_string())?;
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    let held = Held::take()?;
    let mut all = list_strict()?;
    let index = all.iter().map(|a| a.index + 1).max().unwrap_or(0);
    let key = root.agent(index);
    let agent = Agent {
        index,
        name: name.trim().to_string(),
        address: key.address.to_checksum(),
        cap_usdc,
        expires: store::now() + days.max(1) * 86_400,
        created: store::now(),
        revoked: false,
        tx: None,
        salt: Some(hex::encode(salt)),
        auto,
        cap_set: false,
        payers: vec![],
    };
    all.push(agent.clone());
    save(&all)?;
    drop(held);
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: "This node".into(),
        what: format!("Created a key for {}", agent.name),
        kind: "key".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("cap {cap_usdc} USDC a day")),
    });
    let token = token_of(&root, &agent);
    drop(token);
    Ok((agent.clone(), setup_for(port, agent.index, &unb_program(), &node_program())))
}

/// `unb` beside this program (the app bundle and the npm platform package keep them together), else the name on PATH.
fn unb_program() -> String {
    let name = if cfg!(windows) { "unb.exe" } else { "unb" };
    std::env::current_exe()
        .ok()
        .and_then(|me| me.parent().map(|d| d.join(name)))
        .filter(|p| p.exists())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| name.to_string())
}

/// `unbrowse-node`: this program when it is the node, else beside it, else the name on PATH.
fn node_program() -> String {
    let name = if cfg!(windows) { "unbrowse-node.exe" } else { "unbrowse-node" };
    std::env::current_exe()
        .ok()
        .and_then(|me| if me.file_name().is_some_and(|f| f == name) { Some(me) } else { me.parent().map(|d| d.join(name)) })
        .filter(|p| p.exists())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| name.to_string())
}

/// The setup an agent key is shown. It names the agent, never its token: an MCP client is given `unb mcp --agent
/// <index>`, which reads the owner's grant for that agent as it starts, and a shell reads it with `agent token` when
/// the line runs. No setup text, command line or config holds the token.
fn setup_for(port: u16, index: u32, unb: &str, node: &str) -> String {
    let quote = |p: &str| if p.contains(' ') { format!("\"{p}\"") } else { p.to_string() };
    let (unb, node) = (quote(unb), quote(node));
    format!(
        "# Claude Code (MCP):\nclaude mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:{port} -- {unb} mcp --agent {index}\n\n# Any other agent, or the unb CLI (the token is read when the line runs; the first time, the owner is asked):\nexport UNBROWSE_NODE=http://127.0.0.1:{port}\nexport UNBROWSE_AGENT_TOKEN=\"$({node} agent token {index})\""
    )
}

/// After a new root key went in: each key's address is what the new key makes, and nothing it was granted under the old
/// one stands (its transaction, the wallet it paid from). Its token follows the root key by itself (`token_of`).
pub fn rekey(keys: &dyn KeyStore) -> Result<(), String> {
    let root = RootKey::load(keys).map_err(|e| e.to_string())?;
    let _held = Held::take()?;
    let mut all = list_strict()?;
    for a in &mut all {
        a.address = root.agent(a.index).address.to_checksum();
        a.tx = None;
        a.payers.clear();
    }
    // Every token follows the new root key: a grant of the old one opens nothing, and the owner is asked afresh.
    let _ = std::fs::remove_dir_all(grants_dir());
    save(&all)
}

/// On the node's first run, its first agent key, so `unb connect`, the MCP server and the SDK work at once, with no key
/// for the owner to make (R1.20, R1.35). It is local: nothing is written to the chain, and a node that never signs in
/// never grants it there. Made only when no key was ever made: a node whose owner revoked every key gets none back.
pub fn ensure_first(keys: &dyn KeyStore, port: u16) -> Result<Option<Agent>, String> {
    if !list_strict()?.is_empty() {
        return Ok(None);
    }
    make(keys, FIRST, AUTO_CAP_USDC, AUTO_DAYS, port, true).map(|(agent, _)| Some(agent))
}

fn owed_path() -> std::path::PathBuf {
    store::home().join("revokes-owed.json")
}

/// The keys revoked here that the chain hasn't taken the revoke of. A key the chain still grants goes on being able to
/// spend what a voucher signed before can claim, so a revoke the chain didn't take is tried again until it does.
pub fn revokes_owed() -> Vec<u32> {
    std::fs::read(owed_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn keep_owed(owed: &[u32]) {
    let part = owed_path().with_extension("json.part");
    let written = serde_json::to_vec(owed).map_err(|e| e.to_string()).and_then(|b| std::fs::write(&part, b).map_err(|e| e.to_string())).and_then(|_| std::fs::rename(&part, owed_path()).map_err(|e| e.to_string()));
    if let Err(e) = written {
        eprintln!("agent keys: couldn't keep which revokes the chain still owes: {e}");
    }
}

/// The chain didn't take the revoke of key `index`.
pub fn owe_revoke(index: u32) {
    let Ok(_held) = Held::take() else { return };
    let mut owed = revokes_owed();
    if !owed.contains(&index) {
        owed.push(index);
        keep_owed(&owed);
    }
}

/// The chain took the revoke of key `index`.
fn revoke_paid(index: u32) {
    let Ok(_held) = Held::take() else { return };
    let mut owed = revokes_owed();
    owed.retain(|i| *i != index);
    keep_owed(&owed);
}

/// What `keep_granted` does for each live key, given its grant as the chain has it (`chain`: `Some(None)` where it has
/// none, `Some(Some((cap, expiry)))` in USDC and unix seconds, `None` where the chain couldn't be read): the key with
/// the cap and expiry it now has, and whether that grant must be written to the chain (it has none, another cap, or an
/// earlier expiry). A key the node made itself is renewed before it runs out, and at renewal takes the default cap
/// unless the owner set one (`cap_set`). A key past its expiry that the node didn't make is left to lapse. A key whose
/// grant couldn't be read is renewed here but not written: it is looked at again on the next pass.
pub fn to_grant(all: &[Agent], chain: &dyn Fn(&Agent) -> Option<Option<(f64, u64)>>, now: u64) -> Vec<(Agent, bool)> {
    let mut out = Vec::new();
    for a in all.iter().filter(|a| !a.revoked) {
        let renew = a.auto && a.expires < now + RENEW_BEFORE_SECS;
        let expires = if renew { now + AUTO_DAYS * 86_400 } else { a.expires };
        if expires <= now {
            continue;
        }
        let cap = if renew && !a.cap_set { AUTO_CAP_USDC } else { a.cap_usdc };
        let write = match chain(a) {
            None => false,
            Some(None) => true,
            // To within an epoch: the chain keeps the expiry in blocks (R1.28), and as a date it moves with the chain's pace.
            Some(Some((have, exp))) => (have - cap).abs() > 1e-9 || (exp != 0 && exp.saturating_add(crate::chain::EPOCH) < expires),
        };
        if write || expires != a.expires || cap != a.cap_usdc {
            out.push((Agent { expires, cap_usdc: cap, ..a.clone() }, write));
        }
    }
    out
}

/// The keys revoked here that the chain still pays for, by what it says of each (`chain`, as `to_grant` reads it): a
/// revoke is made here first, whatever the chain does, so one it never heard leaves vouchers good to the key's cap until
/// the grant runs out. What decides it is the chain's own grant, not whether this node recorded granting one (`tx`) or
/// owes the revoke (`revokes_owed`): a node that stopped between the two writes, or holds no `tx` for a key, owes one too.
pub fn to_revoke(all: &[Agent], chain: &dyn Fn(&Agent) -> Option<Option<(f64, u64)>>, now: u64) -> Vec<u32> {
    all.iter().filter(|a| a.revoked && matches!(chain(a), Some(Some((_, expiry))) if expiry == 0 || expiry > now)).map(|a| a.index).collect()
}

/// The keys live here whose own grant the chain holds revoked (`revoked`, by what the chain says of each). Revoking is
/// final here (`revoke` has no undo), so a key live in `agents.json` that the chain revoked comes from an older copy of
/// the file, a backup put back, with that key's token still in it. The chain's revoke wins: such a key is revoked here
/// too, and never granted again, where the chain would allow a new grant (`authorizeAgent`).
pub fn revoked_by_chain(all: &[Agent], revoked: &dyn Fn(&Agent) -> bool) -> Vec<u32> {
    all.iter().filter(|a| !a.revoked && revoked(a)).map(|a| a.index).collect()
}

/// Revokes key `index` here because the chain already had (`revoked_by_chain`), and says so.
fn revoke_as_the_chain_has(index: u32) {
    match revoke_quietly(index) {
        Ok(a) => store::log_activity(&Activity {
            at: store::now(),
            who: "Node".into(),
            site: "This node".into(),
            what: format!("Revoked {}'s key, as the chain already had", a.name),
            kind: "key".into(),
            result: "done".into(),
            ms: None,
            unb: None,
            tx: None,
            note: Some("A key revoked on the chain stays revoked, even when an older agents.json comes back".into()),
        }),
        Err(e) => eprintln!("agent keys: revoking key {index} here, as the chain has it: {e}"),
    }
}

/// Keeps the agents' spending keys current (R1.20), never shown and never asked about: a key the node made itself is
/// renewed here before it runs out, and once the owner has signed in, every live key's cap and expiry are granted on
/// the chain (`authorizeAgent`) where the chain has none or an older one, and a key revoked here that the chain still
/// pays for is revoked there. A key the chain holds revoked is revoked here too (`revoked_by_chain`). A local node
/// writes nothing to the chain.
pub async fn keep_granted(node: &std::sync::Arc<crate::Node>) {
    let Ok(keys) = node.key() else { return };
    let online = crate::link::on_network(node).is_some() && node.chain.deployed().is_ok();
    let mut all = list();
    let mut grants = std::collections::HashMap::new();
    let mut revoked = std::collections::HashSet::new();
    if online {
        // Revoked keys too: whether the chain still pays one is what says its revoke is owed.
        for a in all.iter() {
            // A chain that didn't answer: this key is looked at again on the next pass.
            if let Ok((g, gone)) = crate::chain::own_grant(&node.chain, keys, a.index).await {
                grants.insert(a.index, g);
                if gone {
                    revoked.insert(a.index);
                }
            }
        }
        let back = revoked_by_chain(&all, &|a| revoked.contains(&a.index));
        if !back.is_empty() {
            for index in back {
                revoke_as_the_chain_has(index);
            }
            all = list();
        }
    }
    let chain = |a: &Agent| if online { grants.get(&a.index).copied() } else { Some(Some((a.cap_usdc, 0))) };
    let was: std::collections::HashMap<u32, Agent> = all.iter().map(|a| (a.index, a.clone())).collect();
    for (a, write) in to_grant(&all, &chain, store::now()) {
        if was.get(&a.index).is_some_and(|w| w.expires != a.expires || w.cap_usdc != a.cap_usdc) {
            set_terms(a.index, a.cap_usdc, a.expires);
        }
        if online && write {
            match crate::chain::authorize(&node.chain, keys, a.index, a.cap_usdc, a.expires).await {
                Ok(tx) => set_tx(a.index, &tx),
                Err(e) => eprintln!("agent keys: granting {}'s on the chain: {e}", a.name),
            }
        }
    }
    // Which payer each key names: the owner's wallet while it grants the key itself (spec §76.1 item 1.7).
    if online {
        crate::owner_nodes::follow(node).await;
        // The revokes the chain hasn't taken: those owed since it refused one, and any key revoked here it still pays
        // for. An owed one whose grant the chain read back as paying nothing is done, and isn't sent again.
        let due = to_revoke(&all, &chain, store::now());
        let owed = revokes_owed();
        for index in owed.iter().copied().chain(due.iter().copied().filter(|i| !owed.contains(i))) {
            // A revoke owed is let go of only on a reading of the grant that a witness stood behind and that says the
            // chain pays the key nothing (R5-CHAIN-1, R6-CHAIN-2): a second RPC merely named is no witness of a read
            // made on the first. Otherwise it stays owed, isn't sent again while the first RPC reads the key paying
            // nothing, and is sent again whenever it reads the key paid.
            if !due.contains(&index) && grants.contains_key(&index) {
                match crate::chain::own_grant_pays_witnessed(&node.chain, keys, index).await {
                    Ok(Some(false)) => {
                        revoke_paid(index);
                        continue;
                    }
                    // A witness reads the key still paid, whatever the first RPC said: the revoke goes again below.
                    Ok(Some(true)) => {}
                    // No witnessed reading now: kept owed, read again on the next pass.
                    _ => continue,
                }
            }
            match crate::chain::revoke(&node.chain, keys, index).await {
                Ok(_) if revoke_settled(crate::chain::own_grant_pays_witnessed(&node.chain, keys, index).await) => revoke_paid(index),
                Ok(_) => owe_revoke(index),
                Err(e) => eprintln!("agent keys: revoking key {index} on the chain: {e}"),
            }
        }
    }
}

/// Whether a revoke owed is done, from a witnessed reading of the grant (`chain::grant_pays_witnessed`): only when that
/// reading was had and says the chain pays the key nothing. A reading no witness stood behind, or one that failed (a
/// second RPC that disagreed included), leaves the revoke owed.
pub(crate) fn revoke_settled(witnessed_pays: Result<Option<bool>, String>) -> bool {
    matches!(witnessed_pays, Ok(Some(false)))
}

fn set_terms(index: u32, cap: f64, expires: u64) {
    let Ok(_held) = Held::take() else { return };
    let Ok(mut all) = list_strict() else { return };
    for a in all.iter_mut().filter(|a| a.index == index && !a.revoked) {
        a.expires = expires;
        a.cap_usdc = cap;
    }
    let _ = save(&all);
}

/// The owner sets what agent key `index` may spend an epoch, in USDC (under Advanced: `unbrowse-node agent cap`, the
/// SDK's `setAgentCap`, the window's key settings). From here the node keeps that cap at every renewal, and grants it
/// on the chain at its next pass (`keep_granted`). A cap is a sum of USDC above zero: 0 would grant nothing, and
/// revoking is how a key is stopped.
pub fn set_cap(index: u32, cap_usdc: f64) -> Result<Agent, String> {
    if !(cap_usdc.is_finite() && cap_usdc > 0.0) {
        return Err("a key's cap is a sum of USDC an epoch above zero; revoke the key to stop it".into());
    }
    let held = Held::take()?;
    let mut all = list_strict()?;
    let a = all.iter_mut().find(|a| a.index == index && !a.revoked).ok_or("no live agent key with that index")?;
    let before = a.cap_usdc;
    a.cap_usdc = cap_usdc;
    a.cap_set = true;
    let out = a.clone();
    save(&all)?;
    drop(held);
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: "This node".into(),
        what: format!("Set {}'s cap", out.name),
        kind: "key".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("{before} to {cap_usdc} USDC an epoch; granted on the chain at the node's next pass")),
    });
    Ok(out)
}

pub fn set_tx(index: u32, tx: &str) {
    let Ok(_held) = Held::take() else { return };
    let Ok(mut all) = list_strict() else { return };
    if let Some(a) = all.iter_mut().find(|a| a.index == index) {
        a.tx = Some(tx.to_string());
        let _ = save(&all);
    }
}

/// Revokes every key made under `index`: from here no token of it passes.
pub fn revoke(index: u32) -> Result<Agent, String> {
    let out = revoke_quietly(index)?;
    store::log_activity(&Activity {
        at: store::now(),
        who: "You".into(),
        site: "This node".into(),
        what: format!("Revoked {}'s key", out.name),
        kind: "key".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    Ok(out)
}

/// `revoke`, with nothing said.
fn revoke_quietly(index: u32) -> Result<Agent, String> {
    let _held = Held::take()?;
    let mut all = list_strict()?;
    let mut out = None;
    for a in all.iter_mut().filter(|a| a.index == index) {
        a.revoked = true;
        out.get_or_insert_with(|| a.clone());
    }
    let out = out.ok_or("no such agent")?;
    save(&all)?;
    forget_grant(index);
    Ok(out)
}

// ---- grants: an agent's token, handed out once on the owner's yes ----

/// The folder of grants: for each agent the owner let a client have, an owner-only file holding its token, which
/// `unb mcp --agent <n>` reads as it starts. Only the owner's yes writes one (`hand_out_token` in `main.rs`).
pub fn grants_dir() -> std::path::PathBuf {
    store::home().join("bridges")
}

/// Agent `index`'s grant: its token, once the owner let a client have it.
pub fn grant_path(index: u32) -> std::path::PathBuf {
    grants_dir().join(format!("agent-{index}.token"))
}

/// Which agent `--agent first` is: the number of the key the node made itself, written beside its grant (not a secret).
pub fn first_path() -> std::path::PathBuf {
    grants_dir().join("first")
}

/// Writes agent `index`'s grant, and, when it is the node's first key, which key that is. The folder and the file are
/// the owner's alone.
pub fn write_grant(index: u32, token: &str, first: bool) -> Result<(), String> {
    let dir = grants_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::agent_user::keep_folder_private(&dir)?;
    unbrowse_files::private::write(&grant_path(index), token.as_bytes()).map_err(|e| e.to_string())?;
    if first {
        unbrowse_files::private::write(&first_path(), index.to_string().as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Agent `index`'s grant, if the owner gave one.
pub fn read_grant(index: u32) -> Option<String> {
    std::fs::read_to_string(grant_path(index)).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Forgets agent `index`'s grant: its key was revoked.
pub fn forget_grant(index: u32) {
    let _ = std::fs::remove_file(grant_path(index));
    if std::fs::read_to_string(first_path()).ok().and_then(|f| f.trim().parse::<u32>().ok()) == Some(index) {
        let _ = std::fs::remove_file(first_path());
    }
}

/// Compares two strings without stopping at the first difference, so how long it takes says nothing about where two
/// tokens differ. A bearer token compared with `==` leaks its bytes one position at a time to a caller that can
/// measure the comparison; both the agent's token (`by_token`) and the owner's (`api::window::is_owner`) are compared
/// this way, in one place, so they cannot drift apart again. The length is not a secret — every token is `unb_` and 48
/// hex digits, the owner's 64 — so checking it first costs nothing.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// Which agent a bearer token belongs to, if any live one.
pub fn by_token(keys: &dyn KeyStore, token: &str) -> Option<Agent> {
    let root = RootKey::load(keys).ok()?;
    list()
        .into_iter()
        .filter(|a| !a.revoked && a.expires > store::now())
        .find(|a| constant_time_eq(&token_of(&root, a), token))
}

#[cfg(test)]
mod tests {

    /// A revoke the chain didn't take is kept until it does: it used to be said once in the log, and the key stayed
    /// granted on the chain for good.
    #[test]
    fn a_revoke_the_chain_refused_stays_owed_until_it_is_paid() {
        let _home = store::scratch_home("revokes-owed");
        assert!(revokes_owed().is_empty());
        owe_revoke(3);
        owe_revoke(5);
        owe_revoke(3);
        assert_eq!(revokes_owed(), [3, 5], "kept on disk, once each");
        revoke_paid(3);
        assert_eq!(revokes_owed(), [5]);
    }

    /// Only the chain's own word sends a revoke: a live grant on a key revoked here, and nothing else.
    #[test]
    fn a_revoke_goes_to_the_chain_only_where_the_chain_still_pays() {
        let live = Agent { index: 1, name: "live".into(), address: String::new(), cap_usdc: 1.0, expires: 0, created: 0, revoked: false, tx: None, salt: None, auto: false, cap_set: false, payers: vec![] };
        let gone = Agent { index: 2, revoked: true, ..live.clone() };
        let all = [live, gone];
        assert_eq!(to_revoke(&all, &|_| Some(Some((1.0, 0))), 100), vec![2], "a grant with no expiry, on the revoked key alone");
        assert_eq!(to_revoke(&all, &|_| Some(Some((1.0, 200))), 100), vec![2], "and one still running, whatever this node recorded of it");
        assert!(to_revoke(&all, &|_| Some(Some((1.0, 50))), 100).is_empty(), "a grant that ran out pays nothing");
        assert!(to_revoke(&all, &|_| Some(None), 100).is_empty(), "the chain already has it");
        assert!(to_revoke(&all, &|_| None, 100).is_empty(), "a chain that didn't answer is asked next pass");
    }

    /// A key is revoked here first, and the chain goes on honouring vouchers to its cap until it hears. A revoke the
    /// chain never heard, with nothing owed on disk (the node stopped between the two writes), is sent on a later pass,
    /// once. `cargo test -p unbrowse-node-app a_revoke_the_chain -- --ignored`
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn a_revoke_the_chain_never_took_is_sent_again() {
        use alloy::providers::Provider;
        let _one = crate::testchain::one_at_a_time().await;
        crate::testchain::home("revoke-again");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let node = crate::testchain::node("revoke-again");
        crate::link::set_node(&crate::identity(&node).unwrap().address);
        node.chain.start().await.expect("the devnet");
        let keys = node.key().unwrap();
        ensure_first(keys, 0).unwrap().expect("the first key");
        keep_granted(&node).await;
        assert!(crate::chain::agent_grant(&node.chain, keys, 0).await.unwrap().is_some(), "granted");
        revoke(0).unwrap();
        assert!(revokes_owed().is_empty(), "nothing owed on disk");
        assert!(crate::chain::agent_grant(&node.chain, keys, 0).await.unwrap().is_some(), "revoked here alone: the chain still pays it");
        keep_granted(&node).await;
        assert_eq!(crate::chain::agent_grant(&node.chain, keys, 0).await.unwrap(), None, "the next pass tells the chain");
        let p = crate::rpc::ProviderBuilder::new().connect_http(crate::chain::url());
        let me = crate::chain::owner_address(keys).unwrap();
        let sent = p.get_transaction_count(me).await.unwrap();
        keep_granted(&node).await;
        assert_eq!(p.get_transaction_count(me).await.unwrap(), sent, "and nothing more is sent");
    }

    /// A key the chain holds revoked is revoked here, whatever the file says; one the chain still grants, never granted,
    /// or couldn't be read for, is left as the file has it.
    #[test]
    fn a_key_the_chain_revoked_is_revoked_here_whatever_the_file_says() {
        let live = Agent { index: 1, name: "live".into(), address: String::new(), cap_usdc: 1.0, expires: 0, created: 0, revoked: false, tx: None, salt: None, auto: false, cap_set: false, payers: vec![] };
        let back = Agent { index: 2, ..live.clone() };
        let gone = Agent { index: 3, revoked: true, ..live.clone() };
        let all = [live, back, gone];
        assert_eq!(revoked_by_chain(&all, &|a| a.index != 1), vec![2], "the live key the chain revoked, and only that");
        assert!(revoked_by_chain(&all, &|_| false).is_empty());
    }

    /// A backup of `agents.json` from before a revoke, put back, must not bring the key back: the chain allows a new grant
    /// of a revoked key, and the node used to read the revoke as "never granted" and grant it again, its old token with
    /// it. `cargo test -p unbrowse-node-app a_restored_file -- --ignored`
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn a_restored_file_never_brings_back_a_key_the_chain_revoked() {
        let _one = crate::testchain::one_at_a_time().await;
        crate::testchain::home("restored-revoke");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let node = crate::testchain::node("restored-revoke");
        crate::link::set_node(&crate::identity(&node).unwrap().address);
        node.chain.start().await.expect("the devnet");
        let keys = node.key().unwrap();
        ensure_first(keys, 0).unwrap().expect("the first key");
        keep_granted(&node).await;
        assert!(crate::chain::agent_grant(&node.chain, keys, 0).await.unwrap().is_some(), "granted");
        let backup = std::fs::read(path()).unwrap();
        let token = token_of(&RootKey::load(keys).unwrap(), &list()[0]);
        revoke(0).unwrap();
        keep_granted(&node).await;
        assert_eq!(crate::chain::own_grant(&node.chain, keys, 0).await.unwrap(), (None, true), "revoked on the chain");
        std::fs::write(path(), &backup).unwrap();
        assert!(by_token(keys, &token).is_some(), "the old file brings the old token back");
        keep_granted(&node).await;
        assert_eq!(crate::chain::own_grant(&node.chain, keys, 0).await.unwrap(), (None, true), "never granted again");
        assert!(list().iter().all(|a| a.revoked), "revoked here, as the chain has it");
        assert!(by_token(keys, &token).is_none(), "and its token passes nothing");
    }

    /// The node's first key is its own in the one write that makes it.
    #[test]
    fn the_first_key_is_the_nodes_own_in_its_first_write() {
        let _home = store::scratch_home("first-one-write");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let (a, _) = make(&keys, FIRST, AUTO_CAP_USDC, AUTO_DAYS, 7788, true).unwrap();
        assert!(a.auto && list_strict().unwrap().iter().all(|k| k.auto));
    }

    use super::*;

    /// A key's cap reads under its name and under its old one (`cap_unb`, from before fees were USDC), and is written
    /// under both, so a file or a client from before the rename still finds it.
    #[test]
    fn a_new_root_key_leaves_no_key_naming_the_old_one() {
        store::scratch_home("agents-rekey");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let a = ensure_first(&keys, 7788).unwrap().unwrap();
        set_tx(a.index, "0xold");
        set_payer(a.index, 1, Some("0x00000000000000000000000000000000000000a1".parse().unwrap())).unwrap();
        let other = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&other).unwrap();
        rekey(&other).unwrap();
        let now = list().remove(0);
        assert_ne!(now.address, a.address);
        assert_eq!(now.address, RootKey::load(&other).unwrap().agent(a.index).address.to_checksum());
        assert_eq!((now.tx.clone(), now.pays_from()), (None, None));
    }

    #[test]
    fn a_keys_cap_reads_under_either_name_and_is_written_under_both() {
        let old: Agent = serde_json::from_value(serde_json::json!({ "index": 1, "name": "a", "address": "0x1", "cap_unb": 5.0, "expires": 9, "created": 1, "revoked": false })).unwrap();
        assert_eq!(old.cap_usdc, 5.0);
        let new: Agent = serde_json::from_value(serde_json::json!({ "index": 1, "name": "a", "address": "0x1", "cap_usdc": 7.0, "cap_unb": 7.0, "expires": 9, "created": 1, "revoked": false })).unwrap();
        assert_eq!(new.cap_usdc, 7.0);
        let out = serde_json::to_value(&new).unwrap();
        assert_eq!((out["cap_usdc"].as_f64(), out["cap_unb"].as_f64()), (Some(7.0), Some(7.0)));
    }

    fn keys() -> unbrowse_core::MemoryStore {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        keys
    }

    fn token(keys: &dyn KeyStore, a: &Agent) -> String {
        token_of(&RootKey::load(keys).unwrap(), a)
    }

    /// A node's first run makes its first agent key itself, with no chain write, and never again once any key was made:
    /// a node whose owner revoked every key gets none back.
    #[test]
    fn the_first_run_makes_the_first_agent_key_once() {
        let _home = store::scratch_home("agents-first");
        let keys = keys();
        let a = ensure_first(&keys, 7788).unwrap().expect("the first key");
        assert_eq!((a.index, a.auto, a.tx.clone(), a.name.as_str()), (0, true, None, FIRST), "agent 0, the node's own, nothing on the chain");
        assert!(by_token(&keys, &token(&keys, &a)).is_some(), "its token opens the API at once");
        assert!(ensure_first(&keys, 7788).unwrap().is_none(), "made once");
        revoke(0).unwrap();
        assert!(ensure_first(&keys, 7788).unwrap().is_none(), "a revoked first key isn't made again");
    }

    /// Which grants are written: a local node renews its own key's expiry and writes nothing; signed in, every live
    /// key the chain has no grant for, another cap, or an earlier expiry is granted, and one the owner let lapse is left.
    #[test]
    fn grants_are_written_where_the_chain_lacks_them_and_the_nodes_own_key_is_renewed() {
        let now = 1_000_000;
        let day = 86_400;
        let mine = Agent { index: 0, name: "mine".into(), address: String::new(), cap_usdc: AUTO_CAP_USDC, expires: now + 2 * day, created: 0, revoked: false, tx: None, salt: None, auto: true, cap_set: false, payers: vec![] };
        let theirs = Agent { index: 1, name: "theirs".into(), expires: now + 20 * day, auto: false, cap_usdc: 10.0, ..mine.clone() };
        let lapsed = Agent { index: 2, name: "lapsed".into(), expires: now - 1, auto: false, ..mine.clone() };
        let gone = Agent { index: 3, name: "gone".into(), revoked: true, ..theirs.clone() };
        let all = [mine.clone(), theirs.clone(), lapsed, gone];
        let seen = |out: Vec<(Agent, bool)>| out.into_iter().map(|(a, w)| (a.index, a.expires, w)).collect::<Vec<_>>();

        // Local: the chain is the record itself, so nothing is written; the node's own key is renewed.
        let local = |a: &Agent| Some(Some((a.cap_usdc, 0)));
        assert_eq!(seen(to_grant(&all, &local, now)), [(0, now + AUTO_DAYS * day, false)]);

        // Signed in, the chain holding no grant: both live keys are granted, at the expiry each has here.
        let none = |_: &Agent| Some(None);
        assert_eq!(seen(to_grant(&all, &none, now)), [(0, now + AUTO_DAYS * day, true), (1, now + 20 * day, true)]);

        // The chain current: nothing to write but the renewal, which the chain then lacks.
        let current = |a: &Agent| Some(Some((a.cap_usdc, a.expires)));
        assert!(to_grant(std::slice::from_ref(&theirs), &current, now).is_empty(), "the owner's key is current");
        let lower = |a: &Agent| Some(Some((a.cap_usdc / 2.0, a.expires)));
        assert_eq!(to_grant(std::slice::from_ref(&theirs), &lower, now).len(), 1, "a lower cap on the chain is raised");
        // The chain keeps the expiry in blocks: read back as a date it moves with the chain's pace, which writes nothing.
        let drifted = |a: &Agent| Some(Some((a.cap_usdc, a.expires - 600)));
        assert!(to_grant(std::slice::from_ref(&theirs), &drifted, now).is_empty(), "minutes out is the same grant");
        let short = |a: &Agent| Some(Some((a.cap_usdc, a.expires - 2 * day)));
        assert_eq!(to_grant(std::slice::from_ref(&theirs), &short, now).len(), 1, "days out is an earlier expiry");

        // A chain that couldn't be read writes nothing, and never takes an unknown grant for a different one.
        let unread = |_: &Agent| None;
        assert_eq!(seen(to_grant(&all, &unread, now)), [(0, now + AUTO_DAYS * day, false)]);
    }

    /// The automatic key's cap is 5 USDC an epoch (`agent.key_cap`, spec §76.1 item 2). A node made when it was 100 keeps
    /// working at 100 until its key's next renewal, which takes the new default, unless the owner set the cap: then the
    /// renewal keeps the owner's. The owner's cap is a sum above zero, and the chain is told at the next pass.
    #[test]
    fn the_automatic_key_is_capped_at_five_and_an_older_cap_comes_down_at_renewal() {
        assert_eq!(AUTO_CAP_USDC, 5.0);
        let now = 1_000_000;
        let day = 86_400;
        let old = Agent { index: 0, name: FIRST.into(), address: String::new(), cap_usdc: 100.0, expires: now + 20 * day, created: 0, revoked: false, tx: None, salt: None, auto: true, cap_set: false, payers: vec![] };
        let chain = |_: &Agent| Some(Some((100.0, now + 20 * day)));
        assert!(to_grant(std::slice::from_ref(&old), &chain, now).is_empty(), "before its renewal an older key keeps its cap and works");
        let due = Agent { expires: now + day, ..old.clone() };
        let chain = |_: &Agent| Some(Some((100.0, now + day)));
        let out = to_grant(std::slice::from_ref(&due), &chain, now);
        assert_eq!(out.iter().map(|(a, w)| (a.cap_usdc, a.expires, *w)).collect::<Vec<_>>(), [(AUTO_CAP_USDC, now + AUTO_DAYS * day, true)], "renewed at the new default, and written");
        let raised = Agent { cap_usdc: 50.0, cap_set: true, ..due };
        let out = to_grant(&[raised], &chain, now);
        assert_eq!(out[0].0.cap_usdc, 50.0, "a cap the owner set is kept at renewal");

        let _home = store::scratch_home("agents-cap");
        let keys = keys();
        let a = ensure_first(&keys, 7788).unwrap().unwrap();
        assert_eq!(a.cap_usdc, AUTO_CAP_USDC, "a fresh node's first key");
        assert!(set_cap(a.index, 0.0).is_err() && set_cap(a.index, f64::NAN).is_err(), "a cap is above zero");
        assert!(set_cap(9, 20.0).is_err(), "no such key");
        let up = set_cap(a.index, 20.0).unwrap();
        assert_eq!((up.cap_usdc, up.cap_set), (20.0, true));
        assert_eq!(list()[0].cap_usdc, 20.0);
        let chain = |_: &Agent| Some(Some((AUTO_CAP_USDC, up.expires)));
        assert!(to_grant(&list(), &chain, store::now())[0].1, "the raised cap is written to the chain");
    }

    /// A revoked key's token never passes again, even once its index is handed out a second time (its record lost).
    #[test]
    fn a_revoked_token_never_comes_back_when_its_index_is_reused() {
        let home = store::scratch_home("agents-reuse");
        let keys = keys();
        let (a, setup) = create(&keys, "first", 1.0, 30, 7788).unwrap();
        assert!(!setup.contains("--transport") && !setup.contains("Bearer"), "no setup hands an MCP client a bearer token: {setup}");
        assert!(setup.contains(&format!(" mcp --agent {}\n", a.index)), "{setup}");
        let old = token(&keys, &a);
        assert!(!setup.contains(&old), "no setup text holds the token: {setup}");
        assert_eq!(by_token(&keys, &old).map(|x| x.index), Some(a.index));
        revoke(a.index).unwrap();
        assert!(by_token(&keys, &old).is_none());
        std::fs::remove_file(home.join("agents.json")).unwrap();
        let (b, _) = create(&keys, "second", 1.0, 30, 7788).unwrap();
        assert_eq!(b.index, a.index, "the index is handed out again");
        assert!(by_token(&keys, &old).is_none(), "the revoked token still opens nothing");
        assert_eq!(by_token(&keys, &token(&keys, &b)).map(|x| x.name), Some("second".into()));
        // A key from before salts keeps its token.
        let legacy = Agent { salt: None, ..b.clone() };
        assert_eq!(token(&keys, &legacy), RootKey::load(&keys).unwrap().agent(b.index).api_token());
    }

    #[test]
    fn an_agents_file_that_doesnt_read_lets_no_one_in_and_takes_no_new_key() {
        let home = store::scratch_home("agents-unreadable");
        let keys = keys();
        let (a, _) = create(&keys, "first", 1.0, 30, 7788).unwrap();
        std::fs::write(home.join("agents.json"), "{").unwrap();
        assert!(by_token(&keys, &token(&keys, &a)).is_none());
        assert!(create(&keys, "second", 1.0, 30, 7788).is_err(), "never numbered from an empty list and saved over it");
        assert!(revoke(a.index).is_err());
    }

    #[test]
    fn a_revoke_reaches_every_key_made_under_its_index() {
        let home = store::scratch_home("agents-dup");
        let keys = keys();
        let (a, _) = create(&keys, "first", 1.0, 30, 7788).unwrap();
        let twin = Agent { name: "twin".into(), salt: Some("00".into()), ..a.clone() };
        store::write_json(&home.join("agents.json"), &unbrowse_files::AGENTS, &vec![a.clone(), twin.clone()]).unwrap();
        revoke(a.index).unwrap();
        assert!(by_token(&keys, &token(&keys, &a)).is_none() && by_token(&keys, &token(&keys, &twin)).is_none());
    }

    /// A key made when keys carried an approval threshold still opens the node: the threshold is read past, and the
    /// key's cap, expiry and revocation hold as before.
    #[test]
    fn an_agents_file_from_before_still_reads() {
        let home = store::scratch_home("agents-old");
        let keys = keys();
        let (a, _) = create(&keys, "first", 1.0, 30, 7788).unwrap();
        let mut old = serde_json::to_value(vec![a.clone()]).unwrap();
        old[0]["approval_usd"] = serde_json::json!(5.0);
        std::fs::write(home.join("agents.json"), old.to_string()).unwrap();
        let read = by_token(&keys, &token(&keys, &a)).expect("the old key still opens the node");
        assert_eq!((read.index, read.cap_usdc, read.expires), (a.index, a.cap_usdc, a.expires));
        let (b, _) = create(&keys, "second", 1.0, 30, 7788).unwrap();
        assert_eq!(b.index, a.index + 1, "a new key is numbered after the old one");
        assert!(!std::fs::read_to_string(home.join("agents.json")).unwrap().contains("approval_usd"), "the threshold is no longer written");
        revoke(a.index).unwrap();
        assert!(by_token(&keys, &token(&keys, &a)).is_none());
    }

    /// The token comparison agrees with `==` on every pair — a token opens the node exactly when it is the key's —
    /// but, unlike `==`, it compares every byte rather than stopping at the first difference, so how long it takes
    /// never says where two tokens differ (the owner's token is compared the same way, in `api::window::is_owner`).
    #[test]
    fn the_token_comparison_agrees_with_equality_and_reads_every_byte() {
        let tok = "unb_0123456789abcdef0123456789abcdef0123456789abcdef";
        assert!(constant_time_eq(tok, tok), "a token equals itself");
        assert!(constant_time_eq("", ""), "two empty tokens agree");
        // One differing byte, at every position: each is refused, and each agrees with `==`.
        for i in 0..tok.len() {
            let mut b = tok.as_bytes().to_vec();
            b[i] = if b[i] == b'0' { b'1' } else { b'0' };
            let diff = String::from_utf8(b).unwrap();
            assert!(!constant_time_eq(&diff, tok), "a difference at byte {i} is caught");
            assert_eq!(constant_time_eq(&diff, tok), diff == tok, "byte {i} agrees with ==");
        }
        // Lengths that differ are refused outright, never compared past the end.
        assert!(!constant_time_eq(tok, &tok[..tok.len() - 1]), "a shorter token is refused");
        assert!(!constant_time_eq("", tok), "empty is refused against a token");
    }
}
