//! `unbrowse://` links: a name for a site's routes, or for one route, that a person can share.
//!
//! ```text
//! unbrowse://example.com             the routes the network lists for a site
//! unbrowse://example.com/0x<entry>   one route: its entry id, which comes from its body, so a link can't drift
//! ```
//!
//! A link can come from any page, and a page can fire one at this machine, so what it can say is little on purpose: a
//! site and an entry, with no inputs, no goal and no login. Opening one shows what it names and does nothing else
//! (`api::open`): calling a route is a separate step, with the usual limits. Anything else in a link is refused, not
//! ignored, so two links that read alike are the same link, and non-ASCII is refused so a look-alike host can't pass
//! for the site it copies.

use std::fmt;

/// The most a link can be: a long registrable domain and an entry id, with room to spare.
const MAX_LEN: usize = 512;
const SCHEME: &str = "unbrowse://";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The registrable domain: where the network keeps the site's routes.
    pub site: String,
    /// The entry, `0x` and 64 lowercase hex digits. None names the whole site.
    pub entry: Option<String>,
}

impl Link {
    /// A link to `entry` on `site`, or None when they aren't what a link can name.
    pub fn to_entry(site: &str, entry: &str) -> Option<Link> {
        parse(&format!("{SCHEME}{site}/{entry}")).ok()
    }
}

impl fmt::Display for Link {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{SCHEME}{}", self.site)?;
        match &self.entry {
            Some(e) => write!(f, "/{e}"),
            None => Ok(()),
        }
    }
}

/// A DNS label a person could read: not empty, and no hyphen at either end.
fn plain_label(label: &str) -> bool {
    !label.is_empty() && !label.starts_with('-') && !label.ends_with('-')
}

fn entry_of(path: &str) -> Option<String> {
    let hex = path.strip_prefix("0x").unwrap_or(path);
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("0x{}", hex.to_ascii_lowercase()))
}

/// Reads a link. What it says is checked; nothing it names is looked up.
pub fn parse(text: &str) -> Result<Link, String> {
    let text = text.trim();
    if text.len() > MAX_LEN {
        return Err("that link is too long to be one".into());
    }
    let rest = match text.get(..SCHEME.len()) {
        Some(s) if s.eq_ignore_ascii_case(SCHEME) => &text[SCHEME.len()..],
        _ => return Err("an Unbrowse link starts with unbrowse://".into()),
    };
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !host.contains('.') || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') || !host.split('.').all(plain_label) {
        return Err("a link names a site by its plain domain: no port, login or non-ASCII letters".into());
    }
    let site = unbrowse_net::site_of(host).ok_or("that link names no site")?;
    let entry = match path {
        "" => None,
        p => Some(entry_of(p).ok_or("a link names a site and, at most, one route by its entry id: nothing else")?),
    };
    Ok(Link { site, entry })
}

#[cfg(test)]
mod tests {
    use super::*;

    const E: &str = "ab00000000000000000000000000000000000000000000000000000000000001";

    #[test]
    fn a_link_names_a_site_and_at_most_one_route() {
        assert_eq!(parse("unbrowse://example.com").unwrap(), Link { site: "example.com".into(), entry: None });
        let full = format!("unbrowse://example.com/0x{E}");
        assert_eq!(parse(&full).unwrap(), Link { site: "example.com".into(), entry: Some(format!("0x{E}")) });
        assert_eq!(parse(&full).unwrap().to_string(), full);
    }

    /// One thing has one link: however a link is written, it reads back as the same link.
    #[test]
    fn a_link_is_read_the_same_however_it_is_written() {
        let want = format!("unbrowse://example.com/0x{E}");
        for written in [
            format!("UNBROWSE://Example.COM/0X{E}").replace("0X", "0x"),
            format!("unbrowse://www.example.com/{E}"),
            format!("unbrowse://shop.example.com/0x{}", E.to_uppercase()),
            format!("  unbrowse://example.com/0x{E}\n"),
        ] {
            assert_eq!(parse(&written).unwrap().to_string(), want, "{written}");
        }
        assert_eq!(parse("unbrowse://a.example.co.uk").unwrap().site, "example.co.uk");
        // Apps add the slash to a bare host; it says nothing more.
        assert_eq!(parse("unbrowse://example.com/").unwrap(), parse("unbrowse://example.com").unwrap());
    }

    /// A page can fire a link at this machine: it can carry nothing but the two things a link names.
    #[test]
    fn a_link_carries_nothing_else() {
        let e = format!("0x{E}");
        for bad in [
            "".to_string(),
            "example.com".into(),
            "https://example.com".into(),
            "unbrowse:example.com".into(),
            "unbrowse://".into(),
            "unbrowse://localhost".into(),
            "unbrowse://com".into(),
            "unbrowse://127.0.0.1".into(),
            "unbrowse://[::1]".into(),
            "unbrowse://example.com:8080".into(),
            "unbrowse://owner@example.com".into(),
            "unbrowse://owner:pw@example.com".into(),
            "unbrowse://exämple.com".into(),
            "unbrowse://-example.com".into(),
            "unbrowse://example-.com".into(),
            "unbrowse://www.-example.com".into(),
            "unbrowse://example..com".into(),
            "unbrowse://xn--exmple-cua.com/%2e%2e".into(),
            "unbrowse://example.com/search".into(),
            "unbrowse://example.com?q=lamp".into(),
            "unbrowse://example.com#x".into(),
            format!("unbrowse://example.com/{e}?pay=1"),
            format!("unbrowse://example.com/{e}#x"),
            format!("unbrowse://example.com/{e}/call"),
            format!("unbrowse://example.com/{e}/"),
            format!("unbrowse://example.com/../{e}"),
            format!("unbrowse://example.com/{}", &e[..65]),
            format!("unbrowse://example.com\\{e}"),
            format!("unbrowse://example.com/{e}\u{0}"),
            format!("unbrowse://{}.com", "a".repeat(600)),
        ] {
            assert!(parse(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn an_entry_a_site_cant_name_makes_no_link() {
        assert_eq!(Link::to_entry("example.com", &format!("0x{E}")).unwrap().to_string(), format!("unbrowse://example.com/0x{E}"));
        assert_eq!(Link::to_entry("listed by someone, unchecked", &format!("0x{E}")), None);
        assert_eq!(Link::to_entry("example.com", "r1"), None);
    }
}
