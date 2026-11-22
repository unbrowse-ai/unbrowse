//! The caller's value in the site's format: a date, a time or a number the page was asked written one way and sent
//! another (`route::Expr::Format`).
//!
//! Nothing here knows a site's format. Both forms are read from the walk: the form the page was asked in is the asked
//! value with each run of digits or letters given a field it can be (`2026-03-14` is `{yyyy}-{mm}-{dd}`, or
//! `{yyyy}-{dd}-{mm}` where both are months), and the form the call sends is the sent value with each run that one
//! of those fields writes struck out for it. Each pairing is a candidate, and stands only if it rebuilds what every
//! sighting sent (`Lab::rebuilds`).
//!
//! Two walks often cannot tell `dd/mm` from `mm/dd`: on a day of twelve or less both read. Where more than one
//! reading stands and they would send different things for another value, the hole says so ([`Left`]), with a value
//! that separates them (a day above twelve), for the learner's next walk to be asked: the site's own page then says
//! which, and nothing is guessed.

use unbrowse_route as route;
use unbrowse_route::format::{Figure, Moment};
use unbrowse_route::{Expr, Pattern};

/// What a hole's search left standing: more than one reading rebuilds every sighting, and they part on another value.
#[derive(Clone, Debug, PartialEq)]
pub struct Left {
    /// Every reading that rebuilds every sighting, the one the hole takes first.
    pub readings: Vec<Expr>,
    /// The slot to ask again, and a value for it on which the readings send different things.
    pub separates: (String, String),
    /// A proposer chose the first of `readings` (`lab::propose`): the site's tests judge it, as any reading.
    pub by_proposer: bool,
}

/// The most forms one value is read as: a value with more runs than this is no date a person writes.
const MOST_FORMS: usize = 48;

/// A run of a value: digits, letters, or anything else, which a form keeps as its own text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Run {
    Digits,
    Letters,
    Other,
}

fn runs(value: &str) -> Vec<(Run, &str)> {
    let kind = |c: char| if c.is_ascii_digit() { Run::Digits } else if c.is_alphabetic() { Run::Letters } else { Run::Other };
    let mut out: Vec<(Run, &str)> = Vec::new();
    let mut start = 0;
    let mut last: Option<Run> = None;
    for (i, c) in value.char_indices() {
        let k = kind(c);
        if last.is_some_and(|l| l != k || l == Run::Other) {
            out.push((last.unwrap_or(Run::Other), &value[start..i]));
            start = i;
        }
        last = Some(k);
    }
    if let Some(l) = last {
        out.push((l, &value[start..]));
    }
    out
}

/// Which part of a moment a field is: the year, the month, the day, the hour, the minute, the second, or the whole
/// moment at once (seconds or milliseconds since 1970).
fn part(field: &str) -> u8 {
    match field {
        "yyyy" | "yy" => 0,
        "mm" | "m" | "mon" | "month" => 1,
        "dd" | "d" => 2,
        "hh" | "h" => 3,
        "min" => 4,
        "ss" => 5,
        _ => 6,
    }
}

/// Whether the fields a form uses, in their order, make a moment a person writes: each part once, a month and a day
/// together, an hour and a minute together, the clock's parts in order and side by side, and the seconds since 1970
/// alone. `least`: the fewest parts the form must name.
fn a_moment(fields: &[&str], least: usize) -> bool {
    let parts: Vec<u8> = fields.iter().map(|f| part(f)).collect();
    let has = |p: u8| parts.contains(&p);
    let once = (0..=6).all(|p| parts.iter().filter(|&&q| q == p).count() <= 1);
    if !once || (parts.len() < least && !has(6)) {
        return false;
    }
    // The seconds since 1970 stand alone; and so may any one part, where the form may name one only (a day sent by
    // itself, held to walks that moved).
    if has(6) || (parts.len() == 1 && least <= 1) {
        return parts.len() == 1;
    }
    let clock: Vec<usize> = parts.iter().enumerate().filter(|(_, p)| **p >= 3).map(|(i, _)| i).collect();
    let clock_in_order = clock.windows(2).all(|w| w[1] == w[0] + 1 && parts[w[1]] == parts[w[0]] + 1) && clock.first().is_none_or(|&i| parts[i] == 3);
    // A date's parts stand side by side, the day beside the month: a year may open or close it.
    let dated: Vec<usize> = parts.iter().enumerate().filter(|(_, p)| **p <= 2).map(|(i, _)| i).collect();
    let side_by_side = dated.windows(2).all(|w| w[1] == w[0] + 1);
    let at = |p: u8| parts.iter().position(|q| *q == p);
    let day_by_month = match (at(1), at(2)) {
        (Some(m), Some(d)) => m.abs_diff(d) == 1,
        _ => true,
    };
    let date = has(0) || has(1) || has(2);
    let date_whole = !date || (has(1) && has(2));
    let clock_whole = !(has(3) || has(4)) || (has(3) && has(4));
    date_whole && clock_whole && clock_in_order && side_by_side && day_by_month && (date || has(3))
}

