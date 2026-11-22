//! Ids the page's own code makes up for one call, which tie the call's steps together.
//!
//! An upload is named by the client before any byte goes: the page reads the clock and sends the reading as the
//! upload's id, in the upload's address, in its headers and in the later call that publishes it. Such a value must be
//! new on every call (the site refuses an upload id it has already seen), and the same everywhere within one call.
//! It is read from the walk as a property of the value, never of a site: digits shaped like a clock reading taken
//! just before the request that first sends it (13 for milliseconds, which may sit inside a longer value such as
//! `fb_uploader_<id>`; 10 for seconds, only as a whole value), that no response carried before, sent to more than one
//! address. The reading must be within two minutes of that first request's date: a server's token that embeds the
//! time it was issued, and a page's own timestamp, are older than that by the time an upload starts, and stay what
//! the rest of the graph says they are.
//!
//! A reading only one address carries ties nothing together, and one walk cannot say what it is: a time the page
//! worked out from something the site handed it (when a token was issued) is as near to the request. Two sightings
//! can ([`read_anew`]): the call's own reading is another reading on a second walk, as near to that walk's request,
//! where the handed one is the same on both.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::slots::{slots, Loc};
use crate::trace::{Exchange, Trace};

/// Which clock reading an id is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Clock {
    /// Milliseconds since the Unix epoch, 13 digits.
    Millis,
    /// Seconds since the Unix epoch, 10 digits.
    Seconds,
    /// No clock at all: an id drawn at random, written as a UUID is (`080dbce1-3f6b-4a45-b181-2c6c26f285ca`).
    Random,
}

/// Whether a value is written as a random id is, however the page writes it: the canonical UUID (thirty-two hex digits
/// in groups of 8, 4, 4, 4 and 12); the W3C trace context a tracing header carries (`00-<32hex>-<16hex>-<2hex>`); or a
/// base64url correlation id long enough to mean something, with the entropy a random draw has — upper and lower case
/// letters and digits together, which a word or a lowercase hex hash is not. Two sightings that move with nothing
/// behind them are what settle it as a fresh draw (`graph::classify`); the shape alone never does.
pub fn a_random_id(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    let lengths: Vec<usize> = groups.iter().map(|g| g.len()).collect();
    let all_hex = || groups.iter().all(|g| g.chars().all(|c| c.is_ascii_hexdigit()));
    if lengths == [8, 4, 4, 4, 12] && all_hex() {
        return true;
    }
    if lengths == [2, 32, 16, 2] && all_hex() {
        return true;
    }
    value.chars().count() >= 20
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && value.chars().any(|c| c.is_ascii_uppercase())
        && value.chars().any(|c| c.is_ascii_lowercase())
        && value.chars().any(|c| c.is_ascii_digit())
}

const DAY_SECS: i64 = 86_400;

/// How far a made-up id's reading may be from the date of the request that first sends it: the clock is read when
/// the file is picked, and the server's clock and the page's may differ by a little.
const MADE_WITHIN_SECS: i64 = 120;

#[cfg(test)]
thread_local! {
    /// The time a test holds this thread's clock at, where it holds it: two calls a test holds to each other read the
    /// same clock, as one call's makers do.
    pub(crate) static HELD: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}

