//! Ranking routes against an agent's words: BM25 (k1 1.2, b 0.75) over two fields of each route, its own words (what
//! it does, its site, its path) and the names of the fields its answer holds (R2.24). A word fewer routes hold counts
//! for more, a word in a long description for less, and a word only an answer's field holds counts half: it finds the
//! route without putting it ahead of one that says the word.

pub mod coin;
pub mod reputation;

use std::collections::{BTreeSet, HashMap};

const K1: f64 = 1.2;
const B: f64 = 0.75;
/// What a word among the answer's field names counts for, against the same word in the route's own words.
const FIELD_WEIGHT: f64 = 0.5;

/// The lowercase words of a text, two letters or digits or more, each plural made singular: `Flights` is `flight`,
/// `stories` is `story`.
pub fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).map(singular).collect()
}

fn singular(w: &str) -> String {
    if let Some(stem) = w.strip_suffix("ies").filter(|s| s.len() >= 2) {
        return format!("{stem}y");
    }
    match w.strip_suffix('s') {
        Some(stem) if stem.len() >= 3 && !stem.ends_with('s') => stem.to_string(),
        _ => w.to_string(),
    }
}

/// What a route is found by.
#[derive(Clone, Debug, Default)]
pub struct Doc {
    words: Vec<String>,
    fields: Vec<String>,
}

impl Doc {
    /// A route's own words, and the names of the fields its answer holds: each name once, however often the answer
    /// nests it.
    pub fn new<S: AsRef<str>>(words: &str, fields: impl IntoIterator<Item = S>) -> Doc {
        let fields: BTreeSet<String> = fields.into_iter().flat_map(|f| tokens(f.as_ref())).collect();
        Doc { words: tokens(words), fields: fields.into_iter().collect() }
    }

    /// A route known by its own words alone.
    pub fn plain(words: &str) -> Doc {
        Doc::new(words, Vec::<String>::new())
    }

    fn holds(&self, t: &str) -> bool {
        self.words.iter().chain(&self.fields).any(|w| w == t)
    }
}

/// Each doc's score for the query, in order; 0 for a doc that holds none of its words. The scores are relative to
/// these docs alone, so docs to be put in one order are scored together.
pub fn scores(query: &str, docs: &[Doc]) -> Vec<f64> {
    let terms: BTreeSet<String> = tokens(query).into_iter().collect();
    let n = docs.len() as f64;
    let avg = |len: fn(&Doc) -> usize| docs.iter().map(len).sum::<usize>() as f64 / n.max(1.0);
    let (avg_words, avg_fields) = (avg(|d| d.words.len()), avg(|d| d.fields.len()));
    let idf: HashMap<&str, f64> = terms
        .iter()
        .map(|t| {
            let df = docs.iter().filter(|d| d.holds(t)).count() as f64;
            (t.as_str(), (1.0 + (n - df + 0.5) / (df + 0.5)).ln())
        })
        .collect();
    docs.iter()
        .map(|d| {
            terms
                .iter()
                .map(|t| {
                    let tf = weighed(&d.words, t, avg_words) + FIELD_WEIGHT * weighed(&d.fields, t, avg_fields);
                    if tf == 0.0 { 0.0 } else { idf[t.as_str()] * tf * (K1 + 1.0) / (K1 + tf) }
                })
                .sum()
        })
        .collect()
}

/// How often `t` is in a field, against how long the field is next to the same field of the other docs.
fn weighed(field: &[String], t: &str, avg: f64) -> f64 {
    let tf = field.iter().filter(|w| *w == t).count() as f64;
    if tf == 0.0 {
        return 0.0;
    }
    tf / (1.0 - B + B * field.len() as f64 / avg)
}

/// The items that hold some of the query's words, best first; items that score the same keep the order they came in.
/// A query with no words keeps every item, as it came.
pub fn ranked<T>(query: &str, items: Vec<T>, doc: impl Fn(&T) -> Doc) -> Vec<T> {
    if tokens(query).is_empty() {
        return items;
    }
    let docs: Vec<Doc> = items.iter().map(doc).collect();
    let mut scored: Vec<(f64, T)> = scores(query, &docs).into_iter().zip(items).filter(|(s, _)| *s > 0.0).collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.into_iter().map(|(_, t)| t).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(query: &str, docs: &[Doc]) -> Vec<usize> {
        ranked(query, (0..docs.len()).collect(), |i| docs[*i].clone())
    }

    #[test]
    fn words_are_lowercase_singular_and_two_long() {
        assert_eq!(tokens("Search HN Stories: /v1/flights?q=1"), ["search", "hn", "story", "v1", "flight"]);
        assert_eq!(tokens("class news bus is"), ["class", "new", "bus", "is"]);
    }

    #[test]
    fn the_rarer_word_decides() {
        let docs = [Doc::plain("search stories"), Doc::plain("search comments"), Doc::plain("list flights"), Doc::plain("search users")];
        // Each holds one of the two words; the one holding the word fewer hold comes first.
        assert_eq!(order("search flights", &docs), [2, 0, 1, 3]);
    }

    #[test]
    fn a_word_said_counts_for_more_in_a_short_description() {
        let docs = [Doc::plain("search flights by date fare cabin and number of passengers"), Doc::plain("search flights"), Doc::plain("list hotels")];
        assert_eq!(order("flights", &docs), [1, 0]);
    }

    #[test]
    fn a_field_the_answer_holds_finds_a_route_behind_one_that_says_it() {
        let docs = [Doc::new("search stories", ["title", "price"]), Doc::new("list prices", ["sku"]), Doc::new("list users", ["name"])];
        assert_eq!(order("price", &docs), [1, 0]);
        assert_eq!(order("title", &docs), [0]);
    }

    #[test]
    fn a_query_with_no_words_keeps_everything_in_order() {
        let docs = [Doc::plain("b"), Doc::plain("a")];
        assert_eq!(order("", &docs), [0, 1]);
        assert_eq!(order(" ? ", &docs), [0, 1]);
        assert!(order("nothing", &docs).is_empty());
    }
}
