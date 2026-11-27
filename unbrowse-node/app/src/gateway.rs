//! Unbrowse's RPC gateway (`unbrowse-rpc`, `rpc.unbrowse.ai`): Arc's JSON-RPC for the nodes of owners signed in on
//! unbrowse.ai with Privy, relayed to the provider Unbrowse pays for. Arc's public endpoints can't carry a node (one rate
//! limit an address, no block filters); a member node reads the chain here, and keeps the network's public RPC as its
//! second (`rpc::second_url`), which the gateway's operator isn't.
//!
//! The running node holds a pass its own key signed (`hold`, before its chain starts and again each day): the gateway
//! takes the pass in the path and relays only for members. A node that isn't one is refused once, and from then on it
//! reads the network's public RPC (`refuse`). `UNBROWSE_RPC` named by hand wins over both; `UNBROWSE_GATEWAY` names
//! another gateway (a staging one), and `off` turns it off.

use std::sync::RwLock;

use crate::sync::Shared;

/// The gateway every build points at.
pub const DEFAULT: &str = "https://rpc.unbrowse.ai";
/// How long a pass runs: a day, renewed every half (`RENEW`), well inside the two days the gateway takes.
pub const PASS_LIFE_S: u64 = 24 * 3600;
pub const RENEW: std::time::Duration = std::time::Duration::from_secs(12 * 3600);

/// The pass the running node holds: the network it is for and the pass itself (`<node>.<expiry>.<signature>`).
static PASS: RwLock<Option<(String, String)>> = RwLock::new(None);
/// Why the gateway refused this node, once it has: the node reads the network's public RPC from then on.
static REFUSED: RwLock<Option<String>> = RwLock::new(None);

/// The gateway's base address: `UNBROWSE_GATEWAY` when it names one (`off` or empty turns the gateway off), else
/// `DEFAULT`.
pub fn base() -> Option<String> {
    base_from(std::env::var("UNBROWSE_GATEWAY").ok().as_deref())
}

fn base_from(env: Option<&str>) -> Option<String> {
    match env.map(str::trim) {
        Some("") | Some("off") => None,
        Some(named) => Some(named.trim_end_matches('/').to_string()),
        None => Some(DEFAULT.to_string()),
    }
}

/// The message a node signs for its pass (EIP-191). The gateway reads the same text (`unbrowse-rpc/src/gate.js`
/// `passMessage`): the two must never drift apart.
pub fn pass_message(network: &str, expiry: u64) -> String {
    format!("Unbrowse RPC pass\nnetwork: {network}\nexpires: {expiry}")
}

/// A pass for `network`, signed by the node's own key, good until `expiry`.
pub fn sign(keys: &(dyn unbrowse_core::KeyStore + Sync), network: &str, expiry: u64) -> Result<String, String> {
    use alloy::signers::SignerSync;
    let signer = crate::chain::owner_signer(keys)?;
    let sig = signer.sign_message_sync(pass_message(network, expiry).as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!("{:#x}.{expiry}.0x{}", signer.address(), hex::encode(sig.as_bytes())))
}

/// Signs and holds a pass for `network` for the running node, good for a day from now.
pub fn hold(keys: &(dyn unbrowse_core::KeyStore + Sync), network: &str) -> Result<(), String> {
    let pass = sign(keys, network, crate::store::now() + PASS_LIFE_S)?;
    *PASS.writing() = Some((network.to_string(), pass));
    Ok(())
}

/// The gateway's address for `network` with the pass the node holds, unless the gateway is off, the node holds no pass
/// for that network, or the gateway has refused it.
pub fn url_for(network: &str) -> Option<String> {
    if refused().is_some() {
        return None;
    }
    url_held(network)
}

/// The gateway's address for `network` with the pass the node holds, refused or not: what the node asks again when it
/// is off the gateway (`RETAKE`).
pub fn url_held(network: &str) -> Option<String> {
    let base = base()?;
    let held = PASS.reading().clone()?;
    (held.0 == network).then(|| format!("{base}/{network}/{}", held.1))
}

/// The gateway's captcha solver for the running node (`<base>/<network>/<pass>`, to which the solver protocol's
/// `createTask` and `getTaskResult` are joined), unless the gateway is off, the node holds no pass, or the gateway has
/// refused it. The gateway puts Unbrowse's own key in, for members only (`unbrowse-rpc/src/captcha.js`).
pub fn solver_url() -> Option<String> {
    if refused().is_some() {
        return None;
    }
    let network = PASS.reading().as_ref().map(|(n, _)| n.clone())?;
    url_held(&network)
}

