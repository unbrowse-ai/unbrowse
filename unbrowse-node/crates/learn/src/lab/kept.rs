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
