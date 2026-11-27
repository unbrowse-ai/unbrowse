//! What a reply is read to have come to (`outcome`), for the replies and failures its own tests leave open.

use super::*;

fn of(tool: &str, v: Value) -> (Outcome, &'static str) {
    let s = outcome_of(tool, &v);
    (s.outcome, s.from)
}

#[test]
fn a_browse_that_needs_the_owners_hands_says_so_and_one_that_ran_answered() {
    assert_eq!(of("unbrowse_browse", json!({ "needs_owner": true })), (Outcome::NeedsHands, "browse.needs_owner"));
    assert_eq!(of("unbrowse_browse", json!({ "needs_owner": true, "owner": "done" })), (Outcome::NeedsHands, "browse.needs_owner"), "the need comes first");
    assert_eq!(of("unbrowse_browse", json!({ "owner": "done" })), (Outcome::Answered, "owner"));
    assert_eq!(of("unbrowse_browse", json!({ "owner": "declined" })), (Outcome::NeedsPerson, "owner"));
    assert_eq!(of("unbrowse_browse", json!({ "ok": true })), (Outcome::Answered, "browse.ran"));
}

#[test]
fn a_challenge_that_asks_nothing_answered_and_any_other_asks_to_be_looked_at_again() {
    assert_eq!(of("unbrowse_challenge", json!({ "asks": false })), (Outcome::Answered, "challenge.asks"));
    let said = outcome_of("unbrowse_challenge", &json!({ "asks": true, "site": "shop.example" }));
    assert_eq!((said.outcome, said.from), (Outcome::Challenge, "challenge.asks"));
    assert_eq!(said.next, Some(json!({ "tool": "unbrowse_challenge", "args": { "action": "look", "site": "shop.example" } })));
    assert_eq!(outcome_of("unbrowse_challenge", &json!({})).outcome, Outcome::Challenge, "no word of it is a challenge still");
}

#[test]
fn a_tool_the_node_has_no_reader_for_is_taken_as_answered_and_unread() {
    assert_eq!(of("unbrowse_search", json!({ "anything": 1 })), (Outcome::Answered, "unread"));
}

#[test]
fn pages_still_pending_are_still_working_even_when_one_answered() {
    let answered = json!({ "outcome": "answered" });
    let v = json!({ "pages": [answered], "pending": ["https://b.example"] });
    let said = of_pages(&v);
    assert_eq!((said.outcome, said.from), (Outcome::StillWorking, "pages.pending"));
    assert_eq!(of("unbrowse_do", json!({ "how": "pages", "pages": [answered], "pending": [] })), (Outcome::Answered, "pages"));
}

#[test]
fn pages_none_of_which_answered_come_to_what_the_first_page_came_to() {
    let v = json!({ "pages": [{ "outcome": "gone" }, { "outcome": "call_failed" }], "pending": [] });
    assert_eq!(of_pages(&v).outcome, Outcome::Gone);
}

#[test]
fn no_pages_at_all_is_no_route() {
    assert_eq!(of_pages(&json!({})).outcome, Outcome::NoRoute);
    assert_eq!(of_pages(&json!({ "pages": [{ "no": "outcome" }] })).outcome, Outcome::NoRoute, "a first page that says nothing says nothing");
}

#[test]
fn a_403_or_408_is_the_owners_to_give_while_browsing_and_a_refusal_or_a_stop_otherwise() {
    assert_eq!(of_failure("unbrowse_browse", StatusCode::FORBIDDEN, "x").outcome, Outcome::NeedsPerson);
    assert_eq!(of_failure("unbrowse_challenge", StatusCode::FORBIDDEN, "x").outcome, Outcome::NeedsPerson);
    assert_eq!(of_failure("unbrowse_call", StatusCode::FORBIDDEN, "x").outcome, Outcome::NotAllowed);
    assert_eq!(of_failure("unbrowse_browse", StatusCode::REQUEST_TIMEOUT, "x").outcome, Outcome::NeedsPerson);
    assert_eq!(of_failure("unbrowse_call", StatusCode::REQUEST_TIMEOUT, "x").outcome, Outcome::Stopped);
    assert_eq!(of_failure("unbrowse_browse", StatusCode::NOT_FOUND, "x").outcome, Outcome::CallFailed, "a page not found while browsing is no missing route");
    assert_eq!(of_failure("unbrowse_do", StatusCode::NOT_FOUND, "x").outcome, Outcome::NoRoute);
}

