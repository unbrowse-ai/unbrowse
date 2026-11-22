//! Unbrowse fork: `eval --timeout <ms> <script>` gives a script longer than a page command's 30 s.
//!
//! The flag is read here; the script runs in the caller's own world, given that long (`world::eval`).

/// Takes `--timeout <ms>` off the front of `eval`'s arguments. Err when it isn't a number of milliseconds.
pub fn timeout_flag<'a>(rest: &[&'a str]) -> Result<(Option<u64>, Vec<&'a str>), ()> {
    if rest.first() != Some(&"--timeout") {
        return Ok((None, rest.to_vec()));
    }
    let ms = rest.get(1).and_then(|v| v.parse::<u64>().ok()).filter(|ms| *ms > 0).ok_or(())?;
    Ok((Some(ms), rest[2..].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `--timeout` is read only at the front, where the node puts it; a script may hold the word itself.
    #[test]
    fn eval_takes_its_time_from_the_front_of_its_arguments() {
        assert_eq!(timeout_flag(&["--timeout", "120000", "document.title"]), Ok((Some(120_000), vec!["document.title"])));
        assert_eq!(timeout_flag(&["document.title", "--timeout", "5"]), Ok((None, vec!["document.title", "--timeout", "5"])));
        assert!(timeout_flag(&["--timeout", "soon", "document.title"]).is_err());
        assert!(timeout_flag(&["--timeout", "0", "1"]).is_err());
    }
}
