//! Binary bodies opened into fields with no schema: a protobuf message in its wire format, the same inside gRPC-web's
//! framing (in bytes, or as text in base64), and MessagePack.
//!
//! A reader is kept only where what it read, written back, is the very bytes it read: a reading that loses anything
//! (a varint written longer than it needs, a float of the other width, a field a schema would know the type of) is no
//! reading, and the body stays one opaque value. What a reader opens is JSON, so each field is a place like a JSON
//! body's leaf, by pointer, and a body is written by filling the leaves and encoding the tree again.
//!
//! The trees:
//! - protobuf: a list of fields, each `{"n": <field number>, ...}` with one of `"int"` (a varint, as a number),
//!   `"text"` (a length-delimited UTF-8 text), `"msg"` (a length-delimited message, as a list), `"b64"` (other
//!   length-delimited bytes), `"x64"` and `"x32"` (fixed eight and four bytes, in hex);
//! - gRPC-web: a list of frames, each `{"flag": <byte>}` with `"msg"` (a message frame, as a protobuf list) or
//!   `"b64"` (a frame that is not one: trailers);
//! - MessagePack: the value as JSON, where every map's keys are texts and no integer or float is written in a
//!   width other than the narrowest one that holds it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// How a binary body is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Codec {
    /// A protobuf message in its wire format.
    Protobuf,
    /// gRPC-web's frames around protobuf messages, in bytes.
    GrpcWeb,
    /// gRPC-web's frames as text, in base64.
    GrpcWebText,
    /// MessagePack.
    Msgpack,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// Bytes as a route file writes them: base64.
fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

fn varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut v: u64 = 0;
    for shift in (0..64).step_by(7) {
        let b = *bytes.get(*at)?;
        *at += 1;
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

fn put_varint(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// A text a person or a program reads: UTF-8 with no control character but the usual white space.
fn a_text(bytes: &[u8]) -> Option<&str> {
    let s = std::str::from_utf8(bytes).ok()?;
    (!s.is_empty() && s.chars().all(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))).then_some(s)
}

/// A protobuf message read with no schema, field by field. None where the bytes are no message: a wire type that is
/// none of the four, a field number of nought, a length past the end.
fn read_message(bytes: &[u8], depth: usize) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let key = varint(bytes, &mut at)?;
        let (n, wire) = (key >> 3, key & 7);
        if n == 0 || n > 536_870_911 {
            return None;
        }
        let field = match wire {
            0 => json!({ "n": n, "int": varint(bytes, &mut at)? }),
            1 => {
                let b = bytes.get(at..at + 8)?;
                at += 8;
                json!({ "n": n, "x64": hex(b) })
            }
            5 => {
                let b = bytes.get(at..at + 4)?;
                at += 4;
                json!({ "n": n, "x32": hex(b) })
            }
            2 => {
                let len = usize::try_from(varint(bytes, &mut at)?).ok()?;
                let b = bytes.get(at..at.checked_add(len)?)?;
                at += len;
                // A text is a text; what is not one may be a message within; anything else is bytes.
                match a_text(b) {
                    Some(text) => json!({ "n": n, "text": text }),
                    None => match (depth < 16).then(|| read_message(b, depth + 1)).flatten().filter(|m| !m.is_empty()) {
                        Some(inner) => json!({ "n": n, "msg": inner }),
                        None => json!({ "n": n, "b64": b64(b) }),
                    },
                }
            }
            _ => return None,
        };
        out.push(field);
    }
    Some(out)
}

