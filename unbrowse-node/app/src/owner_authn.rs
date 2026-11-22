//! The owner's own authenticator, for a passkey a page in the node's browser asks for and the vault doesn't hold.
//!
//! The node's browser has no window of its own, so the prompt a browser draws for a passkey (touch your security key,
//! or scan a QR with your phone) is never shown, and the node's page guard (`passkey`) refuses such a request at once
//! so the site offers its other ways in. A site whose only other way in is the owner's own security key or phone
//! passkey was then out of reach. Here the node is the browser's client for that request instead: it takes the page's
//! own request, builds the client data a browser would (the page's real origin, never one an agent names), and asks
//! the owner's own authenticator, a security key over USB or their phone over the hybrid QR, for the signature. The
//! page gets an ordinary credential back, and the site checks it as it would any other.
//!
//! What it takes: the request comes from the page's own `navigator.credentials` call (the guard forwards it), on a
//! site whose pages no agent script has run in (a script could otherwise put in a challenge of its own and carry the
//! signature off); the page's origin is read from the browser, never from the page or an agent; the relying party id
//! is that origin's host or a domain it belongs to. Nothing completes without the owner: their key needs a touch, their
//! phone shows the site and asks them. The QR is drawn in the page itself, as a browser would draw its prompt, so the
//! owner sees it wherever they look at the page (the window's hands view, a screenshot an agent shows them). One
//! request at a time. Every request and how it ended is a line in the activity log.
//!
//! macOS only for now: the USB and phone transports need IOKit and CoreBluetooth there; elsewhere `available()` is
//! false and the guard refuses as before.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unbrowse_learn::identity::site_of;
use url::Url;
use webauthn_rs_proto::{PublicKeyCredential, PublicKeyCredentialCreationOptions, PublicKeyCredentialRequestOptions, RegisterPublicKeyCredential};

/// The longest a request waits for the owner, whatever the page asks.
const MOST_WAIT: Duration = Duration::from_secs(300);
/// The least: a page's timeout is sized for a person at the browser's own prompt, and the owner may be reached
/// further away (the QR shown to them in a chat, their window across the room). The spec lets a client adjust it.
const LEAST_WAIT: Duration = Duration::from_secs(120);
/// What a request waits when the page names no timeout.
const DEFAULT_WAIT: Duration = Duration::from_secs(180);

/// Whether this node can ask the owner's own authenticator: a platform with the transports, and not turned off
/// (`UNBROWSE_OWNER_AUTHENTICATOR=0`).
pub fn available() -> bool {
    if std::env::var("UNBROWSE_OWNER_AUTHENTICATOR").as_deref() == Ok("0") {
        return false;
    }
    // A test reaches only the software key it puts in, never the machine's own USB or Bluetooth.
    #[cfg(test)]
    return TEST_DEVICE.lock().map(|d| d.is_some()).unwrap_or(false);
    #[cfg(not(test))]
    cfg!(target_os = "macos")
}

/// A refusal, as the page's promise rejects with it: the DOMException's name and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub name: &'static str,
    pub message: String,
}