/// The fields a run of the asked value may be, in the order they are tried.
fn fields_for(run: Run, text: &str) -> Vec<&'static str> {
    match run {
        Run::Digits => match text.len() {
            4 => vec!["yyyy"],
            2 => vec!["mm", "dd", "hh", "min", "ss", "yy"],
            1 => vec!["m", "d", "h"],
            10 => vec!["s"],
            13 => vec!["ms"],
            _ => Vec::new(),
        },
        Run::Letters => {
            let named = Moment::read(text, "{month}").is_some() as usize;
            match (named, text.chars().count()) {
                (1, _) => vec!["month"],
                (0, 3) if Moment::read(text, "{mon}").is_some() => vec!["mon"],
                _ => Vec::new(),
            }
        }
        Run::Other => Vec::new(),
    }
}

/// A form's text written so that a brace of the value's own does not read as a field.
fn literal(text: &str) -> Option<&str> {
    (!text.contains('{')).then_some(text)
}

/// The forms `value` reads as a moment in: each run of digits given a field it can be, the rest the form's own text,
/// every run of digits a field. Only forms that read the value as a real moment, at most [`MOST_FORMS`].
pub fn time_reads(value: &str) -> Vec<String> {
    let runs = runs(value);
    if !runs.iter().any(|(r, _)| *r == Run::Digits) || runs.len() > 15 || value.contains('{') {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    fn go(runs: &[(Run, &str)], at: usize, form: &mut Vec<String>, fields: &mut Vec<&'static str>, out: &mut Vec<String>, value: &str) {
        if out.len() >= MOST_FORMS {
            return;
        }
        if at == runs.len() {
            let form: String = form.concat();
            if a_moment(fields, 2) && Moment::read(value, &form).is_some() && !out.contains(&form) {
                out.push(form);
            }
            return;
        }
        let (run, text) = runs[at];
        let options = fields_for(run, text);
        if options.is_empty() {
            if run == Run::Digits {
                return;
            }
            form.push(text.to_string());
            go(runs, at + 1, form, fields, out, value);
            form.pop();
            return;
        }
        for field in options {
            form.push(format!("{{{field}}}"));
            fields.push(field);
            go(runs, at + 1, form, fields, out, value);
            fields.pop();
            form.pop();
        }
        // A word that names a month may still be the form's own word.
        if run == Run::Letters {
            form.push(text.to_string());
            go(runs, at + 1, form, fields, out, value);
            form.pop();
        }
    }
    go(&runs, 0, &mut Vec::new(), &mut Vec::new(), &mut out, value);
    out
}

/// Where a moment stands in `sent`, written some form: each stretch of `sent`'s runs that are all fields of the moment
/// (with the text between them), as the byte range it covers and the form it is. A stretch names `least` parts at
/// least. Several forms may write one stretch (a day and a month that are the same number): each is one.
fn written_in(sent: &str, moment: &Moment, least: usize) -> Vec<(usize, usize, String)> {
    let runs = runs(sent);
    let mut offsets = Vec::with_capacity(runs.len());
    let mut at = 0;
    for (_, text) in &runs {
        offsets.push(at);
        at += text.len();
    }
    // What each run may be, of the fields this moment writes as that very text.
    let all = ["yyyy", "yy", "mm", "m", "mon", "month", "dd", "d", "hh", "h", "min", "ss", "s", "ms"];
    let options: Vec<Vec<&str>> = runs.iter().map(|(run, text)| if *run == Run::Other { Vec::new() } else { all.iter().copied().filter(|f| moment.write(&format!("{{{f}}}")).as_deref() == Some(*text)).collect() }).collect();
    let mut out: Vec<(usize, usize, String)> = Vec::new();
    for start in 0..runs.len() {
        if options[start].is_empty() {
            continue;
        }
        for end in start + 1..=runs.len() {
            let stretch = &runs[start..end];
            // A stretch opens and closes on a field, and every run of digits or letters inside it is one.
            if options[end - 1].is_empty() || stretch.iter().zip(&options[start..end]).any(|((run, _), o)| *run != Run::Other && o.is_empty()) {
                continue;
            }
            // Every form the stretch may be, one field per run.
            let mut forms: Vec<(String, Vec<&str>)> = vec![(String::new(), Vec::new())];
            for (k, (run, text)) in stretch.iter().enumerate() {
                let opts = &options[start + k];
                if *run == Run::Other {
                    let Some(text) = literal(text) else { forms.clear(); break };
                    forms.iter_mut().for_each(|(f, _)| f.push_str(text));
                    continue;
                }
                forms = forms.into_iter().flat_map(|(f, used)| opts.iter().map(move |o| (format!("{f}{{{o}}}"), [used.clone(), vec![*o]].concat()))).collect();
                if forms.len() > MOST_FORMS {
                    forms.truncate(MOST_FORMS);
                }
            }
            for (form, used) in forms {
                if a_moment(&used, least) && moment.write(&form).as_deref() == Some(&sent[offsets[start]..offsets[end - 1] + stretch[stretch.len() - 1].1.len()]) {
                    out.push((offsets[start], offsets[end - 1] + stretch[stretch.len() - 1].1.len(), form));
                }
            }
        }
    }
    // A stretch inside a longer one is the longer one cut short: the year beside a day and a month is the moment's
    // year, not the page's own text.
    let spans: Vec<(usize, usize)> = out.iter().map(|(a, b, _)| (*a, *b)).collect();
    out.retain(|(a, b, _)| !spans.iter().any(|(c, d)| c <= a && b <= d && (c, d) != (a, b)));
    out
}

/// The forms a number is written in that are tried: a point, a group and how many places.
fn number_forms() -> Vec<Pattern> {
    let mut out = Vec::new();
    for point in [".", ","] {
        for group in ["", ",", ".", " ", "'", "\u{a0}"] {
            if group == point {
                continue;
            }
            for places in [None, Some(0), Some(1), Some(2), Some(3)] {
                out.push(Pattern::Number { point: point.into(), group: group.into(), places });
            }
        }
    }
    out
}

/// Where `number`, written as `form`, stands whole in `sent`: not beside another digit, a point or a group of its own.
fn number_in(sent: &str, written: &str) -> Vec<(usize, usize)> {
    let next_to = |c: Option<char>| c.is_some_and(|c| c.is_ascii_digit());
    sent.match_indices(written).map(|(at, _)| (at, at + written.len())).filter(|&(a, b)| !next_to(sent[..a].chars().next_back()) && !next_to(sent[b..].chars().next())).collect()
}

/// The ways `name`'s value, `walked` on this sighting, may be sent as `sent` in the site's format: the whole value, or
/// inside a longer text that is otherwise fixed, each a [`route::Expr::Format`] over the slot. `moved`: the value moved
/// between the sightings, so a form that names one part only (a day sent by itself) is held to the walks; on walks
/// that agree it is not offered, as it says too little to be told from a number the page sends for its own reasons.
pub fn candidates(name: &str, walked: &str, sent: &str, moved: bool) -> Vec<Expr> {
    if walked == sent || walked.is_empty() || sent.is_empty() {
        return Vec::new();
    }
    let slot = || Expr::Slot { name: name.to_string(), or: Some(walked.to_string()), optional: false };
    let around = |start: usize, end: usize, inner: Expr| {
        let mut parts = Vec::new();
        if start > 0 {
            parts.push(Expr::text(&sent[..start]));
        }
        parts.push(inner);
        if end < sent.len() {
            parts.push(Expr::text(&sent[end..]));
        }
        match parts.len() {
            1 => parts.pop().unwrap_or_else(|| Expr::text("")),
            _ => Expr::Join { parts, with: String::new() },
        }
    };
    let mut out: Vec<Expr> = Vec::new();
    let mut push = |e: Expr| {
        if !out.contains(&e) {
            out.push(e);
        }
    };
    let least = if moved { 1 } else { 2 };
    for read in time_reads(walked) {
        let Some(moment) = Moment::read(walked, &read) else { continue };
        let mut found = written_in(sent, &moment, least);
        // The whole value first, then the longest stretch.
        found.sort_by_key(|(a, b, _)| (!(*a == 0 && *b == sent.len()), std::cmp::Reverse(b - a), *a));
        for (start, end, form) in found {
            // A form that writes the asked value as it was asked is no format: the plain slot already says it.
            if form == read && start == 0 && end == sent.len() {
                continue;
            }
            push(around(start, end, Expr::Format { of: Box::new(slot()), read: Pattern::Time { form: read.clone() }, write: Pattern::Time { form } }));
        }
    }
    // A number, read in each form that reads it, and written in each form that writes it as `sent` holds it.
    let reads: Vec<Pattern> = [(".", ""), (".", ","), (",", "."), (",", "")]
        .into_iter()
        .filter(|(p, g)| Figure::read(walked, p, g).is_some())
        .map(|(p, g)| Pattern::Number { point: p.into(), group: g.into(), places: None })
        .collect();
    for read in reads {
        let Pattern::Number { point, group, .. } = &read else { continue };
        let Some(figure) = Figure::read(walked, point, group) else { continue };
        for write in number_forms() {
            let Pattern::Number { point: p, group: g, places } = &write else { continue };
            let text = figure.write(p, g, *places);
            if text == walked {
                continue;
            }
            for (start, end) in number_in(sent, &text) {
                push(around(start, end, Expr::Format { of: Box::new(slot()), read: read.clone(), write: write.clone() }));
            }
        }
    }
    out
}

/// What `expr` sends where `name` is given `value`, and nothing else is: a reading's answer for another value.
pub fn sends(expr: &Expr, name: &str, value: &str) -> Option<String> {
    struct Only<'a>(&'a str, &'a str);
    impl route::World for Only<'_> {
        fn slot(&self, name: &str) -> Option<String> {
            (name == self.0).then(|| self.1.to_string())
        }
        fn cookie(&self, _: &str) -> Option<String> {
            None
        }
        fn read(&self, _: &str, _: &route::At) -> Option<String> {
            None
        }
        fn answered(&self, _: &str) -> bool {
            false
        }
        fn fresh(&mut self, id: &str, _: route::Clock) -> String {
            id.to_string()
        }
        fn now_ms(&self) -> u64 {
            0
        }
        fn digits(&mut self, n: usize) -> String {
            "0".repeat(n)
        }
        fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> {
            Err(String::new())
        }
        fn same_site(&self, _: &str, _: &str) -> bool {
            false
        }
    }
    match expr.eval(&mut route::expr::Cx { world: &mut Only(name, value), host: None, sent: None }) {
        Ok(route::Outcome::Is(v)) => Some(v),
        _ => None,
    }
}