#[test]
fn a_503_is_a_pause_only_in_the_pauses_own_words() {
    assert_eq!(of_failure("unbrowse_do", StatusCode::SERVICE_UNAVAILABLE, PAUSED).outcome, Outcome::Paused);
    assert_eq!(of_failure("unbrowse_do", StatusCode::SERVICE_UNAVAILABLE, "the vault is down").outcome, Outcome::CallFailed);
    let waiting = of_failure("unbrowse_do", StatusCode::SERVICE_UNAVAILABLE, crate::WAITING_FOR_KEY);
    assert_eq!((waiting.outcome, waiting.from), (Outcome::NeedsPerson, "node.locked"));
}

#[test]
fn a_failed_call_ends_what_called_it_as_the_calls_status_reads() {
    let f = Failed::of_call((StatusCode::PAYMENT_REQUIRED, "the budget is spent".into()));
    assert_eq!(f.status, StatusCode::PAYMENT_REQUIRED);
    let said = f.said.unwrap();
    assert_eq!((said.outcome, said.from), (Outcome::BudgetSpent, "call.status"));
}

#[test]
fn a_reply_is_stamped_with_what_it_came_to_once_and_a_failure_by_its_status() {
    let mut ok: Result<Value, Failed> = Ok(json!({ "ok": true, "data": { "n": 1 }, "truncated": null }));
    stamp("unbrowse_call", &mut ok);
    assert_eq!(ok.as_ref().unwrap()["outcome"], "answered");
    let mut said_already: Result<Value, Failed> = Ok(json!({ "outcome": "refused" }));
    stamp("unbrowse_call", &mut said_already);
    assert_eq!(said_already.unwrap()["outcome"], "refused", "what a reply already says stays");
    let mut failed: Result<Value, Failed> = Err(Failed::from((StatusCode::GONE, "gone for good".into())));
    stamp("unbrowse_do", &mut failed);
    assert_eq!(failed.unwrap_err().said.map(|s| s.outcome), Some(Outcome::Gone));
    let kept = Said::new(Outcome::Refused, "own");
    let mut own: Result<Value, Failed> = Err(Failed::new(StatusCode::GONE, "x", kept));
    stamp("unbrowse_do", &mut own);
    assert_eq!(own.unwrap_err().said.map(|s| s.outcome), Some(Outcome::Refused), "a failure that said what it came to keeps it");
    let mut other: Result<Value, Failed> = Ok(json!({ "n": 1 }));
    stamp("unbrowse_search", &mut other);
    assert!(other.unwrap().get("outcome").is_none(), "a tool that isn't one of the four is left as it is");
}

#[test]
fn a_failures_body_carries_what_it_came_to_what_stood_in_the_way_and_the_ask() {
    let mut f = Failed::new(StatusCode::CONFLICT, "bad", Said::new(Outcome::BadRequest, "status").then("unbrowse_search", json!({ "q": "x" })));
    f.why = Some("a check stood in the way".into());
    f.ask = Some("ask-1".into());
    let body = failure_body(json!({ "error": "bad", "next": "stale" }), &f);
    assert_eq!(body["outcome"], "bad_request");
    assert_eq!(body["outcome_from"], "status");
    assert_eq!(body["next"], json!({ "tool": "unbrowse_search", "args": { "q": "x" } }));
    assert_eq!((body["why"].as_str(), body["ask"].as_str()), (Some("a check stood in the way"), Some("ask-1")));
    let bare = failure_body(json!({ "error": "bad", "next": "stale" }), &Failed::from((StatusCode::CONFLICT, "bad".into())));
    assert_eq!(bare, json!({ "error": "bad", "next": "stale" }), "a failure that said nothing adds nothing");
    let mut nextless = json!({ "next": "stale" });
    Said::new(Outcome::Answered, "x").put(&mut nextless);
    assert!(nextless.get("next").is_none(), "no call to make next leaves no next");
    let mut not_object = json!([1]);
    Said::new(Outcome::Answered, "x").put(&mut not_object);
    assert_eq!(not_object, json!([1]));
}

