//! Watchtowers for unclaimed lines. A voucher for epoch e can be claimed only through e + 1, and a payer's receipt
//! lines live on its own machine, so a payer whose node is off for two epochs would lose its payees their pay. A claim
//! is authorised by the payer agent's signature, not by who sends it, so a node hands each stream's signed vouchers and
//! lines to peers in advance, and any of them can claim what is still unclaimed as the window is about to close. A
//! tower can only cause a claim: the contract checks the signatures and pays the lines' own payees.
//!
//! - `/unbrowse/tower/1`: a node hands one peer what it would have claimed, as opaque bytes; the answer is that the
//!   peer holds it, or a refusal with its reason. This crate carries the bytes and never reads them.
//! - `Towers`: where a node keeps what it was handed. The node implements it: it checks the signatures and holds the
//!   lines in a bounded store, or says why it won't.
//! - The bounds both sides hold to, and the per-peer rate a node takes hand-overs at.

use std::future::Future;
use std::io;
use std::time::Duration;

use futures::prelude::*;
use libp2p::request_response::{self, OutboundRequestId, ResponseChannel};
use libp2p::{PeerId, StreamProtocol};
use tokio::sync::oneshot;

use crate::body::read_bounded;
use crate::budget::{PerPeer, Rate};

pub const TOWER_PROTOCOL: &str = "/unbrowse/tower/1";
/// One hand-over is one stream's lines, each with its voucher and proof: about a kilobyte a line, so 256 KiB holds a
/// few hundred. A node with more hands them over in parts.
pub const MAX_HANDED_BYTES: usize = 256 * 1024;
/// A refusal's reason, cut to this.
pub const MAX_REASON_BYTES: usize = 512;
/// How long a node waits for a tower's answer, and how long a tower gives its own store to check and keep what it was
/// handed (the check reads the chain): the store's share is shorter, so a slow store is a refusal, not a silence.
pub const TOWER_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const HOLD_TIMEOUT: Duration = Duration::from_secs(20);
/// Hand-overs a node checks at once, from every peer together; one past this is refused at once.
pub(crate) const MAX_HOLDING: usize = 8;
/// How often one peer may hand this node lines: a node hands each stream over when it grows, at most once a pass of
/// its claim loop, so a burst covers a node's streams and a slow refill covers its growth.
pub(crate) const TOWER_RATE: Rate = Rate { burst: 16.0, per_second: 0.2, peers: 1024 };

/// Where a node keeps the lines peers hand it. The node implements it: it checks what it was handed and keeps it, or
/// returns why it won't. The network holds nothing.
pub trait Towers: Send + Sync + 'static {
    fn hold(&self, from: PeerId, handed: &[u8]) -> impl Future<Output = Result<(), String>> + Send;
}

/// A node that watches for no one: every hand-over is refused.
pub struct NoTowers;

impl Towers for NoTowers {
    async fn hold(&self, _: PeerId, _: &[u8]) -> Result<(), String> {
        Err("this node watches for no one".into())
    }
}

/// Why a hand-over wasn't taken.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandError {
    /// The tower answered and won't hold the lines: they don't check, its store is full, or it is taking too many.
    /// Its reason, as it gave it.
    Refused(String),
    /// More than one hand-over carries; nothing was sent.
    TooLarge,
    /// No answer: unreachable, timed out, the connection closed, or bytes that aren't an answer.
    Unanswered(String),
}

impl std::fmt::Display for HandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandError::Refused(r) => write!(f, "the tower refused: {r}"),
            HandError::TooLarge => write!(f, "a hand-over is at most {MAX_HANDED_BYTES} bytes"),
            HandError::Unanswered(r) => write!(f, "the tower didn't answer: {r}"),
        }
    }
}

impl std::error::Error for HandError {}

/// The answer on the wire: one byte, 0 for held and 1 for a refusal, then the reason to the end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TowerAnswer {
    Held,
    Refused { reason: String },
}

impl TowerAnswer {
    /// A refusal, its reason cut to `MAX_REASON_BYTES` on a character boundary.
    pub(crate) fn refused(reason: impl Into<String>) -> TowerAnswer {
        let mut reason = reason.into();
        if reason.len() > MAX_REASON_BYTES {
            let mut end = MAX_REASON_BYTES;
            while !reason.is_char_boundary(end) {
                end -= 1;
            }
            reason.truncate(end);
        }
        TowerAnswer::Refused { reason }
    }

