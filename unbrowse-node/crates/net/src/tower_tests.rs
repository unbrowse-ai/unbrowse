//! What `tower.rs` says in words and hears of a failed hand-over, beyond the wire tests beside it.

use super::*;

#[test]
fn each_way_a_hand_over_fails_is_told_in_its_own_words() {
    assert_eq!(HandError::Refused("the lines don't check".into()).to_string(), "the tower refused: the lines don't check");
    assert_eq!(HandError::TooLarge.to_string(), format!("a hand-over is at most {MAX_HANDED_BYTES} bytes"));
    assert_eq!(HandError::Unanswered("timed out".into()).to_string(), "the tower didn't answer: timed out");
}

#[test]
fn a_hand_over_that_met_a_failure_not_an_answer_is_unanswered() {
    assert_eq!(heard(Ok(TowerAnswer::Held)), Ok(()));
    assert_eq!(heard(Ok(TowerAnswer::refused("full"))), Err(HandError::Refused("full".into())));
    let said = heard(Err(request_response::OutboundFailure::Timeout)).unwrap_err();
    assert!(matches!(&said, HandError::Unanswered(r) if r.to_lowercase().contains("timeout") || r.contains("time")), "{said}");
    assert!(matches!(heard(Err(request_response::OutboundFailure::ConnectionClosed)), Err(HandError::Unanswered(_))));
}

#[test]
fn a_refusal_cut_inside_a_character_is_cut_before_it_not_through_it() {
    let reason = format!("a{}", "é".repeat(MAX_REASON_BYTES));
    let TowerAnswer::Refused { reason: cut } = TowerAnswer::refused(reason) else { panic!("a refusal stays one") };
    assert_eq!(cut.len(), MAX_REASON_BYTES - 1);
    assert!(cut.starts_with('a') && cut[1..].chars().all(|c| c == 'é'));
}
