//! The website an Android app's logins belong to. A password manager keeps a login saved in an app under the app
//! (`android://<signing cert hash>@<package>/`, or Bitwarden's `androidapp://<package>`), not under a site, and the
//! node fills a login only into its own site. A website says which apps share its logins in its Digital Asset Links
//! file (`/.well-known/assetlinks.json`, the `get_login_creds` relation): a site that names the app, and the app's
//! signing certificate where the export kept it, is the app's site. The sites asked are the ones the app's store
//! listing links to, where its developer's website is named. A site that doesn't name the app is never taken, so a
//! stray link costs a fetch, not a password.
//!
//! What is fetched is public: the store listing and each site's links file. No login, password or account name is
//! in any request, and each app is asked about once per import however many of its logins the export holds.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;
use unbrowse_learn::identity::site_of;

use crate::vault::App;

/// Where an Android app is listed by its package. The listing links to its developer's website.
const LISTING: &str = "https://play.google.com/store/apps/details";
const LOGIN_CREDS: &str = "delegate_permission/common.get_login_creds";

/// A page's body, for a GET that answered 2xx; None for anything else.
type Get = Box<dyn Fn(&str) -> Option<String>>;

/// Finds apps' sites for one import, asking about each app once.
pub struct AppSites {
    get: Get,
    known: HashMap<App, Option<String>>,
}

impl AppSites {
    /// Asks the web.
    pub fn new() -> Self {
        // No redirects: a links file another host answers with is that host's word, not the site's.
        let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).build().ok();
        Self::with(Box::new(move |url| {
            let r = http.as_ref()?.get(url).send().ok()?;
            r.status().is_success().then(|| r.text().ok()).flatten()
        }))
    }

    fn with(get: Get) -> Self {
        Self { get, known: HashMap::new() }
    }

    /// The one site the app's listing links to that names the app as sharing its logins. None where no site does, or
    /// several do and the export can't say which.
    pub fn site(&mut self, app: &App) -> Option<String> {
        if let Some(site) = self.known.get(app) {
            return site.clone();
        }
        let found = self.look(app);
        self.known.insert(app.clone(), found.clone());
        found
    }

    fn look(&self, app: &App) -> Option<String> {
        let listing = url::Url::parse_with_params(LISTING, [("id", app.package.as_str()), ("hl", "en")]).ok()?;
        let html = (self.get)(listing.as_str())?;
        let claimed: Vec<String> = linked_sites(&html).into_iter().filter(|site| self.names(site, app)).collect();
        match claimed.as_slice() {
            [one] => Some(one.clone()),
            _ => None,
        }
    }

    /// Whether `site`'s Digital Asset Links file, at the site or its `www.` host, says `app` shares its logins.
    fn names(&self, site: &str, app: &App) -> bool {
        [site.to_string(), format!("www.{site}")].iter().any(|host| {
            (self.get)(&format!("https://{host}/.well-known/assetlinks.json"))
                .and_then(|body| serde_json::from_str::<Value>(&body).ok())
                .is_some_and(|v| shares_logins(&v, app))
        })
    }
}

/// The sites a store listing links to over https, in the order it first links them, without the listing's own site.
fn linked_sites(html: &str) -> Vec<String> {
    let own = url::Url::parse(LISTING).ok().and_then(|u| u.host_str().map(site_of)).unwrap_or_default();
    let mut out = Vec::new();
    for part in html.split("href=\"").skip(1) {
        let link = part.split('"').next().unwrap_or_default();
        let Some(host) = url::Url::parse(link).ok().filter(|u| u.scheme() == "https").and_then(|u| u.host_str().map(str::to_string)) else { continue };
        let site = site_of(&host);
        if !site.is_empty() && site != own && !out.contains(&site) {
            out.push(site);
        }
    }
    out
}

/// Whether Digital Asset Links `statements` say `app` shares the site's logins: the login relation, for the app's
/// package and, where the export kept the app's signing certificate, that certificate. Opening the site's links
/// (`handle_all_urls`) alone isn't sharing its logins.
fn shares_logins(statements: &Value, app: &App) -> bool {
    statements.as_array().into_iter().flatten().any(|s| {
        let t = &s["target"];
        let certs = || t["sha256_cert_fingerprints"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).filter_map(fingerprint);
        s["relation"].as_array().into_iter().flatten().any(|r| r == LOGIN_CREDS)
            && t["namespace"] == "android_app"
            && t["package_name"] == app.package.as_str()
            && app.cert.as_ref().is_none_or(|c| certs().any(|f| &f == c))
    })
}

