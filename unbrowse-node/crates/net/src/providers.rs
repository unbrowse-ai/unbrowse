//! Which of a body's providers a caller still tries (R7.20). A provider that answers nothing, or serves a body that
//! doesn't match its content identifier, is set aside for that body on R7.12's doubling schedule: on its `k`-th
//! failure, `min(2^(k-1), 32)` epochs. It is set aside for that body only: one stale copy says nothing about the
//! others it serves.
//!
//! The caller passes the epoch in, so the schedule is the same on every node and in tests. Whether a count ever
//! resets is open in R7.12; here a good serve clears it, and a caller that wants counts kept never calls `served`.
//!
//! A caller that opens the schedule on a file (`Providers::open`) keeps it across restarts: a node that restarts
//! still skips the providers it set aside, rather than learning again, one timeout each, which of them are gone. The
//! file is small and versioned (`load_kept`, `save_kept`, in `unbrowse_files::SET_ASIDE`): one that is torn,
//! unreadable or too large reads as empty, so it can cost a lookup a retry but never blocks one, and one a newer node
//! wrote reads as empty too and is never written over.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use libp2p::PeerId;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// The longest a provider is set aside for, in epochs (R7.12's `P`).
pub const MAX_EXCLUSION: u64 = 32;

/// The epochs a provider is set aside for on its `k`-th failure: one, then two, four and so on, up to 32.
pub fn exclusion(k: u32) -> u64 {
    if k == 0 {
        return 0;
    }
    1u64.checked_shl(k - 1).unwrap_or(u64::MAX).min(MAX_EXCLUSION)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Strikes {
    count: u32,
    /// The first epoch it is tried again in.
    until: u64,
}

/// Failures by (content id, provider), and the file they are kept in, if any.
#[derive(Clone, Debug, Default)]
pub struct Providers {
    strikes: HashMap<(String, PeerId), Strikes>,
    kept: Option<PathBuf>,
}

/// One provider set aside, as the file keeps it.
#[derive(Serialize, Deserialize)]
struct KeptStrike {
    body: String,
    peer: String,
    count: u32,
    until: u64,
}

impl Providers {
    /// A schedule kept in memory only.
    pub fn new() -> Providers {
        Providers::default()
    }

    /// The schedule kept at `path`, as it was last saved there, and saved there on every change.
    pub fn open(path: impl Into<PathBuf>) -> Providers {
        let path = path.into();
        let mut strikes = HashMap::new();
        for k in load_kept::<KeptStrike>(&path, &unbrowse_files::SET_ASIDE) {
            let Ok(peer) = k.peer.parse::<PeerId>() else { continue };
            if k.count > 0 && !k.body.is_empty() && k.body.len() <= crate::MAX_CONTENT_ID_BYTES {
                strikes.insert((k.body, peer), Strikes { count: k.count, until: k.until });
            }
        }
        let mut p = Providers { strikes, kept: Some(path) };
        p.bound();
        p
    }

    /// `peer` answered nothing for `content_id`, or served a body that didn't match, in `epoch`. It is set aside from
    /// `epoch` through the end of its exclusion, and tried again in the epoch `until` returns. A failure while it is
    /// already set aside counts nothing: calls running at once, each trying it before the first came back, are one
    /// failure of the schedule, and a burst must not cost it the longest exclusion.
    pub fn failed(&mut self, content_id: &str, peer: PeerId, epoch: u64) -> u64 {
        let s = self.strikes.entry((content_id.to_string(), peer)).or_insert(Strikes { count: 0, until: 0 });
        if epoch < s.until {
            return s.until;
        }
        s.count = s.count.saturating_add(1);
        s.until = epoch.saturating_add(exclusion(s.count));
        let until = s.until;
        self.bound();
        self.save();
        until
    }

    /// `peer` served a body for `content_id` that matched: its count clears.
    pub fn served(&mut self, content_id: &str, peer: PeerId) {
        if self.strikes.remove(&(content_id.to_string(), peer)).is_some() {
            self.save();
        }
    }

    /// The failures counted against `peer` for `content_id`.
    pub fn failures(&self, content_id: &str, peer: PeerId) -> u32 {
        self.strikes.get(&(content_id.to_string(), peer)).map_or(0, |s| s.count)
    }

    /// Whether `peer` is set aside for `content_id` in `epoch`.
    pub fn excluded(&self, content_id: &str, peer: PeerId, epoch: u64) -> bool {
        self.strikes.get(&(content_id.to_string(), peer)).is_some_and(|s| epoch < s.until)
    }

    /// The providers of `content_id` to try in `epoch`, in the order given, without those set aside.
    pub fn usable(&self, content_id: &str, providers: impl IntoIterator<Item = PeerId>, epoch: u64) -> Vec<PeerId> {
        providers.into_iter().filter(|p| !self.excluded(content_id, *p, epoch)).collect()
    }

    /// How many (body, provider) pairs have failures counted.
    pub fn len(&self) -> usize {
        self.strikes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.strikes.is_empty()
    }

    /// Forgets every count for `content_id`, as when the caller no longer wants that body.
    pub fn forget(&mut self, content_id: &str) {
        let before = self.strikes.len();
        self.strikes.retain(|(c, _), _| c != content_id);
        if self.strikes.len() != before {
            self.save();
        }
    }

    /// Past `MAX_KEPT` providers set aside, the ones that come back soonest are forgotten first: they are the ones
    /// a caller would try again soonest anyway.
    fn bound(&mut self) {
        while self.strikes.len() > MAX_KEPT {
            let Some(k) = self.strikes.iter().min_by_key(|(_, s)| s.until).map(|(k, _)| k.clone()) else { break };
            self.strikes.remove(&k);
        }
    }

    fn save(&self) {
        let Some(path) = &self.kept else { return };
        let items: Vec<KeptStrike> =
            self.strikes.iter().map(|((body, peer), s)| KeptStrike { body: body.clone(), peer: peer.to_string(), count: s.count, until: s.until }).collect();
        save_kept(path, &unbrowse_files::SET_ASIDE, &items);
    }
}

/// Items one kept schedule holds, at most.
pub const MAX_KEPT: usize = 2048;
/// The most bytes a kept schedule's file is read up to; a larger one reads as empty.
pub const MAX_KEPT_BYTES: u64 = 1 << 20;

/// The items kept at `path` in `format`: none when the file is missing, torn, unreadable, larger than
/// `MAX_KEPT_BYTES` or written by a newer node. At most `MAX_KEPT` are read.
pub fn load_kept<T: DeserializeOwned>(path: &Path, format: &unbrowse_files::Format) -> Vec<T> {
    use std::io::Read as _;
    let Ok(file) = std::fs::File::open(path) else { return vec![] };
    let mut bytes = Vec::new();
    if file.take(MAX_KEPT_BYTES + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_KEPT_BYTES {
        return vec![];
    }
    format.read_from::<Vec<T>>(path, &bytes).map(|items| items.into_iter().take(MAX_KEPT).collect()).unwrap_or_default()
}

/// Keeps `items` at `path`, whole or not at all: written beside it and renamed over it, so a node stopped mid-write
/// reads the last schedule it saved. Only the first `MAX_KEPT` are kept. A write that fails leaves the last one, and
/// so does a file a newer node wrote, which is never written over.
pub fn save_kept<T: Serialize>(path: &Path, format: &unbrowse_files::Format, items: &[T]) {
    if format.writable(path).is_err() {
        return;
    }
    let Ok(bytes) = format.to_vec(&items[..items.len().min(MAX_KEPT)]) else { return };
    if bytes.len() as u64 > MAX_KEPT_BYTES {
        return;
    }
    let _ = unbrowse_files::private::write(path, &bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_doubles_from_one_epoch_to_the_cap() {
        let schedule: Vec<u64> = (1..=8).map(exclusion).collect();
        assert_eq!(schedule, [1, 2, 4, 8, 16, 32, 32, 32]);
        assert_eq!(exclusion(0), 0);
        assert_eq!(exclusion(u32::MAX), MAX_EXCLUSION);
    }

    #[test]
    fn a_failing_provider_is_set_aside_on_the_doubling_schedule() {
        let mut p = Providers::new();
        let (bad, good) = (PeerId::random(), PeerId::random());
        let body = "sha256:aa";
        // First failure in epoch 10: set aside for epoch 10 only.
        assert_eq!(p.failed(body, bad, 10), 11);
        assert_eq!(p.usable(body, [bad, good], 10), [good]);
        assert_eq!(p.usable(body, [bad, good], 11), [bad, good]);
        // Second, in epoch 11: two epochs. Third, in 13: four.
        assert_eq!(p.failed(body, bad, 11), 13);
        assert!(p.excluded(body, bad, 12) && !p.excluded(body, bad, 13));
        assert_eq!(p.failed(body, bad, 13), 17);
        assert!(p.excluded(body, bad, 16) && !p.excluded(body, bad, 17));
        // Up to 32 epochs, never more.
        let mut epoch = 17;
        for _ in 0..10 {
            epoch = p.failed(body, bad, epoch);
        }
        assert_eq!(p.failures(body, bad), 13);
        assert!(p.excluded(body, bad, epoch - 1));
        assert_eq!(p.failed(body, bad, epoch) - epoch, MAX_EXCLUSION);
    }

    /// Calls running at once all find the provider failing: that is one failure on the schedule, not one each.
    #[test]
    fn a_provider_fails_once_however_many_calls_found_it_failing() {
        let (mut p, bad, body) = (Providers::new(), PeerId::random(), "sha256:aa");
        for _ in 0..6 {
            assert_eq!(p.failed(body, bad, 10), 11);
        }
        assert_eq!(p.failures(body, bad), 1);
        assert_eq!(p.failed(body, bad, 11), 13, "the next epoch's failure is the second");
    }

    #[test]
    fn a_provider_set_aside_for_one_body_still_serves_others() {
        let mut p = Providers::new();
        let peer = PeerId::random();
        p.failed("sha256:aa", peer, 5);
        assert!(p.excluded("sha256:aa", peer, 5));
        assert_eq!(p.usable("sha256:bb", [peer], 5), [peer]);
    }

    #[test]
    fn a_good_serve_clears_the_count_and_forget_clears_a_body() {
        let mut p = Providers::new();
        let (a, b) = (PeerId::random(), PeerId::random());
        p.failed("sha256:aa", a, 1);
        p.failed("sha256:aa", a, 2);
        p.served("sha256:aa", a);
        assert_eq!(p.failures("sha256:aa", a), 0);
        assert_eq!(p.failed("sha256:aa", a, 3), 4, "counted from one again");
        p.failed("sha256:aa", b, 3);
        p.failed("sha256:bb", b, 3);
        p.forget("sha256:aa");
        assert_eq!((p.failures("sha256:aa", a), p.failures("sha256:aa", b), p.failures("sha256:bb", b)), (0, 0, 1));
    }

    /// The set-aside file as the first nodes to keep one wrote it still reads.
    #[test]
    fn a_set_aside_file_as_first_written_still_reads() {
        let dir = std::env::temp_dir().join(format!("unbrowse-set-aside-old-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("set-aside.json");
        std::fs::copy(unbrowse_files::fixture(&unbrowse_files::SET_ASIDE), &path).unwrap();
        let p = Providers::open(&path);
        let peer: PeerId = "12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN".parse().unwrap();
        let body = format!("sha256:{}", "ab".repeat(32));
        assert!(p.excluded(&body, peer, 8) && !p.excluded(&body, peer, 9));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