/// The text of a leaf as it is filled: a hole is written as text, a fixed leaf is as it was read.
fn leaf_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// A protobuf message written from its list of fields. None where a field is not one.
fn write_message(fields: &[Value], out: &mut Vec<u8>) -> Option<()> {
    for f in fields {
        let n = f.get("n")?.as_u64()?;
        if let Some(v) = f.get("int") {
            put_varint(n << 3, out);
            put_varint(leaf_text(v)?.parse().ok()?, out);
        } else if let Some(v) = f.get("x64") {
            put_varint((n << 3) | 1, out);
            let b = unhex(&leaf_text(v)?).filter(|b| b.len() == 8)?;
            out.extend(b);
        } else if let Some(v) = f.get("x32") {
            put_varint((n << 3) | 5, out);
            let b = unhex(&leaf_text(v)?).filter(|b| b.len() == 4)?;
            out.extend(b);
        } else {
            let inner: Vec<u8> = if let Some(v) = f.get("text") {
                leaf_text(v)?.into_bytes()
            } else if let Some(v) = f.get("b64") {
                unb64(&leaf_text(v)?)?
            } else {
                let mut inner = Vec::new();
                write_message(f.get("msg")?.as_array()?, &mut inner)?;
                inner
            };
            put_varint((n << 3) | 2, out);
            put_varint(inner.len() as u64, out);
            out.extend(inner);
        }
    }
    Some(())
}

fn read_frames(bytes: &[u8]) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let flag = *bytes.get(at)?;
        let len = u32::from_be_bytes(bytes.get(at + 1..at + 5)?.try_into().ok()?) as usize;
        let b = bytes.get(at + 5..at.checked_add(5)?.checked_add(len)?)?;
        at += 5 + len;
        out.push(match flag & 0x80 {
            0 => json!({ "flag": flag, "msg": read_message(b, 0)? }),
            _ => json!({ "flag": flag, "b64": b64(b) }),
        });
    }
    (!out.is_empty()).then_some(out)
}

fn write_frames(frames: &[Value], out: &mut Vec<u8>) -> Option<()> {
    for f in frames {
        let flag = u8::try_from(f.get("flag")?.as_u64()?).ok()?;
        let payload = match f.get("msg") {
            Some(m) => {
                let mut b = Vec::new();
                write_message(m.as_array()?, &mut b)?;
                b
            }
            None => unb64(&leaf_text(f.get("b64")?)?)?,
        };
        out.push(flag);
        out.extend(u32::try_from(payload.len()).ok()?.to_be_bytes());
        out.extend(payload);
    }
    Some(())
}

fn read_msgpack(b: &[u8], at: &mut usize, depth: usize) -> Option<Value> {
    if depth > 64 {
        return None;
    }
    let take = |at: &mut usize, n: usize| -> Option<&[u8]> {
        let s = b.get(*at..at.checked_add(n)?)?;
        *at += n;
        Some(s)
    };
    let be = |s: &[u8]| s.iter().fold(0u64, |v, x| (v << 8) | u64::from(*x));
    let tag = *take(at, 1)?.first()?;
    let text = |at: &mut usize, n: usize| -> Option<Value> { Some(Value::String(std::str::from_utf8(take(at, n)?).ok()?.to_string())) };
    let list = |at: &mut usize, n: usize| -> Option<Value> { (0..n).map(|_| read_msgpack(b, at, depth + 1)).collect::<Option<Vec<_>>>().map(Value::Array) };
    let map = |at: &mut usize, n: usize| -> Option<Value> {
        let mut m = Map::new();
        for _ in 0..n {
            let Value::String(k) = read_msgpack(b, at, depth + 1)? else { return None };
            let v = read_msgpack(b, at, depth + 1)?;
            if m.insert(k, v).is_some() {
                return None;
            }
        }
        Some(Value::Object(m))
    };
    Some(match tag {
        0x00..=0x7f => json!(tag),
        0x80..=0x8f => map(at, usize::from(tag & 0x0f))?,
        0x90..=0x9f => list(at, usize::from(tag & 0x0f))?,
        0xa0..=0xbf => text(at, usize::from(tag & 0x1f))?,
        0xc0 => Value::Null,
        0xc2 => json!(false),
        0xc3 => json!(true),
        0xca => json!(f64::from(f32::from_bits(be(take(at, 4)?) as u32))),
        0xcb => json!(f64::from_bits(be(take(at, 8)?))),
        0xcc => json!(be(take(at, 1)?)),
        0xcd => json!(be(take(at, 2)?)),
        0xce => json!(be(take(at, 4)?)),
        0xcf => json!(be(take(at, 8)?)),
        0xd0 => json!(i64::from(take(at, 1)?[0] as i8)),
        0xd1 => json!(i64::from(i16::from_be_bytes(take(at, 2)?.try_into().ok()?))),
        0xd2 => json!(i64::from(i32::from_be_bytes(take(at, 4)?.try_into().ok()?))),
        0xd3 => json!(i64::from_be_bytes(take(at, 8)?.try_into().ok()?)),
        0xd9 => {
            let n = usize::from(take(at, 1)?[0]);
            text(at, n)?
        }
        0xda => {
            let n = be(take(at, 2)?) as usize;
            text(at, n)?
        }
        0xdb => {
            let n = be(take(at, 4)?) as usize;
            text(at, n)?
        }
        0xdc => {
            let n = be(take(at, 2)?) as usize;
            list(at, n)?
        }
        0xdd => {
            let n = be(take(at, 4)?) as usize;
            list(at, n)?
        }
        0xde => {
            let n = be(take(at, 2)?) as usize;
            map(at, n)?
        }
        0xdf => {
            let n = be(take(at, 4)?) as usize;
            map(at, n)?
        }
        0xe0..=0xff => json!(i64::from(tag as i8)),
        // Bytes, extensions and the rest have no JSON of their own: such a body is not opened.
        _ => return None,
    })
}

