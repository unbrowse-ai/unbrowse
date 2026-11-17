//! Tests the check runner must judge right: one that passes, one that fails, one that only runs when asked for.

#[cfg(test)]
mod tests {
    #[test]
    fn a_test_that_passes() {}

    #[test]
    fn a_test_that_fails() {
        panic!("the runner must refuse this");
    }

    #[test]
    #[ignore = "runs only when the runner asks for ignored tests"]
    fn a_test_that_needs_asking_for() {}
}
