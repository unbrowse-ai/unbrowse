//! Coverage for the owner's yes: what a failing file does to a question, and what no longer shows in one.

use super::*;

fn keys() -> unbrowse_core::MemoryStore {
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    keys
}

#[test]
fn a_passphrase_file_that_does_not_read_is_why_a_shell_question_could_not_be_asked() {
    let _home = store::scratch_home("dialog-bad-passphrase");
    std::fs::write(passphrase_file(), "not a record").unwrap();
    let said = ask_blocking(&keys(), "Show the vault?").unwrap_err();
    assert!(said.contains("the node couldn't show one (a test shows no dialog)"), "{said}");
    assert!(said.contains("isn't an owner passphrase"), "{said}");
    assert!(said.ends_with("nothing was done"), "{said}");
}

#[test]
fn a_shell_question_with_no_passphrase_set_says_how_to_set_one() {
    let _home = store::scratch_home("dialog-no-passphrase");
    let said = ask_blocking(&keys(), "Show the vault?").unwrap_err();
    assert!(said.contains("unbrowse-node passphrase"), "{said}");
}

#[test]
fn a_payment_approver_that_cannot_be_put_back_to_the_dialog_is_said() {
    let _home = store::scratch_home("dialog-approver-stuck");
    // Something in the file's place that can't be removed as a file.
    std::fs::create_dir(approver_file()).unwrap();
    let said = set_payment_approver(&keys(), "dialog", "test").unwrap_err();
    assert!(said.contains("owner.payment-approver"), "{said}");
}

#[test]
fn answers_from_another_device_that_cannot_be_turned_off_are_said() {
    let _home = store::scratch_home("dialog-remote-stuck");
    std::fs::create_dir(remote_answers_file()).unwrap();
    let said = set_remote_answers(&keys(), false, "test").unwrap_err();
    assert!(said.contains("owner.remote-answers"), "{said}");
}

#[test]
fn a_passphrase_that_cannot_be_read_as_a_file_is_said_not_taken_as_none() {
    let _home = store::scratch_home("dialog-passphrase-dir");
    std::fs::create_dir(passphrase_file()).unwrap();
    assert!(passphrase(&keys()).is_err(), "a folder is not an unset passphrase");
}

#[test]
fn text_a_dialog_would_show_other_than_it_reads_is_left_out_of_a_question() {
    // Invisible formatting in the far planes (tags, musical and Egyptian format controls, shorthand) never reaches the owner.
    let sly = "a\u{E0041}b\u{1D173}c\u{13430}d\u{1BCA0}e\u{110BD}f\u{2066}g";
    assert_eq!(plain(sly), "abcdefg");
    assert!(hidden('\u{E0001}') && hidden('\u{0600}') && hidden('\u{08E2}') && !hidden('a'));
}
