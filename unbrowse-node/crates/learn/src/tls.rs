//! Whose word the node takes that a server is who it says it is.
//!
//! A root list compiled into the binary is a snapshot: when a CA is caught out, the browsers block it within hours
//! and the operating system soon after, but a binary keeps trusting it until it is rebuilt. That is how the eMudhra
//! intermediates (October 2026, keys recoverable from the certificates) stayed trusted by clients that carried their
//! own roots, while every browser had already refused them. So the node's HTTPS clients ask the operating system,
//! which carries the vendor's revocations and blocks as they ship: a CA the OS has stopped trusting, the node has
//! stopped trusting the same day.
//!
//! The Chrome-shaped transport (`http::ChromeFetch`) speaks BoringSSL, which takes a root list and no verifier, so it
//! keeps the bundled Mozilla list; that list is kept current in the lockfile.

use std::sync::Arc;

/// A TLS client configuration that verifies servers with the operating system's verifier.
pub fn os_verified() -> rustls::ClientConfig {
    use rustls_platform_verifier::BuilderVerifierExt;
    // The provider is named, not taken from the process default: the dependency tree carries more than one, and a
    // process default nobody installed would panic here.
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .and_then(|b| b.with_platform_verifier())
        .expect("the ring provider supports the default protocol versions, and the OS verifier loads")
        .with_no_client_auth()
}

/// A blocking client builder whose TLS is checked by the operating system, and whose public names never lead inside
/// the owner's network (`egress`). The client connects to the addresses its own resolver checked, so it never hands a
/// name to a proxy from the environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`) to resolve where no check runs.
pub fn blocking() -> reqwest::blocking::ClientBuilder {
    blocking_for(crate::egress::Egress::Own)
}

/// The same, for a call under `egress`: its resolver and its redirects held to that rule.
pub fn blocking_for(egress: crate::egress::Egress) -> reqwest::blocking::ClientBuilder {
    reqwest::blocking::Client::builder()
        .use_preconfigured_tls(os_verified())
        .no_proxy()
        .dns_resolver(Arc::new(crate::egress::Resolver(egress)))
        .redirect(crate::egress::reqwest_redirects_for(egress))
}

/// The same, async.
pub fn client() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .use_preconfigured_tls(os_verified())
        .no_proxy()
        .dns_resolver(Arc::new(crate::egress::Resolver::default()))
        .redirect(crate::egress::reqwest_redirects())
}

#[cfg(test)]
mod tests {
    /// The public key (SubjectPublicKeyInfo, DER) of the root the compromised eMudhra intermediates chain to. A
    /// fixture, by key and not by name: a root list the node carries must not hold this key under any certificate.
    const DISTRUSTED_KEY: &[u8] = include_bytes!("../tests/fixtures/emsign-ecc-root-ca-g3.spki.der");

    /// The SubjectPublicKeyInfo's contents, without its outer SEQUENCE header: the form webpki-roots keeps.
    fn contents(der: &[u8]) -> &[u8] {
        let len = der[1];
        &der[2 + if len & 0x80 != 0 { (len & 0x7f) as usize } else { 0 }..]
    }

    #[test]
    fn no_bundled_root_holds_a_distrusted_key() {
        let key = contents(DISTRUSTED_KEY);
        // The anchors rustls clients fall back on.
        assert!(
            webpki_roots::TLS_SERVER_ROOTS.iter().all(|a| a.subject_public_key_info.as_ref() != key),
            "webpki-roots still trusts the compromised root"
        );
        // The certificates the Chrome-shaped transport hands BoringSSL: a certificate holds its key's DER whole.
        assert!(
            webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().all(|c| !c.as_ref().windows(DISTRUSTED_KEY.len()).any(|w| w == DISTRUSTED_KEY)),
            "webpki-root-certs still trusts the compromised root"
        );
    }

