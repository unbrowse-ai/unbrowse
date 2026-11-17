//! A value written in another form: a date, a time or a number read the way one place writes it and written the way
//! another does (`docs/REBUILD.md` §5, "format a number or a time"). The caller says `2026-03-14` and the site sends
//! `14/03/2026`; the caller says `1500` and the site sends `1,500.00`.
//!
//! A form is data, read from the walk: the walk's own value with each field it carries struck out for what it is. No
//! form names a site, and the fields are a closed list: a form that names any other reads as its own text.

use serde::{Deserialize, Serialize};

/// How a date, a time or a number is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "as", rename_all = "snake_case", deny_unknown_fields)]
pub enum Pattern {
    /// A date or a time as a form of fields, each in braces, and the form's own text between them:
    /// `{yyyy}` the year, `{yy}` its last two digits; `{mm}` the month in two digits, `{m}` as few as it takes,
    /// `{mon}` its name cut to three letters (`Mar`), `{month}` its whole name; `{dd}` and `{d}` the day; `{hh}` and
    /// `{h}` the hour of 24; `{min}` the minute and `{ss}` the second, two digits each; `{s}` and `{ms}` the seconds
    /// and the milliseconds since 1970, in UTC. Anything else is the form's own text.
    Time { form: String },
    /// A number: `point` between its whole part and its fraction, `group` between each three digits of the whole
    /// part (empty for none), and `places` digits after the point, rounded half up (none: as many as it has).
    Number {
        #[serde(default = "dot", skip_serializing_if = "is_dot")]
        point: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        group: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        places: Option<u8>,
    },
}

fn dot() -> String {
    ".".into()
}

fn is_dot(s: &String) -> bool {
    s == "."
}

/// The names of the months, as a form's `{month}` writes them. `{mon}` is the first three letters.
const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// The fields a form may hold, longest first, so `{mm}` is not read as `{m}`.
pub const FIELDS: [&str; 14] = ["yyyy", "month", "min", "mon", "yy", "mm", "dd", "hh", "ss", "ms", "m", "d", "h", "s"];

/// A moment as a form reads it: each field it carried. A field a form did not carry is none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Moment {
    pub year: Option<i64>,
    pub month: Option<u32>,
    pub day: Option<u32>,
    pub hour: Option<u32>,
    pub minute: Option<u32>,
    pub second: Option<u32>,
    pub milli: Option<u32>,
}

