//! Route bodies between nodes (R7.18, R7.19). A body is opaque bytes named by a content identifier: this crate
//! carries it and never reads it. The caller checks what it is served against the content identifier in the signed
//! listing, so a provider can serve a body but can't change one, and the network needs no trust in who serves.
//!
//! - The key a body's providers are recorded under: `/unbrowse/body/<content id>`.
//! - `/unbrowse/body/1`: a caller asks one provider for a body by content id, with a payment the provider's node
//!   judges; the answer is the body or a refusal with its reason.
//! - The bounds both sides hold to. The per-peer rate a node answers at, and its slots, are `budget`'s.

use std::fmt;
use std::future::Future;
use std::io;
use std::time::Duration;

use futures::prelude::*;
use libp2p::kad::RecordKey;
use libp2p::{PeerId, StreamProtocol};

pub const BODY_PROTOCOL: &str = "/unbrowse/body/1";
/// A content identifier is a hash with a short prefix naming its function, so it is short; a longer one isn't one.
pub const MAX_CONTENT_ID_BYTES: usize = 256;
/// A payment is a signed voucher, a few hundred bytes.
pub const MAX_PAYMENT_BYTES: usize = 4 * 1024;
/// A body is a recipe: how to make the call, in text, never what came back. 64 KiB holds the largest recipe by far,
/// and a provider that sends more is cut off unread.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// A refusal's reason, cut to this.
pub const MAX_REASON_BYTES: usize = 512;
/// Providers one lookup returns, at most (R7.18).
pub const MAX_BODY_PROVIDERS: usize = 20;
/// How long a caller waits for a provider's answer, and how long a node gives its own store to find a body: the
/// store's share is shorter, so a slow store is a refusal the caller hears, not a silence.
pub const BODY_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const SERVE_TIMEOUT: Duration = Duration::from_secs(10);

/// The table key a body's providers are recorded under.
pub fn body_key(content_id: &str) -> RecordKey {
    RecordKey::new(&format!("/unbrowse/body/{content_id}"))
}

/// Where a node's bodies come from when a caller asks it for one. The node implements it: it reads the payment,
/// decides whether it pays for the body, and returns the body, or the reason it won't. The network holds no bodies.
pub trait Bodies: Send + Sync + 'static {
    fn serve(&self, from: PeerId, content_id: &str, payment: &[u8]) -> impl Future<Output = Result<Vec<u8>, String>> + Send;
}

/// A node that serves no bodies: every ask is refused.
pub struct NoBodies;

impl Bodies for NoBodies {
    async fn serve(&self, _: PeerId, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
        Err("this node serves no bodies".into())
    }
}

/// Why a fetch brought no body back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The provider answered and wouldn't serve: the payment didn't satisfy it, it doesn't hold the body, or it is
    /// answering too many asks. Its reason, as it gave it.
    Refused(String),
    /// The answer was larger than a body may be, and was cut off unread.
    TooLarge,
    /// The ask itself is out of bounds: a content id or payment longer than the network carries.
    Invalid(String),
    /// No answer: unreachable, timed out, the connection closed, or bytes that aren't an answer.
    Unanswered(String),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::Refused(r) => write!(f, "the provider refused: {r}"),
            FetchError::TooLarge => write!(f, "the provider sent more than {MAX_BODY_BYTES} bytes"),
            FetchError::Invalid(r) => write!(f, "{r}"),
            FetchError::Unanswered(r) => write!(f, "the provider didn't answer: {r}"),
        }
    }
}

impl std::error::Error for FetchError {}

/// The ask on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BodyAsk {
    pub content_id: String,
    pub payment: Vec<u8>,
}

/// The answer on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BodyAnswer {
    Ok { body: Vec<u8> },
    Refused { reason: String },
}

impl BodyAsk {
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.content_id.is_empty() || self.content_id.len() > MAX_CONTENT_ID_BYTES {
            return Err(format!("a content id is 1 to {MAX_CONTENT_ID_BYTES} bytes"));
        }
        if self.payment.len() > MAX_PAYMENT_BYTES {
            return Err(format!("a payment is at most {MAX_PAYMENT_BYTES} bytes"));
        }
        Ok(())
    }
}

