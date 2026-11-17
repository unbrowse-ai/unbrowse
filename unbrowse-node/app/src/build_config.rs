//! What a fresh install starts with, fixed when the node is built. Going live is setting these when a release is cut
//! (`.github/workflows/release.yml` passes them from the repository's variables); a plain `cargo build` sets none and
//! behaves as before. Each is a default only: a settings file the owner already has keeps what it says, and the
//! run-time overrides (`UNBROWSE_CHAIN`, `UNBROWSE_SITE`) still win.
//!
//! - `UNBROWSE_DEFAULT_CHAIN`: the chain a fresh install runs on, by its network file's name (`chain::names`). The
//!   devnet when unset.
//! - `UNBROWSE_SITE`: the website tried first for the owner's sign-in, and its relay (`link::sites`).
//!   None when unset: the public sites are tried.
//! - `UNBROWSE_SHARE_DEFAULT`: how a fresh install shares the routes it learns (`store::ShareMode`): `used`, `all`
//!   or `off`. `used` when unset.
//!
//! A value the node can't take fails the build, so a release never ships a default it would refuse at run time. An
//! empty value is unset: a repository variable nobody set reaches the build as one.

use crate::store::ShareMode;

const CHAIN: Option<&str> = given(option_env!("UNBROWSE_DEFAULT_CHAIN"));
const SITE: Option<&str> = given(option_env!("UNBROWSE_SITE"));
const SHARE: Option<&str> = given(option_env!("UNBROWSE_SHARE_DEFAULT"));

const _: () = assert!(CHAIN.is_none() || known_chain(CHAIN), "UNBROWSE_DEFAULT_CHAIN isn't a chain the node knows: devnet, or an Arc network's name");
const _: () = assert!(SHARE.is_none() || share_mode(SHARE).is_some(), "UNBROWSE_SHARE_DEFAULT is used, all or off");
const _: () = assert!(SITE.is_none() || is_site(SITE), "UNBROWSE_SITE is a site's address, https:// (or http:// on this machine), with no path");

/// The chain a fresh install runs on.
pub fn default_chain() -> &'static str {
    CHAIN.unwrap_or(crate::chain::DEVNET)
}

/// The website the build puts first, if it names one.
pub fn site() -> Option<&'static str> {
    SITE
}

/// How a fresh install shares the routes it learns.
pub fn share_default() -> ShareMode {
    share_mode(SHARE).unwrap_or(ShareMode::Used)
}

/// A value that says something: an empty one, or only spaces, is none.
const fn given(v: Option<&'static str>) -> Option<&'static str> {
    match v {
        Some(s) if !s.trim_ascii().is_empty() => Some(s.trim_ascii()),
        _ => None,
    }
}

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn starts(s: &str, prefix: &str) -> bool {
    let (s, p) = (s.as_bytes(), prefix.as_bytes());
    if s.len() < p.len() {
        return false;
    }
    let mut i = 0;
    while i < p.len() {
        if s[i] != p[i] {
            return false;
        }
        i += 1;
    }
    true
}

/// The names `chain::names` takes: the devnet's and each network file's.
const fn known_chain(v: Option<&str>) -> bool {
    let Some(name) = v else { return false };
    if same(name, crate::chain::DEVNET) {
        return true;
    }
    let mut i = 0;
    while i < crate::arc::NETWORKS.len() {
        if same(name, crate::arc::NETWORKS[i].name) {
            return true;
        }
        i += 1;
    }
    false
}

/// A share mode by its name. `on` and `true` read as `used`, `false` as `off`, as an old settings file's switch does.
pub(crate) const fn share_mode(v: Option<&str>) -> Option<ShareMode> {
    let Some(v) = v else { return None };
    if same(v, "used") || same(v, "on") || same(v, "true") {
        Some(ShareMode::Used)
    } else if same(v, "all") {
        Some(ShareMode::All)
    } else if same(v, "off") || same(v, "false") {
        Some(ShareMode::Off)
    } else {
        None
    }
}

/// A site's origin: https, or http to this machine (a test's), and nothing after the host but an optional port.
const fn is_site(v: Option<&str>) -> bool {
    let Some(v) = v else { return false };
    let rest = if starts(v, "https://") {
        v.len() - 8
    } else if starts(v, "http://127.0.0.1") || starts(v, "http://localhost") {
        // The host ends there: a name that only begins like this machine's is someone else's.
        let host_end = "http://localhost".len();
        if v.len() > host_end && v.as_bytes()[host_end] != b':' && v.as_bytes()[host_end] != b'/' {
            return false;
        }
        v.len() - 7
    } else {
        return false;
    };
    let b = v.as_bytes();
    let mut i = b.len() - rest;
    if i == b.len() {
        return false;
    }
    while i < b.len() {
        let c = b[i];
        if !(c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b':' || (c == b'/' && i == b.len() - 1)) {
            return false;
        }
        i += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A build that sets nothing behaves as before: the devnet, no site of its own, and routes shared once used.
    #[test]
    fn a_build_with_no_flags_keeps_todays_defaults() {
        assert_eq!(given(None), None);
        assert_eq!(given(Some("")), None, "an unset repository variable reaches the build empty");
        assert_eq!(given(Some("  ")), None);
        assert_eq!(given(Some(" arc-testnet ")), Some("arc-testnet"));
        assert_eq!(CHAIN.unwrap_or(crate::chain::DEVNET), default_chain());
        if option_env!("UNBROWSE_DEFAULT_CHAIN").is_none() {
            assert_eq!(default_chain(), "devnet");
        }
        if option_env!("UNBROWSE_SHARE_DEFAULT").is_none() {
            assert_eq!(share_default(), ShareMode::Used);
        }
        if option_env!("UNBROWSE_SITE").is_none() {
            assert_eq!(site(), None);
        }
    }

    /// The values a release may set are the ones the node takes at run time, and nothing else.
    #[test]
    fn a_flag_takes_only_what_the_node_takes() {
        for name in crate::chain::names() {
            assert!(known_chain(Some(name)), "{name}");
        }
        assert!(!known_chain(Some("arc-devnet")) && !known_chain(Some("Devnet")) && !known_chain(None));
        assert_eq!(share_mode(Some("used")), Some(ShareMode::Used));
        assert_eq!(share_mode(Some("all")), Some(ShareMode::All));
        assert_eq!(share_mode(Some("off")), Some(ShareMode::Off));
        assert_eq!(share_mode(Some("on")), Some(ShareMode::Used));
        assert_eq!(share_mode(Some("everything")), None);
        assert!(is_site(Some("https://unbrowse.ai")) && is_site(Some("https://staging.unbrowse.ai/")) && is_site(Some("http://127.0.0.1:8787")));
        assert!(!is_site(Some("http://unbrowse.ai")), "plain http only to this machine");
        assert!(!is_site(Some("https://unbrowse.ai/link")), "an origin, not a page");
        assert!(!is_site(Some("https://")) && !is_site(Some("unbrowse.ai")));
        assert!(!is_site(Some("http://localhost.example.com")), "a name that only begins like this machine's");
    }
}