#[test]
fn the_sandbox_readers_a_do_repeats_are_named_and_the_rest_are_its_results() {
    use unbrowse_learn::sandbox::Unheld;
    assert_eq!(unheld_from(&Unheld::NoRuntime), "sandbox.no_runtime");
    assert_eq!(unheld_from(&Unheld::Lacks("x".into())), "sandbox.lacks");
    assert_eq!(unheld_from(&Unheld::NotConfined("x".into())), "sandbox.not_confined");
    let said = unheld_said(&Unheld::NoRuntime);
    assert_eq!((said.outcome, said.from), (Outcome::CallFailed, "sandbox.no_runtime"));
    let v = json!({ "how": "called", "result": { "ok": false, "outcome": "call_failed", "outcome_from": "sandbox.lacks" } });
    assert_eq!(of("unbrowse_do", v), (Outcome::CallFailed, "sandbox.lacks"));
    let v = json!({ "how": "called", "result": { "ok": false, "outcome": "call_failed", "outcome_from": "something.else" } });
    assert_eq!(of("unbrowse_do", v), (Outcome::CallFailed, "result.outcome"), "a reader a do can't say again");
    assert_eq!(of("unbrowse_do", json!({ "how": "browse" })), (Outcome::NeedsHands, "unread"));
}

#[test]
fn what_the_sandbox_held_back_tells_the_owner_what_they_can_do_for_each_cause() {
    use unbrowse_learn::sandbox::Unheld;
    let none = held_back(&Unheld::NoRuntime);
    assert_eq!(none["outcome_from"], "sandbox.no_runtime");
    assert!(none["owner_can"].as_str().unwrap().contains("install a JavaScript runtime"));
    assert!(none["meanwhile"].as_str().unwrap().contains("browser \"auto\""));
    let lacks = held_back_with(&Unheld::Lacks("fetch".into()), "the browser reads it");
    assert!(lacks["owner_can"].as_str().unwrap().contains("a newer Node"));
    assert_eq!(lacks["meanwhile"], "the browser reads it");
    let loose = held_back(&Unheld::NotConfined("net".into()));
    assert!(loose["owner_can"].as_str().unwrap().contains("where that layer holds"));
}

#[test]
fn an_answer_that_lists_nothing_for_what_was_asked_is_marked_answered_empty_unless_it_was_cut() {
    let mut empty = json!({ "ok": true, "data": { "query": "zq", "results": [] }, "truncated": null });
    answered_with(&mut empty, &["zq".to_string()]);
    assert_eq!(empty["outcome"], "answered_empty");
    let mut cut = json!({ "ok": true, "data": { "query": "zq", "results": [] }, "truncated": { "at": 10 } });
    answered_with(&mut cut, &["zq".to_string()]);
    assert!(cut.get("outcome").is_none(), "a cut answer is left to its own fields");
    let mut failed = json!({ "ok": false, "data": { "query": "zq", "results": [] } });
    answered_with(&mut failed, &["zq".to_string()]);
    assert!(failed.get("outcome").is_none());
    assert_eq!(of("unbrowse_call", json!({ "ok": true, "truncated": { "at": 1 }, "data": [1] })), (Outcome::AnsweredCut, "call.truncated"));
    assert_eq!(of("unbrowse_call", json!({ "ok": false })), (Outcome::CallFailed, "call.ok"));
}