impl Refusal {
    fn not_allowed(m: impl Into<String>) -> Refusal {
        Refusal { name: "NotAllowedError", message: m.into() }
    }
    fn security(m: impl Into<String>) -> Refusal {
        Refusal { name: "SecurityError", message: m.into() }
    }
    fn not_supported(m: impl Into<String>) -> Refusal {
        Refusal { name: "NotSupportedError", message: m.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `navigator.credentials.get`: sign in with a passkey the owner holds.
    Get,
    /// `navigator.credentials.create`: make a passkey on the owner's own device.
    Create,
}

impl Kind {
    fn client_type(self) -> &'static str {
        match self {
            Kind::Get => "webauthn.get",
            Kind::Create => "webauthn.create",
        }
    }
}

/// A page's passkey request, checked: whose origin, for which relying party, asking what.
#[derive(Debug, Clone)]
pub struct Ask {
    pub kind: Kind,
    /// The page's origin, as the browser reports the page's address (`https://host[:port]`).
    pub origin: String,
    pub host: String,
    pub get: Option<PublicKeyCredentialRequestOptions>,
    pub create: Option<PublicKeyCredentialCreationOptions>,
    pub wait: Duration,
}

/// Whether `host` may use `rp_id`: it is the host, or a domain the host is under, and not a bare public suffix
/// (a domain no one registers, which every site under it would share).
fn rp_fits(host: &str, rp_id: &str) -> bool {
    let (host, rp) = (host.to_ascii_lowercase(), rp_id.to_ascii_lowercase());
    if rp.is_empty() || !unbrowse_learn::identity::at_or_under(&host, &rp) {
        return false;
    }
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    let site = site_of(&host);
    !site.is_empty() && unbrowse_learn::identity::at_or_under(&rp, &site)
}

/// Whether a page at `origin` is one a passkey may be used from: https, or http on this machine.
fn secure(origin: &Url) -> bool {
    match origin.scheme() {
        "https" => true,
        "http" => matches!(origin.host_str(), Some(h) if h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1"),
        _ => false,
    }
}

/// The page's options as the spec reads them: each member it may leave out given its default, and the members a
/// client may ignore (hints, attestation formats, extensions) left out. Extensions' inputs (a PRF salt, a large blob)
/// are the site's to the authenticator, and a credential without their outputs is one the site reads as "not
/// supported".
fn spec_defaults(pk: &mut Value) {
    let Some(o) = pk.as_object_mut() else { return };
    for k in ["extensions", "hints", "attestationFormats"] {
        o.remove(k);
    }
    let descriptors = |v: &mut Value| {
        if let Some(list) = v.as_array_mut() {
            for d in list {
                if d.get("type").is_none_or(Value::is_null) {
                    d["type"] = json!("public-key");
                }
                if let Some(t) = d.get_mut("transports").and_then(Value::as_array_mut) {
                    t.retain(|t| matches!(t.as_str(), Some("usb" | "nfc" | "ble" | "internal" | "hybrid")));
                }
            }
        }
    };
    for k in ["allowCredentials", "excludeCredentials"] {
        if let Some(v) = o.get_mut(k) {
            descriptors(v);
        }
    }
    if let Some(sel) = o.get_mut("authenticatorSelection").filter(|v| v.is_object()) {
        let required = sel["residentKey"] == json!("required") || sel["requireResidentKey"] == json!(true);
        sel["requireResidentKey"] = json!(required);
        if sel.get("userVerification").is_none_or(Value::is_null) {
            sel["userVerification"] = json!("preferred");
        }
    }
    if o.contains_key("rp") || o.contains_key("user") {
        if let Some(rp) = o.get_mut("rp").filter(|v| v.is_object()) {
            if rp.get("name").is_none_or(Value::is_null) {
                rp["name"] = json!("");
            }
        }
        if let Some(user) = o.get_mut("user").filter(|v| v.is_object()) {
            for k in ["name", "displayName"] {
                if user.get(k).is_none_or(Value::is_null) {
                    user[k] = json!("");
                }
            }
        }
        if o.get("pubKeyCredParams").is_none_or(|v| v.as_array().is_none_or(|a| a.is_empty())) {
            o.insert("pubKeyCredParams".into(), json!([{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }]));
        }
        if !matches!(o.get("attestation").and_then(Value::as_str), Some("none" | "indirect" | "direct")) {
            o.remove("attestation");
        }
    }
}

impl Ask {
    /// The request a page's guard forwarded (`payload`), for the page the browser says is at `page_url`. The page's
    /// own word on its origin is checked against the browser's, and a request from a frame inside the page is refused:
    /// only the page itself asks, for its own site.
    pub fn from_page(page_url: &str, payload: &Value) -> Result<Ask, Refusal> {
        let page = Url::parse(page_url).map_err(|_| Refusal::security("the page has no address the node can read"))?;
        if !page.origin().is_tuple() {
            return Err(Refusal::security("the page has an opaque origin"));
        }
        let origin = page.origin().ascii_serialization();
        if !secure(&page) {
            return Err(Refusal::security("a passkey is only used on a secure page (https)"));
        }
        if payload["top"] != json!(true) {
            return Err(Refusal::not_allowed("only the page itself asks the owner, not a frame inside it"));
        }
        if payload["origin"].as_str() != Some(origin.as_str()) {
            return Err(Refusal::security("the request's origin is not the page's"));
        }
        let host = page.host_str().unwrap_or_default().to_string();
        let mut pk = payload["publicKey"].clone();
        if !pk.is_object() {
            return Err(Refusal::not_supported("the request has no publicKey options"));
        }
        let wait = pk["timeout"].as_u64().map(Duration::from_millis).unwrap_or(DEFAULT_WAIT).clamp(LEAST_WAIT, MOST_WAIT);
        spec_defaults(&mut pk);
        match payload["kind"].as_str() {
            Some("get") => {
                let rp = pk["rpId"].as_str().map(String::from).unwrap_or_else(|| host.clone());
                if !rp_fits(&host, &rp) {
                    return Err(Refusal::security(format!("{host} can't use a passkey for {rp}")));
                }
                pk["rpId"] = json!(rp);
                if pk.get("allowCredentials").is_none_or(Value::is_null) {
                    pk["allowCredentials"] = json!([]);
                }
                if pk.get("userVerification").is_none_or(Value::is_null) {
                    pk["userVerification"] = json!("preferred");
                }
                let options: PublicKeyCredentialRequestOptions = serde_json::from_value(pk).map_err(|e| Refusal::not_supported(format!("the request's options can't be read: {e}")))?;
                Ok(Ask { kind: Kind::Get, origin, host, get: Some(options), create: None, wait })
            }
            Some("create") => {
                let rp = pk["rp"]["id"].as_str().map(String::from).unwrap_or_else(|| host.clone());
                if !rp_fits(&host, &rp) {
                    return Err(Refusal::security(format!("{host} can't make a passkey for {rp}")));
                }
                pk["rp"]["id"] = json!(rp);
                let options: PublicKeyCredentialCreationOptions = serde_json::from_value(pk).map_err(|e| Refusal::not_supported(format!("the request's options can't be read: {e}")))?;
                Ok(Ask { kind: Kind::Create, origin, host, get: None, create: Some(options), wait })
            }
            _ => Err(Refusal::not_supported("neither get nor create")),
        }
    }

    fn challenge(&self) -> &[u8] {
        match (&self.get, &self.create) {
            (Some(g), _) => &g.challenge,
            (_, Some(c)) => &c.challenge,
            _ => &[],
        }
    }

    /// The client data a browser signs over for this request: its type, the challenge, the page's origin, and that
    /// the page asked from its own top frame.
    pub fn client_data(&self) -> Vec<u8> {
        // Written out in the order the spec lists them: some relying parties read the start of it as text.
        format!(
            r#"{{"type":"{}","challenge":"{}","origin":{},"crossOrigin":false}}"#,
            self.kind.client_type(),
            B64.encode(self.challenge()),
            serde_json::to_string(&self.origin).unwrap_or_default()
        )
        .into_bytes()
    }

    /// The site, as the activity log names it.
    pub fn site(&self) -> String {
        let s = site_of(&self.host);
        if s.is_empty() {
            self.host.clone()
        } else {
            s
        }
    }
}

/// What the owner's authenticator signed.
pub enum Signed {
    Get(PublicKeyCredential),
    Create(RegisterPublicKeyCredential),
}

/// The credential as the page gets it, in the WebAuthn JSON form (`PublicKeyCredential.toJSON()`): base64url for
/// every buffer. A new credential also carries its authenticator data and public key, read from the attestation, for
/// a page that asks the response for them.
pub fn answer(signed: &Signed, client_data: &[u8]) -> Value {
    match signed {
        Signed::Get(c) => json!({
            "id": c.id,
            "rawId": B64.encode(&c.raw_id),
            "type": "public-key",
            "authenticatorAttachment": "cross-platform",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": B64.encode(client_data),
                "authenticatorData": B64.encode(&c.response.authenticator_data),
                "signature": B64.encode(&c.response.signature),
                "userHandle": c.response.user_handle.as_ref().map(|h| B64.encode(h)),
            },
        }),
        Signed::Create(c) => {
            let (auth_data, key) = read_attestation(&c.response.attestation_object);
            let transports = c.response.transports.as_ref().and_then(|t| serde_json::to_value(t).ok()).unwrap_or(json!([]));
            json!({
                "id": c.id,
                "rawId": B64.encode(&c.raw_id),
                "type": "public-key",
                "authenticatorAttachment": "cross-platform",
                "clientExtensionResults": {},
                "response": {
                    "clientDataJSON": B64.encode(client_data),
                    "attestationObject": B64.encode(&c.response.attestation_object),
                    "transports": transports,
                    "authenticatorData": auth_data.map(|a| B64.encode(a)),
                    "publicKey": key.as_ref().map(|(spki, _)| B64.encode(spki)),
                    "publicKeyAlgorithm": key.as_ref().map(|(_, alg)| *alg),
                },
            })
        }
    }
}

/// The authenticator data in an attestation object, and the new credential's public key as SubjectPublicKeyInfo DER
/// with its COSE algorithm (P-256 and Ed25519; other keys come back without one, which the spec allows).
fn read_attestation(object: &[u8]) -> (Option<Vec<u8>>, Option<(Vec<u8>, i64)>) {
    use serde_cbor_2::Value as Cbor;
    let Ok(Cbor::Map(m)) = serde_cbor_2::from_slice::<Cbor>(object) else { return (None, None) };
    let Some(Cbor::Bytes(auth)) = m.get(&Cbor::Text("authData".into())).cloned() else { return (None, None) };
    // rpIdHash (32), flags (1), counter (4), then with attested data (flag 0x40): aaguid (16), id length (2), id, key.
    let key = (|| {
        if auth.len() < 55 || auth[32] & 0x40 == 0 {
            return None;
        }
        let len = u16::from_be_bytes([auth[53], auth[54]]) as usize;
        let start = 55 + len;
        let mut de = serde_cbor_2::Deserializer::from_slice(auth.get(start..)?);
        let cose: Cbor = serde::Deserialize::deserialize(&mut de).ok()?;
        let Cbor::Map(k) = cose else { return None };
        let int = |n: i128| k.get(&Cbor::Integer(n)).cloned();
        let bytes = |n: i128| match int(n) {
            Some(Cbor::Bytes(b)) => Some(b),
            _ => None,
        };
        match (int(1), int(3)) {
            (Some(Cbor::Integer(2)), Some(Cbor::Integer(-7))) => {
                let (x, y) = (bytes(-2)?, bytes(-3)?);
                if x.len() != 32 || y.len() != 32 {
                    return None;
                }
                let mut der = hex_bytes("3059301306072a8648ce3d020106082a8648ce3d030107034200");
                der.push(4);
                der.extend_from_slice(&x);
                der.extend_from_slice(&y);
                Some((der, -7))
            }
            (Some(Cbor::Integer(1)), Some(Cbor::Integer(-8))) => {
                let x = bytes(-2)?;
                if x.len() != 32 {
                    return None;
                }
                let mut der = hex_bytes("302a300506032b6570032100");
                der.extend_from_slice(&x);
                Some((der, -8))
            }
            _ => None,
        }
    })();
    (Some(auth), key)
}

fn hex_bytes(h: &str) -> Vec<u8> {
    (0..h.len()).step_by(2).filter_map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok()).collect()
}

