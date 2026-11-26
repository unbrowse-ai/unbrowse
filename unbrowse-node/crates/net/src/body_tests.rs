//! What `body.rs` says in words and refuses by its bounds, beyond the wire tests beside it.

use super::*;

#[test]
fn a_refusal_cut_inside_a_character_is_cut_before_it_not_through_it() {
    // One byte of ASCII puts every two-byte "é" across the odd offsets, so the bound falls inside one.
    let reason = format!("a{}", "é".repeat(MAX_REASON_BYTES));
    let BodyAnswer::Refused { reason: cut } = BodyAnswer::refused(reason) else { panic!("a refusal stays one") };
    assert_eq!(cut.len(), MAX_REASON_BYTES - 1, "the last whole character that fits");
    assert!(cut.starts_with('a') && cut[1..].chars().all(|c| c == 'é'));
}

#[test]
fn a_short_refusal_is_kept_whole() {
    assert_eq!(BodyAnswer::refused("no such body"), BodyAnswer::Refused { reason: "no such body".into() });
}

#[test]
fn each_way_a_fetch_fails_is_told_in_its_own_words() {
    assert_eq!(FetchError::Refused("unpaid".into()).to_string(), "the provider refused: unpaid");
    assert_eq!(FetchError::TooLarge.to_string(), format!("the provider sent more than {MAX_BODY_BYTES} bytes"));
    assert_eq!(FetchError::Invalid("a content id past the bound".into()).to_string(), "a content id past the bound");
    assert_eq!(FetchError::Unanswered("timed out".into()).to_string(), "the provider didn't answer: timed out");
}

#[test]
fn a_node_that_serves_no_bodies_refuses_every_ask_and_says_so() {
    let said = futures::executor::block_on(NoBodies.serve(PeerId::random(), "sha256:ab", b"paid")).unwrap_err();
    assert_eq!(said, "this node serves no bodies");
}

#[test]
fn an_oversized_answer_is_told_from_a_broken_stream_by_its_error() {
    let oversized = io::Error::other(Oversized);
    assert!(is_oversized(&oversized));
    assert_eq!(oversized.to_string(), "more than the protocol carries");
    assert!(!is_oversized(&io::Error::new(io::ErrorKind::UnexpectedEof, "cut off")));
}
