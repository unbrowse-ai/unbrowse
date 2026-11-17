//! List the browser profiles a site refused, which the engine set aside under `refused/` (`core/src/session.rs`
//! `replace_profile`). Any one may hold a sign-in, so nothing removes them on its own, `--fix` included: this shows
//! each with its size and age, and the owner removes what they don't want.

use agent_browser_core::session::{set_aside_profiles, SetAside};

use super::helpers::human_size;
use super::{Check, Status};

pub(super) fn check(checks: &mut Vec<Check>) {
    let index = agent_browser_core::paths::set_aside_index();
    checks.extend(set_aside_checks(&set_aside_profiles(&index, std::time::SystemTime::now())));
}

/// One line per profile set aside, and one saying how many there are and how to remove one. Info, never a warning:
/// a profile kept is the engine doing what it should, and how long to keep it is the owner's choice.
fn set_aside_checks(kept: &[SetAside]) -> Vec<Check> {
    let category = "Profiles set aside";
    if kept.is_empty() {
        return vec![Check::new("profiles.set_aside", category, Status::Pass, "No refused profiles kept")];
    }
    let total: u64 = kept.iter().map(|k| k.bytes).sum();
    let mut checks = vec![Check::new(
        "profiles.set_aside",
        category,
        Status::Info,
        format!(
            "{} refused profile(s) kept, {} in all. Each may hold a sign-in, so none is removed for you",
            kept.len(),
            human_size(total)
        ),
    )
    .with_fix("remove one you don't want with: rm -rf <path>")];
    for (n, k) in kept.iter().enumerate() {
        checks.push(Check::new(
            format!("profiles.set_aside.{n}"),
            category,
            Status::Info,
            format!("{}  {}, set aside {}", k.path.display(), human_size(k.bytes), age(k.age_secs)),
        ));
    }
    checks
}

fn age(secs: u64) -> String {
    match secs {
        s if s < 3_600 => "within the hour".to_string(),
        s if s < 86_400 => format!("{} hour(s) ago", s / 3_600),
        s => format!("{} day(s) ago", s / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn doctor_lists_each_refused_profile_with_its_size_and_age() {
        let kept = [
            SetAside { path: PathBuf::from("/p/refused/a.example.100"), bytes: 3 * 1024 * 1024, age_secs: 9 * 86_400 },
            SetAside { path: PathBuf::from("/p/refused/b.example.200"), bytes: 512, age_secs: 2 * 3_600 },
        ];
        let checks = set_aside_checks(&kept);
        assert_eq!(checks.len(), 3);
        assert!(checks.iter().all(|c| c.status == Status::Info), "a kept profile is never a warning or a failure");
        assert!(checks[0].message.starts_with("2 refused profile(s) kept, 3.0 MB in all"), "{}", checks[0].message);
        assert_eq!(checks[1].message, "/p/refused/a.example.100  3.0 MB, set aside 9 day(s) ago");
        assert_eq!(checks[2].message, "/p/refused/b.example.200  512 B, set aside 2 hour(s) ago");

        let none = set_aside_checks(&[]);
        assert_eq!((none.len(), none[0].status), (1, Status::Pass));
    }

    /// `--fix` repairs by check id; none of these ids is one it acts on, so it never removes a profile.
    #[test]
    fn doctor_fix_never_removes_a_refused_profile() {
        let dir = tempfile::tempdir().unwrap();
        let kept = dir.path().join("refused").join("a.example.100");
        std::fs::create_dir_all(&kept).unwrap();
        let mut checks = set_aside_checks(&[SetAside { path: kept.clone(), bytes: 1, age_secs: 400 * 86_400 }]);
        let mut fixed = Vec::new();
        super::super::fix::run(&mut checks, &mut fixed);
        assert!(fixed.is_empty(), "{fixed:?}");
        assert!(kept.exists());
    }
}