    fn of(held: Result<(), String>) -> TowerAnswer {
        match held {
            Ok(()) => TowerAnswer::Held,
            Err(reason) => TowerAnswer::refused(reason),
        }
    }
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

pub(crate) fn encode_answer(answer: &TowerAnswer) -> Vec<u8> {
    match answer {
        TowerAnswer::Held => vec![0],
        TowerAnswer::Refused { reason } => [&[1u8][..], reason.as_bytes()].concat(),
    }
}

pub(crate) fn decode_answer(bytes: &[u8]) -> io::Result<TowerAnswer> {
    match bytes.split_first() {
        Some((0, [])) => Ok(TowerAnswer::Held),
        Some((1, reason)) => Ok(TowerAnswer::refused(String::from_utf8_lossy(reason).into_owned())),
        _ => Err(bad("an answer that isn't one")),
    }
}

/// Bytes, as the body protocol's are: the hand-over is the request to its end, and each side reads at most one byte
/// past its bound.
#[derive(Clone, Default)]
pub(crate) struct TowerCodec;

impl request_response::Codec for TowerCodec {
    type Protocol = StreamProtocol;
    type Request = Vec<u8>;
    type Response = TowerAnswer;

    async fn read_request<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<Vec<u8>> {
        read_bounded(io, MAX_HANDED_BYTES).await
    }

    async fn read_response<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<TowerAnswer> {
        decode_answer(&read_bounded(io, 1 + MAX_REASON_BYTES).await?)
    }

    async fn write_request<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, handed: Vec<u8>) -> io::Result<()> {
        if handed.len() > MAX_HANDED_BYTES {
            return Err(bad("a hand-over past the bound"));
        }
        io.write_all(&handed).await?;
        io.close().await
    }

    async fn write_response<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, answer: TowerAnswer) -> io::Result<()> {
        io.write_all(&encode_answer(&answer)).await?;
        io.close().await
    }
}

pub(crate) type Handing = oneshot::Sender<Result<TowerAnswer, request_response::OutboundFailure>>;

/// The swarm's side of the protocol: hand-overs this node sent and waits on, those it is checking, and how often each
/// peer may hand it more.
pub(crate) struct Desk {
    pub(crate) handing: std::collections::HashMap<OutboundRequestId, Handing>,
    holding: usize,
    rate: PerPeer,
}

impl Desk {
    pub(crate) fn new() -> Desk {
        Desk { handing: Default::default(), holding: 0, rate: PerPeer::new(TOWER_RATE) }
    }

    /// A check of a hand-over has finished and its answer is going out.
    pub(crate) fn answered(&mut self) {
        self.holding = self.holding.saturating_sub(1);
    }
}

/// A hand-over being checked: however the check ends, its answer goes out and the place it holds among the checks
/// running is given back. A `Towers` that panics would otherwise hold that place for good.
struct Holding<F: FnOnce(ResponseChannel<TowerAnswer>, TowerAnswer)>(Option<(F, ResponseChannel<TowerAnswer>)>);

impl<F: FnOnce(ResponseChannel<TowerAnswer>, TowerAnswer)> Holding<F> {
    fn answer(mut self, answer: TowerAnswer) {
        if let Some((tell, channel)) = self.0.take() {
            tell(channel, answer);
        }
    }
}

impl<F: FnOnce(ResponseChannel<TowerAnswer>, TowerAnswer)> Drop for Holding<F> {
    fn drop(&mut self) {
        if let Some((tell, channel)) = self.0.take() {
            tell(channel, TowerAnswer::refused("the tower failed checking the lines"));
        }
    }
}