/// One piece of a form: its own text, or a field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece<'a> {
    Text(&'a str),
    Field(&'a str),
}

/// A form in pieces. A brace that opens no field of the list is the form's own text.
pub fn pieces(form: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let rest = form;
    let mut text_from = 0;
    let mut at = 0;
    while let Some(open) = rest[at..].find('{').map(|o| at + o) {
        let field = rest[open + 1..].find('}').map(|close| &rest[open + 1..open + 1 + close]).filter(|f| FIELDS.contains(f));
        match field {
            Some(field) => {
                if open > text_from {
                    out.push(Piece::Text(&rest[text_from..open]));
                }
                out.push(Piece::Field(field));
                at = open + field.len() + 2;
                text_from = at;
            }
            None => at = open + 1,
        }
        if at >= rest.len() {
            break;
        }
    }
    if text_from < rest.len() {
        out.push(Piece::Text(&rest[text_from..]));
    }
    out
}

fn leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// How many days a month has; a February of no known year may have 29.
pub fn days_in(year: Option<i64>, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_none_or(leap) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 of a day of the proleptic Gregorian calendar.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The day of the calendar `days` after 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

impl Moment {
    /// Whether every field it holds is one a calendar and a clock have.
    pub fn is_real(&self) -> bool {
        let month_ok = self.month.is_none_or(|m| (1..=12).contains(&m));
        let day_ok = self.day.is_none_or(|d| d >= 1 && self.month.is_none_or(|m| d <= days_in(self.year, m)) && d <= 31);
        month_ok && day_ok && self.hour.is_none_or(|h| h <= 23) && self.minute.is_none_or(|m| m <= 59) && self.second.is_none_or(|s| s <= 59)
    }

    /// Milliseconds since 1970, in UTC, where it names a day.
    fn epoch_ms(&self) -> Option<i64> {
        let days = days_from_civil(self.year?, self.month?, self.day?);
        let secs = days * 86_400 + i64::from(self.hour.unwrap_or(0)) * 3600 + i64::from(self.minute.unwrap_or(0)) * 60 + i64::from(self.second.unwrap_or(0));
        Some(secs * 1000 + i64::from(self.milli.unwrap_or(0)))
    }

    fn from_epoch_ms(ms: i64) -> Moment {
        let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
        let (y, m, d) = civil_from_days(days);
        let secs = rest / 1000;
        Moment { year: Some(y), month: Some(m), day: Some(d), hour: Some((secs / 3600) as u32), minute: Some((secs / 60 % 60) as u32), second: Some((secs % 60) as u32), milli: Some((rest % 1000) as u32) }
    }

    /// The moment as `form` writes it. None where the form asks a field the moment does not hold.
    pub fn write(&self, form: &str) -> Option<String> {
        let mut out = String::new();
        for piece in pieces(form) {
            match piece {
                Piece::Text(t) => out.push_str(t),
                Piece::Field(f) => out.push_str(&match f {
                    "yyyy" => format!("{:04}", self.year?),
                    "yy" => format!("{:02}", self.year?.rem_euclid(100)),
                    "mm" => format!("{:02}", self.month?),
                    "m" => self.month?.to_string(),
                    "mon" => MONTHS.get(self.month?.checked_sub(1)? as usize)?[..3].to_string(),
                    "month" => MONTHS.get(self.month?.checked_sub(1)? as usize)?.to_string(),
                    "dd" => format!("{:02}", self.day?),
                    "d" => self.day?.to_string(),
                    "hh" => format!("{:02}", self.hour?),
                    "h" => self.hour?.to_string(),
                    "min" => format!("{:02}", self.minute?),
                    "ss" => format!("{:02}", self.second?),
                    "s" => (self.epoch_ms()?.div_euclid(1000)).to_string(),
                    "ms" => self.epoch_ms()?.to_string(),
                    _ => return None,
                }),
            }
        }
        Some(out)
    }

    /// `value` read as `form` writes a moment: each of the form's own texts where the form has it, each field as
    /// many digits or letters as it takes. None where the value is not written so, or names no real moment.
    pub fn read(value: &str, form: &str) -> Option<Moment> {
        let mut m = Moment::default();
        let mut rest = value;
        let digits = |rest: &str, least: usize, most: usize| -> Option<(u64, usize)> {
            let n = rest.chars().take(most).take_while(char::is_ascii_digit).count();
            (n >= least).then(|| rest[..n].parse().ok().map(|v| (v, n))).flatten()
        };
        let set = |slot: &mut Option<u32>, v: u64| -> Option<()> {
            let v = u32::try_from(v).ok()?;
            match slot {
                Some(had) if *had != v => None,
                _ => {
                    *slot = Some(v);
                    Some(())
                }
            }
        };
        for piece in pieces(form) {
            match piece {
                Piece::Text(t) => rest = rest.strip_prefix(t)?,
                Piece::Field(f) => {
                    let (least, most) = match f {
                        "yyyy" => (4, 4),
                        "yy" | "mm" | "dd" | "hh" | "min" | "ss" => (2, 2),
                        "m" | "d" | "h" => (1, 2),
                        "s" => (9, 11),
                        "ms" => (12, 14),
                        _ => (0, 0),
                    };
                    if matches!(f, "mon" | "month") {
                        let at = MONTHS.iter().position(|name| {
                            let name = if f == "mon" { &name[..3] } else { name };
                            rest.get(..name.len()).is_some_and(|r| r.eq_ignore_ascii_case(name))
                        })?;
                        set(&mut m.month, at as u64 + 1)?;
                        rest = &rest[if f == "mon" { 3 } else { MONTHS[at].len() }..];
                        continue;
                    }
                    let (v, n) = digits(rest, least, most)?;
                    rest = &rest[n..];
                    match f {
                        "yyyy" => m.year = Some(v as i64),
                        "yy" => m.year = Some(2000 + v as i64),
                        "mm" | "m" => set(&mut m.month, v)?,
                        "dd" | "d" => set(&mut m.day, v)?,
                        "hh" | "h" => set(&mut m.hour, v)?,
                        "min" => set(&mut m.minute, v)?,
                        "ss" => set(&mut m.second, v)?,
                        "s" => m = Moment::from_epoch_ms(i64::try_from(v).ok()?.checked_mul(1000)?),
                        "ms" => m = Moment::from_epoch_ms(i64::try_from(v).ok()?),
                        _ => return None,
                    }
                }
            }
        }
        (rest.is_empty() && m.is_real()).then_some(m)
    }
}

/// A number as its digits: what a form reads it as, so nothing is lost to a float.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Figure {
    pub negative: bool,
    pub whole: String,
    pub fraction: String,
}

impl Figure {
    /// `value` read as a number written with `point` and `group`. None where it holds anything else, or a group in a
    /// place a group does not go.
    pub fn read(value: &str, point: &str, group: &str) -> Option<Figure> {
        let (negative, rest) = match value.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, value),
        };
        let (whole, fraction) = match rest.split_once(point).filter(|_| !point.is_empty()) {
            Some((w, f)) => (w, f),
            None => (rest, ""),
        };
        let whole: String = if group.is_empty() {
            whole.to_string()
        } else {
            let groups: Vec<&str> = whole.split(group).collect();
            let fits = groups.len() == 1 || (groups[0].len() <= 3 && !groups[0].is_empty() && groups[1..].iter().all(|g| g.len() == 3));
            if !fits {
                return None;
            }
            groups.concat()
        };
        let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
        (!whole.is_empty() && digits(&whole) && digits(fraction)).then(|| Figure { negative, whole, fraction: fraction.to_string() })
    }

    /// The number written with `point`, `group` and `places`.
    pub fn write(&self, point: &str, group: &str, places: Option<u8>) -> String {
        let (mut whole, mut fraction) = (self.whole.trim_start_matches('0').to_string(), self.fraction.clone());
        if let Some(places) = places.map(usize::from) {
            if fraction.len() > places {
                let round_up = fraction.as_bytes()[places] >= b'5';
                fraction.truncate(places);
                if round_up {
                    let mut all: Vec<u8> = format!("{whole}{fraction}").into_bytes();
                    let mut i = all.len();
                    loop {
                        if i == 0 {
                            all.insert(0, b'1');
                            break;
                        }
                        i -= 1;
                        if all[i] == b'9' {
                            all[i] = b'0';
                        } else {
                            all[i] += 1;
                            break;
                        }
                    }
                    let all = String::from_utf8(all).unwrap_or_default();
                    let cut = all.len() - places;
                    whole = all[..cut].to_string();
                    fraction = all[cut..].to_string();
                }
            }
            while fraction.len() < places {
                fraction.push('0');
            }
        }
        if whole.is_empty() {
            whole = "0".into();
        }
        let grouped = if group.is_empty() {
            whole
        } else {
            let chars: Vec<char> = whole.chars().collect();
            let mut out = String::new();
            for (i, c) in chars.iter().enumerate() {
                if i > 0 && (chars.len() - i).is_multiple_of(3) {
                    out.push_str(group);
                }
                out.push(*c);
            }
            out
        };
        let sign = if self.negative && (grouped.chars().any(|c| c != '0' && c.is_ascii_digit()) || fraction.chars().any(|c| c != '0')) { "-" } else { "" };
        match fraction.is_empty() {
            true => format!("{sign}{grouped}"),
            false => format!("{sign}{grouped}{point}{fraction}"),
        }
    }
}