/// Milliseconds since the epoch, now.
pub fn now_millis() -> i64 {
    #[cfg(test)]
    if let Some(now) = HELD.with(|held| held.get()) {
        return now;
    }
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A new reading of `clock` for this call; `n` keeps two ids made in the same call apart.
pub fn make(clock: Clock, n: usize) -> String {
    match clock {
        Clock::Millis => (now_millis() + n as i64).to_string(),
        Clock::Seconds => (now_millis() / 1000 + n as i64).to_string(),
        Clock::Random => {
            // The standard library's own randomly keyed hasher is draw enough for an id nobody has to guess.
            use std::hash::{BuildHasher, Hasher};
            let draw = |salt: usize| {
                let mut h = std::collections::hash_map::RandomState::new().build_hasher();
                h.write_usize(salt);
                h.write_i64(now_millis());
                format!("{:016x}", h.finish())
            };
            let hex = format!("{}{}", draw(n), draw(n + 1));
            format!("{}-{}-4{}-a{}-{}", &hex[..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32])
        }
    }
}

/// An HTTP date (`Sat, 31 Oct 2026 02:42:19 GMT`) as seconds since the epoch.
pub(crate) fn http_date(v: &str) -> Option<i64> {
    let parts: Vec<&str> = v.split_whitespace().collect();
    let [_, day, month, year, time, ..] = parts.as_slice() else { return None };
    let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let m = months.iter().position(|x| month.eq_ignore_ascii_case(x))? as i64 + 1;
    let (d, y): (i64, i64) = (day.parse().ok()?, year.parse().ok()?);
    let hms: Vec<i64> = time.split(':').filter_map(|p| p.parse().ok()).collect();
    let [h, mi, s] = hms.as_slice() else { return None };
    // Days from the civil date, after Howard Hinnant's algorithm.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * DAY_SECS + h * 3600 + mi * 60 + s)
}

/// When exchange `i` happened, in seconds: its answer's date, else the nearest one before it, else after it, else now
/// for a walk whose answers carry no date.
fn sent_at(t: &Trace, i: usize) -> i64 {
    let date = |e: &Exchange| e.response_header("date").and_then(http_date);
    t.exchanges[..=i]
        .iter()
        .rev()
        .find_map(date)
        .or_else(|| t.exchanges[i..].iter().find_map(date))
        .unwrap_or_else(|| now_millis() / 1000)
}

/// Every run of 10 or 13 digits in `text`, standing alone as digits.
fn readings(text: &str) -> Vec<(String, Clock)> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        match i - start {
            13 => out.push((text[start..i].to_string(), Clock::Millis)),
            10 => out.push((text[start..i].to_string(), Clock::Seconds)),
            _ => {}
        }
    }
    out
}

fn near(reading: &str, clock: Clock, at: i64) -> bool {
    let Ok(v) = reading.parse::<i64>() else { return false };
    match clock {
        Clock::Millis => (v / 1000 - at).abs() <= MADE_WITHIN_SECS,
        Clock::Seconds => (v - at).abs() <= MADE_WITHIN_SECS,
        // A random id reads as no time at all.
        Clock::Random => false,
    }
}

/// The values a request sends that an id could sit in: everything but its cookies, which are the session's.
fn sent(ex: &Exchange) -> Vec<String> {
    slots(ex).into_iter().filter(|s| !matches!(s.loc, Loc::Cookie(_))).map(|s| s.value).collect()
}

fn answered(ex: &Exchange, id: &str) -> bool {
    ex.response_body.as_deref().is_some_and(|b| b.contains(id)) || ex.response_headers.iter().any(|(_, v)| v.contains(id))
}

/// The reading of the clock `value` holds that request `i` of `walk` may have made for itself: taken just before the
/// request, carried by no response before it, and not what the caller gave. Ten digits count only as a whole value.
/// One sighting says no more than "may": see [`read_anew`].
pub fn reading_of(walk: &Trace, i: usize, value: &str) -> Option<(String, Clock)> {
    readings(value).into_iter().find(|(id, clock)| {
        (*clock == Clock::Millis || value == id)
            && near(id, *clock, sent_at(walk, i))
            && !walk.exchanges[..i].iter().any(|e| answered(e, id))
            && !walk.inputs.iter().any(|inp| inp.value.contains(id.as_str()))
    })
}

/// The reading of the clock a call makes for itself, as two sightings of the call say it: request `i` of `first` sent
/// `value`, which holds a reading it may have made ([`reading_of`]); request `j` of `second`, the same call on another
/// walk, sent `again` at the same place, which is the same value with another reading of that clock where the first
/// stood, as near to its own request. A time the site handed over is the same on both walks, and is not this.
pub fn read_anew(first: &Trace, i: usize, value: &str, second: &Trace, j: usize, again: &str) -> Option<(String, Clock)> {
    let (id, clock) = reading_of(first, i, value)?;
    let moved = readings(again).into_iter().any(|(other, c)| c == clock && other != id && near(&other, c, sent_at(second, j)) && value.replacen(id.as_str(), &other, 1) == again);
    moved.then_some((id, clock))
}