/// What the owner is shown in the page while a request waits, and how it ended.
#[derive(Debug, Clone)]
pub enum ToPage {
    /// The QR their phone scans (the `FIDO:/` address), drawn as SVG.
    Qr { url: String, svg: String },
    /// A line of status: "Touch your security key", "Connecting to your phone".
    Status(String),
    /// The credential, in the WebAuthn JSON form.
    Done(Value),
    /// The owner approved a sign-in with a passkey the node keeps: the page asks its own authenticator now.
    Approved,
    Refused(Refusal),
}

impl ToPage {
    /// The message as the page's guard reads it.
    pub fn to_json(&self) -> Value {
        match self {
            ToPage::Qr { url, svg } => json!({ "qr": url, "svg": svg }),
            ToPage::Status(s) => json!({ "status": s }),
            ToPage::Done(c) => json!({ "credential": c }),
            ToPage::Approved => json!({ "approved": true }),
            ToPage::Refused(r) => json!({ "error": r.message, "name": r.name }),
        }
    }
}

/// The QR for a `FIDO:/` address, as SVG.
pub fn qr_svg(url: &str) -> String {
    match qrcode::QrCode::new(url.as_bytes()) {
        Ok(code) => code.render::<qrcode::render::svg::Color>().min_dimensions(220, 220).quiet_zone(true).build(),
        Err(_) => String::new(),
    }
}

