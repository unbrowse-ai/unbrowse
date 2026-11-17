//! What a site says of how many asks it has left. A site that counts its asks says so in its answers (a header that
//! names how many remain), and a learn that goes on asking optional questions spends the caller's share: the route
//! is learned, and its first real call is told to come back later. The count is read from any answer, kept by the
//! host that gave it, and asked of before a question the route can do without.

use crate::trace::Exchange;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a count is believed: a site's window moves on, and an old count must not hold questions back for good.
const BELIEVED: Duration = Duration::from_secs(600);

/// A window this short is how fast a site may be asked, not how much it may be asked.
const A_PACE: Duration = Duration::from_secs(10);

static LEFT: Mutex<Option<HashMap<String, (u64, Instant)>>> = Mutex::new(None);

/// The count an answer gives, if it gives one: a header whose name ends `ratelimit-remaining`, a whole number first.
pub fn said(ex: &Exchange) -> Option<u64> {
    ex.response_headers.iter().find(|(k, _)| k.to_ascii_lowercase().ends_with("ratelimit-remaining")).and_then(|(_, v)| {
        let digits: String = v.trim().chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    })
}

/// Notes what `ex` says its host has left. Within the time a count is believed the lower one stands: answers are
/// read out of order (a walk's, then the calls made after it, then the walk's again), and a count only falls.
pub fn note(ex: &Exchange) {
    let (Some(left), Some(place)) = (said(ex), place_of(ex.url.as_str())) else { return };
    // A count is believed until the site says it starts again: four asks a second with three left is no shortage.
    let now = Instant::now();
    // A count that starts again within moments is a pace, not a budget: four asks a second with two left leaves
    // nothing to ration, and the questions a learn asks are seconds apart anyway. Only a count with a long window,
    // or none stated, is kept.
    if resets_in(ex).is_some_and(|wait| wait <= A_PACE) {
        let mut guard = LEFT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = guard.as_mut() {
            map.remove(&place);
        }
        return;
    }
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        let said: Vec<String> = ex.response_headers.iter().filter(|(k, _)| k.to_ascii_lowercase().contains("ratelimit")).map(|(k, v)| format!("{k}: {v}")).collect();
        eprintln!("   [budget] {place} says {said:?}: {left} left, believed for {:?}", resets_in(ex).unwrap_or(BELIEVED).min(BELIEVED));
    }
    note_until(&place, left, now, now + resets_in(ex).unwrap_or(BELIEVED).min(BELIEVED));
}

/// How long until the count an answer gives starts again, where it says: a header whose name ends `ratelimit-reset`,
/// in seconds (a larger number is a clock time and is not read), or the window its limit names (`4;w=1`).
pub fn resets_in(ex: &Exchange) -> Option<Duration> {
    let header = |ending: &str| ex.response_headers.iter().find(|(k, _)| k.to_ascii_lowercase().ends_with(ending)).map(|(_, v)| v.trim().to_string());
    let seconds = |text: &str| text.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u64>().ok();
    let reset = header("ratelimit-reset").and_then(|v| seconds(&v)).filter(|n| *n < 100_000);
    let window = header("ratelimit-limit").and_then(|v| v.split("w=").nth(1).and_then(seconds));
    reset.or(window).map(Duration::from_secs)
}

/// Where a count is kept: the host and path of the call that was answered with it, and nothing of its query. A site
/// counts each of its calls by itself, and one call's few asks left say nothing of the call beside it on that host.
pub fn place_of(address: &str) -> Option<String> {
    let url = url::Url::parse(address.split(['?', '#']).next().unwrap_or(address)).ok()?;
    Some(format!("{}{}", url.host_str()?, url.path().trim_end_matches('/')))
}

#[cfg(test)]
fn note_for(host: &str, left: u64, now: Instant) {
    note_until(host, left, now, now + BELIEVED);
}

/// Keeps `left` for `host`, believed until `until`. Within the time an earlier count is believed the lower one stands.
fn note_until(host: &str, left: u64, now: Instant, until: Instant) {
    let mut guard = LEFT.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let lower = map.get(host).filter(|(_, believed_until)| now < *believed_until).map_or(left, |(was, _)| left.min(*was));
    map.insert(host.to_string(), (lower, until));
}