/// One event of the protocol. A hand-over from a peer past its rate, or one past the checks running at once, is
/// refused at once; any other is checked by `towers` off the swarm's loop, and its answer goes back through `answer`.
pub(crate) fn event<T: Towers>(
    behaviour: &mut request_response::Behaviour<TowerCodec>,
    desk: &mut Desk,
    towers: &std::sync::Arc<T>,
    answer: impl FnOnce(ResponseChannel<TowerAnswer>, TowerAnswer) + Send + 'static,
    e: request_response::Event<Vec<u8>, TowerAnswer>,
) {
    match e {
        request_response::Event::Message { peer, message: request_response::Message::Request { request, channel, .. }, .. } => {
            let busy = if !desk.rate.take(peer, std::time::Instant::now()) {
                Some("too many hand-overs from this peer; hand them over later")
            } else if desk.holding >= MAX_HOLDING {
                Some("too many hand-overs at once; hand them over later")
            } else {
                None
            };
            if let Some(reason) = busy {
                let _ = behaviour.send_response(channel, TowerAnswer::refused(reason));
                return;
            }
            desk.holding += 1;
            let (towers, holding) = (towers.clone(), Holding(Some((answer, channel))));
            tokio::spawn(async move {
                let held = tokio::time::timeout(HOLD_TIMEOUT, towers.hold(peer, &request)).await.unwrap_or_else(|_| Err("the tower didn't check the lines in time".into()));
                holding.answer(TowerAnswer::of(held));
            });
        }
        request_response::Event::Message { message: request_response::Message::Response { request_id, response }, .. } => {
            if let Some(reply) = desk.handing.remove(&request_id) {
                let _ = reply.send(Ok(response));
            }
        }
        request_response::Event::OutboundFailure { request_id, error, .. } => {
            if let Some(reply) = desk.handing.remove(&request_id) {
                let _ = reply.send(Err(error));
            }
        }
        _ => {}
    }
}

/// What the node hears for an answer, or for the failure that stood in for one.
pub(crate) fn heard(answer: Result<TowerAnswer, request_response::OutboundFailure>) -> Result<(), HandError> {
    match answer {
        Ok(TowerAnswer::Held) => Ok(()),
        Ok(TowerAnswer::Refused { reason }) => Err(HandError::Refused(reason)),
        Err(e) => Err(HandError::Unanswered(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::request_response::Codec as _;

    fn proto() -> StreamProtocol {
        StreamProtocol::new(TOWER_PROTOCOL)
    }

    #[tokio::test]
    async fn a_hand_over_and_its_answers_cross_the_wire_unchanged() {
        let handed = br#"[{"payer":"0x01"}]"#.to_vec();
        let mut wire = Vec::new();
        TowerCodec.write_request(&proto(), &mut futures::io::Cursor::new(&mut wire), handed.clone()).await.unwrap();
        assert_eq!(TowerCodec.read_request(&proto(), &mut &wire[..]).await.unwrap(), handed);
        for answer in [TowerAnswer::Held, TowerAnswer::refused("the store is full")] {
            let mut wire = Vec::new();
            TowerCodec.write_response(&proto(), &mut futures::io::Cursor::new(&mut wire), answer.clone()).await.unwrap();
            assert_eq!(TowerCodec.read_response(&proto(), &mut &wire[..]).await.unwrap(), answer);
        }
    }

    /// A hand-over past the bound is never sent, and one a peer sends anyway is cut off one byte past it, unread.
    #[tokio::test]
    async fn a_hand_over_past_the_bound_is_never_sent_or_read() {
        let flood = vec![b'x'; MAX_HANDED_BYTES + 1];
        let mut wire = Vec::new();
        assert!(TowerCodec.write_request(&proto(), &mut futures::io::Cursor::new(&mut wire), flood.clone()).await.is_err());
        assert!(wire.is_empty(), "nothing was written");
        let more = vec![b'x'; 4 * MAX_HANDED_BYTES];
        let mut reader = &more[..];
        assert!(TowerCodec.read_request(&proto(), &mut reader).await.is_err());
        assert_eq!(more.len() - reader.len(), MAX_HANDED_BYTES + 1, "read stops one byte past the bound");
        assert_eq!(TowerCodec.read_request(&proto(), &mut &flood[..MAX_HANDED_BYTES]).await.unwrap().len(), MAX_HANDED_BYTES, "exactly at the bound is a hand-over");
    }

    #[test]
    fn a_refusal_is_cut_to_its_bound_and_an_answer_is_one_of_two() {
        let long = "é".repeat(MAX_REASON_BYTES);
        let TowerAnswer::Refused { reason } = TowerAnswer::refused(long) else { panic!() };
        assert!(reason.len() <= MAX_REASON_BYTES && reason.chars().all(|c| c == 'é'));
        assert!(decode_answer(&[]).is_err() && decode_answer(&[7]).is_err() && decode_answer(&[0, 1]).is_err());
    }
}