impl BodyAnswer {
    /// A refusal, its reason cut to `MAX_REASON_BYTES` on a character boundary.
    pub(crate) fn refused(reason: impl Into<String>) -> BodyAnswer {
        let mut reason = reason.into();
        if reason.len() > MAX_REASON_BYTES {
            let mut end = MAX_REASON_BYTES;
            while !reason.is_char_boundary(end) {
                end -= 1;
            }
            reason.truncate(end);
        }
        BodyAnswer::Refused { reason }
    }

    /// What the node sends for what its store returned. A body past the bound is never sent: the caller would cut it
    /// off anyway, so the node refuses it and spends nothing carrying it.
    pub(crate) fn of(served: Result<Vec<u8>, String>) -> BodyAnswer {
        match served {
            Ok(body) if body.len() > MAX_BODY_BYTES => BodyAnswer::refused(format!("the body is larger than {MAX_BODY_BYTES} bytes")),
            Ok(body) => BodyAnswer::Ok { body },
            Err(reason) => BodyAnswer::refused(reason),
        }
    }
}

/// Bytes, not JSON: a body is raw bytes, and JSON would write each byte as a number. An ask is the content id's
/// length in two bytes, the content id, then the payment to the end; an answer is one byte, 0 for a body and 1 for a
/// refusal, then the body or the reason to the end. Each side reads at most one byte past its bound, so a peer that
/// sends more is cut off there.
#[derive(Clone, Default)]
pub(crate) struct BodyCodec;

/// An answer that ran past the bound. Carried inside the io error, so the node can tell it from a broken stream.
#[derive(Debug)]
pub(crate) struct Oversized;

impl fmt::Display for Oversized {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "more than the protocol carries")
    }
}

impl std::error::Error for Oversized {}

pub(crate) fn is_oversized(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<Oversized>())
}

/// Reads to the end of the stream, at most `max` bytes; one past that is an `Oversized` error.
pub(crate) async fn read_bounded<T: AsyncRead + Unpin + Send>(io: &mut T, max: usize) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    io.take(max as u64 + 1).read_to_end(&mut buf).await?;
    if buf.len() > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, Oversized));
    }
    Ok(buf)
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

const ASK_MAX: usize = 2 + MAX_CONTENT_ID_BYTES + MAX_PAYMENT_BYTES;
const ANSWER_MAX: usize = 1 + MAX_BODY_BYTES;

pub(crate) fn decode_ask(bytes: &[u8]) -> io::Result<BodyAsk> {
    let (len, rest) = bytes.split_first_chunk::<2>().ok_or_else(|| bad("an ask too short"))?;
    let len = u16::from_be_bytes(*len) as usize;
    if len > rest.len() {
        return Err(bad("an ask too short"));
    }
    let (id, payment) = rest.split_at(len);
    let ask = BodyAsk { content_id: String::from_utf8(id.to_vec()).map_err(|_| bad("a content id that isn't text"))?, payment: payment.to_vec() };
    ask.check().map_err(|e| bad(&e))?;
    Ok(ask)
}

pub(crate) fn encode_ask(ask: &BodyAsk) -> io::Result<Vec<u8>> {
    ask.check().map_err(|e| bad(&e))?;
    let mut out = Vec::with_capacity(2 + ask.content_id.len() + ask.payment.len());
    out.extend_from_slice(&(ask.content_id.len() as u16).to_be_bytes());
    out.extend_from_slice(ask.content_id.as_bytes());
    out.extend_from_slice(&ask.payment);
    Ok(out)
}

pub(crate) fn decode_answer(bytes: &[u8]) -> io::Result<BodyAnswer> {
    match bytes.split_first() {
        Some((0, body)) => Ok(BodyAnswer::Ok { body: body.to_vec() }),
        Some((1, reason)) => Ok(BodyAnswer::refused(String::from_utf8_lossy(reason).into_owned())),
        _ => Err(bad("an answer that isn't one")),
    }
}

pub(crate) fn encode_answer(answer: &BodyAnswer) -> Vec<u8> {
    match answer {
        BodyAnswer::Ok { body } => [&[0u8][..], body].concat(),
        BodyAnswer::Refused { reason } => [&[1u8][..], reason.as_bytes()].concat(),
    }
}

impl libp2p::request_response::Codec for BodyCodec {
    type Protocol = StreamProtocol;
    type Request = BodyAsk;
    type Response = BodyAnswer;

    async fn read_request<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<BodyAsk> {
        decode_ask(&read_bounded(io, ASK_MAX).await?)
    }

