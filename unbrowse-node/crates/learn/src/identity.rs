//! Site identity: which site a host belongs to.
//!
//! Every site check in the node goes through this module, and a test refuses a
//! host tail comparison anywhere else. A host's site is its registrable domain
//! under the public suffix list, its private section included, so `a.github.io`
//! and `b.github.io` are two sites while `www.shop.co.uk` and `shop.co.uk` are
//! one. A host with no registrable domain — an IP address, `localhost`, a bare
//! suffix such as `co.uk` or `github.io`, text that is no host name at all — is
//! only its own site.
//!
//! Site identity is not origin identity: an exact origin (scheme, host and
//! port) is compared as an origin wherever a check names one.

use url::Host;

/// The host a site check reads: a URL or `host:port` is taken apart the way the
/// browser's own address parser takes it apart — lower case, punycode, no
/// scheme, user, port, path or trailing dots. None for text holding no host.
pub fn host_of(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let url = match raw.contains("://") {
        true => url::Url::parse(raw).ok()?,
        false => url::Url::parse(&format!("http://{raw}/")).ok()?,
    };
    Some(url.host_str()?.trim_end_matches('.').to_ascii_lowercase())
}

/// A host's site: its registrable domain under the public suffix list, private
/// section included, else the host itself. The empty string for no host.
pub fn site_of(host: &str) -> String {
    let Some(host) = host_of(host) else { return String::new() };
    match registrable(&host) {
        Some(site) => site,
        None => host,
    }
}

/// Whether two hosts are one site. The only site comparison: a name that merely
/// ends in another's text is another site.
pub fn same_site(a: &str, b: &str) -> bool {
    let (a, b) = (site_of(a), site_of(b));
    !a.is_empty() && a == b
}

/// Whether `host` is on the site `site` names.
pub fn on_site(host: &str, site: &str) -> bool {
    same_site(host, site)
}

/// Whether `host` is `name` or below it, by whole labels: what an owner's
/// exclusion list means, where a name is taken as written rather than as a site.
pub fn at_or_under(host: &str, name: &str) -> bool {
    let (Some(host), Some(name)) = (host_of(host), host_of(name)) else { return false };
    host == name || host.ends_with(&format!(".{name}"))
}

/// Whether a host is a name the public suffix list knows, ICANN or private
/// section, and has a registrable domain under it. An address is not one; a
/// host that is itself a suffix is not one (a bare `shop` is the TLD, not a
/// page); a special-use name the list does not hold (`localhost`, a name under
/// a reserved label) is not one; and neither is text with no host in it. This is
/// the property that decides whether a page is public, so no list of reserved
/// names is kept.
pub fn is_public_name(host: &str) -> bool {
    use psl::Psl as _;
    let Some(host) = host_of(host) else { return false };
    if is_address(&host) {
        return false;
    }
    // The list holds no suffix for an unlisted top-level label, and a listed one it does not know is no page's.
    let listed = psl::List.suffix(host.as_bytes()).and_then(|s| s.typ()).is_some();
    listed && registrable(&host).is_some()
}

/// The registrable domain: the public suffix and one label more. None where the
/// host is an address, has an empty label, or is itself a suffix.
fn registrable(host: &str) -> Option<String> {
    if is_address(host) || host.split('.').any(str::is_empty) {
        return None;
    }
    psl::domain_str(host).map(str::to_ascii_lowercase)
}

fn is_address(host: &str) -> bool {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    matches!(Host::parse(bare), Ok(Host::Ipv4(_)) | Ok(Host::Ipv6(_)))
}

/// `url` as a label or a log line may say it: its scheme, host, port and path. Never a login, a query or a fragment,
/// which hold what the page was asked and can hold a credential (`#access_token=…`). Text that isn't an address is cut
/// at its first `?` or `#` all the same.
pub fn said_address(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut u) if u.has_host() => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.set_query(None);
            u.set_fragment(None);
            u.to_string()
        }
        _ => url.split(['?', '#']).next().unwrap_or_default().to_string(),
    }
}