/// The formats `expr` holds, each with the slot it reads.
fn formats_in(expr: &Expr) -> Vec<(&str, &Pattern)> {
    expr.all()
        .into_iter()
        .filter_map(|e| match e {
            Expr::Format { of, read, .. } => of.slots().first().map(|name| (*name, read)),
            _ => None,
        })
        .collect()
}

/// Other values of the kind `walked` is, written in the form `read` reads, in the order a next walk asks them: for a
/// date, the same month on days above twelve (so a day cannot be read as a month), then other months; for a number,
/// one with a fraction and one in the thousands.
pub fn others_of_its_kind(walked: &str, read: &Pattern) -> Vec<String> {
    match read {
        Pattern::Time { form } => {
            let Some(m) = Moment::read(walked, form) else { return Vec::new() };
            let mut out = Vec::new();
            let months: Vec<u32> = m.month.into_iter().chain([11, 10, 9]).collect();
            for month in months {
                // A day above twelve cannot be a month; one below ten is written with a nought or without one.
                for day in [25, 27, 13, 28, 20, 5] {
                    let moved = Moment { month: m.month.map(|_| month), day: m.day.map(|_| day), ..m };
                    if moved == m || !moved.is_real() {
                        continue;
                    }
                    if let Some(v) = moved.write(form).filter(|v| v != walked && !out.contains(v)) {
                        out.push(v);
                    }
                }
            }
            // A time of day alone: another hour.
            if m.day.is_none() {
                for hour in [17, 21, 14] {
                    if let Some(v) = (Moment { hour: Some(hour), ..m }).write(form).filter(|v| v != walked && !out.contains(v)) {
                        out.push(v);
                    }
                }
            }
            out
        }
        Pattern::Number { point, group, .. } => {
            let figures = [Figure { negative: false, whole: "1234".into(), fraction: "5".into() }, Figure { negative: false, whole: "2750".into(), fraction: String::new() }];
            figures.iter().map(|f| f.write(point, group, None)).filter(|v| v != walked).collect()
        }
    }
}

