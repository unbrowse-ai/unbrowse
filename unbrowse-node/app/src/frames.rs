//! Pictures of what the node's browser sees while it walks a page (a learn, or a heal's re-walk), for the owner's
//! window. The engine's screencast hands over a few JPEG frames a second; the node keeps only the latest per walk,
//! and the last one stays as the walk's poster. Only a few walks' posters are kept: memory stays a few hundred KB.
//!
//! The window is told a picture is ready with a small `frame` event (the walk, a sequence number, the size) and
//! fetches the bytes itself with `GET /owner/frame?walk=…`: pictures never ride the event stream.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use unbrowse_learn::screencast::{Frame, FrameSink};
use serde::Serialize;
use crate::sync::Locked;

/// Walks whose last picture is kept.
const KEPT: usize = 4;

/// A picture is ready: what the `frame` event carries. Never a URL, a header or a cookie.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FrameNote {
    pub walk: String,
    pub seq: u64,
    pub w: u32,
    pub h: u32,
    /// The page as the walk settled: the walk's poster.
    pub settled: bool,
}

struct Shot {
    walk: String,
    seq: u64,
    jpeg: Vec<u8>,
}

/// The latest picture of each of the last few walks, newest walk first.
#[derive(Clone, Default)]
pub struct Frames(Arc<Mutex<VecDeque<Shot>>>);

impl Frames {
    /// Keeps `f` as walk `walk`'s latest picture; returns what to tell the window.
    pub fn put(&self, walk: &str, f: Frame) -> FrameNote {
        let mut shots = self.0.locked();
        let seq = match shots.iter().position(|s| s.walk == walk) {
            Some(i) => {
                let mut s = shots.remove(i).expect("position is in range");
                s.seq += 1;
                s.jpeg = f.jpeg;
                let seq = s.seq;
                shots.push_front(s);
                seq
            }
            None => {
                shots.push_front(Shot { walk: walk.to_string(), seq: 1, jpeg: f.jpeg });
                shots.truncate(KEPT);
                1
            }
        };
        FrameNote { walk: walk.to_string(), seq, w: f.width, h: f.height, settled: f.settled }
    }

    /// Walk `walk`'s latest picture (its JPEG), or the newest walk's when `walk` is empty.
    pub fn get(&self, walk: &str) -> Option<Vec<u8>> {
        let shots = self.0.locked();
        shots.iter().find(|s| walk.is_empty() || s.walk == walk).map(|s| s.jpeg.clone())
    }

    /// Bytes held, for the tests' memory bound.
    #[cfg(test)]
    fn held(&self) -> usize {
        self.0.locked().iter().map(|s| s.jpeg.len()).sum()
    }

    /// A sink for walk `walk`'s pictures: each one is kept and `tell` is told. The thread that takes them ends
    /// when the walk drops its sink.
    pub fn follow(&self, walk: &str, tell: impl Fn(FrameNote) + Send + 'static) -> FrameSink {
        let (tx, rx) = std::sync::mpsc::channel::<Frame>();
        let frames = self.clone();
        let walk = walk.to_string();
        std::thread::spawn(move || {
            for f in rx {
                tell(frames.put(&walk, f));
            }
        });
        tx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(n: u8) -> Frame {
        Frame { jpeg: vec![n; 1000], width: 640, height: 400, settled: false }
    }

    #[test]
    fn only_the_latest_picture_of_the_last_few_walks_is_kept() {
        let f = Frames::default();
        assert_eq!(f.put("a", frame(1)).seq, 1);
        assert_eq!(f.put("a", frame(2)).seq, 2);
        assert_eq!(f.get("a").unwrap()[0], 2);
        for w in ["b", "c", "d", "e"] {
            f.put(w, frame(3));
        }
        assert!(f.get("a").is_none(), "the oldest walk's poster goes");
        assert_eq!(f.held(), KEPT * 1000);
        f.put("e", frame(9));
        assert_eq!(f.get("").unwrap()[0], 9, "an empty walk asks for the newest");
    }

    #[test]
    fn a_followed_walk_tells_each_picture_and_ends_with_its_sink() {
        let f = Frames::default();
        let (told_tx, told) = std::sync::mpsc::channel();
        let sink = f.follow("w", move |n| told_tx.send(n).unwrap());
        sink.send(frame(1)).unwrap();
        sink.send(Frame { settled: true, ..frame(2) }).unwrap();
        drop(sink);
        let notes: Vec<FrameNote> = told.iter().collect();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[1], FrameNote { walk: "w".into(), seq: 2, w: 640, h: 400, settled: true });
        let text = serde_json::to_string(&notes[1]).unwrap();
        assert_eq!(text, r#"{"walk":"w","seq":2,"w":640,"h":400,"settled":true}"#);
        assert_eq!(f.get("w").unwrap()[0], 2);
    }
}
