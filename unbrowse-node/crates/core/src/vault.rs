//! Payment cards, for the payment step of a checkout.
//!
//! The app keeps a card beside the root key, the way it keeps a password (`app/src/vault.rs`, `Keep`), and agents
//! name one only by reference: `vault:card:<label>:<field>`. This module says what a card is, reads one the owner
//! enters, and gives each field as a checkout form takes it. What may be said about a card without saying it is its
//! label and its last four digits. Nothing here touches a keystore, and nothing here ever leaves the machine (FR-4).

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// A payment card the node holds for checkout forms. The site sees these values; an agent sees only references,
/// and a route body keeps the reference at its `Class::Input { secret: true }`, never the value.
///
/// Its verification value is kept only when the owner chose to keep card security codes (#185): card rules (PCI DSS)
/// forbid keeping one after authorisation, even encrypted, so by default the owner types it at each checkout.
#[derive(Clone, Debug, Default, Serialize, Deserialize, zeroize::Zeroize)]
pub struct Card {
    /// The primary account number, as digits (no spaces).
    pub number: String,
    /// MM/YY.
    pub expiry: String,
    /// The three or four digit verification value, or empty: none is kept unless the owner turned on keeping card
    /// security codes. Left out of what is kept when empty, so a card without one holds no trace of the field.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cvv: String,
    /// The name as it appears on the card.
    pub name: String,
}

/// One field of a card, as a checkout form asks for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardField {
    /// The card number, digits only.
    Number,
    /// MM/YY.
    Expiry,
    /// MM.
    Month,
    /// YYYY.
    Year,
    /// YY.
    ShortYear,
    Cvv,
    Name,
}

impl CardField {
    pub fn parse(s: &str) -> Option<CardField> {
        Some(match s {
            "number" => CardField::Number,
            "expiry" => CardField::Expiry,
            "month" => CardField::Month,
            "year" => CardField::Year,
            "yy" => CardField::ShortYear,
            "cvv" => CardField::Cvv,
            "name" => CardField::Name,
            _ => return None,
        })
    }

    /// The field as a reference names it.
    pub fn name(self) -> &'static str {
        match self {
            CardField::Number => "number",
            CardField::Expiry => "expiry",
            CardField::Month => "month",
            CardField::Year => "year",
            CardField::ShortYear => "yy",
            CardField::Cvv => "cvv",
            CardField::Name => "name",
        }
    }

    /// Whether the field's value is what makes a card spendable: the number, the verification value and the expiry
    /// together. Anything the browser says back has these said as their reference; a month, a year or a name alone is
    /// left as the page wrote it, since replacing every "12" or a name in a page would garble what the agent reads.
    pub fn is_secret(self) -> bool {
        matches!(self, CardField::Number | CardField::Cvv | CardField::Expiry)
    }
}

impl Card {
    /// A card as the owner entered it: the number with any spaces or dashes, the expiry as MM/YY, MM/YYYY or MMYY.
    /// Refuses a number that fails its check digit (ISO/IEC 7812), an expiry that isn't a month, or a verification
    /// value that isn't three or four digits, so a typo is caught when the card is kept, not at a checkout. `cvv` is
    /// `None` when the vault keeps no security codes; then a name that is only digits is refused too, since a script
    /// that still sends the code in that place would have it kept as the name.
    pub fn read(number: &str, expiry: &str, cvv: Option<&str>, name: &str) -> Result<Card, String> {
        let digits: String = number.chars().filter(|c| !matches!(c, ' ' | '-')).collect();
        if !(12..=19).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) || !luhn(&digits) {
            return Err("that isn't a card number: check the digits".into());
        }
        let e: String = expiry.chars().filter(|c| !c.is_whitespace()).collect();
        let (mm, yy) = match e.split_once('/') {
            Some((m, y)) => (m.to_string(), y.to_string()),
            None if e.len() == 4 => (e[..2].to_string(), e[2..].to_string()),
            None => return Err("enter the expiry as MM/YY".into()),
        };
        let yy = match yy.len() {
            2 => yy,
            4 if yy.starts_with("20") => yy[2..].to_string(),
            _ => return Err("enter the expiry as MM/YY".into()),
        };
        let month: u8 = mm.parse().map_err(|_| "enter the expiry as MM/YY")?;
        if !(1..=12).contains(&month) || !yy.bytes().all(|b| b.is_ascii_digit()) {
            return Err("enter the expiry as MM/YY".into());
        }
        let name = name.trim();
        let cvv = match cvv.map(str::trim) {
            Some(cvv) if !(3..=4).contains(&cvv.len()) || !cvv.bytes().all(|b| b.is_ascii_digit()) => {
                return Err("the security code is the 3 or 4 digits on the card".into());
            }
            Some(cvv) => cvv.to_string(),
            None if !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()) => {
                return Err("that isn't a name: the vault keeps no security code, so give the number, the expiry and the name on the card".into());
            }
            None => String::new(),
        };
        Ok(Card { number: digits, expiry: format!("{month:02}/{yy}"), cvv, name: name.to_string() })
    }

    /// The last four digits: what the owner is shown to tell their cards apart, and all an agent ever learns of one.
    pub fn last4(&self) -> String {
        self.number.chars().skip(self.number.len().saturating_sub(4)).collect()
    }

    /// Whether the card holds its verification value.
    pub fn has_code(&self) -> bool {
        !self.cvv.is_empty()
    }

    /// One field, as the form takes it. None for the verification value of a card kept without one.
    pub fn field(&self, f: CardField) -> Option<Zeroizing<String>> {
        if f == CardField::Cvv && !self.has_code() {
            return None;
        }
        let (mm, yy) = self.expiry.split_once('/').unwrap_or(("", ""));
        Some(Zeroizing::new(match f {
            CardField::Number => self.number.clone(),
            CardField::Expiry => self.expiry.clone(),
            CardField::Month => mm.to_string(),
            CardField::Year => format!("20{yy}"),
            CardField::ShortYear => yy.to_string(),
            CardField::Cvv => self.cvv.clone(),
            CardField::Name => self.name.clone(),
        }))
    }
}