/// What the call at `host` (a place, as `place_of` writes it) was last told it has left, while that is still believed.
pub fn left(host: &str) -> Option<u64> {
    left_at(host, Instant::now())
}

fn left_at(host: &str, now: Instant) -> Option<u64> {
    let guard = LEFT.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref()?.get(host).filter(|(_, believed_until)| now < *believed_until).map(|(n, _)| *n)
}

/// Whether the call at `host` (a place, as `place_of` writes it) can spare `asks` more and still have `keep` left for
/// the caller. One that has been told nothing can.
pub fn spares(host: &str, asks: u64, keep: u64) -> bool {
    left(host).is_none_or(|n| n >= asks + keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(host: &str, headers: &[(&str, &str)]) -> Exchange {
        Exchange {
            method: "POST".into(),
            url: format!("https://{host}/v1").parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        }
    }

    /// The walk that exposed it: a video search that allows twenty asks and says how many are left in each answer.
    /// The learn spent twelve on its own questions and the second look spent the rest, so the caller's first real
    /// search was told to try again later. A site that says how few it has left is spared the optional questions.
    #[test]
    fn a_site_that_says_how_few_asks_it_has_left_is_spared_the_optional_ones() {
        assert_eq!(said(&answer("a.example", &[("X-RateLimit-Remaining", "16")])), Some(16));
        assert_eq!(said(&answer("a.example", &[("ratelimit-remaining", "4, 4;w=60")])), Some(4));
        assert_eq!(said(&answer("a.example", &[("content-type", "application/json")])), None);
        assert!(spares("never-said.example", 8, 8), "a host that says nothing is asked as before");
        let start = Instant::now();
        note_for("counts.example", 16, start);
        assert!(spares("counts.example", 2, 8) && !spares("counts.example", 9, 8));
        // Read out of order, the lower count stands.
        note_for("counts.example", 9, start);
        note_for("counts.example", 16, start);
        assert_eq!(left("counts.example"), Some(9));
        assert!(!spares("counts.example", 2, 8));
        // A count is the call's own: another call on the same host is told nothing by it.
        let mut limited = answer("api.example", &[("x-ratelimit-remaining", "1")]);
        limited.url = "https://api.example/v1/presence?user=1".parse().unwrap();
        note(&limited);
        assert_eq!(left(&place_of("https://api.example/v1/presence?user=2").unwrap()), Some(1));
        assert!(spares(&place_of("https://api.example/v1/search?q=lamp").unwrap(), 8, 8));
        // A count that starts again in a second is believed for a second.
        let brisk = answer("api.example", &[("x-ratelimit-limit", "4, 4;w=1"), ("x-ratelimit-remaining", "3"), ("x-ratelimit-reset", "1")]);
        assert_eq!(resets_in(&brisk), Some(Duration::from_secs(1)));
        assert_eq!(resets_in(&answer("api.example", &[("x-ratelimit-remaining", "3")])), None);
        assert_eq!(resets_in(&answer("api.example", &[("x-ratelimit-reset", "1794561167")])), None, "a clock time is not a wait");
        let mut brisk_call = brisk.clone();
        brisk_call.url = "https://api.example/v1/brisk".parse().unwrap();
        note(&brisk_call);
        let place = place_of("https://api.example/v1/brisk").unwrap();
        assert_eq!(left(&place), None, "a pace is not a budget");
        assert!(spares(&place, 8, 8));
        // A window of a minute is believed for what is left of it.
        let mut slow = answer("api.example", &[("x-ratelimit-remaining", "5"), ("x-ratelimit-reset", "40")]);
        slow.url = "https://api.example/v1/slow".parse().unwrap();
        note(&slow);
        let place = place_of("https://api.example/v1/slow").unwrap();
        assert_eq!(left(&place), Some(5));
        assert_eq!(left_at(&place, Instant::now() + Duration::from_secs(41)), None, "past its reset it says nothing");
        // An old count is not believed.
        assert_eq!(left_at("counts.example", start + BELIEVED + Duration::from_secs(1)), None);
    }
}
