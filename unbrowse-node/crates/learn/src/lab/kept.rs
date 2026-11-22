//! Kept walks, read as cases: a page, what it was asked, the walk's capture, and the call a learner kept from it.
//!
//! A corpus is a folder of cases outside the repository (a capture holds the session that walked), laid out as the
//! node's own corpus reader lays it out: `<corpus>/<case>/case.json` with the page and what it was asked,
//! `learn_<walk>.jsonl` with the walk's capture, and `learned.json` naming the call that was kept. Two cases of one
//! site are two walks of one page for two values.

use std::collections::BTreeMap;
use std::path::Path;

use crate::trace::Trace;

/// One kept walk.
pub struct Case {
    pub site: String,
    pub url: String,
    pub value: String,
    /// The call the learner kept from this walk: its method, host and path.
    pub call: Option<String>,
    pub trace: Trace,
}

/// The case in `dir`. None when the folder is no case, or its capture holds no walk.
pub fn case(dir: &Path) -> Option<Case> {
    let json = |name: &str| std::fs::read_to_string(dir.join(name)).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let case = json("case.json")?;
    let said = |key: &str| case.get(key).and_then(|v| v.as_str()).map(String::from);
    let capture = std::fs::read_dir(dir).ok()?.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))?;
    let trace = crate::walk::trace_from_walk(dir, capture.file_stem()?.to_str()?)?;
    let call = json("learned.json").and_then(|l| l.get("call").and_then(|c| c.as_str()).filter(|c| !c.is_empty()).map(String::from));
    Some(Case { site: said("site")?, url: said("url")?, value: said("value").unwrap_or_default(), call, trace })
}

/// What a case's page was asked: its address's own pairs, and the case's value under a name of its own where the
/// address holds it somewhere else (in its path).
pub fn asked(case: &Case) -> Vec<(String, String)> {
    let mut out = url::Url::parse(&case.url).map(|u| crate::trace::asked_pairs(&u)).unwrap_or_default();
    if !case.value.is_empty() && !out.iter().any(|(_, v)| v.eq_ignore_ascii_case(&case.value)) {
        out.push(("word".into(), case.value.clone()));
    }
    out
}


/// Every case of a corpus, by site, in the order of their folders' names.
pub fn by_site(corpus: &Path) -> BTreeMap<String, Vec<Case>> {
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(corpus).map(|d| d.flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect()).unwrap_or_default();
    dirs.sort();
    let mut sites: BTreeMap<String, Vec<Case>> = BTreeMap::new();
    for dir in &dirs {
        if let Some(case) = case(dir) {
            sites.entry(case.site.clone()).or_default().push(case);
        }
    }
    sites
}