/// How often a node off the gateway (refused, or the gateway didn't answer) asks it again. An owner who signs in while
/// the node runs, on this machine or another, has it reading through the gateway within this, with no restart: until
/// 2026-11-18 a refusal held until the node restarted, so a node linked after it started was never gassed.
pub const RETAKE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Why the gateway refused this node, if it has.
pub fn refused() -> Option<String> {
    REFUSED.reading().clone()
}

/// Forgets the gateway's refusal: it took the node since.
pub fn unrefuse() {
    *REFUSED.writing() = None;
}

/// Whether `url` is the gateway's (any pass, any network).
pub fn is_gateway(url: &str) -> bool {
    base().is_some_and(|b| url.trim_end_matches('/').starts_with(&format!("{b}/")))
}

/// `url` as it may be shown or logged: the gateway's with its pass left out (a pass lets whoever holds it read through
/// the gateway as this node until it runs out), any other as it is.
pub fn shown(url: &str) -> String {
    match base() {
        Some(b) if url.starts_with(&format!("{b}/")) => {
            let rest = &url[b.len() + 1..];
            let network = rest.split('/').next().unwrap_or_default();
            format!("{b}/{network}/<pass>")
        }
        _ => url.to_string(),
    }
}

/// `text` as it may be shown or logged: the pass the node holds, and the pass segment of any gateway address in it,
/// replaced by `<pass>`. An HTTP client's error repeats the whole URL it asked, so an error from the gateway carries
/// the pass unless it goes through here (UNB-223).
pub fn scrub(text: &str) -> String {
    let held = PASS.reading().as_ref().map(|(_, pass)| pass.clone()).filter(|p| !p.is_empty());
    scrub_with(text, base().as_deref(), held.as_deref())
}

fn scrub_with(text: &str, base: Option<&str>, held: Option<&str>) -> String {
    let mut out = match held {
        Some(pass) => text.replace(pass, "<pass>"),
        None => text.to_string(),
    };
    if let Some(base) = base {
        let prefix = format!("{base}/");
        let mut scrubbed = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(at) = rest.find(&prefix) {
            let (before, after) = rest.split_at(at + prefix.len());
            scrubbed.push_str(before);
            // `<network>/<pass>`: the network stays, the segment after it goes, up to whatever ends a URL in prose.
            let Some(slash) = after.find('/').filter(|&i| i > 0 && after[..i].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) else {
                rest = after;
                continue;
            };
            scrubbed.push_str(&after[..=slash]);
            let tail = &after[slash + 1..];
            let end = tail.find(|c: char| c.is_whitespace() || matches!(c, ')' | '(' | '"' | '\'' | '<' | '>' | ',' | ';' | '/' | '?' | '#')).unwrap_or(tail.len());
            if end > 0 {
                scrubbed.push_str("<pass>");
            }
            rest = &tail[end..];
        }
        scrubbed.push_str(rest);
        out = scrubbed;
    }
    out
}

/// Whether an RPC error is the gateway saying this node isn't one it serves: not a member, or a pass it won't take.
pub fn refusal(error: &str) -> bool {
    error.contains("-32001") || error.contains("isn't a member") || error.contains("not a member's pass")
}

/// The gateway refused this node, for `why`: from now on it reads the network's public RPC.
pub fn refuse(why: &str) {
    *REFUSED.writing() = Some(why.to_string());
}

/// Back to a gateway that hasn't refused this node, for a test that had it refuse.
#[cfg(test)]
pub fn forget_refusal() {
    *REFUSED.writing() = None;
}