fn write_msgpack(v: &Value, out: &mut Vec<u8>) -> Option<()> {
    let len = |out: &mut Vec<u8>, n: usize, fix: u8, fix_max: usize, w8: Option<u8>, w16: u8, w32: u8| -> Option<()> {
        if n <= fix_max {
            out.push(fix | n as u8);
        } else if let Some(t) = w8.filter(|_| n <= 0xff) {
            out.extend([t, n as u8]);
        } else if n <= 0xffff {
            out.push(w16);
            out.extend((n as u16).to_be_bytes());
        } else {
            out.push(w32);
            out.extend(u32::try_from(n).ok()?.to_be_bytes());
        }
        Some(())
    };
    match v {
        Value::Null => out.push(0xc0),
        Value::Bool(b) => out.push(if *b { 0xc3 } else { 0xc2 }),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                match u {
                    0..=0x7f => out.push(u as u8),
                    0x80..=0xff => out.extend([0xcc, u as u8]),
                    0x100..=0xffff => {
                        out.push(0xcd);
                        out.extend((u as u16).to_be_bytes());
                    }
                    0x1_0000..=0xffff_ffff => {
                        out.push(0xce);
                        out.extend((u as u32).to_be_bytes());
                    }
                    _ => {
                        out.push(0xcf);
                        out.extend(u.to_be_bytes());
                    }
                }
            } else if let Some(i) = n.as_i64() {
                match i {
                    -32..=-1 => out.push(i as i8 as u8),
                    -128..=-33 => out.extend([0xd0, i as i8 as u8]),
                    -32768..=-129 => {
                        out.push(0xd1);
                        out.extend((i as i16).to_be_bytes());
                    }
                    -2_147_483_648..=-32769 => {
                        out.push(0xd2);
                        out.extend((i as i32).to_be_bytes());
                    }
                    _ => {
                        out.push(0xd3);
                        out.extend(i.to_be_bytes());
                    }
                }
            } else {
                out.push(0xcb);
                out.extend(n.as_f64()?.to_bits().to_be_bytes());
            }
        }
        Value::String(s) => {
            len(out, s.len(), 0xa0, 31, Some(0xd9), 0xda, 0xdb)?;
            out.extend(s.as_bytes());
        }
        Value::Array(items) => {
            len(out, items.len(), 0x90, 15, None, 0xdc, 0xdd)?;
            for i in items {
                write_msgpack(i, out)?;
            }
        }
        Value::Object(m) => {
            len(out, m.len(), 0x80, 15, None, 0xde, 0xdf)?;
            for (k, v) in m {
                write_msgpack(&Value::String(k.clone()), out)?;
                write_msgpack(v, out)?;
            }
        }
    }
    Some(())
}