    async fn read_response<T: AsyncRead + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T) -> io::Result<BodyAnswer> {
        decode_answer(&read_bounded(io, ANSWER_MAX).await?)
    }

    async fn write_request<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, ask: BodyAsk) -> io::Result<()> {
        io.write_all(&encode_ask(&ask)?).await?;
        io.close().await
    }

    async fn write_response<T: AsyncWrite + Unpin + Send>(&mut self, _: &StreamProtocol, io: &mut T, answer: BodyAnswer) -> io::Result<()> {
        io.write_all(&encode_answer(&answer)).await?;
        io.close().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::request_response::Codec as _;

    fn proto() -> StreamProtocol {
        StreamProtocol::new(BODY_PROTOCOL)
    }

    #[tokio::test]
    async fn an_ask_and_its_answers_cross_the_wire_unchanged() {
        let ask = BodyAsk { content_id: "sha256:abc".into(), payment: vec![0, 1, 2, 255] };
        let mut wire = Vec::new();
        BodyCodec.write_request(&proto(), &mut futures::io::Cursor::new(&mut wire), ask.clone()).await.unwrap();
        assert_eq!(BodyCodec.read_request(&proto(), &mut &wire[..]).await.unwrap(), ask);
        for answer in [BodyAnswer::Ok { body: b"{\"method\":\"GET\"}".to_vec() }, BodyAnswer::Ok { body: vec![] }, BodyAnswer::refused("unpaid")] {
            let mut wire = Vec::new();
            BodyCodec.write_response(&proto(), &mut futures::io::Cursor::new(&mut wire), answer.clone()).await.unwrap();
            assert_eq!(BodyCodec.read_response(&proto(), &mut &wire[..]).await.unwrap(), answer);
        }
    }

    /// A provider that sends more than a body may hold is cut off one byte past the bound, however much it sends.
    #[tokio::test]
    async fn an_answer_past_the_bound_is_cut_off_unread() {
        let flood = encode_answer(&BodyAnswer::Ok { body: vec![b'x'; 10 * MAX_BODY_BYTES] });
        let mut reader = &flood[..];
        let e = BodyCodec.read_response(&proto(), &mut reader).await.unwrap_err();
        assert!(is_oversized(&e), "{e}");
        assert_eq!(flood.len() - reader.len(), ANSWER_MAX + 1, "read stops one byte past the bound");
        // Exactly at the bound is a body.
        let full = encode_answer(&BodyAnswer::Ok { body: vec![b'x'; MAX_BODY_BYTES] });
        assert!(matches!(BodyCodec.read_response(&proto(), &mut &full[..]).await.unwrap(), BodyAnswer::Ok { body } if body.len() == MAX_BODY_BYTES));
    }

    #[test]
    fn an_ask_out_of_bounds_is_never_read_or_sent() {
        let long_id = BodyAsk { content_id: "c".repeat(MAX_CONTENT_ID_BYTES + 1), payment: vec![] };
        let long_payment = BodyAsk { content_id: "c".into(), payment: vec![0; MAX_PAYMENT_BYTES + 1] };
        let empty = BodyAsk { content_id: String::new(), payment: vec![] };
        for ask in [long_id, long_payment, empty] {
            assert!(encode_ask(&ask).is_err());
            let mut raw = (ask.content_id.len() as u16).to_be_bytes().to_vec();
            raw.extend_from_slice(ask.content_id.as_bytes());
            raw.extend_from_slice(&ask.payment);
            assert!(decode_ask(&raw).is_err());
        }
        assert!(decode_ask(&[0, 9, b'a']).is_err(), "a length past the bytes sent");
        assert!(decode_answer(&[]).is_err() && decode_answer(&[7, 1]).is_err());
    }

    #[test]
    fn a_body_past_the_bound_is_refused_not_sent_and_a_long_reason_is_cut() {
        assert!(matches!(BodyAnswer::of(Ok(vec![0; MAX_BODY_BYTES + 1])), BodyAnswer::Refused { .. }));
        assert_eq!(BodyAnswer::of(Ok(vec![1; 3])), BodyAnswer::Ok { body: vec![1; 3] });
        let BodyAnswer::Refused { reason } = BodyAnswer::of(Err("é".repeat(MAX_REASON_BYTES))) else { panic!() };
        assert!(reason.len() <= MAX_REASON_BYTES && reason.chars().all(|c| c == 'é'));
    }
}