/// Where the request's progress goes: to the page that asked.
pub struct Ui {
    tell: Mutex<Box<dyn FnMut(ToPage) + Send>>,
}

impl Ui {
    pub fn new(tell: impl FnMut(ToPage) + Send + 'static) -> Ui {
        Ui { tell: Mutex::new(Box::new(tell)) }
    }
    pub fn say(&self, m: ToPage) {
        if let Ok(mut t) = self.tell.lock() {
            t(m)
        }
    }
}

impl std::fmt::Debug for Ui {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Ui")
    }
}

impl webauthn_authenticator_rs::ui::UiCallback for Ui {
    /// A key's PIN isn't asked for: the node has no way to take it from the owner yet, so a key that needs one says
    /// so through the request's refusal.
    fn request_pin(&self) -> Option<String> {
        None
    }
    fn request_touch(&self) {
        self.say(ToPage::Status("Touch your security key".into()));
    }
    fn processing(&self) {
        self.say(ToPage::Status("Working…".into()));
    }
    fn fingerprint_enrollment_feedback(&self, _: u32, _: Option<webauthn_authenticator_rs::types::EnrollSampleStatus>) {}
    fn cable_qr_code(&self, _: webauthn_authenticator_rs::types::CableRequestType, url: String) {
        let svg = qr_svg(&url);
        self.say(ToPage::Qr { url, svg });
    }
    fn dismiss_qr_code(&self) {
        self.say(ToPage::Status("Connecting to your phone…".into()));
    }
    fn cable_status_update(&self, state: webauthn_authenticator_rs::types::CableState) {
        use webauthn_authenticator_rs::types::CableState;
        let s = match state {
            CableState::ConnectingToTunnelServer => "Connecting to your phone…",
            CableState::WaitingForAuthenticatorResponse => "Approve on your phone",
            _ => "Working…",
        };
        self.say(ToPage::Status(s.into()));
    }
}

