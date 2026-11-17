//! Surviving a panic: locks that outlive one, and background loops that start again after one.
//!
//! A `std::sync` lock is poisoned when a thread panics while holding it, and `.lock().unwrap()` then panics in every
//! later caller. The node keeps its state for tabs, asks, walks and the chain in process-wide locks, so one panicking
//! request poisoned the lock it held, and each request after it that touched the same state panicked as well, until
//! the node restarted. A guard taken here ignores the poison and hands back the state as the panicking thread left it.
//! Every value kept behind these locks stays usable after a partial update: a list may lack an entry it was about to
//! gain, and the next caller rebuilds or retries it, as it would after a restart.
//!
//! The node's background loops (claims, pricing and holds; joining the peer network; agent grants) each ran as one
//! spawned task, and a panic in any pass ended that task for the rest of the node's life with nothing said: a node
//! whose claim loop panicked once stopped claiming, and lines its agents' payers signed passed their window unpaid.
//! `keep_running` runs such a loop and starts it again after a panic.

use std::future::Future;
use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

/// `lock()` for a `Mutex`, without poisoning.
pub trait Locked<T: ?Sized> {
    fn locked(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> Locked<T> for Mutex<T> {
    fn locked(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `read()` and `write()` for an `RwLock`, without poisoning.
pub trait Shared<T: ?Sized> {
    fn reading(&self) -> RwLockReadGuard<'_, T>;
    fn writing(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> Shared<T> for RwLock<T> {
    fn reading(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn writing(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The wait before a loop that panicked starts again, doubling each time it panics again, up to `RESTART_WAIT_MAX`, so a
/// loop that panics at once on every start doesn't spin.
const RESTART_WAIT: Duration = Duration::from_secs(5);
const RESTART_WAIT_MAX: Duration = Duration::from_secs(300);

/// Runs the loop `start` makes until it returns. A panic in it is said on stderr (and reported, where reports are
/// on, by the panic hook `report::start` sets), and a new one is started after a wait. A loop that returns, or whose
/// task is cancelled, isn't started again.
pub async fn keep_running<F, Fut>(what: &'static str, start: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()> + Send + 'static,
{
    keep_running_after(what, RESTART_WAIT, start).await
}

async fn keep_running_after<F, Fut>(what: &'static str, first_wait: Duration, mut start: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()> + Send + 'static,
{
    let mut wait = first_wait;
    loop {
        match tokio::spawn(start()).await {
            Err(e) if e.is_panic() => {
                eprintln!("{what}: panicked; starting it again in {}s", wait.as_secs());
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(RESTART_WAIT_MAX);
            }
            _ => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poison<T: Send + Sync>(m: &'static Mutex<T>) {
        let _ = std::thread::spawn(move || {
            let _held = m.lock();
            panic!("a request panics while it holds the lock");
        })
        .join();
        assert!(m.is_poisoned());
    }

    #[test]
    fn a_lock_a_panic_poisoned_still_opens() {
        static LIST: Mutex<Vec<u32>> = Mutex::new(Vec::new());
        LIST.locked().push(1);
        poison(&LIST);
        LIST.locked().push(2);
        assert_eq!(*LIST.locked(), vec![1, 2]);
    }

    #[test]
    fn a_shared_lock_a_panic_poisoned_still_reads_and_writes() {
        static ON: RwLock<bool> = RwLock::new(false);
        let _ = std::thread::spawn(|| {
            let _held = ON.write();
            panic!("a writer panics");
        })
        .join();
        assert!(ON.is_poisoned());
        *ON.writing() = true;
        assert!(*ON.reading());
    }

    #[tokio::test]
    async fn a_loop_that_panics_starts_again() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static STARTS: AtomicU32 = AtomicU32::new(0);
        keep_running_after("a test loop", Duration::ZERO, || async {
            if STARTS.fetch_add(1, Ordering::SeqCst) < 2 {
                panic!("a pass panics");
            }
        })
        .await;
        assert_eq!(STARTS.load(Ordering::SeqCst), 3, "started again after each of two panics, then left to end");
    }

    #[tokio::test]
    async fn a_loop_that_ends_is_not_started_again() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static STARTS: AtomicU32 = AtomicU32::new(0);
        keep_running_after("a test loop", Duration::ZERO, || async {
            STARTS.fetch_add(1, Ordering::SeqCst);
        })
        .await;
        assert_eq!(STARTS.load(Ordering::SeqCst), 1);
    }
}
