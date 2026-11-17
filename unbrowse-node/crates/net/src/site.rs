//! The key a site is found under. Agents name a page; the table is keyed by the registrable domain the page belongs
//! to, so every subdomain and path of one site meets at one key.

use libp2p::kad::RecordKey;

/// The registrable domain of a url or host: the public suffix and one label more, lowercased. None for an address, a
/// bare suffix, or text with no host in it.
pub fn site_of(input: &str) -> Option<String> {
    let input = input.trim();
    let host = match url::Url::parse(input) {
        Ok(u) if u.host_str().is_some() => u.host_str()?.to_string(),
        _ => url::Url::parse(&format!("https://{input}")).ok()?.host_str()?.to_string(),
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') || host.split('.').any(str::is_empty) {
        return None;
    }
    psl::domain_str(&host).map(str::to_string)
}

/// The table key a site's providers are recorded under.
pub fn site_key(site: &str) -> RecordKey {
    RecordKey::new(&format!("/unbrowse/site/{site}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_page_of_a_site_meets_at_one_key() {
        for page in ["https://www.example.co.uk/flights?from=SIN", "shop.example.co.uk", "EXAMPLE.co.uk.", "http://example.co.uk:8080"] {
            assert_eq!(site_of(page).as_deref(), Some("example.co.uk"), "{page}");
        }
        assert_eq!(site_key("example.co.uk"), site_key(&site_of("https://a.b.example.co.uk/").unwrap()));
    }

    #[test]
    fn an_address_or_a_bare_suffix_is_no_site() {
        for not in ["127.0.0.1", "http://[::1]/", "co.uk", "localhost", ""] {
            assert_eq!(site_of(not), None, "{not}");
        }
    }
}