/// What `bytes` hold as `codec` writes them, as JSON. None where they are not written so, or the reading, written
/// back, is not these very bytes.
pub fn open(codec: Codec, bytes: &[u8]) -> Option<Value> {
    let tree = match codec {
        Codec::Protobuf => Value::Array(read_message(bytes, 0).filter(|m| !m.is_empty())?),
        Codec::GrpcWeb => Value::Array(read_frames(bytes)?),
        Codec::GrpcWebText => {
            use base64::Engine;
            let text = std::str::from_utf8(bytes).ok()?;
            Value::Array(read_frames(&base64::engine::general_purpose::STANDARD.decode(text.trim()).ok()?)?)
        }
        Codec::Msgpack => {
            let mut at = 0;
            let v = read_msgpack(bytes, &mut at, 0)?;
            (at == bytes.len()).then_some(v)?
        }
    };
    (close(codec, &tree).as_deref() == Some(bytes)).then_some(tree)
}

/// `tree` written as `codec` writes it. None where the tree is not one this codec writes.
pub fn close(codec: Codec, tree: &Value) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    match codec {
        Codec::Protobuf => write_message(tree.as_array()?, &mut out)?,
        Codec::GrpcWeb => write_frames(tree.as_array()?, &mut out)?,
        Codec::GrpcWebText => {
            use base64::Engine;
            let mut raw = Vec::new();
            write_frames(tree.as_array()?, &mut raw)?;
            out = base64::engine::general_purpose::STANDARD.encode(raw).into_bytes();
        }
        Codec::Msgpack => write_msgpack(tree, &mut out)?,
    }
    Some(out)
}

/// The codec a body is written in, by what its own content type says, and failing that by which reader opens it
/// exactly: gRPC-web framing first (its five bytes of frame are no message), then protobuf. MessagePack is read only
/// where the type names it, as nearly any bytes open as some MessagePack value. None where no reader opens it.
pub fn opened(content_type: Option<&str>, bytes: &[u8]) -> Option<(Codec, Value)> {
    let kind = content_type.unwrap_or_default().split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    let named: &[Codec] = if kind.contains("grpc-web-text") {
        &[Codec::GrpcWebText]
    } else if kind.contains("grpc") {
        &[Codec::GrpcWeb]
    } else if kind.contains("msgpack") || kind.contains("messagepack") {
        &[Codec::Msgpack]
    } else if kind.contains("protobuf") || kind.contains("x-proto") {
        &[Codec::Protobuf]
    } else if kind.is_empty() || kind == "application/octet-stream" {
        &[Codec::GrpcWeb, Codec::Protobuf]
    } else {
        &[]
    };
    named.iter().find_map(|c| open(*c, bytes).map(|t| (*c, t)))
}

/// How a body that is no text is carried where bodies are text (a request as the filler builds it, a walk's record of
/// a request): this mark, then the bytes in base64. A NUL opens it, and no text body holds a NUL (a walk keeps none:
/// `agent-browser-core`'s `body_text`), so a text body never reads as one.
pub const BYTES_MARK: &str = "\u{0}bytes:base64:";

/// `bytes` as a body is carried: as they are where they are text (UTF-8, no NUL), else marked ([`BYTES_MARK`]).
pub fn carried(bytes: &[u8]) -> String {
    use base64::Engine;
    match std::str::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => text.to_string(),
        _ => format!("{BYTES_MARK}{}", base64::engine::general_purpose::STANDARD.encode(bytes)),
    }
}

/// The bytes a carried body is ([`carried`]): a marked body's bytes, and a text body's own.
pub fn bytes_of(body: &str) -> Vec<u8> {
    use base64::Engine;
    match body.strip_prefix(BYTES_MARK) {
        Some(b64) => base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default(),
        None => body.as_bytes().to_vec(),
    }
}