/// The card number's check digit (the Luhn algorithm).
fn luhn(digits: &str) -> bool {
    let sum: u32 = digits
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| {
            let d = u32::from(b - b'0');
            if i % 2 == 1 { if d * 2 > 9 { d * 2 - 9 } else { d * 2 } } else { d }
        })
        .sum();
    sum.is_multiple_of(10)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_card() -> Card {
        Card::read("4242 4242 4242 4242", "12/2028", Some("123"), " Lewis Tham ").unwrap()
    }

    #[test]
    fn a_card_is_read_as_the_owner_typed_it() {
        let c = test_card();
        assert_eq!((c.number.as_str(), c.expiry.as_str(), c.cvv.as_str(), c.name.as_str()), ("4242424242424242", "12/28", "123", "Lewis Tham"));
        assert_eq!(Card::read("4242-4242-4242-4242", "1228", Some("1234"), "").unwrap().expiry, "12/28");
        assert_eq!(Card::read("4242424242424242", "3/29", Some("123"), "").unwrap().expiry, "03/29");
    }

    #[test]
    fn a_typo_is_caught_when_the_card_is_kept() {
        assert!(Card::read("4242424242424241", "12/28", Some("123"), "").is_err(), "check digit");
        assert!(Card::read("4242", "12/28", Some("123"), "").is_err(), "too short");
        assert!(Card::read("4242424242424242", "13/28", Some("123"), "").is_err(), "no 13th month");
        assert!(Card::read("4242424242424242", "12/1928", Some("123"), "").is_err());
        assert!(Card::read("4242424242424242", "12-28", Some("123"), "").is_err());
        assert!(Card::read("4242424242424242", "12/28", Some("12"), "").is_err(), "security code");
        assert!(Card::read("4242424242424242", "12/28", Some("12a"), "").is_err());
    }

    #[test]
    fn each_field_is_given_as_a_form_takes_it() {
        let c = test_card();
        let f = |n: &str| c.field(CardField::parse(n).unwrap()).unwrap().to_string();
        assert_eq!([f("number"), f("expiry"), f("month"), f("year"), f("yy"), f("cvv"), f("name")], ["4242424242424242", "12/28", "12", "2028", "28", "123", "Lewis Tham"]);
        assert_eq!(c.last4(), "4242");
        assert_eq!(CardField::parse("pin"), None);
        for n in ["number", "expiry", "month", "year", "yy", "cvv", "name"] {
            assert_eq!(CardField::parse(n).unwrap().name(), n);
        }
    }

    /// With security codes not kept, a card is read without one and keeps nothing of the field; a card kept with one
    /// gives it back, and holds no trace of it once it is cleared.
    #[test]
    fn a_card_read_without_a_code_holds_none() {
        let c = Card::read("4242424242424242", "12/28", None, "Lewis Tham").unwrap();
        let kept = serde_json::to_string(&c).unwrap();
        assert!(!kept.contains("cvv") && !c.has_code() && c.field(CardField::Cvv).is_none(), "{kept}");
        assert!(Card::read("4242424242424242", "12/28", None, "123").is_err(), "a code sent where the name goes isn't kept as the name");
        let mut old: Card = serde_json::from_str(r#"{"number":"4242424242424242","expiry":"12/28","cvv":"123","name":"Lewis Tham"}"#).unwrap();
        assert_eq!(old.field(CardField::Cvv).unwrap().as_str(), "123");
        old.cvv.clear();
        assert!(!serde_json::to_string(&old).unwrap().contains("123"));
    }

    #[test]
    fn only_what_makes_a_card_spendable_is_said_as_its_reference() {
        assert!(CardField::Number.is_secret() && CardField::Cvv.is_secret() && CardField::Expiry.is_secret());
        assert!(!CardField::Month.is_secret() && !CardField::Year.is_secret() && !CardField::Name.is_secret());
    }

    #[test]
    fn a_card_round_trips_as_json() {
        let card = Zeroizing::new(test_card());
        let bytes = Zeroizing::new(serde_json::to_vec(&*card).unwrap());
        let back: Card = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.number, card.number);
        assert_eq!(back.expiry, card.expiry);
    }
}