/// What the owner is told once when the gateway refuses the node.
pub fn refused_note(why: &str) -> String {
    let at = base().unwrap_or_else(|| DEFAULT.to_string());
    format!(
        "Unbrowse's RPC ({at}) didn't take this node ({why}): it serves the nodes of owners signed in on unbrowse.ai. Sign in (`unbrowse-node sign-in`) to use it; until then the node reads the network's public RPC, which limits how often it can ask"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The address the node reads through names the network and carries the pass held for it, and there is none for a
    /// network the node holds no pass for. (A test elsewhere has the gateway refuse the node for a moment, and a refused
    /// node has no address: either answer holds then.)
    #[test]
    fn the_gateway_address_carries_the_pass_held_for_its_network() {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        hold(&keys, "pass-test-net").unwrap();
        let held = url_held("pass-test-net");
        let prefix = base().map(|b| format!("{b}/pass-test-net/0x"));
        assert_eq!(held.is_some(), prefix.is_some(), "an address exactly when the gateway is on: {held:?}");
        assert!(held.iter().zip(prefix.iter()).all(|(u, p)| u.starts_with(p.as_str())), "{held:?}");
        let used = url_for("pass-test-net");
        assert!(used == held || refused().is_some(), "{used:?}");
        // The captcha solver is the same address, for the network the pass is held for, and gone once refused.
        assert_eq!(solver_url(), url_for("pass-test-net"));
        assert_eq!(url_held("another-net"), None);
        assert_eq!(url_for("another-net"), None);
    }

    /// A pass the node signs is the one the gateway reads: the same message, and a signature that recovers to the
    /// node's address (the gateway's own test reads a pass `cast wallet sign` made the same way).
    #[test]
    fn a_pass_is_signed_by_the_node_for_its_network_and_day() {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let me = crate::chain::owner_signer(&keys).unwrap().address();
        let pass = sign(&keys, "arc-testnet", 1_900_000_000).unwrap();
        let parts: Vec<&str> = pass.split('.').collect();
        assert_eq!(parts.len(), 3, "{pass}");
        assert_eq!(parts[0].parse::<alloy::primitives::Address>().unwrap(), me);
        assert_eq!(parts[1], "1900000000");
        let signer = crate::link::signer_of(&pass_message("arc-testnet", 1_900_000_000), parts[2]).unwrap();
        assert_eq!(signer, me, "the signature recovers to the node");
        assert_ne!(crate::link::signer_of(&pass_message("arc-mainnet", 1_900_000_000), parts[2]).ok(), Some(me), "and only for its network");
    }

    #[test]
    fn the_gateway_is_on_by_default_and_named_or_turned_off_by_hand() {
        assert_eq!(base_from(None).as_deref(), Some(DEFAULT));
        assert_eq!(base_from(Some("https://unbrowse-rpc-staging.example.dev/")).as_deref(), Some("https://unbrowse-rpc-staging.example.dev"));
        assert_eq!(base_from(Some("off")), None);
        assert_eq!(base_from(Some(" ")), None);
    }

    /// An HTTP client's error names the URL it asked in full; what is logged or kept as the chain's status names the
    /// gateway and the network, never the pass (UNB-223). Text with no gateway address in it is left as it was.
    #[test]
    fn an_error_from_the_gateway_never_carries_its_pass() {
        let base = "https://rpc.unbrowse.ai";
        let pass = "0x2a5784cb375def9a20c63fa54d7b6deceba7a0c6.1795091264.0x7ca5e0412cb5d156840c159be4b3776eacec2736c0115adde5cf5062882f9b8b";
        let said = format!("arc-testnet doesn't answer at {base}/arc-testnet/<pass>: error sending request for url ({base}/arc-testnet/{pass})");
        let shown = scrub_with(&said, Some(base), None);
        assert_eq!(shown, format!("arc-testnet doesn't answer at {base}/arc-testnet/<pass>: error sending request for url ({base}/arc-testnet/<pass>)"));
        for part in pass.split('.') {
            assert!(!shown.contains(part), "{shown}");
        }
        // The pass the node holds goes wherever it appears, in a URL or not.
        assert_eq!(scrub_with(&format!("rejected {pass}"), Some(base), Some(pass)), "rejected <pass>");
        assert_eq!(scrub_with(&format!("rejected {pass}"), None, Some(pass)), "rejected <pass>", "with the gateway turned off too");
        // Another RPC's error, a gateway address with no pass, and plain text stay as they were.
        let other = "arc-testnet doesn't answer at https://rpc.testnet.arc.io/: error sending request for url (https://rpc.testnet.arc.io/)";
        assert_eq!(scrub_with(other, Some(base), None), other);
        assert_eq!(scrub_with(&format!("{base}/ is down"), Some(base), None), format!("{base}/ is down"));
        assert_eq!(scrub_with("nothing to hide", Some(base), Some(pass)), "nothing to hide");
    }

    #[test]
    fn the_gateways_refusals_are_told_apart_from_other_errors() {
        assert!(refusal(r#"server returned an error response: error code -32001: this node isn't a member: its owner signs in with Privy on unbrowse.ai first"#));
        assert!(refusal("not a member's pass: the pass ran out: the node signs a new one"));
        assert!(!refusal(r#"error code -32005: rate limit exceeded"#));
        assert!(!refusal("error sending request for url"));
    }
}
