//! The heap the node's tests run on, counted for the thread that asks ([`peak_of`]): a test holds a piece of work to
//! the most it keeps allocated at once. Only the asking thread's allocations count, so tests running beside it on
//! other threads change nothing; a free of what was allocated before the count started counts as nothing freed.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counted;

#[global_allocator]
static HEAP: Counted = Counted;

thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
    static HELD: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

fn grew(n: usize) {
    let _ = COUNTING.try_with(|on| {
        if on.get() {
            let held = HELD.with(|h| {
                h.set(h.get() + n);
                h.get()
            });
            PEAK.with(|p| p.set(p.get().max(held)));
        }
    });
}

fn shrank(n: usize) {
    let _ = COUNTING.try_with(|on| {
        if on.get() {
            HELD.with(|h| h.set(h.get().saturating_sub(n)));
        }
    });
}

// SAFETY: every call goes to the system allocator unchanged; the counting beside it touches only this thread's cells.
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        shrank(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            shrank(layout.size());
            grew(new_size);
        }
        p
    }
}

/// What `work` returns, and the most this thread held allocated at once while it ran, in bytes.
pub fn peak_of<T>(work: impl FnOnce() -> T) -> (T, usize) {
    HELD.with(|h| h.set(0));
    PEAK.with(|p| p.set(0));
    COUNTING.with(|on| on.set(true));
    let out = work();
    COUNTING.with(|on| on.set(false));
    (out, PEAK.with(Cell::get))
}

#[cfg(test)]
mod tests {
    /// The count sees what a piece of work holds at once, not what it allocated in all.
    #[test]
    fn the_count_is_the_most_held_at_once() {
        let (_, peak) = super::peak_of(|| {
            for _ in 0..8 {
                drop(std::hint::black_box(vec![0u8; 1 << 20]));
            }
        });
        assert!((1 << 20..2 << 20).contains(&peak), "eight 1 MiB buffers one after another held {peak} at once");
        let (kept, peak) = super::peak_of(|| (0..8).map(|_| std::hint::black_box(vec![0u8; 1 << 20])).collect::<Vec<_>>());
        assert_eq!(kept.len(), 8);
        assert!(peak >= 8 << 20, "eight 1 MiB buffers kept together held {peak} at once");
    }
}
