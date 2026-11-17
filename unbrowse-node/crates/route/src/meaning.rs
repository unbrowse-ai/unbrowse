//! What a route's values mean, where the learner found it (`docs/REBUILD.md`, "Next, in order", item 6): the kind of
//! value each slot takes, and which fields of the answer are its records' own, each a pointer into a record.
//!
//! A kind is read from what the ways do with the slot before anything is asked of a proposer: a slot a way reads as a
//! date is a date, one a way looks up in the site's table is one of the site's own words. A slot none of that says
//! anything of has no kind here; a proposer may name it later, and the site is the judge of what is sent.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The kind of value a slot takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A day of the calendar.
    Date,
    /// A time of day.
    Time,
    /// A day and a time of it.
    Moment,
    /// A number.
    Number,
    /// One of the words the site lists (its places, its categories): the slot's choices are what it lists.
    Listed,
    /// Free text: a word or a phrase, sent as written.
    Text,
    /// A place's name (a city, a country), where a proposer said so of a slot the ways say only is free text, and
    /// every walk's value of it bears it out (`learn.proposer`).
    Place,
}

/// The answer's records: the list in the answer step's reply that holds them, and each field a record carries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Records {
    /// Where the list sits in the reply's JSON, a pointer.
    pub list: String,
    pub fields: Vec<Field>,
}

/// One field of a record: a name, and where it sits in the record, a pointer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub name: String,
    pub at: String,
    /// The slot whose value this field says back on every walk: what the records were asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub says: Option<String>,
}

/// What a route's values mean.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Meaning {
    /// Each slot's kind, by its name, where one was found.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub kinds: BTreeMap<String, Kind>,
    /// The answer's records, where its reply holds a list of them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub records: Option<Records>,
}

impl Meaning {
    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty() && self.records.is_none()
    }
}