/// The codec a content type names, where it names one this crate reads: no guess from the bytes.
pub fn named(content_type: &str) -> Option<Codec> {
    let kind = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    if kind.contains("grpc-web-text") {
        Some(Codec::GrpcWebText)
    } else if kind.contains("grpc") {
        Some(Codec::GrpcWeb)
    } else if kind.contains("msgpack") || kind.contains("messagepack") {
        Some(Codec::Msgpack)
    } else if kind.contains("protobuf") || kind.contains("x-proto") {
        Some(Codec::Protobuf)
    } else {
        None
    }
}

/// A binary answer, of a content type that names a codec this crate reads, as the text of the JSON it holds: what
/// every reader of an answer then reads as it reads any JSON. None where the type names none, or the bytes do not
/// open exactly.
pub fn answer_as_json(content_type: &str, bytes: &[u8]) -> Option<String> {
    open(named(content_type)?, bytes).map(|tree| tree.to_string())
}

/// A reply's bytes as every reader of a reply reads them, the one place a reply's bytes become its text: the JSON a
/// binary answer of a codec this crate reads holds ([`answer_as_json`]), else the bytes as they are where they are
/// text (UTF-8, no NUL). None for bytes that are neither, which no reader reads. What the text then says (JSON, a
/// guarded or padded answer, a stream's events, an answer only the site's own code unpacks) is the trace's
/// `own_json`'s to read, once, the same for a walk's record and a call's live answer.
pub fn reply_text(content_type: &str, bytes: &[u8]) -> Option<String> {
    answer_as_json(content_type, bytes).or_else(|| std::str::from_utf8(bytes).ok().filter(|t| !t.contains('\0')).map(String::from))
}