/// Where a case's walk made the call that was kept from it.
pub fn kept_call(case: &Case) -> Option<usize> {
    let call = case.call.as_ref()?;
    case.trace.exchanges.iter().position(|e| (200..300).contains(&e.status) && format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), e.url.path()) == *call)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A corpus folder of its own for one test, gone when it drops.
    struct Corpus(std::path::PathBuf);
    impl Corpus {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("kept-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        /// A case folder: its `case.json`, a capture of the page and the one call it made (answered `status`) where `walk`
        /// is Some, and the `learned.json` where `learned` is Some.
        fn case(&self, folder: &str, said: serde_json::Value, walk: Option<(&str, u16)>, learned: Option<serde_json::Value>) -> &Self {
            let dir = self.0.join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("case.json"), said.to_string()).unwrap();
            if let Some((call, status)) = walk {
                let page = said["url"].as_str().unwrap_or("https://shop.example/").to_string();
                let lines = [
                    serde_json::json!({"type": "request", "t": 1.0, "requestId": "1", "method": "GET", "url": page, "headers": {}, "resourceType": "Document", "frameId": "MAIN"}),
                    serde_json::json!({"type": "response", "t": 1.5, "requestId": "1", "url": page, "status": 200, "mimeType": "text/html", "headers": {}, "body": "<html></html>"}),
                    serde_json::json!({"type": "request", "t": 2.0, "requestId": "2", "method": "GET", "url": call, "headers": {}, "resourceType": "Fetch", "frameId": "MAIN"}),
                    serde_json::json!({"type": "response", "t": 2.5, "requestId": "2", "url": call, "status": status, "mimeType": "application/json", "headers": {}, "body": "{\"items\":[]}"}),
                ];
                let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
                std::fs::write(agent_browser_core::session::capture_path(&dir, "learn_w"), text).unwrap();
            }
            if let Some(learned) = learned {
                std::fs::write(dir.join("learned.json"), learned.to_string()).unwrap();
            }
            self
        }
    }
    impl Drop for Corpus {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A kept walk reads as a case: the site and the page it was asked, the value, the walk's own calls, and the call the
    /// learner kept from it (named by method, host and path, without its query). A learned file naming no call, or a
    /// folder with no capture, no site or no case file, is a case that keeps nothing, or none.
    #[test]
    fn a_kept_walk_reads_as_a_case_with_the_call_the_learner_kept() {
        let corpus = Corpus::new("case");
        corpus
            .case("a", serde_json::json!({"site": "shop.example", "url": "https://shop.example/search?q=lamp", "value": "lamp"}), Some(("https://shop.example/api/search?q=lamp", 200)), Some(serde_json::json!({"call": "GET shop.example/api/search"})))
            .case("b", serde_json::json!({"site": "shop.example", "url": "https://shop.example/search?q=sofa"}), Some(("https://shop.example/api/search?q=sofa", 200)), Some(serde_json::json!({"call": ""})))
            .case("no-capture", serde_json::json!({"site": "shop.example", "url": "https://shop.example/"}), None, None)
            .case("no-site", serde_json::json!({"url": "https://shop.example/search?q=lamp"}), Some(("https://shop.example/api/search?q=lamp", 200)), None);
        let kept = case(&corpus.0.join("a")).expect("a case");
        assert_eq!((kept.site.as_str(), kept.url.as_str(), kept.value.as_str()), ("shop.example", "https://shop.example/search?q=lamp", "lamp"));
        assert_eq!(kept.call.as_deref(), Some("GET shop.example/api/search"));
        assert!(kept.trace.exchanges.iter().any(|e| e.url.path() == "/api/search"), "the walk's own calls are the case's trace");
        let unlearned = case(&corpus.0.join("b")).expect("a case that kept no call");
        assert_eq!((unlearned.value.as_str(), unlearned.call), ("", None), "no value said, and an empty call is none");
        assert!(case(&corpus.0.join("no-capture")).is_none(), "no capture, no walk");
        assert!(case(&corpus.0.join("no-site")).is_none(), "a case names its site");
        assert!(case(&corpus.0.join("missing")).is_none(), "no folder, no case");
    }

    /// What a case's page was asked is its address's own pairs, with the case's value added under a name of its own only
    /// where the address holds it nowhere (in its path, or not at all); a value the address already asks, in any case,
    /// is not asked twice.
    #[test]
    fn what_a_page_was_asked_is_its_pairs_and_the_value_where_the_address_holds_it_elsewhere() {
        let corpus = Corpus::new("asked");
        corpus
            .case("a", serde_json::json!({"site": "shop.example", "url": "https://shop.example/search?q=Lamp&sort=new", "value": "lamp"}), Some(("https://shop.example/api/search?q=lamp", 200)), None)
            .case("b", serde_json::json!({"site": "shop.example", "url": "https://shop.example/p/sofa/", "value": "sofa"}), Some(("https://shop.example/api/p/sofa", 200)), None);
        let in_query = asked(&case(&corpus.0.join("a")).unwrap());
        assert!(in_query.contains(&("q".to_string(), "Lamp".to_string())) && in_query.contains(&("sort".to_string(), "new".to_string())), "{in_query:?}");
        assert!(in_query.iter().all(|(name, _)| name != "word"), "the address asks the value already: {in_query:?}");
        let in_path = asked(&case(&corpus.0.join("b")).unwrap());
        assert!(in_path.contains(&("word".to_string(), "sofa".to_string())), "the value the path holds is asked as `word`: {in_path:?}");
    }

    /// A corpus reads site by site, each site's cases in the order of their folders' names; a folder with no case file,
    /// and one that is no case, are passed over, and a folder with no corpus is no site.
    #[test]
    fn a_corpus_reads_site_by_site_in_the_order_of_its_folders() {
        let corpus = Corpus::new("sites");
        let said = |site: &str, q: &str| serde_json::json!({"site": site, "url": format!("https://{site}/search?q={q}"), "value": q});
        corpus
            .case("2-sofa", said("shop.example", "sofa"), Some(("https://shop.example/api/search?q=sofa", 200)), None)
            .case("1-lamp", said("shop.example", "lamp"), Some(("https://shop.example/api/search?q=lamp", 200)), None)
            .case("3-bonds", said("funds.example", "bonds"), Some(("https://funds.example/api/search?q=bonds", 200)), None)
            .case("4-broken", said("funds.example", "gilts"), None, None);
        std::fs::create_dir_all(corpus.0.join("notes")).unwrap();
        std::fs::write(corpus.0.join("README.txt"), "not a case").unwrap();
        let sites = by_site(&corpus.0);
        assert_eq!(sites.keys().map(String::as_str).collect::<Vec<_>>(), ["funds.example", "shop.example"]);
        assert_eq!(sites["shop.example"].iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["lamp", "sofa"]);
        assert_eq!(sites["funds.example"].iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["bonds"], "a case with no capture is passed over");
        assert!(by_site(&corpus.0.join("nowhere")).is_empty());
    }

    /// The call a learner kept is found in the case's own walk by method, host and path, and only where that call
    /// answered 2xx: a kept call that failed in the walk, or one the walk never made, is no place in it.
    #[test]
    fn the_call_that_was_kept_is_found_in_the_walk_where_it_answered() {
        let corpus = Corpus::new("kept");
        let said = serde_json::json!({"site": "shop.example", "url": "https://shop.example/search?q=lamp", "value": "lamp"});
        let learned = |call: &str| Some(serde_json::json!({"call": call}));
        corpus
            .case("ok", said.clone(), Some(("https://shop.example/api/search?q=lamp", 200)), learned("GET shop.example/api/search"))
            .case("failed", said.clone(), Some(("https://shop.example/api/search?q=lamp", 500)), learned("GET shop.example/api/search"))
            .case("other", said.clone(), Some(("https://shop.example/api/search?q=lamp", 200)), learned("POST shop.example/api/search"))
            .case("none", said, Some(("https://shop.example/api/search?q=lamp", 200)), None);
        let at = kept_call(&case(&corpus.0.join("ok")).unwrap()).expect("the kept call is in the walk");
        assert_eq!(case(&corpus.0.join("ok")).unwrap().trace.exchanges[at].url.path(), "/api/search");
        assert_eq!(kept_call(&case(&corpus.0.join("failed")).unwrap()), None, "it answered 500 in the walk");
        assert_eq!(kept_call(&case(&corpus.0.join("other")).unwrap()), None, "the walk made no POST");
        assert_eq!(kept_call(&case(&corpus.0.join("none")).unwrap()), None, "no call was kept");
    }
}
