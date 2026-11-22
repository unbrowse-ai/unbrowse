//! What this node can do against a wall that a call's own client can't: the sources it hands the client
//! (`RouteClient::with_clearer`), each tried where the wall's own list names it (`refusal::Wall::sources`).
//!
//! One source lives here so far: the owner's own browser session. The engine, the site's own page and the check's
//! script in the sandbox are the client's own; a solver's token still has to be handed to the check's page before it
//! is a pass (`solver`), so it is not a source yet.

use crate::{import, store};
use std::collections::HashMap;
use unbrowse_learn::client::Clearer;
use unbrowse_learn::refusal::{Cleared, Source};

/// The client the owner's own browser is, to a pass it earned: not this call's.
const OWNERS_BROWSER: &str = "the owner's browser";

/// The owner's own browser session for `host` as a source against a wall: the owner may be through the site's check in
/// their own browser on this machine, so the node takes that session in (`import::when_signed_out`, at most once per
/// site in a while, and only on the owner's yes asked in the node's window, naming `who`) and the call goes again with
/// it. The pass is the owner's browser's, and is kept as that.
pub fn owners_session(host: String, who: String, node: Option<std::sync::Arc<crate::Node>>) -> Clearer {
    owners_session_from(host, move |h| import::when_signed_out(h, &who, |q| import::ask_in_the_nodes_window(node.as_deref(), q)))
}

fn owners_session_from(host: String, mut reach: impl FnMut(&str) -> Option<Result<import::Kept, String>> + Send + 'static) -> Clearer {
    Box::new(move |_wall| {
        let kept = match reach(&host)? {
            Ok(kept) => kept,
            Err(e) => {
                eprintln!("   [door] {host}: the owner's browser session wasn't taken in: {e}");
                return None;
            }
        };
        if kept.cookies == 0 {
            return None;
        }
        let jar: HashMap<String, String> = store::read_json(&store::jar_path(&host), &unbrowse_files::JAR);
        (!jar.is_empty()).then(|| Cleared { cookies: jar.into_iter().collect(), ttl: None, bound_to: Some(OWNERS_BROWSER.into()), by: Some(Source::OwnerSession) })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use unbrowse_learn::refusal::Wall;

    /// The owner's browser session is a source against a wall when the import kept something: what it kept is the
    /// pass, named as the owner's browser's. An import that was reached for too recently, one that failed and one that
    /// kept nothing are no pass.
    #[test]
    fn the_owners_browser_session_is_a_source_against_a_wall() {
        store::scratch_home("clearance-owners-session");
        let host = "shop.example";
        let jar = HashMap::from([("cleared".to_string(), "in-the-owners-browser".to_string())]);
        std::fs::create_dir_all(store::jar_path(host).parent().unwrap()).unwrap();
        std::fs::write(store::jar_path(host), unbrowse_files::JAR.to_vec_pretty(&jar).unwrap()).unwrap();
        let kept = |cookies| Some(Ok(import::Kept { host: host.into(), cookies, profiles: 0, profile_error: None }));

        let pass = owners_session_from(host.into(), move |_| kept(1))(&Wall::Person).expect("the import kept a session");
        assert_eq!(pass.cookies.get("cleared").map(String::as_str), Some("in-the-owners-browser"));
        assert_eq!((pass.bound_to.as_deref(), pass.by), (Some(OWNERS_BROWSER), Some(Source::OwnerSession)));

        assert!(owners_session_from(host.into(), |_| None)(&Wall::Person).is_none(), "reached for too recently");
        assert!(owners_session_from(host.into(), |_| Some(Err("no browser".into())))(&Wall::Person).is_none(), "the import failed");
        assert!(owners_session_from(host.into(), move |_| kept(0))(&Wall::Person).is_none(), "the import kept nothing");
    }
}