/// [`reply_text`] for a live answer, which is always some text: bytes that are neither are carried lossily, as a
/// transport has always carried them, and read as nothing by the readers after.
pub fn reply_read(content_type: &str, bytes: &[u8]) -> String {
    reply_text(content_type, bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

/// The places of an opened tree a value of the walk's sits at: each leaf that carries a value (never a field's number
/// or a frame's flag), by pointer, with its text.
pub fn leaves(tree: &Value) -> Vec<(String, String)> {
    fn walk(v: &Value, at: String, out: &mut Vec<(String, String)>) {
        match v {
            Value::Object(m) => {
                for (k, v) in m {
                    if matches!(k.as_str(), "n" | "flag") && v.is_number() {
                        continue;
                    }
                    walk(v, format!("{at}/{}", k.replace('~', "~0").replace('/', "~1")), out);
                }
            }
            Value::Array(items) => items.iter().enumerate().for_each(|(i, v)| walk(v, format!("{at}/{i}"), out)),
            other => {
                if let Some(t) = leaf_text(other) {
                    out.push((at, t));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(tree, String::new(), &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A search posted as a schemaless message: field 1 the word, field 2 a count, field 3 a message within.
    fn search(word: &str) -> Vec<u8> {
        let mut b = vec![0x0a, word.len() as u8];
        b.extend(word.as_bytes());
        b.extend([0x10, 0x14, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x02]);
        b
    }

    #[test]
    fn a_protobuf_message_opens_into_fields_and_writes_back_its_own_bytes() {
        let tree = open(Codec::Protobuf, &search("kettle")).expect("it opens");
        assert_eq!(tree, json!([{ "n": 1, "text": "kettle" }, { "n": 2, "int": 20 }, { "n": 3, "msg": [{ "n": 1, "int": 1 }, { "n": 2, "int": 2 }] }]));
        assert_eq!(leaves(&tree)[0], ("/0/text".to_string(), "kettle".to_string()));
        let mut filled = tree.clone();
        filled[0]["text"] = json!("teapot");
        assert_eq!(close(Codec::Protobuf, &filled), Some(search("teapot")));
    }

    /// Bytes that are no text are carried marked and come back as they were; text is carried as itself, and a text
    /// body never reads as marked.
    #[test]
    fn a_body_of_bytes_is_carried_as_its_bytes() {
        let bytes: Vec<u8> = vec![0x0a, 0x80, 0x01, 0xff, 0x00, 0x10];
        let carried_bytes = carried(&bytes);
        assert!(carried_bytes.starts_with(BYTES_MARK));
        assert_eq!(bytes_of(&carried_bytes), bytes);
        assert_eq!(carried(b"{\"q\":\"kettle\"}"), "{\"q\":\"kettle\"}");
        assert_eq!(bytes_of("caf\u{e9}"), "caf\u{e9}".as_bytes());
        assert!(carried(b"a\0b").starts_with(BYTES_MARK), "a NUL is no text");
    }

    #[test]
    fn a_reading_that_would_not_write_back_the_same_bytes_is_no_reading() {
        // The count written in two bytes where one holds it: a schema's writer would not, and this reader cannot say it.
        let long = [0x08, 0x94, 0x00];
        assert_eq!(open(Codec::Protobuf, &long), None);
        assert_eq!(open(Codec::Protobuf, b"{\"q\":\"kettle\"}"), None, "JSON is no message");
        assert_eq!(open(Codec::Protobuf, &[]), None);
    }

    #[test]
    fn grpc_web_frames_open_around_their_messages_in_bytes_and_as_text() {
        let msg = search("kettle");
        let mut framed = vec![0, 0, 0, 0, msg.len() as u8];
        framed.extend(&msg);
        let tree = open(Codec::GrpcWeb, &framed).expect("a frame");
        assert_eq!(tree[0]["msg"][0]["text"], "kettle");
        use base64::Engine;
        let text = base64::engine::general_purpose::STANDARD.encode(&framed);
        assert_eq!(opened(Some("application/grpc-web-text"), text.as_bytes()).map(|(c, _)| c), Some(Codec::GrpcWebText));
        assert_eq!(opened(None, &framed).map(|(c, _)| c), Some(Codec::GrpcWeb), "a frame's five bytes say it is framed");
        assert_eq!(opened(None, &msg).map(|(c, _)| c), Some(Codec::Protobuf));
    }

    #[test]
    fn a_msgpack_answer_opens_into_its_json() {
        // {"query": "kettle", "results": [{"title": "kettle one", "price": 12}], "n": 300, "neg": -5, "f": 1.5}
        let mut b = vec![0x85, 0xa5];
        b.extend(b"query");
        b.push(0xa6);
        b.extend(b"kettle");
        b.push(0xa7);
        b.extend(b"results");
        b.extend([0x91, 0x82, 0xa5]);
        b.extend(b"title");
        b.push(0xaa);
        b.extend(b"kettle one");
        b.push(0xa5);
        b.extend(b"price");
        b.extend([12, 0xa1, b'n', 0xcd, 0x01, 0x2c, 0xa3]);
        b.extend(b"neg");
        b.extend([0xfb, 0xa1, b'f', 0xcb]);
        b.extend(1.5f64.to_bits().to_be_bytes());
        let tree = opened(Some("application/msgpack"), &b).map(|(_, t)| t).expect("it opens");
        assert_eq!(tree, json!({ "query": "kettle", "results": [{ "title": "kettle one", "price": 12 }], "n": 300, "neg": -5, "f": 1.5 }));
        // A number written wider than it needs is not this reader's to say.
        assert_eq!(open(Codec::Msgpack, &[0xcd, 0x00, 0x05]), None);
        assert_eq!(opened(None, &b), None, "MessagePack is read only where its type says so");
        assert_eq!(answer_as_json("application/x-msgpack", &b).map(|t| serde_json::from_str::<Value>(&t).unwrap()), Some(tree));
        assert_eq!(answer_as_json("application/octet-stream", &b), None, "a type that names no codec is not guessed at");
    }
}