/// The owner's authenticator, as a request reaches it.
pub trait Device: Send + Sync {
    /// Signs `ask` (over `client_data_hash`), saying its progress to `ui`, until `cancel` is set.
    fn sign(&self, ask: &Ask, client_data_hash: Vec<u8>, ui: &Ui, cancel: &AtomicBool) -> Result<Signed, Refusal>;
}

fn sign_with(a: &mut impl webauthn_authenticator_rs::AuthenticatorBackendHashedClientData, ask: &Ask, hash: Vec<u8>) -> Result<Signed, Refusal> {
    let ms = ask.wait.as_millis() as u32;
    let refused = |e: webauthn_authenticator_rs::prelude::WebauthnCError| Refusal::not_allowed(format!("the authenticator refused: {e:?}"));
    match (&ask.get, &ask.create) {
        (Some(g), _) => a.perform_auth(hash, g.clone(), ms).map(Signed::Get).map_err(refused),
        (_, Some(c)) => a.perform_register(hash, c.clone(), ms).map(Signed::Create).map_err(refused),
        _ => Err(Refusal::not_supported("nothing asked")),
    }
}

/// The owner's security key over USB, or their phone over the hybrid QR: whichever answers first.
#[cfg(target_os = "macos")]
struct OwnersDevices;

#[cfg(target_os = "macos")]
impl Device for OwnersDevices {
    fn sign(&self, ask: &Ask, hash: Vec<u8>, ui: &Ui, cancel: &AtomicBool) -> Result<Signed, Refusal> {
        use webauthn_authenticator_rs::cable::connect_cable_authenticator;
        use webauthn_authenticator_rs::ctap2::select_one_device;
        use webauthn_authenticator_rs::transport::Transport;
        use webauthn_authenticator_rs::types::CableRequestType;
        use webauthn_authenticator_rs::usb::USBTransport;

        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| Refusal::not_allowed(e.to_string()))?;
        let request = match (&ask.create, ask.kind) {
            (Some(c), Kind::Create) if c.authenticator_selection.as_ref().is_some_and(|s| s.require_resident_key || matches!(s.resident_key, Some(webauthn_rs_proto::ResidentKeyRequirement::Required | webauthn_rs_proto::ResidentKeyRequirement::Preferred))) => {
                CableRequestType::DiscoverableMakeCredential
            }
            (_, Kind::Create) => CableRequestType::MakeCredential,
            (_, Kind::Get) => CableRequestType::GetAssertion,
        };
        let failed: Mutex<Vec<String>> = Mutex::new(Vec::new());
        // A transport that can't start (no Bluetooth permission, no USB access) is noted and waits: the other may answer.
        let or_wait = |what: &str, e: String| {
            if let Ok(mut f) = failed.lock() {
                f.push(format!("{what}: {e}"));
            }
        };
        rt.block_on(async {
            let usb_transport = USBTransport::new().await;
            let usb = async {
                let found = match &usb_transport {
                    Ok(t) => match t.watch().await {
                        Ok(stream) => select_one_device(stream, ui).await,
                        Err(e) => {
                            or_wait("security key", format!("{e:?}"));
                            None
                        }
                    },
                    Err(e) => {
                        or_wait("security key", format!("{e:?}"));
                        None
                    }
                };
                match found {
                    Some(a) => a,
                    None => std::future::pending().await,
                }
            };
            let phone = async {
                match connect_cable_authenticator(request, ui).await {
                    Ok(a) => a,
                    Err(e) => {
                        or_wait("phone", format!("{e:?}"));
                        std::future::pending().await
                    }
                }
            };
            let cancelled = async {
                while !cancel.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            };
            tokio::select! {
                mut a = usb => {
                    ui.say(ToPage::Status("Touch your security key".into()));
                    sign_with(&mut a, ask, hash)
                }
                mut a = phone => sign_with(&mut a, ask, hash),
                _ = cancelled => Err(Refusal::not_allowed("the request was cancelled")),
                _ = tokio::time::sleep(ask.wait) => {
                    let why = failed.lock().map(|f| f.join("; ")).unwrap_or_default();
                    Err(Refusal::not_allowed(if why.is_empty() { "the owner didn't answer in time".to_string() } else { format!("the owner didn't answer in time ({why})") }))
                }
            }
        })
    }
}