/// The ids the walk's own code made up for the call, with the clock each reads. `b`, a second sighting, rules out a
/// reading it sends too: a value two walks share is the site's, not the call's. And it settles a reading only one
/// address carries: the call's own where `b` makes the same request and sends another reading there ([`read_anew`]).
pub(crate) fn ids(a: &Trace, b: Option<&Trace>) -> Vec<(String, Clock)> {
    let mut out: Vec<(String, Clock)> = Vec::new();
    let mut ruled_out: BTreeSet<String> = BTreeSet::new();
    for (i, ex) in a.exchanges.iter().enumerate() {
        for slot in slots(ex).into_iter().filter(|s| !matches!(s.loc, Loc::Cookie(_))) {
            let value = slot.value.clone();
            for (id, clock) in readings(&value) {
                if out.iter().any(|(o, _)| *o == id) || ruled_out.contains(&id) {
                    continue;
                }
                // Ten digits inside a longer value are too often a part of something else (a token's issue time).
                if clock == Clock::Seconds && value != id {
                    continue;
                }
                let made_here = near(&id, clock, sent_at(a, i))
                    && !a.exchanges[..i].iter().any(|e| answered(e, &id))
                    && !a.inputs.iter().any(|inp| inp.value.contains(&id))
                    && !b.is_some_and(|b| b.exchanges.iter().any(|e| sent(e).iter().any(|v| v.contains(&id))));
                // Steps, not requests: an upload's chunks and the probes among them go to one address.
                let places: BTreeSet<String> = a.exchanges[i..]
                    .iter()
                    .filter(|e| e.method != "OPTIONS" && sent(e).iter().any(|v| holds(v, &id)))
                    .map(|e| format!("{}{}", e.url.host_str().unwrap_or_default(), e.url.path()))
                    .collect();
                // One address carries it: the second walk's request to that address says whether it is read anew.
                let anew = || {
                    b.is_some_and(|b| {
                        b.exchanges.iter().enumerate().filter(|(_, eb)| eb.method == ex.method && eb.url.host_str() == ex.url.host_str() && eb.url.path() == ex.url.path()).any(|(j, eb)| {
                            slots(eb).iter().any(|s| s.loc == slot.loc && read_anew(a, i, &value, b, j, &s.value).is_some_and(|(found, _)| found == id))
                        })
                    })
                };
                if made_here && (places.len() >= 2 || anew()) {
                    out.push((id, clock));
                } else {
                    ruled_out.insert(id);
                }
            }
        }
    }
    out
}

/// Whether `value` holds `id` as a reading of its own: the same digits at the head of a longer run are another number,
/// and most often a server's token saying when it was issued, which a new id would break.
pub(crate) fn holds(value: &str, id: &str) -> bool {
    readings(value).iter().any(|(r, _)| r == id)
}