impl Pattern {
    /// The kind of value a pattern reads: a moment, or a number.
    pub fn is_time(&self) -> bool {
        matches!(self, Pattern::Time { .. })
    }
}

/// `value`, read as `read` writes it and written as `write` does. None where it does not read so, or the two are not
/// forms of one kind of value.
pub fn reformat(value: &str, read: &Pattern, write: &Pattern) -> Option<String> {
    match (read, write) {
        (Pattern::Time { form: from }, Pattern::Time { form: to }) => Moment::read(value, from)?.write(to),
        (Pattern::Number { point, group, .. }, Pattern::Number { point: to_point, group: to_group, places }) => Some(Figure::read(value, point, group)?.write(to_point, to_group, *places)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time(form: &str) -> Pattern {
        Pattern::Time { form: form.into() }
    }

    #[test]
    fn a_date_is_read_in_one_form_and_written_in_another() {
        assert_eq!(reformat("2026-03-14", &time("{yyyy}-{mm}-{dd}"), &time("{dd}/{mm}/{yyyy}")).as_deref(), Some("14/03/2026"));
        assert_eq!(reformat("2026-03-04", &time("{yyyy}-{mm}-{dd}"), &time("{d} {mon} {yy}")).as_deref(), Some("4 Mar 26"));
        assert_eq!(reformat("14 March 2026", &time("{d} {month} {yyyy}"), &time("{yyyy}{mm}{dd}")).as_deref(), Some("20260314"));
        assert_eq!(reformat("2026-03-14", &time("{yyyy}-{mm}-{dd}"), &time("{s}")).as_deref(), Some("1773446400"));
        assert_eq!(reformat("1773446400000", &time("{ms}"), &time("{yyyy}-{mm}-{dd}T{hh}:{min}")).as_deref(), Some("2026-03-14T00:00"));
        assert_eq!(reformat("2026-03-14T09:05", &time("{yyyy}-{mm}-{dd}T{hh}:{min}"), &time("{h}h{min}, {d}/{m}")).as_deref(), Some("9h05, 14/3"));
    }

    #[test]
    fn a_value_that_names_no_real_day_does_not_read() {
        assert_eq!(reformat("2026-14-03", &time("{yyyy}-{mm}-{dd}"), &time("{dd}/{mm}/{yyyy}")), None, "no fourteenth month");
        assert_eq!(reformat("2026-02-29", &time("{yyyy}-{mm}-{dd}"), &time("{dd}")), None, "2026 is no leap year");
        assert_eq!(reformat("2028-02-29", &time("{yyyy}-{mm}-{dd}"), &time("{dd}")).as_deref(), Some("29"));
        assert_eq!(reformat("2026/03/14", &time("{yyyy}-{mm}-{dd}"), &time("{dd}")), None, "the form's own text is held to");
        assert_eq!(reformat("2026-03-14", &time("{yyyy}-{mm}-{dd}"), &time("{hh}")), None, "a field the moment does not hold");
    }

    #[test]
    fn a_brace_that_names_no_field_is_the_forms_own_text() {
        assert_eq!(pieces("{q}-{dd}"), vec![Piece::Text("{q}-"), Piece::Field("dd")]);
        assert_eq!(Moment::read("{q}-07", "{q}-{dd}").and_then(|m| m.day), Some(7));
    }

    #[test]
    fn a_number_is_read_in_one_form_and_written_in_another() {
        let plain = Pattern::Number { point: ".".into(), group: String::new(), places: None };
        let money = Pattern::Number { point: ".".into(), group: ",".into(), places: Some(2) };
        let european = Pattern::Number { point: ",".into(), group: ".".into(), places: Some(2) };
        assert_eq!(reformat("1500", &plain, &money).as_deref(), Some("1,500.00"));
        assert_eq!(reformat("1234567.895", &plain, &european).as_deref(), Some("1.234.567,90"));
        assert_eq!(reformat("1.234,5", &european, &plain).as_deref(), Some("1234.5"));
        assert_eq!(reformat("9.999", &plain, &money).as_deref(), Some("10.00"));
        assert_eq!(reformat("12a", &plain, &money), None);
        assert_eq!(reformat("1,50,000", &money, &plain), None, "a group of two is no group of thousands");
        assert_eq!(reformat("2026-03-14", &time("{yyyy}-{mm}-{dd}"), &plain), None, "a moment is not written as a number");
    }

    #[test]
    fn a_pattern_reads_back_as_it_was_written() {
        let money = Pattern::Number { point: ".".into(), group: ",".into(), places: Some(2) };
        let said = serde_json::to_value(&money).unwrap();
        assert_eq!(said, serde_json::json!({ "as": "number", "group": ",", "places": 2 }));
        assert_eq!(serde_json::from_value::<Pattern>(said).unwrap(), money);
        assert!(serde_json::from_value::<Pattern>(serde_json::json!({ "as": "weekday" })).is_err(), "a kind this crate does not know does not read");
    }
}