#[cfg(test)]
pub static TEST_DEVICE: Mutex<Option<Arc<dyn Device>>> = Mutex::new(None);

fn device() -> Option<Arc<dyn Device>> {
    #[cfg(test)]
    if let Some(d) = TEST_DEVICE.lock().ok().and_then(|d| d.clone()) {
        return Some(d);
    }
    #[cfg(target_os = "macos")]
    return Some(Arc::new(OwnersDevices));
    #[allow(unreachable_code)]
    None
}

/// One request at a time: a second while one waits is refused.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Runs `ask` against the owner's authenticator, saying its progress and its end to `ui`, on a thread of its own.
/// Returns at once; `cancel` ends a wait.
pub fn run(ask: Ask, ui: Ui, cancel: Arc<AtomicBool>, done: impl FnOnce(&Ask, &Result<Value, Refusal>) + Send + 'static) {
    if BUSY.swap(true, Ordering::SeqCst) {
        let r = Err(Refusal::not_allowed("the owner is already answering another passkey request"));
        ui.say(ToPage::Refused(Refusal::not_allowed("the owner is already answering another passkey request")));
        done(&ask, &r);
        return;
    }
    std::thread::spawn(move || {
        let result = (|| {
            let device = device().ok_or_else(|| Refusal::not_supported("this node has no way to reach the owner's authenticator"))?;
            let client_data = ask.client_data();
            let hash = Sha256::digest(&client_data).to_vec();
            let signed = device.sign(&ask, hash, &ui, &cancel)?;
            Ok(answer(&signed, &client_data))
        })();
        BUSY.store(false, Ordering::SeqCst);
        // Logged before the page hears, so the log has it by the time the site moves on.
        done(&ask, &result);
        ui.say(match &result {
            Ok(c) => ToPage::Done(c.clone()),
            Err(r) => ToPage::Refused(r.clone()),
        });
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A software authenticator standing in for the owner's key: what it makes, it keeps for the next sign-in.
    pub struct SoftKey(pub Mutex<webauthn_authenticator_rs::softtoken::SoftToken>);

    impl SoftKey {
        pub fn new() -> SoftKey {
            SoftKey(Mutex::new(webauthn_authenticator_rs::softtoken::SoftToken::new(true).unwrap().0))
        }
    }

    impl Device for SoftKey {
        fn sign(&self, ask: &Ask, hash: Vec<u8>, ui: &Ui, _: &AtomicBool) -> Result<Signed, Refusal> {
            ui.say(ToPage::Status("Touch your security key".into()));
            let mut t = self.0.lock().unwrap();
            sign_with(&mut *t, ask, hash)
        }
    }

    fn payload(kind: &str, origin: &str, pk: Value) -> Value {
        json!({ "kind": kind, "origin": origin, "top": true, "publicKey": pk })
    }

    #[test]
    fn a_page_asks_only_for_its_own_site() {
        let pk = json!({ "challenge": "AAEC", "rpId": "npmjs.com" });
        let ask = Ask::from_page("https://www.npmjs.com/login/webauthn", &payload("get", "https://www.npmjs.com", pk.clone())).unwrap();
        assert_eq!(ask.get.unwrap().rp_id, "npmjs.com");
        // Another site's relying party, a frame, a lie about the origin, an insecure page: each refused.
        let other = Ask::from_page("https://evil.example/", &payload("get", "https://evil.example", pk.clone())).unwrap_err();
        assert_eq!(other.name, "SecurityError");
        let mut framed = payload("get", "https://www.npmjs.com", pk.clone());
        framed["top"] = json!(false);
        assert_eq!(Ask::from_page("https://www.npmjs.com/", &framed).unwrap_err().name, "NotAllowedError");
        assert_eq!(Ask::from_page("https://evil.example/", &payload("get", "https://www.npmjs.com", pk.clone())).unwrap_err().name, "SecurityError");
        assert_eq!(Ask::from_page("http://www.npmjs.com/", &payload("get", "http://www.npmjs.com", pk)).unwrap_err().name, "SecurityError");
        // A bare public suffix is no one's relying party.
        let suffix = Ask::from_page("https://shop.example.co.uk/", &payload("get", "https://shop.example.co.uk", json!({ "challenge": "AAEC", "rpId": "co.uk" }))).unwrap_err();
        assert_eq!(suffix.name, "SecurityError");
    }

    #[test]
    fn the_relying_party_defaults_to_the_page_host() {
        let ask = Ask::from_page("https://login.example.com/a", &payload("get", "https://login.example.com", json!({ "challenge": "AAEC" }))).unwrap();
        assert_eq!(ask.get.unwrap().rp_id, "login.example.com");
    }

    #[test]
    fn client_data_names_the_page_origin_and_challenge() {
        let ask = Ask::from_page("https://www.npmjs.com/login", &payload("get", "https://www.npmjs.com", json!({ "challenge": "AAEC", "rpId": "npmjs.com" }))).unwrap();
        let cd: Value = serde_json::from_slice(&ask.client_data()).unwrap();
        assert_eq!(cd, json!({ "type": "webauthn.get", "challenge": "AAEC", "origin": "https://www.npmjs.com", "crossOrigin": false }));
    }

    /// A page may name as its passkey's relying party its own host or a name it sits under, by whole labels and within
    /// its own site: a name that only ends in the host's text, another site, or a public suffix is not one.
    #[test]
    fn a_relying_party_is_the_pages_host_or_a_name_it_sits_under_on_its_own_site() {
        assert!(rp_fits("www.shop.example.com", "www.shop.example.com"));
        assert!(rp_fits("www.shop.example.com", "shop.example.com"));
        assert!(rp_fits("www.shop.example.com", "example.com"));
        assert!(rp_fits("WWW.Example.com", "example.COM"));
        assert!(!rp_fits("www.example.com", "com"), "a public suffix is no site");
        assert!(!rp_fits("a.github.io", "github.io"), "a private suffix is no site either");
        assert!(!rp_fits("notexample.com", "example.com"), "a tail of the text is another site");
        assert!(!rp_fits("example.com", "www.example.com"), "a name below the page is not the page's");
        assert!(!rp_fits("www.example.com", "other.com"));
        assert!(!rp_fits("www.example.com", ""));
        assert!(rp_fits("app.localhost", "localhost"));
    }
}