/// Where the readings that all rebuild every sighting would send different things for another value: they, and the
/// first other value of the asked kind on which they part. None where one reading stands, or they agree on every
/// value tried (the same reading written twice).
pub fn left_standing(standing: &[Expr], walked: &str) -> Option<Left> {
    let first = standing.first()?;
    let (name, _) = *formats_in(first).first()?;
    let mut tried: Vec<String> = Vec::new();
    for e in standing {
        for (_, read) in formats_in(e) {
            for v in others_of_its_kind(walked, read) {
                if !tried.contains(&v) {
                    tried.push(v);
                }
            }
        }
    }
    let parts = |v: &str| {
        let said: Vec<Option<String>> = standing.iter().map(|e| sends(e, name, v)).collect();
        said.iter().any(|s| *s != said[0])
    };
    let separates = tried.into_iter().find(|v| parts(v))?;
    Some(Left { readings: standing.to_vec(), separates: (name.to_string(), separates), by_proposer: false })
}

/// Whether the sightings so far cannot tell how `name`'s value is written where a call sends it: given what each
/// sighting was asked and sent at one place (`seen`, the first walk's first), more than one reading rebuilds every
/// sighting and they part on another value of the kind ([`left_standing`]). The value they part on, where they do: a
/// next sighting asked one like it settles which. None where one reading stands or none does, or they agree on every
/// value tried. Read from the sightings alone, as the learn's search reads them, for whoever holds two walks' calls
/// after the route was kept (a confirming browse), when the readings the search left are no longer in hand.
pub fn writings_left(name: &str, seen: &[(&str, &str)]) -> Option<String> {
    let (walked, sent) = *seen.first()?;
    let moved = seen.iter().any(|(asked, _)| *asked != walked);
    let standing: Vec<Expr> = candidates(name, walked, sent, moved).into_iter().filter(|c| seen.iter().all(|(asked, sent)| sends(c, name, asked).as_deref() == Some(*sent))).collect();
    left_standing(&standing, walked).map(|left| left.separates.1)
}