/// Whether a request sends `id` anywhere but its cookies.
pub(crate) fn carries(ex: &Exchange, id: &str) -> bool {
    sent(ex).iter().any(|v| holds(v, id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One request of a walk, answered at `date`.
    fn asked(url: &str, date: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("date".into(), date.into())],
            response_body: None,
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        }
    }

    #[test]
    fn a_reading_one_address_carries_is_the_calls_own_only_where_a_second_walk_reads_the_clock_anew() {
        // 1_793_383_794 is Fri, 30 Oct 2026 18:09:54 GMT. The first walk's call sends that second in milliseconds
        // beside the caller's word; nothing else carries it.
        let first = Trace { exchanges: vec![asked("https://shop.example/api/find?q=lamps&_=1793383794120&v=7", "Fri, 30 Oct 2026 18:09:54 GMT")], inputs: vec![crate::trace::Input::new("q", "lamps")] };
        // One walk cannot say what it is: a time the page worked out from what the site handed it is as near.
        assert!(ids(&first, None).is_empty(), "{:?}", ids(&first, None));
        // A second walk, four minutes on, sends its own reading there: the call reads the clock for itself.
        let later = Trace { exchanges: vec![asked("https://shop.example/api/find?q=chairs&_=1793384034733&v=7", "Fri, 30 Oct 2026 18:13:54 GMT")], inputs: vec![] };
        assert_eq!(ids(&first, Some(&later)), vec![("1793383794120".to_string(), Clock::Millis)]);
        assert_eq!(read_anew(&first, 0, "1793383794120", &later, 0, "1793384034733"), Some(("1793383794120".to_string(), Clock::Millis)));
        // A second walk that sends the same digits says the site handed them over: it is nobody's reading.
        let same = Trace { exchanges: vec![asked("https://shop.example/api/find?q=chairs&_=1793383794120&v=7", "Fri, 30 Oct 2026 18:13:54 GMT")], inputs: vec![] };
        assert!(ids(&first, Some(&same)).is_empty());
        // A second walk whose number there is nowhere near its own request says nothing about a clock.
        let far = Trace { exchanges: vec![asked("https://shop.example/api/find?q=chairs&_=1793000000000&v=7", "Fri, 30 Oct 2026 18:13:54 GMT")], inputs: vec![] };
        assert!(ids(&first, Some(&far)).is_empty());
        // Nor does a second walk that never made the call.
        let elsewhere = Trace { exchanges: vec![asked("https://shop.example/api/other?_=1793384034733", "Fri, 30 Oct 2026 18:13:54 GMT")], inputs: vec![] };
        assert!(ids(&first, Some(&elsewhere)).is_empty());
        // A reading inside a longer value is found the same way, where only the reading moved.
        assert!(read_anew(&first, 0, "t-1793383794120-x", &later, 0, "t-1793384034733-x").is_some());
        assert!(read_anew(&first, 0, "t-1793383794120-x", &later, 0, "u-1793384034733-y").is_none());
    }

    #[test]
    fn an_http_date_reads_as_seconds_since_the_epoch() {
        assert_eq!(http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(http_date("Fri, 30 Oct 2026 18:09:54 GMT"), Some(1_793_383_794));
        assert_eq!(http_date("not a date"), None);
    }

    /// Seconds are the head of the same moment in milliseconds, so an id read off the clock and a token a server stamped
    /// at that moment share their digits. The token holds no such id.
    #[test]
    fn digits_at_the_head_of_a_longer_run_are_not_the_id() {
        assert!(holds("1735108752.1793970892", "1793970892"));
        assert!(holds("fb_uploader_1793970892", "1793970892"));
        assert!(!holds("AHbIdTjQ-:1793970892572", "1793970892"));
    }

    #[test]
    fn only_a_reading_that_stands_alone_as_digits_is_a_clock() {
        let r = readings("fb_uploader_1793383794019 and 17933837940190 and v1793383794");
        assert_eq!(r, vec![("1793383794019".to_string(), Clock::Millis), ("1793383794".to_string(), Clock::Seconds)]);
    }

    /// A random id is read by its shape, however the page writes it: the canonical UUID, the W3C trace context a
    /// tracing header carries (`00-<32hex>-<16hex>-<2hex>`), and a base64url correlation id with the entropy a random
    /// draw has (upper and lower case letters and digits together). A lowercase hex hash and a plain word are none of
    /// these, so a value the site issued once is never read as a fresh draw.
    #[test]
    fn a_random_id_is_read_by_its_shape_however_the_page_writes_it() {
        assert!(a_random_id("080dbce1-3f6b-4a45-b181-2c6c26f285ca"), "a canonical UUID");
        assert!(a_random_id("00-18e9afb8c4c2225b5f8025390021dd54-757e1ea26bfc13cc-00"), "a W3C traceparent");
        assert!(a_random_id("7HAITjek-F-zCUMUz_6aP6Fl3cv5SRFmdu7M"), "a base64url correlation id");
        // A lowercase hex hash is no random draw, nor a word, nor a short token.
        assert!(!a_random_id("9f36aeafbe60771e321a7cc95a78140772ab3e96"), "a sha1 is not a fresh id");
        assert!(!a_random_id("customer"), "a word is not a fresh id");
        assert!(!a_random_id("abc123"), "a short token is not a fresh id");
        assert!(!a_random_id("trafficType=customer,deviceType=desktop"), "a baggage context is not a fresh id");
    }
}