    /// The test above fails on the lists from before the fix: it finds the key in the form each list keeps it.
    #[test]
    fn the_key_is_found_where_a_list_holds_it() {
        let cert = include_bytes!("../tests/fixtures/emsign-ecc-root-ca-g3.der");
        assert!(cert.windows(DISTRUSTED_KEY.len()).any(|w| w == DISTRUSTED_KEY));
        assert!(DISTRUSTED_KEY.ends_with(contents(DISTRUSTED_KEY)) && contents(DISTRUSTED_KEY).len() + 2 == DISTRUSTED_KEY.len());
    }

    /// With a proxy named in the environment, the node's clients still connect where their own resolver checked: the
    /// request reaches the site, and the proxy, which would have resolved the name unchecked, is never asked.
    #[test]
    fn a_proxy_in_the_environment_is_never_used() {
        use std::io::{Read, Write};
        let answer = |l: std::net::TcpListener, tx: std::sync::mpsc::Sender<&'static str>, who: &'static str| {
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let _ = s.read(&mut [0u8; 1024]);
                    let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
                    let _ = tx.send(who);
                }
            });
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (proxy_at, site_at) = (proxy.local_addr().unwrap(), site.local_addr().unwrap());
        answer(proxy, tx.clone(), "proxy");
        answer(site, tx, "site");
        std::env::set_var("HTTP_PROXY", format!("http://{proxy_at}"));
        std::env::set_var("ALL_PROXY", format!("http://{proxy_at}"));
        let client = super::blocking().resolve("shop.example.com", site_at).build();
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("ALL_PROXY");
        let sent = client.unwrap().get(format!("http://shop.example.com:{}/", site_at.port())).send();
        assert!(sent.is_ok(), "{sent:?}");
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)), Ok("site"));
    }

    #[test]
    fn the_os_verifier_builds() {
        let _ = super::os_verified();
        super::blocking().build().expect("a client");
    }

    /// Live, not fixture: the incident's own site publishes four hosts whose chains run through
    /// the compromised intermediates. Both transports the node uses must refuse every one of them
    /// — the Chrome-shaped one on its bundled list, and the one that asks the OS — while a chain
    /// from an ordinary certificate still works. The offline test above checks the lists hold no
    /// such root; this one checks a served chain that actually reaches one is rejected.
    ///
    /// Sync, not async: `ChromeFetch` owns a runtime of its own, and starting one from inside
    /// another is exactly what the runtime refuses.
    #[test]
    #[ignore = "needs the internet"]
    fn a_chain_from_the_compromised_intermediates_is_refused() {
        use crate::http::ChromeFetch;
        use crate::replay::{Fetch, Request};

        const HOSTS: [&str; 4] = [
            "dv-g3b-emudhra.we-have-a-problem.com",
            "dv-g3b-aaa-emudhra.we-have-a-problem.com",
            "dv-g3b-noct-emudhra.we-have-a-problem.com",
            "dv-g3b-aaa-noct-emudhra.we-have-a-problem.com",
        ];

        let os = super::blocking().build().expect("an os-verified client");
        for host in HOSTS {
            let url = url::Url::parse(&format!("https://{host}/")).expect("a url");

            let mut chrome = ChromeFetch::new().expect("the chrome-shaped transport");
            let refused_by_bundled_list = chrome
                .fetch(&Request {
                    method: "GET".into(),
                    url: url.clone(),
                    headers: vec![],
                    body: None,
                    exchange: 0,
                })
                .is_err();
            assert!(
                refused_by_bundled_list,
                "the bundled-list transport accepted {host}"
            );

            let refused_by_os = os.get(url.as_str()).send().is_err();
            assert!(refused_by_os, "the os-verified client accepted {host}");
        }

        // The refusals above are about that chain, not about TLS in general.
        let ordinary = os
            .get("https://example.com/")
            .send()
            .expect("an ordinary certificate still works");
        assert!(ordinary.status().is_success(), "{}", ordinary.status());
    }
}