/// Whether a call sends `value`, an asked date, time or number, in a written form of the site's: a place of the call
/// holds it in a form the walk reads (a date within a longer text, a number only as the place's whole value, since a
/// short number inside a text is any number). What a call's pick counts as sending the asked value, as it counts
/// the value sent as it was asked.
pub fn sent_in_a_format(e: &crate::trace::Exchange, value: &str) -> bool {
    if time_reads(value).is_empty() && Figure::read(value, ".", "").is_none() {
        return false;
    }
    crate::slots::slots(e).iter().any(|slot| {
        candidates("asked", value, &slot.value, false).iter().any(|c| {
            let whole_or_dated = match c {
                Expr::Format { read, .. } => read.is_time() || slot.value.chars().count() >= 4,
                _ => formats_in(c).iter().all(|(_, r)| r.is_time()),
            };
            whole_or_dated && sends(c, "asked", value).as_deref() == Some(slot.value.as_str())
        })
    })
}

/// Another value to walk the page with, where the walk shows the page's call sending an asked value in a format:
/// for each asked value (`asked`, by name) that a call of `exchanges` sends in a form other than it was asked, a
/// value of the same kind, chosen to separate the readings one walk leaves standing (a day above twelve where the day
/// and the month could be either). The asked value, and the value for the next walk. None where no call sends an
/// asked value in a format: then this says nothing, and the page's own offers stand.
pub fn next_value(exchanges: &[crate::trace::Exchange], asked: &[(String, String)]) -> Option<(String, String)> {
    for (name, walked) in asked {
        if time_reads(walked).is_empty() && Figure::read(walked, ".", "").is_none() {
            continue;
        }
        for e in exchanges.iter().filter(|e| !e.is_asset() && !e.is_main_document()) {
            for slot in crate::slots::slots(e) {
                let standing: Vec<Expr> = candidates(name, walked, &slot.value, false).into_iter().filter(|c| sends(c, name, walked).as_deref() == Some(slot.value.as_str())).collect();
                let Some(first) = standing.first() else { continue };
                if let Some(left) = left_standing(&standing, walked) {
                    return Some((walked.clone(), left.separates.1));
                }
                let read = formats_in(first).first().map(|(_, r)| (*r).clone())?;
                if let Some(other) = others_of_its_kind(walked, &read).into_iter().next() {
                    return Some((walked.clone(), other));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(form: &str) -> Pattern {
        Pattern::Time { form: form.into() }
    }

    fn format(read: &str, write: &str) -> Expr {
        Expr::Format { of: Box::new(Expr::Slot { name: "date".into(), or: Some("2026-03-14".into()), optional: false }), read: time(read), write: time(write) }
    }

    #[test]
    fn an_asked_date_is_read_in_the_forms_its_runs_can_be() {
        assert_eq!(time_reads("2026-03-14"), vec!["{yyyy}-{mm}-{dd}"], "a fourteenth month does not read");
        assert_eq!(time_reads("2026-03-04"), vec!["{yyyy}-{mm}-{dd}", "{yyyy}-{dd}-{mm}"]);
        assert_eq!(time_reads("14 Mar 2026"), vec!["{dd} {mon} {yyyy}"]);
        assert_eq!(time_reads("2026-03-14T09:30"), vec!["{yyyy}-{mm}-{dd}T{hh}:{min}"]);
        assert!(time_reads("kettle").is_empty() && time_reads("12").is_empty() && time_reads("2026").is_empty());
    }

    #[test]
    fn the_callers_date_sent_in_another_form_is_a_format_of_the_slot() {
        // The fourteenth is written `14` with a nought before a day below ten or without one: both stand, padded first.
        assert_eq!(candidates("date", "2026-03-14", "14/03/2026", false), vec![format("{yyyy}-{mm}-{dd}", "{dd}/{mm}/{yyyy}"), format("{yyyy}-{mm}-{dd}", "{d}/{mm}/{yyyy}")]);
        let said = candidates("date", "2026-03-04", "from 04.03.26 on", false);
        let Expr::Join { parts, .. } = &said[0] else { panic!("{said:?}") };
        assert_eq!((&parts[0], &parts[2]), (&Expr::text("from "), &Expr::text(" on")));
        assert!(matches!(&parts[1], Expr::Format { write: Pattern::Time { form }, .. } if form == "{dd}.{mm}.{yy}"), "{said:?}");
        assert_eq!(sends(&said[0], "date", "2026-11-25").as_deref(), Some("from 25.11.26 on"));
        assert!(candidates("date", "2026-03-14", "2026-03-14", false).is_empty(), "the date as asked is the plain slot's");
        assert!(candidates("date", "2026-03-14", "kettle", false).is_empty());
        // One part alone is held to two walks: on one, a day sent by itself is a number like any other.
        assert!(candidates("date", "2026-03-14", "14", false).is_empty());
        assert!(candidates("date", "2026-03-14", "14", true).contains(&format("{yyyy}-{mm}-{dd}", "{dd}")));
        assert_eq!(candidates("date", "2026-03-14", "1773446400", false), vec![format("{yyyy}-{mm}-{dd}", "{s}")]);
    }

    #[test]
    fn a_number_sent_in_another_form_is_a_format_of_the_slot() {
        let said = candidates("price", "1500", "1,500.00", false);
        let money = Pattern::Number { point: ".".into(), group: ",".into(), places: Some(2) };
        assert!(said.iter().any(|e| matches!(e, Expr::Format { write, .. } if *write == money)), "{said:?}");
        assert!(candidates("price", "1500", "1500", false).is_empty());
    }

    /// One walk on the fourth of March cannot tell a day from a month: both readings rebuild what it sent, and they part
    /// on a day above twelve. The hole says so, and the value it names for the next walk is one on which they part.
    #[test]
    fn where_a_day_could_be_a_month_the_hole_says_so_and_names_a_value_that_separates_them() {
        let standing: Vec<Expr> = candidates("date", "2026-03-04", "04/03/2026", false).into_iter().filter(|c| sends(c, "date", "2026-03-04").as_deref() == Some("04/03/2026")).collect();
        assert_eq!(standing.len(), 2, "{standing:?}");
        let left = left_standing(&standing, "2026-03-04").expect("two readings left");
        let (slot, value) = &left.separates;
        assert_eq!(slot, "date");
        let said: Vec<Option<String>> = standing.iter().map(|e| sends(e, "date", value)).collect();
        assert_ne!(said[0], said[1], "the value {value} parts the readings: {said:?}");
        assert!(value.ends_with("-25") || value.contains("-25-"), "a day above twelve: {value}");
        // A day above twelve leaves the day apart from the month, and a day below ten says whether it is padded: the
        // two walks together leave one reading.
        let one: Vec<Expr> = candidates("date", "2026-03-14", "14/03/2026", false).into_iter().filter(|c| sends(c, "date", "2026-11-05").as_deref() == Some("05/11/2026")).collect();
        assert_eq!(one.len(), 1);
        assert_eq!(left_standing(&one, "2026-03-14"), None);
    }

    /// Two walks each on a day of twelve or less, written day first, are rebuilt as well by a reading that takes the
    /// day for the month and writes them the other way round: they cannot tell the two apart, and a day above twelve
    /// does. A walk on a day above twelve leaves one reading, and a value written as asked leaves none.
    #[test]
    fn two_walks_on_days_a_month_could_be_leave_both_writings() {
        let left = writings_left("date", &[("2026-03-04", "04/03/2026"), ("2026-11-07", "07/11/2026")]).expect("two writings fit both walks");
        assert!(left.ends_with("-25"), "a day above twelve parts them: {left}");
        assert_eq!(writings_left("date", &[("2026-03-04", "04/03/2026"), ("2026-06-21", "21/06/2026")]), None, "the twenty-first is no month");
        assert_eq!(writings_left("date", &[("2026-03-04", "2026-03-04"), ("2026-11-07", "2026-11-07")]), None, "sent as asked");
        assert_eq!(writings_left("q", &[("kettle", "kettle"), ("lamp", "lamp")]), None);
    }

    #[test]
    fn a_walk_whose_call_sends_the_date_in_a_format_names_the_next_walks_value() {
        use crate::lab::sighting::tests::{call, trace};
        let walked = trace(vec![call("GET", "https://shop.example/api/slots?d=04%2F03%2F2026&n=2", &[], None, "{}")]);
        let (was, next) = next_value(&walked.exchanges, &[("date".into(), "2026-03-04".into())]).expect("a next value");
        assert_eq!(was, "2026-03-04");
        assert_eq!(next, "2026-03-25", "the same month, a day above twelve");
        let plain = trace(vec![call("GET", "https://shop.example/api/slots?d=2026-03-04", &[], None, "{}")]);
        assert_eq!(next_value(&plain.exchanges, &[("date".into(), "2026-03-04".into())]), None, "sent as asked: nothing to separate");
        assert_eq!(next_value(&walked.exchanges, &[("q".into(), "kettle".into())]), None);
    }

    /// What a reading sends for another value is worked out from the value alone: a source that is no value of the caller
    /// (a cookie, an earlier reply, a file) sends nothing, so a reading built on one is never mistaken for one that
    /// rebuilds the sighting; a stamp and an id made for the call are as the world with no clock and no chance makes
    /// them.
    #[test]
    fn a_reading_sends_only_what_the_callers_value_makes() {
        let slot = || Box::new(Expr::Slot { name: "date".into(), or: None, optional: false });
        assert_eq!(sends(&slot(), "date", "2026-03-14").as_deref(), Some("2026-03-14"));
        assert_eq!(sends(&slot(), "other", "2026-03-14"), None, "a slot the caller gave no value for sends nothing");
        assert_eq!(sends(&Expr::Cookie { name: "sid".into(), here: false }, "date", "x"), None, "no session in hand");
        assert_eq!(sends(&Expr::Read { step: "x0".into(), at: route::At::Json { pointer: "/token".into() } }, "date", "x"), None, "no earlier reply in hand");
        assert_eq!(sends(&Expr::File { slot: "date".into(), fact: route::FileFact::Name }, "date", "x"), None, "no file in hand");
        assert_eq!(sends(&Expr::Fresh { id: "req".into(), clock: route::Clock::Millis }, "date", "x").as_deref(), Some("req"));
        assert_eq!(sends(&Expr::Stamp { form: "t{ms}s{s}r{d4}".into() }, "date", "x").as_deref(), Some("t0s0r0000"), "no clock and no chance");
    }

    /// A run of digits is a date's part by its length: one digit a month, day or hour written without a nought, ten
    /// the seconds since 1970 and thirteen the milliseconds, each read only as a moment that is real.
    #[test]
    fn a_run_of_digits_is_read_as_a_part_of_a_date_by_its_length() {
        assert!(time_reads("2026-3-4").contains(&"{yyyy}-{m}-{d}".to_string()), "{:?}", time_reads("2026-3-4"));
        assert_eq!(time_reads("1773446400"), vec!["{s}".to_string()]);
        assert_eq!(time_reads("1773446400000"), vec!["{ms}".to_string()]);
        assert!(time_reads("12345678").is_empty(), "eight digits are no part of a date");
        let at_the_second = Moment::read("1773446400", "{s}").expect("the seconds read");
        assert_eq!(at_the_second.write("{yyyy}-{mm}-{dd}").as_deref(), Some("2026-03-14"));
    }

    /// Another value of a number's kind, for a next walk, is one with a fraction and one in the thousands, written in the
    /// point and the group the walk read; a value that is the walked one is not offered back.
    #[test]
    fn another_number_for_a_next_walk_has_a_fraction_and_thousands_in_the_walks_own_form() {
        let money = Pattern::Number { point: ".".into(), group: ",".into(), places: None };
        assert_eq!(others_of_its_kind("15.50", &money), vec!["1,234.5".to_string(), "2,750".to_string()]);
        assert_eq!(others_of_its_kind("2,750", &money), vec!["1,234.5".to_string()], "the walked value is not offered back");
        let european = Pattern::Number { point: ",".into(), group: ".".into(), places: None };
        assert_eq!(others_of_its_kind("15,5", &european), vec!["1.234,5".to_string(), "2.750".to_string()]);
    }

    /// A call sends an asked value in a format of the site's, whether a date within a longer text or a number as the
    /// place's whole value: a date asked `2026-03-04` and sent `04/03/2026` does; the date as asked, a word, and a short
    /// number inside a bigger text do not.
    #[test]
    fn a_call_sends_an_asked_value_in_a_format_when_a_place_holds_it_written_another_way() {
        use crate::lab::sighting::tests::call;
        let get = |url: &str| call("GET", url, &[], None, "{}");
        assert!(sent_in_a_format(&get("https://shop.example/api/slots?d=04%2F03%2F2026"), "2026-03-04"), "a date written day first");
        assert!(sent_in_a_format(&get("https://shop.example/api/slots?range=from%2004.03.26%20on"), "2026-03-04"), "a date inside a longer text");
        assert!(sent_in_a_format(&get("https://shop.example/api/price?max=1%2C500.00"), "1500"), "a number as the place's whole value");
        assert!(!sent_in_a_format(&get("https://shop.example/api/slots?d=2026-03-04"), "2026-03-04"), "as asked is no format");
        assert!(!sent_in_a_format(&get("https://shop.example/api/slots?d=04%2F03%2F2026"), "kettle"), "a word is no date or number");
        assert!(!sent_in_a_format(&get("https://shop.example/api/price?max=7.0"), "7"), "a short number is any number");
        assert!(!sent_in_a_format(&get("https://shop.example/api/price?note=about%201%2C500.00%20or%20so"), "1500"), "a number inside a text is a number of the text's own");
    }

    /// A price the call sends with thousands and two places is asked again as another number, never the walked one: the
    /// next walk is given a figure to tell the readings of the number apart.
    #[test]
    fn a_number_sent_in_a_format_names_another_number_for_the_next_walk() {
        use crate::lab::sighting::tests::{call, trace};
        let walked = trace(vec![call("GET", "https://shop.example/api/price?max=1%2C500.00&n=2", &[], None, "{}")]);
        let (was, next) = next_value(&walked.exchanges, &[("max".into(), "1500".into())]).expect("a next value");
        assert_eq!(was, "1500");
        assert_ne!(next, "1500");
        assert!(next.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.'), "a number: {next}");
        assert!(next.parse::<f64>().is_ok() || next.contains(','), "a number: {next}");
    }

    /// A date sent as seconds since 1970 has one reading, with no day that could be a month, so the next walk is asked
    /// another date in the form the first was asked in: the same month, a day above twelve.
    #[test]
    fn a_date_sent_as_seconds_has_one_reading_and_the_next_walk_asks_another_date() {
        use crate::lab::sighting::tests::{call, trace};
        let walked = trace(vec![call("GET", "https://shop.example/api/slots?from=1773446400", &[], None, "{}")]);
        assert_eq!(next_value(&walked.exchanges, &[("date".into(), "2026-03-14".into())]), Some(("2026-03-14".into(), "2026-03-25".into())));
    }
}
