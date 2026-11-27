//! Coverage tests for `hands.rs`: what the owner is told when a page they typed a secret into fails.

use super::*;

#[test]
fn a_secret_typed_into_a_page_that_failed_is_told_to_the_owner_with_the_reason() {
    store::scratch_home("hands-cov-forget");
    let why = format!("the page went away {}", "x".repeat(300));
    forget_failed("shop.example", &why);
    let told = store::read_activity(20).into_iter().find(|a| a.site == "shop.example" && a.kind == "hands").expect("the owner is told");
    assert_eq!((told.who.as_str(), told.result.as_str()), ("You", "failed"));
    assert!(told.what.contains("may still be in the node's walk record"));
    assert_eq!(told.note.as_deref().map(|n| n.chars().count()), Some(200), "the reason is kept to 200 characters");
    assert!(told.note.unwrap().starts_with("the page went away"));
}

#[test]
fn a_program_is_on_the_path_only_when_a_file_of_that_name_is() {
    assert!(!which("no-such-program-unbrowse-cov"));
}