/// `text` with every web address in it said as [`said_address`] says it: what a label or a log line carries, whoever
/// wrote it.
pub fn said_addresses(text: &str) -> String {
    text.split(' ')
        .map(|w| if w.contains("://") { said_address(w) } else { w.to_string() })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    /// A label or a log line says an address without what it asked or held: no query, no fragment, no login.
    #[test]
    fn no_label_carries_an_addresss_query_or_fragment() {
        assert_eq!(super::said_address("https://bank.example/cb?code=abc#access_token=tok_123"), "https://bank.example/cb");
        assert_eq!(super::said_address("https://user:pw@bank.example:8443/a/b"), "https://bank.example:8443/a/b");
        assert_eq!(super::said_addresses("this node's walk of https://bank.example/#access_token=tok_123 (2 s)"), "this node's walk of https://bank.example/ (2 s)");
        assert_eq!(super::said_address("not an address?q=1"), "not an address");
    }

    use super::*;

    /// A hosting suffix is one site per tenant: another user's page under it is
    /// another site, so its cookies are not this session's to send.
    #[test]
    fn a_hosting_suffix_is_its_own_site() {
        assert_eq!(site_of("alice.github.io"), "alice.github.io");
        assert_eq!(site_of("bob.github.io"), "bob.github.io");
        assert!(!same_site("alice.github.io", "bob.github.io"));
        assert!(!on_site("bob.github.io", "alice.github.io"));
        // The suffix itself has no registrable domain: it is only its own site.
        assert_eq!(site_of("github.io"), "github.io");
        assert!(!on_site("alice.github.io", "github.io"));
        assert_eq!(site_of("shop.vercel.app"), "shop.vercel.app");
        assert!(!same_site("shop.vercel.app", "apps.vercel.app"));
    }

    /// A compound suffix is one site across its subdomains, however many labels
    /// the suffix has, and whatever the country.
    #[test]
    fn a_compound_suffix_is_one_site() {
        for (a, b) in [
            ("www.shop.co.uk", "shop.co.uk"),
            ("checkout.shop.co.uk", "www.shop.co.uk"),
            ("www.skyscanner.com.sg", "skyscanner.com.sg"),
            ("www.foo.ne.jp", "foo.ne.jp"),
            ("shop.example", "www.shop.example"),
        ] {
            assert!(same_site(a, b), "{a} and {b} are one site");
        }
        assert_eq!(site_of("www.skyscanner.com.sg"), "skyscanner.com.sg");
        assert_eq!(site_of("carousell.sg"), "carousell.sg");
        assert_eq!(site_of("example.com"), "example.com");
        // Two names under the same suffix are two sites.
        assert!(!same_site("shop.example", "other.example"));
        assert!(!same_site("shop.co.uk", "shop.com"));
    }

    /// An address or a name with no suffix list entry is only itself, never the
    /// tail of its dotted text: `127.0.0.1` is not on the site `0.1`.
    #[test]
    fn an_ip_or_localhost_is_only_itself() {
        for host in ["127.0.0.1", "10.0.0.1", "[::1]", "localhost"] {
            assert_eq!(site_of(host), host, "{host}");
        }
        assert_ne!(site_of("127.0.0.1"), "0.1");
        assert!(!same_site("127.0.0.1", "10.0.0.1"));
        assert!(same_site("localhost", "localhost"));
        // The browser's own parser writes an IPv4 address in its canonical form.
        assert_eq!(site_of("0x7f.0.0.1"), "127.0.0.1");
        assert_eq!(site_of("127.000.000.001"), "127.0.0.1");
    }

    /// A name that only ends in another's text is another site: the check is by
    /// labels, never by tail.
    #[test]
    fn a_name_that_merely_ends_in_the_site_is_not_on_it() {
        assert!(!on_site("notshop.example", "shop.example"));
        assert!(!on_site("shop.example.attacker.net", "shop.example"));
        assert!(on_site("shop.example", "shop.example"));
        assert!(on_site("api.shop.example", "shop.example"));
        // An exclusion names a host or a name under it, by whole labels too.
        assert!(at_or_under("shop.example", "shop.example"));
        assert!(at_or_under("api.shop.example", "shop.example"));
        assert!(!at_or_under("notshop.example", "shop.example"));
    }

    /// The same site is read out of a URL, a host, or a host with a port, in any
    /// case, with or without a trailing dot.
    #[test]
    fn a_site_is_read_from_a_url_or_a_host() {
        for input in [
            "https://www.shop.co.uk/item/1?q=x#top",
            "www.shop.co.uk",
            "WWW.Shop.CO.UK",
            "www.shop.co.uk.",
            "www.shop.co.uk:8443",
            "https://user:pass@www.shop.co.uk/x",
        ] {
            assert_eq!(site_of(input), "shop.co.uk", "{input}");
        }
        assert_eq!(site_of(""), "");
        assert!(!same_site("", ""));
    }

    /// A public name is one the suffix list holds; anything else is local,
    /// reserved or not a host at all, and no model is sent to it.
    #[test]
    fn a_public_name_is_one_the_suffix_list_holds() {
        for host in ["example.com", "www.shop.co.uk", "alice.github.io", "x.onion"] {
            assert!(is_public_name(host), "{host}");
        }
        for host in ["localhost", "127.0.0.1", "[::1]", "foo.local", "service.internal", "foo.test", "foo.example", "foo.invalid", "shop", ""] {
            assert!(!is_public_name(host), "{host}");
        }
        // `shop` and `com` are top-level labels: a page needs a name below one.
        assert!(!is_public_name("com"));
        assert!(is_public_name("shop.example.com"));
    }

    /// The rule lives here: no other file in the node may compare a host by its
    /// tail, which is how three separate bugs of that shape were written.
    #[test]
    fn every_site_check_in_the_tree_goes_through_this_module() {
        let learn = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        for dir in [learn.join("src"), learn.join("../../app/src")] {
            let mut pending = vec![dir];
            while let Some(dir) = pending.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        pending.push(path);
                    } else if path.extension().is_some_and(|x| x == "rs") {
                        files.push(path);
                    }
                }
            }
        }
        assert!(files.len() > 10, "the scan found the sources");
        let mut offenders = Vec::new();
        for file in files {
            if file.file_name().is_some_and(|n| n == "identity.rs") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            for (n, line) in text.lines().enumerate() {
                let code = line.trim();
                if code.starts_with("//") || !code.contains(".ends_with(") {
                    continue;
                }
                // A tail compared on a whole label, or a variable that names a site: both are a site checked by
                // tail, and this module is the only place that may do it.
                if code.contains("\".{\"") || code.to_ascii_lowercase().contains("site") {
                    offenders.push(format!("{}:{}: {}", file.display(), n + 1, code));
                }
            }
        }
        assert!(offenders.is_empty(), "compare sites with `identity`, never by tail:\n{}", offenders.join("\n"));
    }
}