/// A certificate fingerprint as Digital Asset Links writes it, colon-separated hex, as its 32 bytes.
fn fingerprint(hex: &str) -> Option<Vec<u8>> {
    hex::decode(hex.replace(':', "")).ok().filter(|b| b.len() == 32)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;

    const CERT: &str = "1F:4D:D5:4C:31:C5:6E:32:BE:03:4B:F1:21:1F:AA:51:C4:9F:70:61:A8:EA:CE:04:42:99:75:BF:C0:A5:37:8B";

    fn app(package: &str, cert: Option<&str>) -> App {
        App { package: package.into(), cert: cert.map(|c| fingerprint(c).unwrap()) }
    }

    fn statements(relation: &str, package: &str, cert: &str) -> Value {
        serde_json::json!([{ "relation": [relation], "target": { "namespace": "android_app", "package_name": package, "sha256_cert_fingerprints": [cert] } }])
    }

    /// A site shares its logins with an app only by the login relation, for that package and its signing certificate.
    #[test]
    fn only_the_login_relation_for_the_same_app_and_certificate_counts() {
        let other = CERT.replace("1F:4D", "00:00");
        let ride = |cert| app("com.ride.passenger", cert);
        assert!(shares_logins(&statements(LOGIN_CREDS, "com.ride.passenger", CERT), &ride(Some(CERT))));
        assert!(shares_logins(&statements(LOGIN_CREDS, "com.ride.passenger", CERT), &ride(None)), "an export that kept no certificate");
        assert!(!shares_logins(&statements(LOGIN_CREDS, "com.ride.passenger", &other), &ride(Some(CERT))), "another signer's app");
        assert!(!shares_logins(&statements(LOGIN_CREDS, "com.ride.passenger.beta", CERT), &ride(Some(CERT))), "another package");
        assert!(!shares_logins(&statements("delegate_permission/common.handle_all_urls", "com.ride.passenger", CERT), &ride(Some(CERT))), "links only");
        assert!(!shares_logins(&serde_json::json!({ "not": "a list" }), &ride(None)));
    }

    /// The sites asked are the ones the listing links to over https, each once, never the listing's own.
    #[test]
    fn a_listing_names_the_sites_it_links_to_but_not_its_own() {
        let html = r#"<a href="https://play.google.com/store">x</a><a href="https://support.google.com/a">y</a>
            <a href="https://www.ride.example/">site</a><a href="https://ride.example/privacy">p</a>
            <a href="http://plain.example">old</a><a href="https://cdn.example/x.js">z</a>"#;
        assert_eq!(linked_sites(html), ["ride.example", "cdn.example"]);
    }

    /// The whole lookup against a made-up web: the listing's one site that names the app for its logins is the app's
    /// site, asked once however many logins ask; links only, two claimants, or no listing at all give no site.
    #[test]
    fn an_app_resolves_to_the_one_linked_site_that_names_it_for_logins() {
        let login = statements(LOGIN_CREDS, "com.ride.passenger", CERT).to_string();
        let mut web: HashMap<String, String> = HashMap::new();
        let listing = |package: &str, links: &[&str]| {
            let url = url::Url::parse_with_params(LISTING, [("id", package), ("hl", "en")]).unwrap().to_string();
            (url, links.iter().map(|l| format!(r#"<a href="{l}">x</a>"#)).collect::<String>())
        };
        web.extend([
            listing("com.ride.passenger", &["https://cdn.example/a.js", "https://www.ride.example/"]),
            ("https://www.ride.example/.well-known/assetlinks.json".into(), login.clone()),
            ("https://cdn.example/.well-known/assetlinks.json".into(), "not json".into()),
            listing("com.links.only", &["https://links.example/"]),
            ("https://links.example/.well-known/assetlinks.json".into(), statements("delegate_permission/common.handle_all_urls", "com.links.only", CERT).to_string()),
            listing("com.twice.claimed", &["https://one.example/", "https://two.example/"]),
            ("https://one.example/.well-known/assetlinks.json".into(), statements(LOGIN_CREDS, "com.twice.claimed", CERT).to_string()),
            ("https://two.example/.well-known/assetlinks.json".into(), statements(LOGIN_CREDS, "com.twice.claimed", CERT).to_string()),
        ]);
        let asked = Rc::new(RefCell::new(Vec::<String>::new()));
        let log = asked.clone();
        let mut sites = AppSites::with(Box::new(move |url| {
            log.borrow_mut().push(url.to_string());
            web.get(url).cloned()
        }));

        assert_eq!(sites.site(&app("com.ride.passenger", Some(CERT))).as_deref(), Some("ride.example"));
        let fetched = asked.borrow().len();
        assert_eq!(sites.site(&app("com.ride.passenger", Some(CERT))).as_deref(), Some("ride.example"));
        assert_eq!(asked.borrow().len(), fetched, "an app is asked about once");
        assert_eq!(sites.site(&app("com.ride.passenger", Some(&CERT.replace("1F:4D", "00:00")))), None, "another signer's app");
        assert_eq!(sites.site(&app("com.links.only", None)), None, "a site that names the app for links only");
        assert_eq!(sites.site(&app("com.twice.claimed", None)), None, "two sites claim it: the export can't say which");
        assert_eq!(sites.site(&app("com.not.listed", None)), None, "no listing");
    }

    /// Against the live web: an app whose site names it for its logins resolves to that site, from the store listing
    /// alone; an app whose site names it only for links doesn't. `cargo test -- --ignored live_`
    #[test]
    #[ignore]
    fn live_apps_resolve_to_the_site_that_claims_them() {
        let mut sites = AppSites::new();
        assert_eq!(sites.site(&app("com.grabtaxi.passenger", Some(CERT))).as_deref(), Some("grab.com"));
        assert_eq!(sites.site(&app("com.spotify.music", None)).as_deref(), Some("spotify.com"));
        assert_eq!(sites.site(&app("com.github.android", None)), None, "github.com names its app for links, not logins");
        assert_eq!(sites.site(&app("com.grabtaxi.passenger", Some(&CERT.replace("1F:4D", "00:00")))), None, "another signer's app");
    }
}
