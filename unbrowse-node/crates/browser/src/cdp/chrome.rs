#[cfg(windows)]
use super::windows_process::Child;
use std::io::{BufRead, BufReader, Write};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use super::discovery::discover_cdp_url;
use crate::ca_bundle::CaBundle;

/// How long a handoff browser waits for the person it was left open for. Verification takes a person a minute; an
/// agent's run has no person coming at all, and a browser nobody closed ran until the machine did (the Eden report
/// ended one run with 88 node and Chrome processes still up).
pub const HANDOFF_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// Browsers this process launched and still serves for others after leaving them (`serve_while_others_remain`).
static KEPT: std::sync::Mutex<Vec<std::thread::JoinHandle<()>>> = std::sync::Mutex::new(Vec::new());

/// Waits until every browser this process still serves for others has been closed by the last of them to leave. A
/// process calls it on its way out, after it can no longer be reached: the browsers die with it otherwise.
pub fn serve_kept_browsers() {
    loop {
        let kept = std::mem::take(&mut *KEPT.lock().unwrap_or_else(|e| e.into_inner()));
        if kept.is_empty() {
            return;
        }
        for serving in kept {
            let _ = serving.join();
        }
    }
}

pub struct ChromeProcess {
    child: Child,
    pub ws_url: String,
    temp_user_data_dir: Option<PathBuf>,
    temp_nss_home: Option<PreparedNssHome>,
    /// On Unix, the process group ID used to kill the entire Chrome process tree.
    #[cfg(unix)]
    pgid: Option<i32>,
    /// Private Xvfb server auto-started for headed mode on displayless Linux
    /// hosts. Dropped (and killed) after the Chrome tree is torn down.
    #[cfg(target_os = "linux")]
    xvfb: Option<XvfbServer>,
    /// This process's place among those using the browser, when others can reach it.
    hold: Option<BrowserHold>,
    /// The door to the browser's debugger, which is on a pipe only this process holds (`pipe`). Dropped after the
    /// browser: it closes when the browser does.
    relay: Option<super::pipe::Relay>,
}

struct PreparedNssHomeInner {
    path: PathBuf,
}

impl Drop for PreparedNssHomeInner {
    fn drop(&mut self) {
        for attempt in 0..3 {
            match std::fs::remove_dir_all(&self.path) {
                Ok(()) => break,
                Err(_) if attempt < 2 => std::thread::sleep(Duration::from_millis(100)),
                Err(e) => {
                    let _ = writeln!(
                        std::io::stderr(),
                        "Warning: failed to clean up temporary CA trust store {}: {}",
                        self.path.display(),
                        e
                    );
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct PreparedNssHome {
    inner: Arc<PreparedNssHomeInner>,
}

impl PreparedNssHome {
    fn path(&self) -> &Path {
        &self.inner.path
    }
}

impl ChromeProcess {
    pub fn kill(&mut self) {
        super::launched::closed(self.child.id());
        let _ = self.child.kill();
        // On Unix, kill the entire process group to ensure Chrome helper
        // processes (GPU, renderer, utility, crashpad) are also terminated.
        // This prevents orphaned Chrome processes from blocking the user's
        // normal Chrome (issue #1113).
        //
        // Once: `wait` below reaps the leader, and after that the number is free for another process's group. A second
        // kill (the one `Drop` always makes) must not reach it.
        #[cfg(unix)]
        if let Some(pgid) = self.pgid.take() {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
        let _ = self.child.wait();
    }

    /// Keep a headed browser and its profile alive for a human handoff: the person has [`HANDOFF_TTL`] to finish
    /// verification and close it themselves, and nobody coming closes it too, so a walk that never passed the door
    /// never leaves a browser running for good (the handoff was open until then, which an agent's failed run made
    /// forever). The reaper keeps the profile's temporary resources until the browser goes, then cleans up as usual.
    pub fn preserve_until_closed(self) {
        self.preserve_for(HANDOFF_TTL);
    }

    /// The same handoff, with the wait it is given: the browser waits for the person to close it, and at the deadline
    /// it is closed the way any browser of a walk's is (dropped, which kills it and its tree).
    pub fn preserve_for(self, ttl: Duration) {
        let mut me = self;
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + ttl;
            loop {
                match me.child.try_wait() {
                    // The person closed it; the drop below finishes the cleanup.
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
                    // Nobody came: the handoff is over, and the drop kills what it kept.
                    _ => break,
                }
            }
        });
    }

    /// Leaves a browser others still use without closing it under them. Its debugger is on a pipe only this process
    /// holds, so the browser lives as long as this process does: the launcher stays its owner, serving the others,
    /// until the last of them has gone, then closes it as anyone last out would. The process waits for that in
    /// [`serve_kept_browsers`] before it exits. A launcher that crashes or is killed takes the browser with it.
    pub fn serve_while_others_remain(self) {
        self.serve_while_others_remain_polling(Duration::from_millis(250));
    }

    fn serve_while_others_remain_polling(mut self, every: Duration) {
        let Some(mut hold) = self.hold.take() else {
            // Nobody else can reach it: this was the last use.
            drop(self);
            return;
        };
        let serving = std::thread::spawn(move || {
            loop {
                if self.has_exited() {
                    break;
                }
                if hold.last_out() {
                    // Held alone now: a daemon coming to reattach waits until the browser has gone.
                    if let Some(relay) = self.relay.as_ref() {
                        relay.close_browser();
                    }
                    self.wait_or_kill(Duration::from_secs(5));
                    break;
                }
                std::thread::sleep(every);
            }
            drop(self);
            drop(hold);
        });
        KEPT.lock().unwrap_or_else(|e| e.into_inner()).push(serving);
    }

    /// Takes a place among the processes using this browser, which others can reattach to.
    pub fn share(&mut self, hold: BrowserHold) {
        self.hold = Some(hold);
    }

    /// Whether another process is still using this browser, and so must keep it.
    pub fn others_remain(&mut self) -> bool {
        self.hold.as_mut().is_some_and(|hold| !hold.last_out())
    }

    /// Returns the OS process ID of the Chrome child process.
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Non-blocking check whether Chrome has exited.
    /// Returns `true` if the process has exited (and reaps it), `false` if still running.
    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }

    /// Wait for Chrome to exit on its own (after Browser.close CDP command),
    /// falling back to kill() if it doesn't exit within the timeout.
    /// This allows Chrome to flush cookies and other state to the user-data-dir.
    pub fn wait_or_kill(&mut self, timeout: Duration) {
        let start = std::time::Instant::now();
        let poll_interval = Duration::from_millis(50);

        while start.elapsed() < timeout {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(poll_interval),
                Err(_) => break,
            }
        }

        self.kill();
    }
}

impl Drop for ChromeProcess {
    fn drop(&mut self) {
        // A process leaving by another way than `close` leaves the others their browser too.
        if self.others_remain() {
            return;
        }
        self.kill();
        if let Some(ref dir) = self.temp_user_data_dir {
            for attempt in 0..3 {
                match std::fs::remove_dir_all(dir) {
                    Ok(()) => break,
                    Err(_) if attempt < 2 => {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => {
                        // Use write! instead of eprintln! to avoid panicking
                        // if the daemon's stderr pipe is broken (parent dropped it).
                        let _ = writeln!(
                            std::io::stderr(),
                            "Warning: failed to clean up temp profile {}: {}",
                            dir.display(),
                            e
                        );
                    }
                }
            }
        }
    }
}

/// A private Xvfb virtual display owned by one Chrome process.
///
/// Headed Chrome on Linux needs an X display, and some workloads need headed
/// mode on hosts that have none: headless Chrome cannot composite WebGPU
/// canvas presentation into screenshots (upstream limitation), so WebGPU
/// capture requires a real or virtual display. When headed mode is requested,
/// no DISPLAY is set, and Xvfb is installed, launch spawns a private server
/// instead of failing. Opt out with AGENT_BROWSER_NO_XVFB=1.
///
/// The server requires MIT-MAGIC-COOKIE-1 authentication (`-auth`): without
/// authorization records an X server allows any local user to connect, which
/// on a shared host would let other accounts observe the browser and inject
/// input. Only the paired Chrome process receives the cookie via XAUTHORITY.
#[cfg(target_os = "linux")]
struct XvfbServer {
    child: Child,
    display: String,
    auth_file: PathBuf,
}

#[cfg(target_os = "linux")]
impl Drop for XvfbServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.auth_file);
    }
}

/// Write an .Xauthority file containing one FamilyWild MIT-MAGIC-COOKIE-1
/// record with a random cookie, created 0600.
///
/// FamilyWild (0xffff, empty address and display number) matches any display,
/// which sidesteps a chicken-and-egg with `-displayfd`: the display number is
/// only known after the server starts, but the auth file must exist before.
/// The server side is unaffected -- X servers compare only the cookie bytes
/// for MIT-MAGIC-COOKIE-1 -- and client libraries (libXau/libxcb) accept
/// FamilyWild entries for any display.
#[cfg(target_os = "linux")]
fn write_xauth_file(path: &Path) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;

    // Uuid v4 carries 122 random bits in 16 bytes.
    let cookie = uuid::Uuid::new_v4();
    let name = b"MIT-MAGIC-COOKIE-1";

    // .Xauthority records are sequences of big-endian u16-length-prefixed
    // fields: family, address, display number, auth name, auth data.
    let mut buf: Vec<u8> = Vec::with_capacity(10 + name.len() + 16);
    buf.extend_from_slice(&0xffffu16.to_be_bytes()); // FamilyWild
    buf.extend_from_slice(&0u16.to_be_bytes()); // address: empty
    buf.extend_from_slice(&0u16.to_be_bytes()); // display number: empty
    buf.extend_from_slice(&(name.len() as u16).to_be_bytes());
    buf.extend_from_slice(name);
    buf.extend_from_slice(&16u16.to_be_bytes());
    buf.extend_from_slice(cookie.as_bytes());

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&buf)
}

#[cfg(target_os = "linux")]
/// True when the launch will effectively run headed and therefore needs a
/// display. This must track `build_chrome_args`: extensions suppress
/// `--headless=new` (content scripts are not injected headless), so a
/// nominally headless launch with extensions is headed in practice.
fn xvfb_applicable(options: &LaunchOptions) -> bool {
    !options.effectively_headless()
}

/// The number of a display on this machine (`:99`, `:0.0`, `unix:1`); `None` for one on another host, which is not
/// this machine's to ask.
#[cfg(any(target_os = "linux", test))]
fn local_display_number(display: &str) -> Option<u32> {
    let (host, rest) = display.rsplit_once(':')?;
    if !(host.is_empty() || host == "unix") {
        return None;
    }
    rest.split('.').next()?.parse().ok()
}

/// Whether an X server answers at `display`. A display on this machine is asked the way an X client asks it: its
/// socket, by name or by file, takes a connection. One on another host is taken to answer; Chrome finds out itself.
#[cfg(target_os = "linux")]
fn display_answers(display: &str) -> bool {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixStream};
    let Some(number) = local_display_number(display) else { return true };
    let socket = format!("/tmp/.X11-unix/X{number}");
    UnixStream::connect(&socket).is_ok()
        || SocketAddr::from_abstract_name(socket.as_bytes()).is_ok_and(|named| UnixStream::connect_addr(&named).is_ok())
}

#[cfg(target_os = "linux")]
fn maybe_start_xvfb(options: &LaunchOptions) -> Option<XvfbServer> {
    if !xvfb_applicable(options) {
        return None;
    }
    // A display is taken at its word only while something answers on it: a `DISPLAY` left naming a server that
    // never started, or has gone, is no display, and Chrome would exit on it. Where a Wayland display is named
    // too, Chrome may open its window there, so the choice stays Chrome's.
    let named = std::env::var("DISPLAY").ok().filter(|d| !d.is_empty());
    let wayland = std::env::var("WAYLAND_DISPLAY").is_ok_and(|w| !w.is_empty());
    if named.is_some_and(|d| wayland || display_answers(&d)) {
        return None;
    }
    if options.no_xvfb {
        return None;
    }

    let (w, h) = options.viewport_size.unwrap_or((1280, 720));

    // Private MIT-MAGIC-COOKIE-1 authority file; passed to the server via
    // -auth and to the paired Chrome via XAUTHORITY. Removed on Drop.
    let auth_file =
        std::env::temp_dir().join(format!("agent-browser-xauth-{}", uuid::Uuid::new_v4()));
    if write_xauth_file(&auth_file).is_err() {
        return None;
    }
    let cleanup_auth = |path: &Path| {
        let _ = std::fs::remove_file(path);
    };

    // Let Xvfb allocate the display itself with -displayfd: the server binds
    // the first free display atomically and writes its number to the given
    // fd. Probing /tmp/.X11-unix for free numbers is racy -- two concurrent
    // sessions could adopt the same display, and closing one would kill the
    // display under the other session's Chrome.
    use std::io::Read;
    use std::os::unix::io::FromRawFd;

    let mut fds = [0i32; 2];
    // SAFETY: plain pipe(2); both ends are wrapped in File below so they are
    // closed on every path out of this function.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        cleanup_auth(&auth_file);
        return None;
    }
    // SAFETY: fds are fresh from pipe(2) and owned exclusively here.
    let mut read_end = unsafe { std::fs::File::from_raw_fd(fds[0]) };
    let write_end = unsafe { std::fs::File::from_raw_fd(fds[1]) };

    let mut child = match Command::new("Xvfb")
        .args([
            "-displayfd",
            &fds[1].to_string(),
            "-screen",
            "0",
            &format!("{}x{}x24", w, h),
            "-nolisten",
            "tcp",
            "-auth",
            &auth_file.display().to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        // Xvfb not installed (or not executable): headed launch proceeds
        // without a display and surfaces Chrome's own error.
        Err(_) => {
            cleanup_auth(&auth_file);
            return None;
        }
    };
    // Drop the parent's copy of the write end so the read below sees EOF as
    // soon as Xvfb exits without reporting a display.
    drop(write_end);

    // SAFETY: read_end owns fds[0]; make it non-blocking so a wedged Xvfb
    // cannot stall the launch past the deadline.
    unsafe {
        let flags = libc::fcntl(fds[0], libc::F_GETFL);
        libc::fcntl(fds[0], libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let mut chunk = [0u8; 16];
        match read_end.read(&mut chunk) {
            // EOF: Xvfb exited without binding a display.
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    match String::from_utf8_lossy(&buf[..pos]).trim().parse::<u32>() {
                        Ok(num) => {
                            return Some(XvfbServer {
                                child,
                                display: format!(":{}", num),
                                auth_file,
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    cleanup_auth(&auth_file);
    None
}

#[derive(Clone)]
pub struct LaunchOptions {
    pub headless: bool,
    pub executable_path: Option<String>,
    pub proxy: Option<String>,
    pub proxy_bypass: Option<String>,
    pub proxy_username: Option<String>,
    pub proxy_password: Option<String>,
    pub profile: Option<String>,
    pub args: Vec<String>,
    pub allow_file_access: bool,
    pub extensions: Option<Vec<String>>,
    pub storage_state: Option<String>,
    pub user_agent: Option<String>,
    pub ignore_https_errors: bool,
    pub ca_cert: Option<String>,
    pub ca_bundle: Option<CaBundle>,
    pub ca_cert_digest: Option<[u8; 32]>,
    pub prepared_nss_home: Option<PreparedNssHome>,
    pub color_scheme: Option<String>,
    pub download_path: Option<String>,
    /// Hide native scrollbars in headless Chromium screenshots by launching
    /// Chrome with `--hide-scrollbars`.
    pub hide_scrollbars: bool,
    /// Initial viewport dimensions used for `--window-size` so the content
    /// area matches the desired viewport from the start.
    pub viewport_size: Option<(u32, u32)>,
    /// When true, omit `--password-store=basic` and `--use-mock-keychain` so
    /// Chrome uses the real system keychain. Set automatically when launching
    /// with a copied Chrome profile.
    pub use_real_keychain: bool,
    /// Enable WebGPU in environments where Chrome does not expose it by
    /// default (headless, GPU-less containers, blocklisted GPUs). On Linux
    /// this routes WebGPU through SwiftShader's software Vulkan with software
    /// compositing so it works without a GPU or display.
    pub webgpu: bool,
    /// Enable Chrome's experimental WebMCP implementation for agent-browser
    /// managed sessions. Enabled by default and disabled with `--no-webmcp`.
    pub webmcp: bool,
    /// Disable automatic Xvfb for headed launches on displayless Linux
    /// hosts (AGENT_BROWSER_NO_XVFB). Carried as a launch option so the
    /// CLI's current environment wins over the env a long-lived daemon was
    /// spawned with.
    pub no_xvfb: bool,
    /// Restrict WebRTC to proxied transports so direct UDP cannot bypass the
    /// HTTP domain filter. Enabled automatically with `--allowed-domains`.
    pub restrict_webrtc: bool,
}

impl LaunchOptions {
    /// Whether Chrome will actually run headless after applying launch rules.
    ///
    /// Extensions force headed mode because Chrome does not inject their
    /// content scripts under `--headless=new`.
    pub fn effectively_headless(&self) -> bool {
        self.headless
            && !self
                .extensions
                .as_ref()
                .is_some_and(|exts| !exts.is_empty())
    }
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            headless: true,
            executable_path: None,
            proxy: None,
            proxy_bypass: None,
            proxy_username: None,
            proxy_password: None,
            profile: None,
            args: Vec::new(),
            allow_file_access: false,
            extensions: None,
            storage_state: None,
            user_agent: None,
            ignore_https_errors: false,
            ca_cert: None,
            ca_bundle: None,
            ca_cert_digest: None,
            prepared_nss_home: None,
            color_scheme: None,
            download_path: None,
            hide_scrollbars: true,
            viewport_size: None,
            use_real_keychain: false,
            webgpu: false,
            webmcp: true,
            no_xvfb: false,
            restrict_webrtc: false,
        }
    }
}

struct ChromeArgs {
    args: Vec<String>,
    user_data_dir: PathBuf,
    temp_user_data_dir: Option<PathBuf>,
}

fn build_chrome_args(options: &LaunchOptions) -> Result<ChromeArgs, String> {
    // Chrome only honors the last --enable-features switch on the command
    // line, so every feature must be collected into a single flag.
    let mut enable_features: Vec<String> = vec![
        "NetworkService".to_string(),
        "NetworkServiceInProcess".to_string(),
    ];
    if options.webmcp {
        enable_features.push("WebMCPTesting".to_string());
        enable_features.push("DevToolsWebMCPSupport".to_string());
    }
    if options.webgpu && cfg!(target_os = "linux") {
        enable_features.push("Vulkan".to_string());
    }

    // User-supplied --enable-features values are merged into that single
    // flag too: appending them as a second switch would silently clobber
    // the preset's features (e.g. drop the WebGPU preset's Vulkan). To turn
    // a preset feature off, pass --disable-features=<name>, which Chrome
    // resolves as disabled.
    // The debugger is on a pipe, and Chrome tells every page a browser driven over one is automated
    // (`navigator.webdriver`), as it does for an ephemeral port. A launched browser doesn't say that: the switch that
    // opens it to its driver is not part of what it is. Merged the same way, since Chrome reads one such switch.
    let mut disable_blink: Vec<String> = vec!["AutomationControlled".to_string()];
    let mut user_args: Vec<String> = Vec::new();
    for arg in &options.args {
        if let Some(values) = arg.strip_prefix("--disable-blink-features=") {
            for feature in values.split(',').map(str::trim).filter(|f| !f.is_empty()) {
                if !disable_blink.iter().any(|f| f == feature) {
                    disable_blink.push(feature.to_string());
                }
            }
        } else if arg.starts_with("--remote-debugging-port=") || arg == "--remote-debugging-pipe" {
            // The debugger is the launch's to place: a port would open it to every local process.
        } else if let Some(values) = arg.strip_prefix("--enable-features=") {
            for feature in values.split(',').map(str::trim).filter(|f| !f.is_empty()) {
                if !enable_features.iter().any(|f| f == feature) {
                    enable_features.push(feature.to_string());
                }
            }
        } else {
            user_args.push(arg.clone());
        }
    }

    let mut args = vec![
        // The debugger is on fds 3 and 4, which only the launching process holds: no port any local process of any
        // user could open (`pipe`).
        "--remote-debugging-pipe".to_string(),
        format!("--disable-blink-features={}", disable_blink.join(",")),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-component-update".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-hang-monitor".to_string(),
        "--disable-popup-blocking".to_string(),
        "--disable-prompt-on-repost".to_string(),
        "--disable-sync".to_string(),
        "--disable-features=Translate".to_string(),
        format!("--enable-features={}", enable_features.join(",")),
        "--metrics-recording-only".to_string(),
    ];

    if options.webgpu {
        // WebGPU is not exposed in headless or GPU-blocklisted environments
        // unless explicitly enabled.
        args.push("--enable-unsafe-webgpu".to_string());
        if cfg!(target_os = "linux") {
            // Route WebGPU through SwiftShader's software Vulkan and disable
            // Vulkan surface presentation (software compositing). This
            // combination produces real pixels in GPU-less containers and CI;
            // hardware-Vulkan users can override via --args (later switches
            // win). macOS and Windows use the hardware Metal/D3D backends.
            args.push("--use-angle=vulkan".to_string());
            args.push("--use-vulkan=swiftshader".to_string());
            args.push("--use-webgpu-adapter=swiftshader".to_string());
            args.push("--disable-vulkan-surface".to_string());
        }
    }

    if !options.use_real_keychain {
        args.push("--password-store=basic".to_string());
        args.push("--use-mock-keychain".to_string());
    }

    let effectively_headless = options.effectively_headless();

    // Extensions require headed mode in native Chrome (content scripts are not
    // injected in headless mode).  Skip --headless when extensions are loaded.
    if effectively_headless {
        args.push("--headless=new".to_string());
        // Linux paints native scrollbars into viewport screenshots unless
        // Chrome is launched with this flag. `--hide-scrollbars` is
        // presence-based, so agent-browser exposes --hide-scrollbars false
        // as the public opt-out instead of forwarding a fake inverse switch.
        if options.hide_scrollbars {
            args.push("--hide-scrollbars".to_string());
        }
        // Enable SwiftShader software rendering in headless mode.  This
        // prevents silent crashes in environments where GPU drivers are
        // missing or restricted (VMs, containers, some cloud machines)
        // while preserving WebGL support.  Playwright uses the same flag.
        args.push("--enable-unsafe-swiftshader".to_string());
    }

    if let Some(ref proxy) = options.proxy {
        args.push(format!("--proxy-server={}", proxy));
    }

    if let Some(ref bypass) = options.proxy_bypass {
        args.push(format!("--proxy-bypass-list={}", bypass));
    }

    let (user_data_dir, temp_user_data_dir) = if let Some(ref profile) = options.profile {
        let expanded = expand_tilde(profile);
        let dir = PathBuf::from(&expanded);
        args.push(format!("--user-data-dir={}", expanded));
        (dir, None)
    } else {
        // A fixed runtime dir, not a random temp one: another daemon finds the
        // Chrome a live one launched through the DevToolsActivePort file that
        // lives here. It holds the profile and the debugger's address, so it is
        // the owner's alone.
        let dir = runtime_dir_for_mode(effectively_headless);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create runtime profile dir: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        args.push(format!("--user-data-dir={}", dir.display()));
        (dir, None)
    };

    if options.ignore_https_errors {
        args.push("--ignore-certificate-errors".to_string());
    }

    if options.allow_file_access {
        args.push("--allow-file-access-from-files".to_string());
        args.push("--allow-file-access".to_string());
    }

    if let Some(ref exts) = options.extensions {
        if !exts.is_empty() {
            let ext_list = exts.join(",");
            args.push(format!("--load-extension={}", ext_list));
            args.push(format!("--disable-extensions-except={}", ext_list));
        }
    }

    let has_window_size = options
        .args
        .iter()
        .any(|a| a.starts_with("--start-maximized") || a.starts_with("--window-size="));

    if !has_window_size && effectively_headless {
        let (w, h) = options.viewport_size.unwrap_or((1280, 720));
        args.push(format!("--window-size={},{}", w, h));
    }

    args.extend(user_args);

    if options.restrict_webrtc {
        // Append this after user and plugin arguments so an unsafe custom
        // policy cannot override the containment setting. JavaScript-level
        // RTCPeerConnection blocking is the primary control; this prevents
        // direct UDP traffic if page code obtains a native constructor.
        args.retain(|arg| !arg.starts_with("--force-webrtc-ip-handling-policy="));
        args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string());
    }

    if should_disable_sandbox(&args) {
        args.push("--no-sandbox".to_string());
    }

    if should_disable_dev_shm(&args) {
        args.push("--disable-dev-shm-usage".to_string());
    }

    Ok(ChromeArgs {
        args,
        user_data_dir,
        temp_user_data_dir,
    })
}

#[cfg(target_os = "linux")]
pub fn prepare_nss_home(ca_cert: &CaBundle) -> Result<PreparedNssHome, String> {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let home = std::env::temp_dir().join(format!("agent-browser-nss-{}", uuid::Uuid::new_v4()));
    let pki_dir = home.join(".local/share/pki");
    let db_dir = pki_dir.join("nssdb");

    let result = (|| {
        std::fs::create_dir_all(&db_dir)
            .map_err(|e| format!("Failed to create temporary CA trust store: {e}"))?;
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to secure temporary CA trust store: {e}"))?;
        symlink(".local/share/pki", home.join(".pki"))
            .map_err(|e| format!("Failed to configure temporary CA trust store: {e}"))?;

        let db = format!("sql:{}", db_dir.display());
        run_certutil(
            &["-N", "--empty-password", "-d", &db],
            "initialize the NSS database",
        )?;

        for (index, cert) in ca_cert.certificates().iter().enumerate() {
            let cert_path = home.join(format!("ca-{index}.der"));
            std::fs::write(&cert_path, cert.as_ref())
                .map_err(|e| format!("Failed to stage CA certificate for import: {e}"))?;
            std::fs::set_permissions(&cert_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("Failed to secure staged CA certificate: {e}"))?;
            let nickname = format!("agent-browser-ca-{index}");
            let cert_path_arg = cert_path.display().to_string();
            let import_result = run_certutil(
                &[
                    "-A",
                    "-d",
                    &db,
                    "-t",
                    "C,,",
                    "-n",
                    &nickname,
                    "-i",
                    &cert_path_arg,
                ],
                "import the CA certificate",
            );
            let _ = std::fs::remove_file(&cert_path);
            import_result?;
        }

        Ok(())
    })();

    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&home);
        return Err(error);
    }

    Ok(PreparedNssHome {
        inner: Arc::new(PreparedNssHomeInner { path: home }),
    })
}

#[cfg(not(target_os = "linux"))]
pub fn prepare_nss_home(_ca_cert: &CaBundle) -> Result<PreparedNssHome, String> {
    Err("--ca-cert is currently supported only on Linux".to_string())
}

fn resolve_prepared_nss_home(options: &LaunchOptions) -> Result<Option<PreparedNssHome>, String> {
    if let Some(home) = options.prepared_nss_home.clone() {
        return Ok(Some(home));
    }

    let ca_bundle = match options.ca_bundle.clone() {
        Some(bundle) => Some(bundle),
        None => options
            .ca_cert
            .as_deref()
            .map(crate::ca_bundle::load)
            .transpose()?,
    };

    ca_bundle.as_ref().map(prepare_nss_home).transpose()
}

#[cfg(target_os = "linux")]
fn run_certutil(args: &[&str], action: &str) -> Result<(), String> {
    let output = Command::new("certutil").args(args).output().map_err(|e| {
        format!(
            "Failed to {action}: could not run certutil ({e}). Run agent-browser install --with-deps, or install libnss3-tools on Debian/Ubuntu or nss-tools on RPM Linux."
        )
    })?;
    if output.status.success() {
        return Ok(());
    }

    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        Err(format!(
            "Failed to {action}: certutil exited with {}. Run agent-browser install --with-deps, or repair libnss3-tools on Debian/Ubuntu or nss-tools on RPM Linux.",
            output.status
        ))
    } else {
        Err(format!("Failed to {action}: {detail}"))
    }
}

fn terminate_launched_chrome(child: &mut Child) {
    super::launched::closed(child.id());
    let _ = child.kill();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
}


/// The fixed Chrome runtime dir for a launch mode. One Chrome per mode
/// machine-wide: headed and headless cannot share a user-data-dir, and a
/// second launch while one is alive is prevented by reattach-first.
/// `AGENT_BROWSER_RUNTIME_DIR` isolates concurrent runs if ever needed.
pub fn runtime_dir_for_mode(headless: bool) -> PathBuf {
    if let Ok(dir) = std::env::var("AGENT_BROWSER_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    let mode = if headless { "headless" } else { "headed" };
    dirs::home_dir()
        .map(|h| h.join(".agent-browser").join(format!("chrome-runtime-{mode}")))
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("agent-browser-chrome-runtime-{mode}"))
        })
}

/// The runtime dir's record of the Chrome launched into it: its process id,
/// written at launch, readable only by its owner.
const RUNTIME_PID_FILE: &str = "agent-browser-chrome.pid";

fn write_runtime_pid(dir: &Path, pid: u32) {
    write_chrome_record(dir, &format!("{pid}\n"));
}

/// Records a browser a daemon launched in a profile, as a launch records one in the runtime dir. The daemon does this,
/// not the launch: a walk's browser in the same profile is the walk's to end, and with no record it is never reattached.
/// The mode goes with it because a profile, unlike a runtime dir, holds either.
pub fn remember_chrome(dir: &Path, pid: u32, headless: bool) {
    let mode = if headless { "headless" } else { "headed" };
    write_chrome_record(dir, &format!("{pid}\n{mode}\n"));
    record_browser(dir, pid);
}

/// Beside a profile: which process its browser is, as `<pid> <start>` ([`crate::process::started`]), written by whoever
/// launched it, readable by the owner only. A number and its start name one process for as long as it lives.
const BROWSER_IDENTITY_FILE: &str = "agent-browser-chrome.identity";

/// Records the browser `pid` (a process this one launched and still holds) as the profile's at `dir`. A system that
/// can't say when it started records nothing, and the browser is then never reused.
pub fn record_browser(dir: &Path, pid: u32) {
    let Some(started) = crate::process::started(pid) else {
        let _ = std::fs::remove_file(dir.join(BROWSER_IDENTITY_FILE));
        return;
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(dir.join(BROWSER_IDENTITY_FILE)) {
        use std::io::Write as _;
        let _ = file.write_all(format!("{pid} {started}\n").as_bytes());
    }
}

/// The browser the profile at `dir` records ([`record_browser`]): its number and start. None with no such record, or
/// one that isn't a plain file of the profile's own.
fn recorded_browser(dir: &Path) -> Option<(u32, u64)> {
    let path = dir.join(BROWSER_IDENTITY_FILE);
    if !std::fs::symlink_metadata(&path).ok()?.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let (pid, started) = text.trim().split_once(' ')?;
    Some((pid.parse().ok().filter(|p: &u32| *p > 1)?, started.parse().ok()?))
}

fn write_chrome_record(dir: &Path, record: &str) {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(dir.join(RUNTIME_PID_FILE)) {
        use std::io::Write as _;
        let _ = file.write_all(record.as_bytes());
    }
}

/// The file whose locks say who is using the browser in a runtime dir.
const HOLDERS_FILE: &str = "agent-browser-chrome.holders";

/// One process's place among those using a browser that outlives any one of them. Several daemons can reach the Chrome
/// in a runtime dir, and each holds a shared lock on a file there for as long as it uses it. The system lets go of the
/// lock however a process ends, so a daemon that crashed never counts: the alternative, a list of who is attached,
/// would be wrong after every crash this machine exists to survive.
pub struct BrowserHold {
    lock: Option<std::fs::File>,
}

impl BrowserHold {
    /// Joins the users of the browser in `dir`, waiting while one closes it: that one holds the lock alone until its
    /// browser has gone, so what is found next is either gone or staying. A dir that can't hold a lock leaves this
    /// process acting alone, as it would with no lock at all.
    pub fn take(dir: &Path) -> Self {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(HOLDERS_FILE))
            .ok()
            .filter(|lock| lock.lock_shared().is_ok());
        Self { lock }
    }

    /// Whether nobody else is using the browser. This gives up the place taken: the answer is for a process on its way
    /// out, and when it is yes the lock is held alone until this hold is dropped. Of two leaving at once, exactly one
    /// hears yes: a failed try holds nothing, so the other's try can't fail on it.
    pub fn last_out(&mut self) -> bool {
        let Some(lock) = self.lock.as_ref() else { return true };
        let _ = lock.unlock();
        !matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock))
    }
}

/// A Chrome this process reattached to: not its child, so what `ChromeProcess` asks of a child is asked of the system.
pub struct ReattachedChrome {
    pid: u32,
    /// When the process proved to be the browser started ([`crate::process::started`]): its number is signalled only
    /// while the process with it is still that one.
    started: Option<u64>,
    hold: BrowserHold,
    /// The mode it was launched in, where that was recorded.
    headless: Option<bool>,
}

impl ReattachedChrome {
    pub fn headless(&self) -> Option<bool> {
        self.headless
    }

    pub fn others_remain(&mut self) -> bool {
        !self.hold.last_out()
    }

    pub fn has_exited(&self) -> bool {
        !crate::process::alive(self.pid) || !crate::process::is_still(self.pid, self.started)
    }

    /// Waits for a browser that answered `Browser.close` to go, and ends it if it doesn't. A browser that didn't answer
    /// isn't this: the pid is only proved by what answers, and a process that has it now may be anyone's.
    pub fn wait_or_kill(&self, timeout: Duration) {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if self.has_exited() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Chrome leads its own process group (see `try_launch_chrome`), which holds its helpers too. The group is
        // signalled only while its leader is still the browser this proved at reattach: same number, same start, and
        // still the leader of a group of that number. A browser that went has left its number to anyone.
        #[cfg(unix)]
        if let Some(pid) = i32::try_from(self.pid).ok().filter(|p| *p > 1) {
            if crate::process::is_still(self.pid, self.started) && unsafe { libc::getpgid(pid) } == pid {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
    }
}

/// Whether the process is alive and ours to signal. Elsewhere the endpoint's
/// own report of its browser process is the whole check.
/// Reattaches to a surviving runtime Chrome, if one is alive: reads the
/// `DevToolsActivePort` file the fixed runtime dir holds and checks that
/// what answers there is the Chrome this runtime dir launched. A port any
/// local process could bind once that Chrome exited proves nothing by
/// answering: the recorded Chrome must still be running, and the endpoint
/// must name that same process as its browser. None: no live Chrome of
/// ours, so the caller launches fresh.
pub async fn reattach_chrome(dir: &Path) -> Option<(String, ReattachedChrome)> {
    // The place is taken first, so a daemon closing this Chrome is either waited for or sees this one and leaves it.
    let hold = {
        let dir = dir.to_path_buf();
        tokio::task::spawn_blocking(move || BrowserHold::take(&dir)).await.ok()?
    };
    let (ws_url, pid) = reattach_runtime_dir(dir, Duration::from_secs(2)).await?;
    // The browser has just answered as this pid: what it is, from now, is this number started at this moment.
    let started = crate::process::started(pid);
    let record = std::fs::read_to_string(dir.join(RUNTIME_PID_FILE)).unwrap_or_default();
    let headless = record.lines().nth(1).map(|mode| mode != "headed");
    Some((ws_url, ReattachedChrome { pid, started, hold, headless }))
}

/// Where a Chrome these options would launch keeps the record that finds it again: the runtime dir, or a profile given
/// by path. A profile given by name runs in a temp copy that goes with its browser, so there is nothing to find.
pub fn reattachable_dir(options: &LaunchOptions) -> Option<PathBuf> {
    match options.profile.as_deref() {
        Some(profile) if is_chrome_profile_name(profile) => None,
        Some(profile) => Some(PathBuf::from(expand_tilde(profile))),
        None => Some(runtime_dir_for_mode(options.effectively_headless())),
    }
}

async fn reattach_runtime_dir(dir: &Path, timeout: Duration) -> Option<(String, u32)> {
    let content = std::fs::read_to_string(dir.join("DevToolsActivePort")).ok()?;
    let mut lines = content.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let ws_path = lines.next().unwrap_or("").trim();
    let pid: u32 = std::fs::read_to_string(dir.join(RUNTIME_PID_FILE))
        .ok()?
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()?;
    if !crate::process::alive(pid) {
        return None;
    }
    let ws_url = format!("ws://127.0.0.1:{port}{ws_path}");
    (ws_browser_pid(&ws_url, timeout).await? == pid).then_some((ws_url, pid))
}

/// The DevTools address of the browser that holds the Chrome profile at `dir` right now, or None. A profile's
/// `DevToolsActivePort` outlives its browser, the port it names can come to be anyone's, and what answers there says
/// what it likes about itself. So the address is the profile's only on what was recorded and what the system says: the
/// profile records the browser launched in it ([`record_browser`]: its number and the moment it started); the process
/// holding the profile's lock (`SingletonLock`, Chrome's `<host>-<pid>`) is that number, and the live process with it
/// started at exactly that moment, so it is that browser and not a later one given its number; and the system says that
/// process is the one listening on the loopback port. Only then is the endpoint asked, and its own report must agree. A
/// profile with no record, or a platform that can't say who listens on a port, is never reused: the walk launches its
/// own browser.
pub async fn proven_profile_endpoint(dir: &Path, timeout: Duration) -> Option<String> {
    let content = std::fs::read_to_string(dir.join("DevToolsActivePort")).ok()?;
    let mut lines = content.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let ws_path = lines.next().unwrap_or("").trim();
    if !ws_path.starts_with('/') {
        return None;
    }
    let (browser, started) = recorded_browser(dir)?;
    if profile_holder(dir)? != browser || !crate::process::is_still(browser, Some(started)) {
        return None;
    }
    // The port is the browser's own, as the system tells it: an endpoint can claim any process, never own its socket.
    if !crate::process::listens_on_loopback(browser, port) {
        return None;
    }
    let ws_url = format!("ws://127.0.0.1:{port}{ws_path}");
    (ws_browser_pid(&ws_url, timeout).await? == browser).then_some(ws_url)
}

/// The process that holds a Chrome profile, from its `SingletonLock` link (`<host>-<pid>`); None where there is none.
fn profile_holder(dir: &Path) -> Option<u32> {
    let target = std::fs::read_link(dir.join("SingletonLock")).ok()?;
    target.to_string_lossy().rsplit_once('-')?.1.parse().ok().filter(|pid| *pid > 1)
}

/// The process id the endpoint reports for its browser process
/// (`SystemInfo.getProcessInfo`), if it answers as a browser.
async fn ws_browser_pid(ws_url: &str, timeout: Duration) -> Option<u32> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    tokio::time::timeout(timeout, async {
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await.ok()?;
        let cmd = r#"{"id":1,"method":"SystemInfo.getProcessInfo"}"#;
        ws.send(Message::Text(cmd.into())).await.ok()?;
        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Text(text) = msg {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                if v.get("id").and_then(|id| id.as_u64()) != Some(1) {
                    continue;
                }
                let _ = ws.close(None).await;
                return v
                    .pointer("/result/processInfo")?
                    .as_array()?
                    .iter()
                    .find(|p| p.get("type").and_then(|t| t.as_str()) == Some("browser"))?
                    .get("id")?
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok());
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

pub fn launch_chrome(options: &LaunchOptions) -> Result<ChromeProcess, String> {
    let chrome_path = match &options.executable_path {
        Some(p) => PathBuf::from(p),
        None => find_chrome().ok_or_else(|| {
            let cache_dir = crate::paths::browsers_dirs_here().iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ");
            format!(
                "Chrome not found. Checked:\n  \
                 - agent-browser cache: {}\n  \
                 - System Chrome installations\n  \
                 - Puppeteer browser cache\n  \
                 - Playwright browser cache\n\
                 Run `agent-browser install` to download Chrome, or use --executable-path.",
                cache_dir
            )
        })?,
    };

    // A replacement a process died in the middle of leaves this profile's name empty, and Chrome would make a new one
    // there with the owner's out of sight: every launch comes through here, so this is where it is finished.
    if let Some(profile) = options.profile.as_deref().filter(|p| !is_chrome_profile_name(p)) {
        crate::session::finish_replacing(Path::new(&expand_tilde(profile)));
    }

    // Profile name preprocessing: if --profile is a Chrome profile name (not a
    // path), resolve it to a directory, copy the profile to a temp dir, and
    // rewrite options so the retry loop uses the copied profile.
    let mut resolved_options: Option<LaunchOptions> = None;
    let mut profile_temp_dir: Option<PathBuf> = None;

    if let Some(ref profile) = options.profile {
        if is_chrome_profile_name(profile) {
            let user_data_dir = find_chrome_user_data_dir().ok_or_else(|| {
                "No Chrome user data directory found. Cannot resolve profile name.\n\
                 If you meant a directory path, use a full path (e.g., /path/to/profile)."
                    .to_string()
            })?;
            let resolved = resolve_chrome_profile(&user_data_dir, profile)?;
            let temp_path = copy_chrome_profile(&user_data_dir, &resolved)?;

            let mut opts = options.clone();
            opts.profile = Some(temp_path.display().to_string());
            opts.use_real_keychain = true;
            opts.args.push(format!("--profile-directory={}", resolved));
            profile_temp_dir = Some(temp_path);
            resolved_options = Some(opts);
        }
    }

    let effective_options = resolved_options.as_ref().unwrap_or(options);

    let max_attempts = 3;
    let mut last_err = String::new();

    for attempt in 1..=max_attempts {
        match try_launch_chrome(&chrome_path, effective_options) {
            Ok(mut process) => {
                // Transfer profile temp dir ownership to ChromeProcess for cleanup on Drop.
                // The try_launch_chrome temp_user_data_dir is None here because we set profile
                // to the temp path (treated as a user-supplied path, no second temp dir).
                if let Some(ref dir) = profile_temp_dir {
                    process.temp_user_data_dir = Some(dir.clone());
                }
                return Ok(process);
            }
            Err(e) => {
                last_err = e;
                // No display is the machine's answer, and the same at every attempt.
                if last_err.starts_with(NO_DISPLAY) {
                    break;
                }
                if attempt < max_attempts {
                    // Use write! instead of eprintln! to avoid panicking
                    // if the daemon's stderr pipe is broken (parent dropped it).
                    let _ = writeln!(
                        std::io::stderr(),
                        "[chrome] Launch attempt {}/{} failed, retrying in 500ms: {}",
                        attempt,
                        max_attempts,
                        last_err
                    );
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
    }

    // All retries failed: clean up profile temp dir if we created one
    if let Some(ref dir) = profile_temp_dir {
        let _ = std::fs::remove_dir_all(dir);
    }

    Err(last_err)
}

/// Turns Chrome's own password prompts off in the profile at `user_data_dir`, before it opens. After a sign-in with a
/// password Chrome knows was leaked, its warning opens over the page: every click and key sent to the tab goes to it and
/// reaches nothing, and the commands still answer done, while scripts run on. Nobody can dismiss it in a headless
/// browser, so the tab stays dead whatever is done on it. It answers to the profile's preference alone: no switch turns
/// it off. The node's vault keeps logins, so Chrome has none of its own to offer to save either. What else the profile's
/// preferences hold stands.
fn keep_password_prompts_off(user_data_dir: &Path) {
    let file = user_data_dir.join("Default").join("Preferences");
    let mut prefs = match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(prefs) if prefs.is_object() => prefs,
            // Preferences Chrome can't read either: it starts them over, and the next launch has one to set.
            _ => return,
        },
        Err(_) => serde_json::json!({}),
    };
    prefs["credentials_enable_service"] = serde_json::json!(false);
    if !prefs["profile"].is_object() {
        prefs["profile"] = serde_json::json!({});
    }
    prefs["profile"]["password_manager_enabled"] = serde_json::json!(false);
    prefs["profile"]["password_manager_leak_detection"] = serde_json::json!(false);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&file, prefs.to_string());
}

/// Whether a live Chrome holds the profile. Chrome listens on a socket the profile links to for as long as it runs, so
/// a connection says it is there now, where the lock and link it leaves behind after a crash say only that it was.
/// The link is followed by hand: it points somewhere short, and the path through a profile may be too long to connect.
#[cfg(unix)]
fn profile_held(user_data_dir: &Path) -> bool {
    std::fs::read_link(user_data_dir.join("SingletonSocket"))
        .is_ok_and(|socket| std::os::unix::net::UnixStream::connect(socket).is_ok())
}

/// Chrome keeps no such socket here: a second browser finds out for itself, and says so as it exits.
#[cfg(not(unix))]
fn profile_held(_user_data_dir: &Path) -> bool {
    false
}

/// How the launched browser's debugger is reached: on its pipe (`pipe`), or on a loopback port it picks and names in
/// `DevToolsActivePort`, as the agent-browser CLI reaches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Debugger {
    Pipe,
    Port,
}

/// Set once a browser on this machine has stayed silent on its pipe: later launches go straight to the port.
static PIPE_SILENT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What a launch on the pipe that went unanswered falls back to. Windows, 22 Nov 2026 (c772f210): the system Chrome
/// 157.0.8103.79 never answered the engine's pipe, three launches of 30 s each, while the CLI drove the same Chrome on
/// a port in about a second. A browser that left early, or whose launch failed for another reason, is not retried:
/// the port would fail it the same way.
fn fallback_after(debugger: Debugger, error: &str, windows: bool) -> Option<Debugger> {
    (windows && debugger == Debugger::Pipe && error.starts_with(PIPE_TIMEOUT)).then_some(Debugger::Port)
}

/// The start of the error a launch whose browser never answered on its pipe ends with.
const PIPE_TIMEOUT: &str = "Timeout waiting for Chrome's debugger to answer";

/// How long a launch waits for the browser's first answer on its pipe. Shorter on Windows, where a silent pipe falls
/// back to the port rather than failing.
fn pipe_wait(windows: bool) -> Duration {
    Duration::from_secs(if windows { 10 } else { 30 })
}

fn try_launch_chrome(chrome_path: &Path, options: &LaunchOptions) -> Result<ChromeProcess, String> {
    let windows = cfg!(windows);
    let first = if windows && PIPE_SILENT.load(std::sync::atomic::Ordering::Relaxed) { Debugger::Port } else { Debugger::Pipe };
    match try_launch_chrome_on(chrome_path, options, first) {
        Err(e) => match fallback_after(first, &e, windows) {
            Some(next) => {
                PIPE_SILENT.store(true, std::sync::atomic::Ordering::Relaxed);
                let _ = writeln!(std::io::stderr(), "[chrome] {e}; trying its debugger on a port instead");
                try_launch_chrome_on(chrome_path, options, next).map_err(|port| format!("{e}; on a port: {port}"))
            }
            None => Err(e),
        },
        ok => ok,
    }
}

/// The launch's arguments with the debugger placed as `debugger` says.
fn debugger_args(mut args: Vec<String>, debugger: Debugger) -> Vec<String> {
    if debugger == Debugger::Port {
        for arg in args.iter_mut().filter(|a| *a == "--remote-debugging-pipe") {
            *arg = "--remote-debugging-port=0".to_string();
        }
    }
    args
}

/// The browser's DevTools address from its `DevToolsActivePort` file (port, then path), once Chrome has written both.
fn devtools_address(content: &str) -> Option<String> {
    let mut lines = content.lines();
    let port: u16 = lines.next()?.trim().parse().ok().filter(|p| *p != 0)?;
    let path = lines.next()?.trim();
    path.starts_with("/devtools/browser/").then(|| format!("ws://127.0.0.1:{port}{path}"))
}

fn try_launch_chrome_on(chrome_path: &Path, options: &LaunchOptions, debugger: Debugger) -> Result<ChromeProcess, String> {
    let ChromeArgs {
        args,
        user_data_dir,
        temp_user_data_dir,
    } = build_chrome_args(options)?;
    let args = debugger_args(args, debugger);

    let cleanup_temp_dir = |dir: &Option<PathBuf>| {
        if let Some(ref d) = dir {
            let _ = std::fs::remove_dir_all(d);
        }
    };

    // A profile opens in one browser. A second one started on it gives no debugger: it exits 21, or, when both have
    // windows, hands its arguments to the first (a new window in a browser someone may be using) and exits 0. So none is
    // started, and the profile's files stay as the running browser has them: its port file is the only way back to it.
    if profile_held(&user_data_dir) {
        cleanup_temp_dir(&temp_user_data_dir);
        return Err(format!(
            "the profile at {} is already open in a running browser{}: close that browser, or connect to it",
            user_data_dir.display(),
            lock_holder(&user_data_dir).map(|h| format!(" ({h})")).unwrap_or_default()
        ));
    }

    // A port file left by an earlier launch names a debugger that is gone.
    let _ = std::fs::remove_file(user_data_dir.join("DevToolsActivePort"));
    keep_password_prompts_off(&user_data_dir);

    #[cfg(target_os = "linux")]
    let temp_nss_home = match resolve_prepared_nss_home(options) {
        Ok(home) => home,
        Err(error) => {
            cleanup_temp_dir(&temp_user_data_dir);
            return Err(error);
        }
    };
    #[cfg(not(target_os = "linux"))]
    let temp_nss_home: Option<PreparedNssHome> = None;

    #[cfg(target_os = "linux")]
    let xvfb = maybe_start_xvfb(options);

    // The debugger's pipe: Chrome reads fd 3 and writes fd 4, and nothing else in the system holds them.
    let pipes = match debugger {
        Debugger::Pipe => Some(super::pipe::pipes().map_err(|e| {
            cleanup_temp_dir(&temp_user_data_dir);
            format!("no pipe for the browser's debugger: {e}")
        })?),
        Debugger::Port => None,
    };

    #[cfg(not(windows))]
    let mut cmd = Command::new(chrome_path);
    #[cfg(not(windows))]
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Scope the virtual display and its auth cookie to the Chrome child;
    // the daemon's own environment is left untouched.
    #[cfg(target_os = "linux")]
    if let Some(ref x) = xvfb {
        cmd.env("DISPLAY", &x.display);
        cmd.env("XAUTHORITY", &x.auth_file);
    }
    #[cfg(target_os = "linux")]
    if let Some(ref home) = temp_nss_home {
        cmd.env("HOME", home.path());
        cmd.env("XDG_DATA_HOME", home.path().join(".local/share"));
    }

    // The child's pipe ends, copied above the numbers they go to so placing one can't close the other. They close on
    // exec except where `dup2` puts them, at 3 and 4.
    #[cfg(unix)]
    let child_fds = if let Some(pipes) = pipes.as_ref() {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        let above = |fd: i32| -> Result<OwnedFd, String> {
            // SAFETY: fcntl on a descriptor this process owns; the copy is owned by the OwnedFd.
            let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
            if copy < 0 {
                return Err(format!("no pipe for the browser's debugger: {}", std::io::Error::last_os_error()));
            }
            Ok(unsafe { OwnedFd::from_raw_fd(copy) })
        };
        match (above(pipes.child_reads.as_raw_fd()), above(pipes.child_writes.as_raw_fd())) {
            (Ok(r), Ok(w)) => Some((r, w)),
            (Err(e), _) | (_, Err(e)) => {
                cleanup_temp_dir(&temp_user_data_dir);
                return Err(e);
            }
        }
    } else {
        None
    };

    // Place Chrome in its own process group so we can kill the entire tree
    // (main process + GPU/renderer/utility/crashpad helpers) with a single
    // killpg(), preventing orphaned processes (issue #1113).
    //
    // NOTE: Do NOT use PR_SET_PDEATHSIG here. Chrome is spawned via
    // tokio::task::spawn_blocking, and PR_SET_PDEATHSIG fires when the
    // *thread* that forked the child exits, not the process. Tokio reaps
    // idle blocking threads after ~10s, which kills Chrome (issue #1157).
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let fds = child_fds.as_ref().map(|(r, w)| (r.as_raw_fd(), w.as_raw_fd()));
        // SAFETY: pre_exec runs between fork() and exec() in the child.
        // setpgid and dup2 are async-signal-safe.
        unsafe {
            cmd.pre_exec(move || {
                libc::setpgid(0, 0);
                if let Some((read_fd, write_fd)) = fds {
                    if libc::dup2(read_fd, 3) < 0 || libc::dup2(write_fd, 4) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }

    #[cfg(not(windows))]
    let spawned = cmd.spawn();
    #[cfg(windows)]
    let spawned = Child::spawn(
        chrome_path,
        &args,
        options.effectively_headless(),
        pipes.as_ref().map(|p| (&p.child_reads, &p.child_writes)),
    );
    // This process's copies of the child's ends go now: the pipe closes when the browser does.
    #[cfg(unix)]
    drop(child_fds);
    let pipes = pipes.map(|super::pipe::Pipes { child_reads, child_writes, to_browser, from_browser }| {
        drop((child_reads, child_writes));
        (to_browser, from_browser)
    });
    let mut child = spawned.map_err(|e| {
        cleanup_temp_dir(&temp_user_data_dir);
        format!("Failed to launch Chrome at {:?}: {}", chrome_path, e)
    })?;
    // Noted at once, before it answers: a launch whose process stops while the browser starts leaves it too.
    super::launched::opened(child.id(), &user_data_dir);

    // A runtime-dir Chrome may be reattached by a later daemon; record which
    // process it is so that daemon can tell it from whatever else answers on
    // its port. Written before the port file: a daemon that dies between the two
    // leaves a Chrome a later one can still prove is its own.
    if options.profile.is_none() {
        write_runtime_pid(&user_data_dir, child.id());
    }
    // Which process this browser is, beside its profile: the child is ours and unreaped, so its number and start are
    // its own. Only a browser with this record, alive as this same process, is ever reused (`proven_profile_endpoint`).
    record_browser(&user_data_dir, child.id());

    let deadline = |wait: Duration| std::time::Instant::now() + wait;
    let (ws_url, relay) = match pipes {
        Some((to_browser, from_browser)) => {
            let relay = match super::pipe::Relay::start(to_browser, from_browser) {
                Ok(relay) => relay,
                Err(e) => {
                    terminate_launched_chrome(&mut child);
                    cleanup_temp_dir(&temp_user_data_dir);
                    return Err(format!("the browser's debugger couldn't be served: {e}"));
                }
            };
            if let Err(e) = wait_for_debugger(&mut child, || relay.wait_ready(Duration::from_millis(50)).then(|| relay.ws_url()), || relay.is_closed(), deadline(pipe_wait(cfg!(windows)))) {
                terminate_launched_chrome(&mut child);
                // A profile another browser holds is said as its folder and who holds it, read before the folder goes.
                let e = said_of_lock(&user_data_dir, e);
                cleanup_temp_dir(&temp_user_data_dir);
                return Err(e);
            }
            let ws_url = relay.ws_url();
            remember_devtools(&user_data_dir, &ws_url);
            (ws_url, Some(relay))
        }
        None => {
            let port_file = user_data_dir.join("DevToolsActivePort");
            let answered = || {
                std::thread::sleep(Duration::from_millis(50));
                std::fs::read_to_string(&port_file).ok().and_then(|c| devtools_address(&c))
            };
            match wait_for_debugger(&mut child, answered, || false, deadline(Duration::from_secs(30))) {
                Ok(ws_url) => (ws_url, None),
                Err(e) => {
                    terminate_launched_chrome(&mut child);
                    let e = said_of_lock(&user_data_dir, e.replace(PIPE_TIMEOUT, "Timeout waiting for Chrome to name its debugger's port"));
                    cleanup_temp_dir(&temp_user_data_dir);
                    return Err(e);
                }
            }
        }
    };

    #[cfg(unix)]
    let pgid = {
        let pid = child.id() as i32;
        // The child called setpgid(0,0) via process_group(0), so its PGID
        // equals its own PID.
        Some(pid)
    };

    Ok(ChromeProcess {
        child,
        ws_url,
        temp_user_data_dir,
        temp_nss_home,
        #[cfg(unix)]
        pgid,
        #[cfg(target_os = "linux")]
        xvfb,
        hold: None,
        relay,
    })
}

/// Waits for the browser's debugger: `answered` gives its address once it is up (each call waits a moment), and
/// `closed` says its pipe has closed. Chrome's stderr is drained for the life of the browser (it blocks on a full pipe),
/// and what it said before an early exit is the launch's error.
fn wait_for_debugger(
    child: &mut Child,
    mut answered: impl FnMut() -> Option<String>,
    closed: impl Fn() -> bool,
    deadline: std::time::Instant,
) -> Result<String, String> {
    let said: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    if let Some(stderr) = child.stderr.take() {
        let said = said.clone();
        let _ = std::thread::Builder::new().name("chrome-stderr-drain".into()).spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let mut said = said.lock().unwrap_or_else(|e| e.into_inner());
                if said.len() < 200 {
                    said.push(line);
                }
            }
        });
    }
    let last_words = |message: &str| {
        // The reader may still hold Chrome's last words.
        std::thread::sleep(Duration::from_millis(100));
        chrome_launch_error(message, &said.lock().unwrap_or_else(|e| e.into_inner()))
    };
    while std::time::Instant::now() <= deadline {
        if let Some(address) = answered() {
            said.lock().unwrap_or_else(|e| e.into_inner()).clear();
            return Ok(address);
        }
        if let Some(exited) = exited_early(child) {
            return Err(last_words(&exited));
        }
        if closed() {
            // A browser closes its pipe on its way out, and the pipe's end can come before the exit can be read: wait
            // a moment for the exit, so the error names it and what Chrome said.
            let until = std::time::Instant::now() + Duration::from_millis(1000);
            while std::time::Instant::now() < until {
                if let Some(exited) = exited_early(child) {
                    return Err(last_words(&exited));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            return Err(last_words("Chrome closed its debugger's pipe before answering"));
        }
    }
    Err(PIPE_TIMEOUT.to_string())
}

/// "Chrome exited early (exit code: n) ..." once the launched browser has exited, else None.
fn exited_early(child: &mut Child) -> Option<String> {
    let status = child.try_wait().ok()??;
    let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string());
    Some(format!("Chrome exited early (exit code: {code}) before its debugger answered"))
}

/// Write `DevToolsActivePort` in Chrome's own shape (port, then path), so the browser can be found again while its
/// launcher serves it. The path carries the debugger's secret, so the file is the owner's alone.
fn remember_devtools(user_data_dir: &Path, ws_url: &str) {
    let Some(rest) = ws_url.strip_prefix("ws://") else { return };
    let Some((host, path)) = rest.split_once('/') else { return };
    let Some((_, port)) = host.rsplit_once(':') else { return };
    let file = user_data_dir.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&file);
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    if let Ok(mut f) = open.open(&file) {
        let _ = f.write_all(format!("{port}\n/{path}\n").as_bytes());
    }
}

/// Who Chrome's lock on a profile names, as the lock's link says it (`<host>-<pid>`): the process on this machine and
/// what it is now, or the other machine. `None` when the profile has no lock.
#[cfg(unix)]
fn lock_holder(user_data_dir: &Path) -> Option<String> {
    let link = std::fs::read_link(user_data_dir.join("SingletonLock")).ok()?;
    let link = link.to_string_lossy().into_owned();
    let (host, pid) = link.rsplit_once('-')?;
    let pid: u32 = pid.parse().ok()?;
    Some(holder_said(host, pid, &this_host(), process_name(pid)))
}

#[cfg(not(unix))]
fn lock_holder(_user_data_dir: &Path) -> Option<String> {
    None
}

/// This machine's name, as Chrome writes it into a profile's lock.
#[cfg(unix)]
fn this_host() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_string())
        .or_else(|_| {
            std::process::Command::new("uname").arg("-n").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_default()
}

/// The program process `pid` runs, while it runs. `None` once it has gone, or where the system won't say.
#[cfg(unix)]
fn process_name(pid: u32) -> Option<String> {
    // Linux says it in /proc; where there is none (macOS), `ps` does. No answer from either: the process has gone.
    let program = match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(cmdline) => String::from_utf8_lossy(cmdline.split(|b| *b == 0).next().filter(|p| !p.is_empty())?).into_owned(),
        Err(_) => {
            let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).stderr(Stdio::null()).output().ok()?;
            let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !out.status.success() || said.is_empty() {
                return None;
            }
            said
        }
    };
    Some(Path::new(&program).file_name().map_or(program.clone(), |n| n.to_string_lossy().into_owned()))
}

/// The holder of a lock made by process `pid` on `host`, said from this machine, `here`, where that process now runs
/// `name` (none once it has gone).
#[cfg_attr(not(unix), allow(dead_code))]
fn holder_said(host: &str, pid: u32, here: &str, name: Option<String>) -> String {
    if !here.is_empty() && host != here {
        return format!("locked by process {pid} on another machine, {host}; this one is {here}");
    }
    match name {
        Some(name) => format!("locked by process {pid}, {name}"),
        None => format!("locked by process {pid}, which has stopped"),
    }
}

/// A launch Chrome refused because its profile is locked, said as which folder and which process: Chrome's own words
/// name a lock file deep in its log, or a process number with no word of what it is. Another error goes as it came.
fn said_of_lock(user_data_dir: &Path, error: String) -> String {
    let lower = error.to_lowercase();
    if !(lower.contains("singletonlock") || lower.contains("processsingleton") || lower.contains("profile appears to be in use")) {
        return error;
    }
    let holder = lock_holder(user_data_dir);
    let next = match holder.as_deref() {
        Some(h) if h.contains("another machine") => format!(
            "if no browser runs there on this profile, remove {} and try again",
            user_data_dir.join("SingletonLock").display()
        ),
        Some(h) if h.ends_with("has stopped") => "the lock is what a browser that stopped left: try again".to_string(),
        Some(_) => "another browser started on this profile, at the same moment or before: close it, or wait for it to finish, and try again".to_string(),
        None => "the lock is gone now: try again".to_string(),
    };
    format!(
        "the browser profile at {} is {}: {next}\n{error}",
        user_data_dir.display(),
        holder.unwrap_or_else(|| "locked by another browser".to_string()),
    )
}

/// How a launch that was asked for a window, on a machine with no display to open it on, starts what it says: one
/// plain line ahead of Chrome's own, which name a source file and `$DISPLAY` and nothing a caller can act on.
pub const NO_DISPLAY: &str = "a window was asked for and this machine has no display to open it on";

/// Chrome's last words when its window found no display.
const CHROME_FOUND_NO_DISPLAY: &str = "Missing X server or $DISPLAY";

/// What this process's environment names for a display, for [`NO_DISPLAY`]: the launch already tried to stand a
/// private Xvfb in for one that is missing (`maybe_start_xvfb`), so reaching here means none started either.
fn display_named() -> String {
    match std::env::var("DISPLAY").ok().filter(|d| !d.is_empty()) {
        Some(display) => format!("Chrome could open none at DISPLAY={display}"),
        None => "DISPLAY is not set, and no Xvfb was started to stand in for one".to_string(),
    }
}

fn chrome_launch_error(message: &str, stderr_lines: &[String]) -> String {
    if let Some(said) = stderr_lines.iter().find(|l| l.contains(CHROME_FOUND_NO_DISPLAY)) {
        return format!(
            "{NO_DISPLAY}: {}. Start a display, install Xvfb (a headed launch starts its own), or ask for no window.\n{message}\nChrome stderr:\n  {said}",
            display_named()
        );
    }
    let relevant: Vec<&String> = stderr_lines
        .iter()
        .filter(|l| {
            let lower = l.to_lowercase();
            lower.contains("error")
                || lower.contains("fatal")
                || lower.contains("sandbox")
                || lower.contains("namespace")
                || lower.contains("permission")
                || lower.contains("cannot")
                || lower.contains("failed")
                || lower.contains("abort")
        })
        .collect();

    if relevant.is_empty() {
        if stderr_lines.is_empty() {
            return format!(
                "{} (no stderr output from Chrome)\nHint: try passing --args \"--no-sandbox\" if Chrome crashes silently in your environment",
                message
            );
        }
        let last_lines: Vec<&String> = stderr_lines.iter().rev().take(5).collect();
        return format!(
            "{}\nChrome stderr (last {} lines):\n  {}",
            message,
            last_lines.len(),
            last_lines
                .into_iter()
                .rev()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join("\n  ")
        );
    }

    let hint = if relevant.iter().any(|l| {
        let lower = l.to_lowercase();
        lower.contains("sandbox") || lower.contains("namespace")
    }) {
        "\nHint: try --args \"--no-sandbox\" (required in containers, VMs, and some Linux setups)"
    } else {
        ""
    };

    format!(
        "{}\nChrome stderr:\n  {}{}",
        message,
        relevant
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n  "),
        hint
    )
}

pub fn find_chrome() -> Option<PathBuf> {
    // 1. Check Chrome downloaded by `agent-browser install`
    if let Some(p) = crate::paths::find_installed_chrome() {
        return Some(p);
    }

    // If the cache directory exists but no Chrome was found, warn -- this
    // likely means the cache is corrupted or the directory layout is unexpected.
    if let Some(cache_dir) = crate::paths::browsers_dirs_here().into_iter().find(|d| d.exists()) {
        let _ = writeln!(
            std::io::stderr(),
            "Warning: Chrome cache directory exists ({}) but no Chrome binary found inside. \
             Falling back to system Chrome. Run `agent-browser install` to re-download.",
            cache_dir.display()
        );
    }

    // 2. Check system-installed Chrome
    #[cfg(target_os = "macos")]
    {
        let candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ];
        for c in &candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                return Some(p);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let candidates = [
            "google-chrome",
            "google-chrome-stable",
            "chromium-browser",
            "chromium",
            "brave-browser",
            "brave-browser-stable",
        ];
        for name in &candidates {
            if let Ok(output) = Command::new("which").arg(name).output() {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !path.is_empty() {
                        return Some(PathBuf::from(path));
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let candidates = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ];
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let chrome = PathBuf::from(&local).join(r"Google\Chrome\Application\chrome.exe");
            if chrome.exists() {
                return Some(chrome);
            }
            let brave =
                PathBuf::from(&local).join(r"BraveSoftware\Brave-Browser\Application\brave.exe");
            if brave.exists() {
                return Some(brave);
            }
        }
        for c in &candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                return Some(p);
            }
        }
    }

    // 3. Fallback: check Puppeteer / Playwright browser caches
    if let Some(p) = find_puppeteer_chrome() {
        return Some(p);
    }
    if let Some(p) = find_playwright_chromium() {
        return Some(p);
    }

    None
}

pub fn read_devtools_active_port(user_data_dir: &Path) -> Option<(u16, String)> {
    let path = user_data_dir.join("DevToolsActivePort");
    let content = std::fs::read_to_string(&path).ok()?;
    let mut lines = content.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let ws_path = lines
        .next()
        .unwrap_or("/devtools/browser")
        .trim()
        .to_string();
    Some((port, ws_path))
}

pub async fn auto_connect_cdp() -> Result<String, String> {
    let user_data_dirs = get_chrome_user_data_dirs();

    for dir in &user_data_dirs {
        if let Some((port, ws_path)) = read_devtools_active_port(dir) {
            match resolve_cdp_from_active_port(port, &ws_path).await {
                Ok(ws_url) => return Ok(ws_url),
                // Chrome is alive and still showing the permission prompt.
                // Probing further would open another prompt (#1365).
                Err(ActivePortError::AwaitingApproval) => {
                    return Err(format!(
                        "Chrome is waiting for remote-debugging approval on port {}. Approve the prompt in Chrome and retry.",
                        port
                    ));
                }
                Err(ActivePortError::Unreachable(_)) => {}
            }
            // Port is dead — remove the stale file so future runs skip it.
            let stale = dir.join("DevToolsActivePort");
            let _ = std::fs::remove_file(&stale);
        }
    }

    // Fallback: probe common ports
    for port in [9222u16, 9229] {
        if let Ok(ws_url) = discover_cdp_url("127.0.0.1", port, None).await {
            return Ok(ws_url);
        }
    }

    Err("No running Chrome instance found. Launch Chrome with --remote-debugging-port or use --cdp.".to_string())
}

/// Resolve a CDP WebSocket URL from a DevToolsActivePort entry.
///
/// Tries the exact WebSocket path from DevToolsActivePort first (single
/// prompt on M144+), then falls back to legacy HTTP discovery for older
/// Chrome versions. This order avoids triggering duplicate remote-debugging
/// permission prompts (#1210, #1206).
async fn resolve_cdp_from_active_port(port: u16, ws_path: &str) -> Result<String, ActivePortError> {
    resolve_cdp_from_active_port_within(port, ws_path, AUTO_CONNECT_WS_VERIFY_TIMEOUT).await
}

#[derive(Debug, PartialEq)]
enum ActivePortError {
    /// The handshake stayed open past the timeout: Chrome is holding it for
    /// the remote-debugging permission prompt.
    AwaitingApproval,
    Unreachable(String),
}

async fn resolve_cdp_from_active_port_within(
    port: u16,
    ws_path: &str,
    timeout: Duration,
) -> Result<String, ActivePortError> {
    let ws_url = format!("ws://127.0.0.1:{}{}", port, ws_path);
    match verify_ws_endpoint(&ws_url, timeout).await {
        WsVerify::Live => return Ok(ws_url),
        WsVerify::TimedOut => return Err(ActivePortError::AwaitingApproval),
        WsVerify::Failed => {}
    }

    // Pre-M144 fallback: HTTP endpoints (/json/version, /json/list, etc.)
    if let Ok(ws_url) = discover_cdp_url("127.0.0.1", port, None).await {
        return Ok(ws_url);
    }

    Err(ActivePortError::Unreachable(format!(
        "Cannot connect to Chrome on port {}: both direct WebSocket and HTTP discovery failed",
        port
    )))
}

/// How long `--auto-connect` keeps the direct WebSocket handshake open.
/// Chrome 144+ holds the handshake while it shows the remote-debugging
/// permission prompt, so this must leave time to approve it (#1365). It stays
/// below the client's 30s read timeout (`connection::read_timeout_for`) so the
/// daemon answers before the client gives up and retries.
const AUTO_CONNECT_WS_VERIFY_TIMEOUT: Duration = Duration::from_secs(20);

enum WsVerify {
    Live,
    TimedOut,
    Failed,
}

/// Verify that a WebSocket endpoint is a live CDP server by sending
/// `Browser.getVersion` and checking for a valid response.
async fn verify_ws_endpoint(ws_url: &str, timeout: Duration) -> WsVerify {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let result = tokio::time::timeout(timeout, async {
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await.ok()?;
        let cmd = r#"{"id":1,"method":"Browser.getVersion"}"#;
        ws.send(Message::Text(cmd.into())).await.ok()?;
        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Text(text) = msg {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if v.get("id").and_then(|id| id.as_u64()) == Some(1) {
                        let _ = ws.close(None).await;
                        return Some(());
                    }
                }
            }
        }
        None
    })
    .await;
    match result {
        Ok(Some(())) => WsVerify::Live,
        Ok(None) => WsVerify::Failed,
        Err(_) => WsVerify::TimedOut,
    }
}

/// Returns the default Chrome user-data directory paths for the current platform.
/// Includes Chrome, Chrome Canary, Chromium, and Brave.
pub fn get_chrome_user_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let base = home.join("Library/Application Support");
            for name in [
                "Google/Chrome",
                "Google/Chrome Canary",
                "Chromium",
                "BraveSoftware/Brave-Browser",
            ] {
                dirs.push(base.join(name));
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            let config = home.join(".config");
            for name in [
                "google-chrome",
                "google-chrome-unstable",
                "chromium",
                "BraveSoftware/Brave-Browser",
            ] {
                dirs.push(config.join(name));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            for name in [
                r"Google\Chrome\User Data",
                r"Google\Chrome SxS\User Data",
                r"Chromium\User Data",
                r"BraveSoftware\Brave-Browser\User Data",
            ] {
                dirs.push(base.join(name));
            }
        }
    }

    dirs
}

/// Returns true if the given string looks like a Chrome profile name rather than
/// a file path. A profile name contains no `/`, `\`, or `~` characters.
pub fn is_chrome_profile_name(s: &str) -> bool {
    !s.contains('/') && !s.contains('\\') && !s.contains('~')
}

/// Returns the first existing Chrome user-data directory that contains a
/// `Local State` file.
pub fn find_chrome_user_data_dir() -> Option<PathBuf> {
    get_chrome_user_data_dirs()
        .into_iter()
        .find(|dir| dir.join("Local State").is_file())
}

/// A Chrome profile entry parsed from `Local State`.
#[derive(Debug, Clone)]
pub struct ChromeProfile {
    /// The directory name (e.g., "Default", "Profile 1").
    pub directory: String,
    /// The user-visible display name (e.g., "Person 1").
    pub name: String,
}

/// Lists all Chrome profiles found in the given user-data directory by reading
/// the `Local State` JSON file. Returns an empty vec if the file is missing,
/// malformed, or lacks the expected `profile.info_cache` key.
pub fn list_chrome_profiles(user_data_dir: &Path) -> Vec<ChromeProfile> {
    let local_state_path = user_data_dir.join("Local State");
    let content = match std::fs::read_to_string(&local_state_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let info_cache = match json.get("profile").and_then(|p| p.get("info_cache")) {
        Some(obj) if obj.is_object() => obj.as_object().unwrap(),
        _ => return Vec::new(),
    };

    let mut profiles: Vec<ChromeProfile> = info_cache
        .iter()
        .map(|(dir_name, info)| {
            let display_name = info
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(dir_name)
                .to_string();
            ChromeProfile {
                directory: dir_name.clone(),
                name: display_name,
            }
        })
        .collect();
    profiles.sort_by(|a, b| a.directory.cmp(&b.directory));
    profiles
}

/// Resolves a profile input string to a Chrome profile directory name using
/// three-tier matching:
/// 1. Exact directory name match
/// 2. Case-insensitive display name match (error if ambiguous)
/// 3. Case-insensitive directory name match
///
/// Returns the resolved directory name, or an error with available profiles.
pub fn resolve_chrome_profile(user_data_dir: &Path, input: &str) -> Result<String, String> {
    let profiles = list_chrome_profiles(user_data_dir);

    if profiles.is_empty() {
        return Err(format!(
            "No Chrome profiles found in {}.\n\
             If you meant a directory path, use a full path (e.g., /path/to/profile).",
            user_data_dir.display()
        ));
    }

    // Tier 1: exact directory name match
    if let Some(p) = profiles.iter().find(|p| p.directory == input) {
        return Ok(p.directory.clone());
    }

    // Tier 2: case-insensitive display name match
    let input_lower = input.to_lowercase();
    let display_matches: Vec<&ChromeProfile> = profiles
        .iter()
        .filter(|p| p.name.to_lowercase() == input_lower)
        .collect();
    match display_matches.len() {
        1 => return Ok(display_matches[0].directory.clone()),
        n if n > 1 => {
            return Err(format!(
                "Ambiguous profile name \"{}\". Multiple profiles match:\n{}\n\
                 Use the directory name instead.",
                input,
                format_profile_list(&display_matches)
            ));
        }
        _ => {}
    }

    // Tier 3: case-insensitive directory name match
    if let Some(p) = profiles
        .iter()
        .find(|p| p.directory.to_lowercase() == input_lower)
    {
        return Ok(p.directory.clone());
    }

    let all_profiles: Vec<&ChromeProfile> = profiles.iter().collect();
    Err(format!(
        "Chrome profile \"{}\" not found. Available profiles:\n{}\n\
         If you meant a directory path, use a full path (e.g., /path/to/profile).",
        input,
        format_profile_list(&all_profiles)
    ))
}

fn format_profile_list(profiles: &[&ChromeProfile]) -> String {
    profiles
        .iter()
        .map(|p| format!("  {} ({})", p.directory, p.name))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Directories to exclude when copying a Chrome profile. These are large
/// non-auth directories that are not needed for reusing login state.
const PROFILE_COPY_EXCLUDE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "Service Worker",
    "blob_storage",
    "File System",
    "GCM Store",
    "optimization_guide",
    "ShaderCache",
    "component_crx_cache",
];

/// How a copy of the owner's Chrome profile is named, before the pid of the process that made it. The copy holds their
/// sign-ins, and only `Drop` removes it, so a process that crashes leaves it behind; the pid says when nobody is left to.
const COPY_PREFIX: &str = "agent-browser-profile-p";

/// Removes copies whose maker is gone and that no browser still has open: a browser can outlive the daemon that started
/// it. Older copies carry no pid, and are left.
fn sweep_left_copies(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let maker = name
            .to_str()
            .and_then(|n| n.strip_prefix(COPY_PREFIX))
            .and_then(|rest| rest.split('-').next())
            .and_then(|pid| pid.parse::<u32>().ok());
        if maker.is_some_and(|pid| !crate::process::alive(pid)) && !profile_held(&entry.path()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Copies a Chrome profile subdirectory and `Local State` to a temp directory
/// with a two-level structure suitable for `--user-data-dir`. Returns the temp
/// directory path on success.
///
/// The copy is best-effort: individual file failures (e.g., `SingletonLock`)
/// are skipped with a warning. If the source profile directory is missing or
/// the temp dir cannot be created, returns an error after cleaning up.
/// A copied `Preferences` with `profile.exit_type` of `Crashed` is set to `Normal`, best effort (upstream #2189): the
/// owner's Chrome is usually still running, so its profile reads as crashed, and every launch of the copy offered
/// "Restore pages?".
pub fn copy_chrome_profile(
    user_data_dir: &Path,
    profile_directory: &str,
) -> Result<PathBuf, String> {
    sweep_left_copies(&std::env::temp_dir());
    let temp_dir = std::env::temp_dir().join(format!(
        "{COPY_PREFIX}{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp profile dir: {}", e))?;

    // Copy Local State (non-fatal if missing or unreadable)
    let local_state_src = user_data_dir.join("Local State");
    if let Err(e) = std::fs::copy(&local_state_src, temp_dir.join("Local State")) {
        let _ = writeln!(
            std::io::stderr(),
            "Warning: could not copy Local State from {}: {}",
            local_state_src.display(),
            e
        );
    }

    // Copy profile subdirectory
    let src_profile = user_data_dir.join(profile_directory);
    if !src_profile.is_dir() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "Profile directory not found: {}",
            src_profile.display()
        ));
    }
    let dst_profile = temp_dir.join(profile_directory);
    if let Err(e) = copy_dir_recursive(&src_profile, &dst_profile) {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!("Failed to copy profile: {}", e));
    }
    mark_cleanly_closed(&dst_profile);

    Ok(temp_dir)
}

/// Sets a copied profile's `profile.exit_type` from `Crashed` to `Normal`, so Chrome opens the copy without offering to
/// restore the source's last session. A missing, unreadable or malformed `Preferences` is left as copied, and so is one
/// that says anything else.
fn mark_cleanly_closed(profile: &Path) {
    let preferences_path = profile.join("Preferences");
    let normalized = (|| {
        let bytes = std::fs::read(&preferences_path).ok()?;
        let mut preferences: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let exit_type = preferences.pointer_mut("/profile/exit_type")?;
        if exit_type.as_str() != Some("Crashed") {
            return None;
        }
        *exit_type = serde_json::Value::String("Normal".to_string());
        serde_json::to_vec(&preferences).ok()
    })();
    if let Some(bytes) = normalized {
        let candidate = profile.join(format!(".Preferences-{}.tmp", uuid::Uuid::new_v4()));
        if std::fs::write(&candidate, bytes).is_ok() {
            let _ = std::fs::rename(&candidate, &preferences_path);
        }
        let _ = std::fs::remove_file(&candidate);
    }
}

/// Recursively copies a directory, skipping entries in [`PROFILE_COPY_EXCLUDE_DIRS`].
/// Individual file copy failures are logged to stderr but do not fail the operation.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create directory {}: {}", dst.display(), e))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory {}: {}", src.display(), e))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                let _ = writeln!(
                    std::io::stderr(),
                    "Warning: failed to read entry in {}: {}",
                    src.display(),
                    e
                );
                continue;
            }
        };

        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let src_path = entry.path();
        let dst_path = dst.join(&name);

        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(e) => {
                let _ = writeln!(
                    std::io::stderr(),
                    "Warning: failed to get file type for {}: {}",
                    src_path.display(),
                    e
                );
                continue;
            }
        };

        if file_type.is_dir() {
            if PROFILE_COPY_EXCLUDE_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if let Err(e) = std::fs::copy(&src_path, &dst_path) {
            let _ = writeln!(
                std::io::stderr(),
                "Warning: failed to copy {}: {}",
                src_path.display(),
                e
            );
        }
    }

    Ok(())
}

/// Whether the kernel refuses this user the namespaces Chrome's sandbox is built on: unprivileged user namespaces
/// turned off (`kernel.unprivileged_userns_clone = 0`, `user.max_user_namespaces = 0`). AppArmor's restriction isn't
/// read: Ubuntu desktops set it and still run Chrome's sandbox under Chrome's own profile.
#[cfg(target_os = "linux")]
fn user_namespaces_blocked() -> bool {
    let read = |p: &str| std::fs::read_to_string(p).ok().map(|s| s.trim().to_string());
    read("/proc/sys/kernel/unprivileged_userns_clone").as_deref() == Some("0") || read("/proc/sys/user/max_user_namespaces").as_deref() == Some("0")
}

/// Returns true if Chrome's sandbox should be disabled because the environment
/// doesn't support it (containers, VMs, CI runners, running as root).
fn should_disable_sandbox(existing_args: &[String]) -> bool {
    if existing_args.iter().any(|a| a == "--no-sandbox") {
        return false; // already set by user
    }

    // A kernel that refuses user namespaces can't run the sandbox at all. A CI
    // runner whose AppArmor holds them back (GitHub Actions on Ubuntu 24.04)
    // says so with `AGENT_BROWSER_NO_SANDBOX=1`, never by a `CI` variable: any
    // program sets that one, and the sandbox is what keeps a page's code off
    // the machine.
    #[cfg(target_os = "linux")]
    if user_namespaces_blocked() {
        return true;
    }
    if std::env::var("AGENT_BROWSER_NO_SANDBOX").is_ok_and(|v| v == "1") {
        return true;
    }

    #[cfg(unix)]
    {
        // Root user -- standard container default, Chrome sandbox requires non-root
        if unsafe { libc::geteuid() } == 0 {
            return true;
        }

        // Docker container
        if Path::new("/.dockerenv").exists() {
            return true;
        }

        // Podman container
        if Path::new("/run/.containerenv").exists() {
            return true;
        }

        // Generic container detection: cgroup contains docker/kubepods/lxc
        if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
            if cgroup.contains("docker") || cgroup.contains("kubepods") || cgroup.contains("lxc") {
                return true;
            }
        }
    }

    false
}

#[cfg(any(target_os = "linux", test))]
const MIN_DEV_SHM_AVAILABLE_BYTES: u64 = 256 * 1024 * 1024;

#[cfg(target_os = "linux")]
fn available_filesystem_bytes(path: &Path) -> Option<u64> {
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();

    // SAFETY: `path` is a valid, NUL-terminated C string and `stats` points to
    // writable storage for a `statvfs` value. A successful call initializes it.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }

    let stats = unsafe { stats.assume_init() };
    let available_bytes = u128::from(stats.f_bavail).saturating_mul(u128::from(stats.f_frsize));
    Some(u64::try_from(available_bytes).unwrap_or(u64::MAX))
}

#[cfg(any(target_os = "linux", test))]
fn dev_shm_is_too_small(available_bytes: u64) -> bool {
    available_bytes < MIN_DEV_SHM_AVAILABLE_BYTES
}

/// Returns true if Chrome should use disk instead of `/dev/shm` for shared memory.
/// Prefer the actual filesystem capacity over environment markers because some
/// container runtimes expose no conventional marker and others provision a large mount.
fn should_disable_dev_shm(existing_args: &[String]) -> bool {
    if existing_args.iter().any(|a| a == "--disable-dev-shm-usage") {
        return false;
    }

    #[cfg(target_os = "linux")]
    if let Some(available_bytes) = available_filesystem_bytes(Path::new("/dev/shm")) {
        return dev_shm_is_too_small(available_bytes);
    }

    // Preserve the existing safe fallback when `/dev/shm` cannot be inspected.
    if std::env::var("CI").is_ok() {
        return true;
    }

    #[cfg(unix)]
    {
        if unsafe { libc::geteuid() } == 0 {
            return true;
        }
        if Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists() {
            return true;
        }
        if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
            if cgroup.contains("docker") || cgroup.contains("kubepods") || cgroup.contains("lxc") {
                return true;
            }
        }
    }

    false
}

/// Search Puppeteer's browser cache for a Chrome binary.
/// Puppeteer v19+ stores Chrome in ~/.cache/puppeteer/chrome/<platform>-<version>/
fn find_puppeteer_chrome() -> Option<PathBuf> {
    let mut search_dirs = Vec::new();

    if let Ok(custom) = std::env::var("PUPPETEER_CACHE_DIR") {
        search_dirs.push(PathBuf::from(custom).join("chrome"));
    }

    if let Some(home) = dirs::home_dir() {
        search_dirs.push(home.join(".cache/puppeteer/chrome"));
    }

    for dir in &search_dirs {
        if !dir.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut matches: Vec<(String, PathBuf)> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| {
                    let candidate = build_puppeteer_binary_path(&e.path());
                    if candidate.exists() {
                        Some((e.file_name().to_string_lossy().to_string(), candidate))
                    } else {
                        None
                    }
                })
                .collect();
            // Newest version first, by number, not by the name's text.
            matches.sort_by(|a, b| crate::paths::version_order(&b.0, &a.0));
            if let Some((_, p)) = matches.into_iter().next() {
                return Some(p);
            }
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn build_puppeteer_binary_path(version_dir: &Path) -> PathBuf {
    version_dir.join("chrome-linux64/chrome")
}

#[cfg(target_os = "macos")]
fn build_puppeteer_binary_path(version_dir: &Path) -> PathBuf {
    // Puppeteer uses chrome-mac-arm64 or chrome-mac-x64 depending on arch
    let arm = version_dir.join(
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if arm.exists() {
        return arm;
    }
    version_dir.join(
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    )
}

#[cfg(target_os = "windows")]
fn build_puppeteer_binary_path(version_dir: &Path) -> PathBuf {
    version_dir.join(r"chrome-win64\chrome.exe")
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn build_puppeteer_binary_path(version_dir: &Path) -> PathBuf {
    version_dir.join("chrome")
}

/// Search Playwright's browser cache for a Chromium binary.
/// Legacy fallback for users who previously installed Chromium via Playwright.
fn find_playwright_chromium() -> Option<PathBuf> {
    let mut search_dirs = Vec::new();

    if let Ok(custom) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
        search_dirs.push(PathBuf::from(custom));
    }

    if let Some(home) = dirs::home_dir() {
        search_dirs.push(home.join(".cache/ms-playwright"));
    }

    for dir in &search_dirs {
        if !dir.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut matches: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_str()
                        .map(|n| n.starts_with("chromium-"))
                        .unwrap_or(false)
                })
                .filter_map(|e| {
                    let candidate = build_playwright_binary_path(&e.path());
                    if candidate.exists() {
                        Some(candidate)
                    } else {
                        None
                    }
                })
                .collect();
            // Sort descending so the newest version wins
            matches.sort();
            matches.reverse();
            if let Some(p) = matches.into_iter().next() {
                return Some(p);
            }
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn build_playwright_binary_path(chromium_dir: &Path) -> PathBuf {
    // Playwright's Linux layout is chrome-linux/chrome; chrome-linux64 is
    // the Chrome-for-Testing naming kept as a fallback.
    let standard = chromium_dir.join("chrome-linux/chrome");
    if standard.exists() {
        return standard;
    }
    chromium_dir.join("chrome-linux64/chrome")
}

#[cfg(target_os = "macos")]
fn build_playwright_binary_path(chromium_dir: &Path) -> PathBuf {
    chromium_dir.join("chrome-mac/Chromium.app/Contents/MacOS/Chromium")
}

#[cfg(target_os = "windows")]
fn build_playwright_binary_path(chromium_dir: &Path) -> PathBuf {
    chromium_dir.join("chrome-win/chrome.exe")
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix('~') {
        if let Some(home) = dirs::home_dir() {
            return home
                .join(rest.strip_prefix('/').unwrap_or(rest))
                .to_string_lossy()
                .to_string();
        }
    }
    path.to_string()
}

/// A fake Chrome that answers its pipe's first command, as Chrome does, then waits.
#[cfg(all(test, unix))]
fn fake_chrome(dir: &Path, then: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let executable = dir.join("chrome");
    std::fs::write(
        &executable,
        format!(
            r#"#!/bin/sh
set -eu
for arg do
case "$arg" in
    --user-data-dir=*) profile="${{arg#*=}}" ;;
esac
done
printf '%s\n' "$@" > "$profile/args"
printf '{{"id":1,"result":{{"product":"Fake"}}}}\000' >&4
{then}
"#
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    executable
}


#[cfg(test)]
mod reattach_tests {
    use super::*;

    /// A loopback WebSocket server that answers every command with `reply(id)`.
    async fn fake_endpoint(reply: fn(u64) -> serde_json::Value) -> u16 {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(sock).await else { return };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        let id = serde_json::from_str::<serde_json::Value>(&text)
                            .ok()
                            .and_then(|v| v.get("id").and_then(|i| i.as_u64()))
                            .unwrap_or(0);
                        let _ = ws.send(Message::Text(reply(id).to_string().into())).await;
                    }
                });
            }
        });
        port
    }

    fn runtime_dir(port: u16, pid: Option<u32>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("DevToolsActivePort"),
            format!("{port}\n/devtools/browser/x\n"),
        )
        .unwrap();
        if let Some(pid) = pid {
            write_runtime_pid(dir.path(), pid);
        }
        dir
    }

    /// A browser this process reattached to is not its child: its group is ended only while the number is still that
    /// browser's, started when it was proved. A number the system has since given to a group leader of its own (a
    /// shell, another program) is never signalled.
    #[cfg(unix)]
    #[test]
    fn a_reattached_browsers_group_is_never_signalled_once_its_number_is_someone_elses() {
        use std::os::unix::process::CommandExt;
        let dir = tempfile::tempdir().unwrap();
        let mut leader = std::process::Command::new("sleep").arg("30").process_group(0).spawn().unwrap();
        let pid = leader.id();
        let now = crate::process::started(pid);
        for stale in [None, now.map(|t| t + 1)] {
            let gone = ReattachedChrome { pid, started: stale, hold: BrowserHold::take(dir.path()), headless: None };
            assert!(gone.has_exited(), "a number that is someone else's is a browser that has gone");
            gone.wait_or_kill(Duration::from_millis(50));
            assert!(leader.try_wait().unwrap().is_none(), "the group now holding the number was signalled");
        }
        let browser = ReattachedChrome { pid, started: now, hold: BrowserHold::take(dir.path()), headless: None };
        browser.wait_or_kill(Duration::from_millis(50));
        let ended = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            leader.try_wait().unwrap().is_some()
        });
        assert!(ended, "the browser this proved is ended with its group");
    }

    /// A profile's DevTools address is used only for the browser the profile recorded at its launch, alive as that same
    /// process (same number, same start), holding the profile's lock, and owning the port as the system says. A profile
    /// with no record, a record of another start, a lock naming another process, an endpoint that only claims to be the
    /// browser, and a browser that has gone are all refused.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_profiles_devtools_address_is_used_only_for_the_browser_it_recorded() {
        static ANSWERS_AS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        // The endpoint is this test process's own socket.
        let port = fake_endpoint(|id| {
            let pid = ANSWERS_AS.load(std::sync::atomic::Ordering::Relaxed);
            serde_json::json!({ "id": id, "result": { "processInfo": [{ "type": "browser", "id": pid }] } })
        })
        .await;
        let timeout = Duration::from_secs(2);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("DevToolsActivePort"), format!("{port}\n/devtools/browser/x\n")).unwrap();
        let lock = |pid: u32| {
            let _ = std::fs::remove_file(dir.path().join("SingletonLock"));
            std::os::unix::fs::symlink(format!("host-{pid}"), dir.path().join("SingletonLock")).unwrap();
        };
        let me = std::process::id();
        let answers = |pid: u32| ANSWERS_AS.store(pid, std::sync::atomic::Ordering::Relaxed);
        lock(me);
        answers(me);
        assert_eq!(proven_profile_endpoint(dir.path(), timeout).await, None, "a profile with no record of its browser is never reused");
        record_browser(dir.path(), me);
        assert_eq!(proven_profile_endpoint(dir.path(), timeout).await, Some(format!("ws://127.0.0.1:{port}/devtools/browser/x")), "the recorded browser, alive and on its port");
        let started = crate::process::started(me).unwrap();
        std::fs::write(dir.path().join(BROWSER_IDENTITY_FILE), format!("{me} {}\n", started + 1)).unwrap();
        assert_eq!(proven_profile_endpoint(dir.path(), timeout).await, None, "the number with another start is another process");
        // A live process that has nothing to do with the port, recorded and holding the lock, which the endpoint claims.
        let mut unrelated = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        record_browser(dir.path(), unrelated.id());
        lock(unrelated.id());
        answers(unrelated.id());
        assert_eq!(proven_profile_endpoint(dir.path(), timeout).await, None, "an endpoint that only says it is the browser is refused");
        // The record and the lock disagree.
        record_browser(dir.path(), me);
        answers(me);
        assert_eq!(proven_profile_endpoint(dir.path(), timeout).await, None, "the lock names another process than the record");
        let gone = unrelated.id();
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        record_browser(dir.path(), gone);
        lock(gone);
        answers(gone);
        assert_eq!(proven_profile_endpoint(dir.path(), timeout).await, None, "a browser that has gone");
    }

    #[tokio::test]
    async fn a_stale_devtools_port_is_never_reattached_to_whatever_answers() {
        // Answers every command, as any CDP-shaped server can.
        let port = fake_endpoint(|id| serde_json::json!({ "id": id, "result": {} })).await;
        let ours = std::process::id();
        let timeout = Duration::from_secs(2);
        assert_eq!(reattach_runtime_dir(runtime_dir(port, Some(ours)).path(), timeout).await, None);
        // No record of the Chrome launched here: nothing to reattach to.
        assert_eq!(reattach_runtime_dir(runtime_dir(port, None).path(), timeout).await, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reattach_needs_the_recorded_chrome_alive_and_answering_as_itself() {
        let timeout = Duration::from_secs(2);
        let port = fake_endpoint(|id| {
            serde_json::json!({ "id": id, "result": { "processInfo": [
                { "type": "browser", "id": std::process::id() }
            ] } })
        })
        .await;
        let ours = std::process::id();
        let dir = runtime_dir(port, Some(ours));
        assert_eq!(
            reattach_runtime_dir(dir.path(), timeout).await,
            Some((format!("ws://127.0.0.1:{port}/devtools/browser/x"), ours))
        );
        // A recorded process that is gone is never reattached, whoever answers.
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let gone_pid = gone.id();
        gone.wait().unwrap();
        assert_eq!(reattach_runtime_dir(runtime_dir(port, Some(gone_pid)).path(), timeout).await, None);
    }

    /// The launched browser opens no debugging port: its debugger is on a pipe, served only at an address that
    /// carries a secret, and that address is written down for the owner alone.
    #[cfg(unix)]
    #[test]
    fn the_browsers_debugger_answers_no_other_process() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let executable = super::fake_chrome(fixture.path(), "exec sleep 60");
        let profile = tempfile::tempdir().unwrap();
        let options = LaunchOptions {
            profile: Some(profile.path().to_string_lossy().into_owned()),
            args: vec!["--remote-debugging-port=9222".into(), "--disable-blink-features=Foo".into()],
            ..Default::default()
        };
        let chrome = try_launch_chrome(&executable, &options).unwrap();
        let args = std::fs::read_to_string(profile.path().join("args")).unwrap();
        assert!(args.lines().any(|a| a == "--remote-debugging-pipe"), "{args}");
        assert!(!args.contains("--remote-debugging-port"), "no port, even one asked for: {args}");
        assert!(args.lines().any(|a| a == "--disable-blink-features=AutomationControlled,Foo"), "{args}");
        let path = chrome.ws_url.split_once("/devtools/browser/").map(|(_, s)| s.to_string()).unwrap();
        assert!(path.len() >= 64, "the address carries a secret: {}", chrome.ws_url);
        let file = profile.path().join("DevToolsActivePort");
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let (port, ws_path) = read_devtools_active_port(profile.path()).unwrap();
        assert_eq!(chrome.ws_url, format!("ws://127.0.0.1:{port}{ws_path}"));
    }

    /// The launcher holds the browser's pipe, so its leaving would close the browser under another process using it:
    /// it stays the owner, serving, until the last of the others has gone, and only then is the browser closed.
    #[cfg(unix)]
    #[test]
    fn a_launcher_leaving_keeps_the_browser_for_the_others_until_the_last_has_gone() {
        let fixture = tempfile::tempdir().unwrap();
        let executable = super::fake_chrome(fixture.path(), "exec sleep 60");
        let profile = tempfile::tempdir().unwrap();
        let options = LaunchOptions { profile: Some(profile.path().to_string_lossy().into_owned()), ..Default::default() };
        let mut chrome = try_launch_chrome(&executable, &options).unwrap();
        let pid = chrome.id();
        chrome.share(BrowserHold::take(profile.path()));
        let other = BrowserHold::take(profile.path());
        let ws_url = chrome.ws_url.clone();

        assert!(chrome.others_remain());
        chrome.serve_while_others_remain_polling(Duration::from_millis(20));
        std::thread::sleep(Duration::from_millis(300));
        assert!(crate::process::alive(pid), "the browser went from under the other process");
        let port = ws_url.split(':').nth(2).unwrap().split('/').next().unwrap();
        assert!(std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok(), "its debugger is still served");

        drop(other);
        serve_kept_browsers();
        assert!(!crate::process::alive(pid), "the last one out closed it");
    }

    /// A browser that exits before answering on its pipe is a failed launch, with what it said.
    #[cfg(unix)]
    #[test]
    fn a_browser_that_never_answers_its_pipe_is_a_failed_launch() {
        let fixture = tempfile::tempdir().unwrap();
        let executable = fixture.path().join("chrome");
        std::fs::write(&executable, "#!/bin/sh\necho 'FATAL: cannot start' >&2\nexit 3\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let profile = tempfile::tempdir().unwrap();
        let options = LaunchOptions { profile: Some(profile.path().to_string_lossy().into_owned()), ..Default::default() };
        let err = try_launch_chrome(&executable, &options).err().unwrap();
        assert!(err.contains("exit code: 3") && err.contains("FATAL: cannot start"), "{err}");
    }

    /// A browser that closes its debugger's pipe on its way out is a failed launch that names its exit and what it said,
    /// not a pipe that closed: the pipe's end can reach the launcher before the exit does (UNB-208, seen under a loaded
    /// test pass).
    #[cfg(unix)]
    #[test]
    fn a_browser_that_closes_its_pipe_and_exits_is_reported_by_its_exit() {
        let fixture = tempfile::tempdir().unwrap();
        let executable = fixture.path().join("chrome");
        std::fs::write(&executable, "#!/bin/sh\nexec 3<&- 4>&-\nsleep 0.2\necho 'FATAL: cannot start' >&2\nexit 3\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let profile = tempfile::tempdir().unwrap();
        let options = LaunchOptions { profile: Some(profile.path().to_string_lossy().into_owned()), ..Default::default() };
        let err = try_launch_chrome(&executable, &options).err().unwrap();
        assert!(err.contains("exit code: 3") && err.contains("FATAL: cannot start"), "{err}");
    }

    /// The CLI's way to the debugger, which drove Chrome 157 on Windows in about a second (22 Nov 2026): Chrome picks a
    /// port and names it, with the browser's path, in the profile's `DevToolsActivePort`.
    #[cfg(unix)]
    #[test]
    fn a_browser_on_a_port_is_reached_at_the_address_it_names() {
        let fixture = tempfile::tempdir().unwrap();
        let executable = fixture.path().join("chrome");
        std::fs::write(
            &executable,
            "#!/bin/sh\nfor arg do case \"$arg\" in --user-data-dir=*) profile=\"${arg#*=}\" ;; esac; done\nprintf '%s\\n' \"$@\" > \"$profile/args\"\nsleep 0.3\nprintf '41234\\n/devtools/browser/abc\\n' > \"$profile/DevToolsActivePort\"\nexec sleep 60\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let profile = tempfile::tempdir().unwrap();
        let options = LaunchOptions { profile: Some(profile.path().to_string_lossy().into_owned()), ..Default::default() };
        let mut chrome = try_launch_chrome_on(&executable, &options, Debugger::Port).unwrap();
        assert_eq!(chrome.ws_url, "ws://127.0.0.1:41234/devtools/browser/abc");
        let args = std::fs::read_to_string(profile.path().join("args")).unwrap();
        assert!(args.lines().any(|a| a == "--remote-debugging-port=0") && !args.contains("--remote-debugging-pipe"), "{args}");
        chrome.kill();
    }

    /// The port path against a real Chrome: what a Windows launch falls back to when the pipe stays silent.
    #[test]
    #[ignore = "requires installed Chrome"]
    fn a_real_chrome_on_a_port_is_reached_and_goes_with_its_launch() {
        let executable = find_chrome().expect("a Chrome on this machine");
        let profile = tempfile::tempdir().unwrap();
        let options = LaunchOptions { headless: true, profile: Some(profile.path().to_string_lossy().into_owned()), ..Default::default() };
        let started = std::time::Instant::now();
        let chrome = try_launch_chrome_on(&executable, &options, Debugger::Port).unwrap();
        assert!(started.elapsed() < Duration::from_secs(25), "{:?}", started.elapsed());
        assert!(chrome.ws_url.starts_with("ws://127.0.0.1:") && chrome.ws_url.contains("/devtools/browser/"), "{}", chrome.ws_url);
        let port: u16 = chrome.ws_url.split(':').nth(2).unwrap().split('/').next().unwrap().parse().unwrap();
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok(), "Chrome listens where it said");
        let pid = chrome.id();
        drop(chrome);
        std::thread::sleep(Duration::from_millis(500));
        assert!(!crate::process::alive(pid), "the browser outlived its launch");
    }

    /// Windows: a browser that stays silent on its pipe is tried once more on a port, and every launch after it goes
    /// there first. One that left early, or failed another way, is not: the port would fail it the same way.
    #[test]
    fn only_a_silent_pipe_on_windows_falls_back_to_the_port() {
        let silent = PIPE_TIMEOUT.to_string();
        assert_eq!(fallback_after(Debugger::Pipe, &silent, true), Some(Debugger::Port));
        assert_eq!(fallback_after(Debugger::Pipe, &silent, false), None, "elsewhere the pipe is the only way");
        assert_eq!(fallback_after(Debugger::Port, &silent, true), None, "the port is the last try");
        assert_eq!(fallback_after(Debugger::Pipe, "Chrome exited early (exit code: 21) before its debugger answered", true), None);
        assert!(pipe_wait(true) < pipe_wait(false), "a silent pipe on Windows is given up on sooner: {:?}", pipe_wait(true));
        let args = debugger_args(vec!["--remote-debugging-pipe".into(), "--no-first-run".into()], Debugger::Port);
        assert_eq!(args, ["--remote-debugging-port=0", "--no-first-run"]);
        let args = debugger_args(vec!["--remote-debugging-pipe".into()], Debugger::Pipe);
        assert_eq!(args, ["--remote-debugging-pipe"]);
    }

    /// A port file is read only once Chrome has written both its lines; a half-written one, or a port of 0, is not yet.
    #[test]
    fn the_port_file_names_the_address_once_it_is_whole() {
        assert_eq!(devtools_address("9222\n/devtools/browser/x-1\n").as_deref(), Some("ws://127.0.0.1:9222/devtools/browser/x-1"));
        assert_eq!(devtools_address("9222\r\n/devtools/browser/x-1\r\n").as_deref(), Some("ws://127.0.0.1:9222/devtools/browser/x-1"));
        assert_eq!(devtools_address("9222\n"), None);
        assert_eq!(devtools_address("0\n/devtools/browser/x\n"), None);
        assert_eq!(devtools_address(""), None);
    }

    /// A profile given by name runs in a temp copy that goes with its browser: there is nothing to find again.
    #[test]
    fn a_profile_is_found_again_by_path_never_by_name() {
        let by_path = LaunchOptions { profile: Some("/p/shop.example".into()), ..Default::default() };
        assert_eq!(reattachable_dir(&by_path), Some(PathBuf::from("/p/shop.example")));
        let by_name = LaunchOptions { profile: Some("Default".into()), ..Default::default() };
        assert_eq!(reattachable_dir(&by_name), None, "a named profile runs in a temp copy");
    }

    /// The last process out is the one to close: however they leave, one of them hears it, and a place given up by a
    /// process that died counts for nothing.
    #[test]
    fn the_last_user_of_a_browser_is_the_only_one_told_it_is_last() {
        // A lock is held by the open file, and a child another test forks in this process holds a copy of every open
        // file until it execs: for that moment a dropped place still counts. Asking again until then is what a process
        // that is alone would hear; a process that isn't alone never hears yes, however often it asks.
        let alone = |hold: &mut BrowserHold| (0..100).any(|_| hold.last_out() || { std::thread::sleep(Duration::from_millis(10)); false });
        let dir = tempfile::tempdir().unwrap();
        let (mut first, mut second) = (BrowserHold::take(dir.path()), BrowserHold::take(dir.path()));
        assert!(!first.last_out(), "another process is on the browser");
        assert!(alone(&mut second));
        drop((first, second));

        let (mut leaving, crashed) = (BrowserHold::take(dir.path()), BrowserHold::take(dir.path()));
        drop(crashed);
        assert!(alone(&mut leaving), "nobody else is left");
    }

    /// A dir that can't hold a lock says nothing about anyone else, and a process there acts as it would alone.
    #[test]
    fn a_dir_that_cannot_hold_a_lock_leaves_a_process_alone() {
        let dir = tempfile::tempdir().unwrap();
        assert!(BrowserHold::take(&dir.path().join("not-there")).last_out());
    }
}

#[cfg(test)]
mod tests {

    /// UNB-145: a launch refused for a locked profile says which folder, and which process holds it, from the lock's
    /// link: a process on this machine by its program, one that stopped, or another machine.
    #[cfg(unix)]
    #[test]
    fn a_locked_profile_names_its_folder_and_holder() {
        let dir = tempfile::tempdir().unwrap();
        let here = this_host();
        let chrome = "Chrome exited before providing DevTools URL\nChrome stderr:\n  [1:1:ERROR:chrome/browser/process_singleton_posix.cc:349] Failed to create /p/SingletonLock: File exists (17)";
        let lock = dir.path().join("SingletonLock");
        std::os::unix::fs::symlink(format!("{here}-{}", std::process::id()), &lock).unwrap();
        let said = said_of_lock(dir.path(), chrome.to_string());
        let me = process_name(std::process::id()).unwrap();
        assert!(said.starts_with(&format!("the browser profile at {} is locked by process {}, {me}:", dir.path().display(), std::process::id())), "{said}");
        assert!(said.contains("another browser started on this profile") && said.ends_with(chrome), "{said}");
        std::fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink(format!("{here}-999999999"), &lock).unwrap();
        assert!(said_of_lock(dir.path(), chrome.into()).contains("locked by process 999999999, which has stopped: the lock is what a browser that stopped left"));
        std::fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink("otherbox-4242", &lock).unwrap();
        let said = said_of_lock(dir.path(), "The profile appears to be in use by another Chromium process (4242) on another computer (otherbox).".into());
        assert!(said.contains("locked by process 4242 on another machine, otherbox") && said.contains(&format!("remove {}", lock.display())), "{said}");
        assert_eq!(said_of_lock(dir.path(), "Missing X server or $DISPLAY".into()), "Missing X server or $DISPLAY", "another failure goes as it came");
    }
    /// A new profile starts with the prompts off, an old one has them turned off with everything else it held left alone,
    /// and preferences that don't read are left to Chrome.
    #[test]
    fn a_profile_opens_with_chromes_password_prompts_off() {
        let dir = std::env::temp_dir().join(format!("prefs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let read = |d: &Path| serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(d.join("Default/Preferences")).unwrap()).unwrap();

        keep_password_prompts_off(&dir);
        let new = read(&dir);
        assert_eq!(new["credentials_enable_service"], false);
        assert_eq!(new["profile"]["password_manager_leak_detection"], false);

        std::fs::write(dir.join("Default/Preferences"), r#"{"profile":{"name":"Site","password_manager_leak_detection":true},"homepage":"x"}"#).unwrap();
        keep_password_prompts_off(&dir);
        let old = read(&dir);
        assert_eq!(old["profile"]["password_manager_leak_detection"], false);
        assert_eq!((&old["profile"]["name"], &old["homepage"]), (&serde_json::json!("Site"), &serde_json::json!("x")));

        std::fs::write(dir.join("Default/Preferences"), "{not json").unwrap();
        keep_password_prompts_off(&dir);
        assert_eq!(std::fs::read_to_string(dir.join("Default/Preferences")).unwrap(), "{not json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    /// A copy of the owner's profile holds their sign-ins, so one a crash left goes at the next copy. One whose maker
    /// lives stays, and so does one from before copies said who made them.
    #[cfg(unix)]
    #[test]
    fn a_copy_of_a_profile_outlives_its_maker_only_until_the_next_copy() {
        let dir = tempfile::tempdir().unwrap();
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let gone_pid = gone.id();
        gone.wait().unwrap();
        let left = dir.path().join(format!("{COPY_PREFIX}{gone_pid}-a"));
        let live = dir.path().join(format!("{COPY_PREFIX}{}-b", std::process::id()));
        let older = dir.path().join("agent-browser-profile-6f1c2a44-0000");
        let other = dir.path().join("something-else");
        for path in [&left, &live, &older, &other] {
            std::fs::create_dir_all(path).unwrap();
        }
        sweep_left_copies(dir.path());
        assert!(!left.exists());
        assert!(live.exists() && older.exists() && other.exists());
    }

    /// The marks a dead browser leaves in a profile say it was there, not that it is.
    #[cfg(unix)]
    #[test]
    fn a_profile_is_held_only_while_something_listens_on_its_socket() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let socket = elsewhere.path().join("s");
        assert!(!profile_held(dir.path()), "a new profile is nobody's");
        let listening = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        std::os::unix::fs::symlink(&socket, dir.path().join("SingletonSocket")).unwrap();
        assert!(profile_held(dir.path()));
        drop(listening);
        // Another test forking at this moment holds the listener until its child execs, so this is given a moment.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while profile_held(dir.path()) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!profile_held(dir.path()), "nobody listens: the link is what a crash left");
    }

    /// The first kill reaps the group's leader, and the number is free from then on.
    #[cfg(unix)]
    #[test]
    fn a_process_group_is_signalled_once() {
        let child = std::os::unix::process::CommandExt::process_group(&mut std::process::Command::new("sleep"), 0).arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        let mut process = ChromeProcess {
            child,
            ws_url: String::new(),
            temp_user_data_dir: None,
            temp_nss_home: None,
            pgid: Some(pid),
            #[cfg(target_os = "linux")]
            xvfb: None,
            hold: None,
            relay: None,
        };
        process.kill();
        assert_eq!(process.pgid, None);
    }
    use crate::test_utils::EnvGuard;

    #[test]
    fn test_dev_shm_capacity_threshold() {
        assert!(dev_shm_is_too_small(64 * 1024 * 1024));
        assert!(dev_shm_is_too_small(128 * 1024 * 1024));
        assert!(!dev_shm_is_too_small(256 * 1024 * 1024));
        assert!(!dev_shm_is_too_small(1024 * 1024 * 1024));
    }

    #[test]
    fn test_existing_disable_dev_shm_arg_is_not_duplicated() {
        assert!(!should_disable_dev_shm(&[
            "--disable-dev-shm-usage".to_string()
        ]));
    }

    #[cfg(unix)]
    #[test]
    fn test_stderr_drained_after_pipe_readiness() {
        let fixture = tempfile::tempdir().unwrap();
        let executable = super::fake_chrome(
            fixture.path(),
            r#"for round in 1 2; do
    while [ ! -f "$profile/request-$round" ]; do sleep 0.01; done
    printf '\377' >&2
    head -c 2097152 /dev/zero >&2
    touch "$profile/drained-$round"
done
exec sleep 60"#,
        );
        // Point the runtime dir at this test's own dir so the launch is hermetic.
        let runtime = tempfile::tempdir().unwrap();
        std::env::set_var("AGENT_BROWSER_RUNTIME_DIR", runtime.path());
        let options = LaunchOptions {
            headless: true,
            ..Default::default()
        };
        let mut chrome = try_launch_chrome(&executable, &options).unwrap();
        std::env::remove_var("AGENT_BROWSER_RUNTIME_DIR");
        let profile = runtime.path().to_path_buf();
        assert!(chrome.ws_url.starts_with("ws://127.0.0.1:"), "{}", chrome.ws_url);
        for round in 1..=2 {
            std::fs::write(profile.join(format!("request-{round}")), b"").unwrap();
            let drained = profile.join(format!("drained-{round}"));
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !drained.exists() && std::time::Instant::now() < deadline {
                assert!(
                    !chrome.has_exited(),
                    "writer exited before completing stderr"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                drained.exists(),
                "stderr burst {round} blocked after readiness"
            );
            assert!(!chrome.has_exited());
        }
        drop(chrome);
        // The runtime dir survives the process: it is the fixed reattach
        // point for the next daemon, not a temp dir to clean up.
        assert!(profile.exists());
    }

    fn prepared_nss_home() -> PreparedNssHome {
        let path = std::env::temp_dir().join(format!(
            "agent-browser-prepared-nss-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        PreparedNssHome {
            inner: Arc::new(PreparedNssHomeInner { path }),
        }
    }

    #[test]
    fn test_resolve_prepared_nss_home_without_ca_returns_none() {
        assert!(resolve_prepared_nss_home(&LaunchOptions::default())
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_resolve_prepared_nss_home_reuses_prepared_home() {
        let prepared = prepared_nss_home();
        let expected_path = prepared.path().to_path_buf();
        let options = LaunchOptions {
            prepared_nss_home: Some(prepared),
            ca_cert: Some("/path/that/must/not/be/read".to_string()),
            ..Default::default()
        };

        let resolved = resolve_prepared_nss_home(&options).unwrap().unwrap();
        assert_eq!(resolved.path(), expected_path);
    }

    #[test]
    fn test_resolve_prepared_nss_home_surfaces_ca_load_error() {
        let missing = std::env::temp_dir()
            .join(format!("missing-ca-{}", uuid::Uuid::new_v4()))
            .display()
            .to_string();
        let options = LaunchOptions {
            ca_cert: Some(missing),
            ..Default::default()
        };

        let result = resolve_prepared_nss_home(&options);
        assert!(matches!(
            result,
            Err(error) if error.contains("Failed to read CA certificate")
        ));
    }

    #[cfg(unix)]
    fn spawn_noop_child() -> Child {
        Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[cfg(windows)]
    fn spawn_noop_child() -> Child {
        let cmd = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe");
        Child::spawn(&cmd, &["/C".into(), "exit 0".into()], false, None).unwrap()
    }

    #[test]
    fn test_find_chrome_returns_some_on_host() {
        // This test only makes sense on systems with Chrome installed
        if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
            let result = find_chrome();
            // Don't assert Some -- CI may not have Chrome
            if let Some(path) = result {
                assert!(path.exists());
            }
        }
    }

    #[test]
    fn test_expand_tilde() {
        let expanded = expand_tilde("~/test/path");
        assert!(!expanded.starts_with('~'));
        assert!(expanded.ends_with("test/path"));
    }

    #[test]
    fn test_expand_tilde_no_tilde() {
        assert_eq!(expand_tilde("/absolute/path"), "/absolute/path");
    }

    #[test]
    fn test_read_devtools_active_port_missing() {
        let result = read_devtools_active_port(Path::new("/nonexistent"));
        assert!(result.is_none());
    }

    #[test]
    fn test_should_disable_sandbox_skips_if_already_set() {
        let args = vec!["--headless=new".to_string(), "--no-sandbox".to_string()];
        assert!(!should_disable_sandbox(&args));
    }

    #[test]
    fn test_chrome_launch_error_no_stderr() {
        let msg = chrome_launch_error("Chrome exited", &[]);
        assert!(msg.contains("no stderr output"));
        assert!(msg.contains("Hint:"));
        assert!(msg.contains("--no-sandbox"));
    }

    #[test]
    fn test_chrome_launch_error_with_sandbox_hint() {
        let lines = vec![
            "some log line".to_string(),
            "Failed to move to new namespace: sandbox error".to_string(),
        ];
        let msg = chrome_launch_error("Chrome exited", &lines);
        assert!(msg.contains("sandbox error"));
        assert!(msg.contains("Hint:"));
        assert!(msg.contains("--no-sandbox"));
    }

    /// A window with no display to open on is said in one plain line, first, with Chrome's own line kept after it.
    #[test]
    fn a_launch_with_no_display_says_so() {
        let lines = vec![
            "[1:1:ERROR:dbus/bus.cc:405] Failed to connect to the bus".to_string(),
            "[1:1:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:259] Missing X server or $DISPLAY".to_string(),
            "[1:1:ERROR:ui/aura/env.cc:262] The platform failed to initialize.  Exiting.".to_string(),
        ];
        let msg = chrome_launch_error("Chrome exited early (exit code: 1) before its debugger answered", &lines);
        assert!(msg.starts_with(NO_DISPLAY), "{msg}");
        assert!(msg.contains("Xvfb") && msg.contains("Chrome exited early (exit code: 1)") && msg.contains("Missing X server or $DISPLAY"), "{msg}");
        // Another failure is not read as one.
        assert!(!chrome_launch_error("Chrome exited", &["Failed to move to new namespace: sandbox error".to_string()]).starts_with(NO_DISPLAY));
    }

    /// Only a display on this machine is asked whether it answers.
    #[test]
    fn a_display_on_this_machine_is_known_by_its_number() {
        assert_eq!(local_display_number(":99"), Some(99));
        assert_eq!(local_display_number(":0.0"), Some(0));
        assert_eq!(local_display_number("unix:1"), Some(1));
        assert_eq!(local_display_number("build-host:0"), None);
        assert_eq!(local_display_number("wayland-0"), None);
        assert_eq!(local_display_number(":"), None);
    }

    #[test]
    fn test_chrome_launch_error_generic() {
        let lines = vec!["info line".to_string(), "another info line".to_string()];
        let msg = chrome_launch_error("Chrome exited", &lines);
        assert!(msg.contains("last 2 lines"));
    }

    #[test]
    fn test_find_playwright_chromium_nonexistent() {
        let guard = EnvGuard::new(&["PLAYWRIGHT_BROWSERS_PATH", "HOME", "USERPROFILE"]);
        guard.set("PLAYWRIGHT_BROWSERS_PATH", "/nonexistent/path");

        let temp_home = std::env::temp_dir().join(format!(
            "agent-browser-test-home-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_home).expect("temp home should be created");
        let temp_home = temp_home.to_string_lossy().to_string();
        guard.set("HOME", &temp_home);
        guard.set("USERPROFILE", &temp_home);

        let result = find_playwright_chromium();
        assert!(result.is_none());
    }

    #[test]
    fn test_build_args_headless_includes_headless_flag() {
        let opts = LaunchOptions {
            headless: true,
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(result.args.iter().any(|a| a == "--headless=new"));
        assert!(result.args.iter().any(|a| a == "--hide-scrollbars"));
        assert!(result
            .args
            .iter()
            .any(|a| a == "--enable-unsafe-swiftshader"));
        assert!(result.args.iter().any(|a| a == "--window-size=1280,720"));
        // The fixed runtime dir is used when no profile: the user-data-dir
        // points at it and no temp dir is tracked (the runtime survives
        // daemon deaths for reattach).
        assert!(result.temp_user_data_dir.is_none());
        assert!(result
            .args
            .iter()
            .any(|a| a.starts_with("--user-data-dir=")
                && a.contains("chrome-runtime-headless")));
    }

    #[test]
    fn test_build_args_headed_no_headless_flag() {
        let opts = LaunchOptions {
            headless: false,
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(!result.args.iter().any(|a| a.contains("--headless")));
        assert!(!result.args.iter().any(|a| a == "--hide-scrollbars"));
        assert!(!result
            .args
            .iter()
            .any(|a| a == "--enable-unsafe-swiftshader"));
        assert!(!result.args.iter().any(|a| a.starts_with("--window-size=")));
        // The fixed runtime dir is used when no profile: the user-data-dir
        // points at it and no temp dir is tracked (the runtime survives
        // daemon deaths for reattach).
        assert!(result.temp_user_data_dir.is_none());
        assert!(result
            .args
            .iter()
            .any(|a| a.starts_with("--user-data-dir=")
                && a.contains("chrome-runtime-headed")));
    }

    #[test]
    fn test_build_args_headless_uses_runtime_dir() {
        let opts = LaunchOptions::default();
        let result = build_chrome_args(&opts).unwrap();
        // No profile: the fixed headless runtime dir, never a temp dir.
        assert!(result.temp_user_data_dir.is_none());
        assert!(result
            .args
            .iter()
            .any(|a| a.starts_with("--user-data-dir=")
                && a.contains("chrome-runtime-headless")));
    }

    #[test]
    fn test_build_args_profile_no_temp_dir() {
        let opts = LaunchOptions {
            profile: Some("/tmp/my-profile".to_string()),
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(result.temp_user_data_dir.is_none());
        assert!(result
            .args
            .iter()
            .any(|a| a == "--user-data-dir=/tmp/my-profile"));
    }

    #[test]
    fn test_build_args_custom_window_size_not_overridden() {
        let opts = LaunchOptions {
            headless: true,
            args: vec!["--window-size=1920,1080".to_string()],
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(!result.args.iter().any(|a| a == "--window-size=1280,720"));
        assert!(result.args.iter().any(|a| a == "--window-size=1920,1080"));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_hide_scrollbars_false_suppresses_default_hide_scrollbars() {
        let opts = LaunchOptions {
            headless: true,
            hide_scrollbars: false,
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(
            !result.args.iter().any(|a| a == "--hide-scrollbars"),
            "--hide-scrollbars false should suppress agent-browser's default hide switch"
        );
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_start_maximized_suppresses_default_window_size() {
        let opts = LaunchOptions {
            headless: true,
            args: vec!["--start-maximized".to_string()],
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(!result.args.iter().any(|a| a == "--window-size=1280,720"));
        assert!(result.args.iter().any(|a| a == "--start-maximized"));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_disables_translate() {
        let opts = LaunchOptions::default();
        let result = build_chrome_args(&opts).unwrap();
        assert!(result
            .args
            .iter()
            .any(|a| a.contains("--disable-features") && a.contains("Translate")));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_webgpu_default_off() {
        let opts = LaunchOptions::default();
        let result = build_chrome_args(&opts).unwrap();
        assert!(!result.args.iter().any(|a| a == "--enable-unsafe-webgpu"));
        assert!(!result.args.iter().any(|a| a.contains("Vulkan")));
        assert!(!result
            .args
            .iter()
            .any(|a| a.starts_with("--use-webgpu-adapter")));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_restrict_webrtc_enforces_safe_policy() {
        let opts = LaunchOptions {
            restrict_webrtc: true,
            args: vec!["--force-webrtc-ip-handling-policy=default".to_string()],
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        let policies: Vec<&String> = result
            .args
            .iter()
            .filter(|arg| arg.starts_with("--force-webrtc-ip-handling-policy="))
            .collect();
        assert_eq!(
            policies,
            vec![&"--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string()]
        );
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_webgpu_includes_webgpu_flags() {
        let opts = LaunchOptions {
            webgpu: true,
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(result.args.iter().any(|a| a == "--enable-unsafe-webgpu"));
        if cfg!(target_os = "linux") {
            let features: Vec<&str> = result
                .args
                .iter()
                .find_map(|arg| arg.strip_prefix("--enable-features="))
                .unwrap()
                .split(',')
                .collect();
            assert!(features.contains(&"NetworkService"));
            assert!(features.contains(&"NetworkServiceInProcess"));
            assert!(features.contains(&"Vulkan"));
            assert!(result.args.iter().any(|a| a == "--use-angle=vulkan"));
            assert!(result.args.iter().any(|a| a == "--use-vulkan=swiftshader"));
            assert!(result
                .args
                .iter()
                .any(|a| a == "--use-webgpu-adapter=swiftshader"));
            assert!(result.args.iter().any(|a| a == "--disable-vulkan-surface"));
        } else {
            assert!(!result
                .args
                .iter()
                .any(|a| a.starts_with("--use-webgpu-adapter")));
        }
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_merges_user_enable_features() {
        let opts = LaunchOptions {
            webgpu: true,
            args: vec![
                "--enable-features=Foo,Bar".to_string(),
                "--some-other-flag".to_string(),
                // Duplicate of a preset feature must not repeat.
                "--enable-features=NetworkService".to_string(),
            ],
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        let flags: Vec<&String> = result
            .args
            .iter()
            .filter(|a| a.starts_with("--enable-features="))
            .collect();
        assert_eq!(flags.len(), 1, "user features must merge, not clobber");
        let features: Vec<&str> = flags[0]
            .strip_prefix("--enable-features=")
            .unwrap()
            .split(',')
            .collect();
        assert!(features.contains(&"NetworkService"));
        assert!(features.contains(&"Foo"));
        assert!(features.contains(&"Bar"));
        if cfg!(target_os = "linux") {
            assert!(
                features.contains(&"Vulkan"),
                "user --enable-features must not drop the WebGPU preset's Vulkan"
            );
        }
        assert_eq!(
            features.iter().filter(|f| **f == "NetworkService").count(),
            1
        );
        assert!(result.args.iter().any(|a| a == "--some-other-flag"));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_xvfb_applicable_tracks_effective_headed_mode() {
        // Plain headless: no display needed.
        assert!(!xvfb_applicable(&LaunchOptions::default()));
        // Headed: needs a display.
        assert!(xvfb_applicable(&LaunchOptions {
            headless: false,
            ..Default::default()
        }));
        // Nominally headless with extensions: build_chrome_args suppresses
        // --headless, so this runs headed and needs a display too.
        assert!(xvfb_applicable(&LaunchOptions {
            headless: true,
            extensions: Some(vec!["/tmp/ext".to_string()]),
            ..Default::default()
        }));
        // An empty extension list does not force headed mode.
        assert!(!xvfb_applicable(&LaunchOptions {
            headless: true,
            extensions: Some(Vec::new()),
            ..Default::default()
        }));
    }

    #[test]
    fn test_effectively_headless_tracks_extension_forced_headed_mode() {
        assert!(LaunchOptions::default().effectively_headless());
        assert!(!LaunchOptions {
            headless: false,
            ..Default::default()
        }
        .effectively_headless());
        assert!(!LaunchOptions {
            headless: true,
            extensions: Some(vec!["/tmp/ext".to_string()]),
            ..Default::default()
        }
        .effectively_headless());
        assert!(LaunchOptions {
            headless: true,
            extensions: Some(Vec::new()),
            ..Default::default()
        }
        .effectively_headless());
    }

    #[test]
    fn test_build_args_single_enable_features_flag() {
        let opts = LaunchOptions {
            webgpu: true,
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        // Chrome only honors the last --enable-features switch, so the preset
        // must never emit more than one.
        let count = result
            .args
            .iter()
            .filter(|a| a.starts_with("--enable-features="))
            .count();
        assert_eq!(count, 1);
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_enables_webmcp_by_default() {
        let result = build_chrome_args(&LaunchOptions::default()).unwrap();
        let features = result
            .args
            .iter()
            .find(|arg| arg.starts_with("--enable-features="))
            .unwrap();
        assert!(features.contains("WebMCPTesting"));
        assert!(features.contains("DevToolsWebMCPSupport"));
    }

    #[test]
    fn test_build_args_webmcp_opt_out() {
        let result = build_chrome_args(&LaunchOptions {
            webmcp: false,
            ..Default::default()
        })
        .unwrap();
        let features = result
            .args
            .iter()
            .find(|arg| arg.starts_with("--enable-features="))
            .unwrap();
        assert!(!features.contains("WebMCPTesting"));
        assert!(!features.contains("DevToolsWebMCPSupport"));
    }

    #[test]
    fn test_build_args_headless_with_extensions_skips_headless_flag() {
        let opts = LaunchOptions {
            headless: true,
            extensions: Some(vec!["/tmp/my-ext".to_string()]),
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(
            !result.args.iter().any(|a| a.contains("--headless")),
            "headless flag should be omitted when extensions are present"
        );
        assert!(
            !result.args.iter().any(|a| a == "--hide-scrollbars"),
            "scrollbars should remain visible when extensions force headed mode"
        );
        assert!(
            !result.args.iter().any(|a| a.contains("--window-size")),
            "window-size should be omitted when extensions force headed mode"
        );
        assert!(result
            .args
            .iter()
            .any(|a| a.starts_with("--load-extension=")));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_headed_with_extensions_no_headless_flag() {
        let opts = LaunchOptions {
            headless: false,
            extensions: Some(vec!["/tmp/my-ext".to_string()]),
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(
            !result.args.iter().any(|a| a.contains("--headless")),
            "headless flag should not be present in headed mode"
        );
        assert!(result
            .args
            .iter()
            .any(|a| a.starts_with("--load-extension=")));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_ignore_https_errors_includes_flag() {
        let opts = LaunchOptions {
            ignore_https_errors: true,
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(result
            .args
            .iter()
            .any(|a| a == "--ignore-certificate-errors"));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_ignore_https_errors_default_no_flag() {
        let opts = LaunchOptions::default();
        let result = build_chrome_args(&opts).unwrap();
        assert!(!result
            .args
            .iter()
            .any(|a| a == "--ignore-certificate-errors"));
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_chrome_process_drop_cleans_temp_dir() {
        let dir = std::env::temp_dir().join(format!(
            "agent-browser-chrome-drop-test-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::create_dir_all(&dir);
        assert!(dir.exists());

        {
            // Simulate a ChromeProcess with a temp dir but a dummy child.
            // We can't actually spawn Chrome here, but we can verify the Drop
            // logic by creating a small helper process.
            let child = spawn_noop_child();
            let _process = ChromeProcess {
                child,
                ws_url: String::new(),
                temp_user_data_dir: Some(dir.clone()),
                temp_nss_home: None,
                #[cfg(unix)]
                pgid: None,
                #[cfg(target_os = "linux")]
                xvfb: None,
                hold: None,
                relay: None,
            };
            // _process dropped here
        }

        assert!(!dir.exists(), "Temp dir should be cleaned up on drop");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_write_xauth_file_wildcard_cookie_record() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!("xauth-test-{}", uuid::Uuid::new_v4()));
        write_xauth_file(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "authority file must be private");

        let bytes = std::fs::read(&path).unwrap();
        // family=FamilyWild, empty address, empty number
        assert_eq!(&bytes[..6], &[0xff, 0xff, 0, 0, 0, 0]);
        // name length + MIT-MAGIC-COOKIE-1
        assert_eq!(&bytes[6..8], &18u16.to_be_bytes());
        assert_eq!(&bytes[8..26], b"MIT-MAGIC-COOKIE-1");
        // 16-byte cookie
        assert_eq!(&bytes[26..28], &16u16.to_be_bytes());
        assert_eq!(bytes.len(), 28 + 16);

        // A second write must produce a different cookie.
        let path2 = std::env::temp_dir().join(format!("xauth-test-{}", uuid::Uuid::new_v4()));
        write_xauth_file(&path2).unwrap();
        assert_ne!(std::fs::read(&path2).unwrap()[28..], bytes[28..]);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&path2);
    }

    #[test]
    fn test_is_chrome_profile_name_simple() {
        assert!(is_chrome_profile_name("Default"));
        assert!(is_chrome_profile_name("Profile 1"));
        assert!(is_chrome_profile_name(""));
    }

    #[test]
    fn test_is_chrome_profile_name_paths() {
        assert!(!is_chrome_profile_name("/tmp/dir"));
        assert!(!is_chrome_profile_name("~/my-profile"));
        assert!(!is_chrome_profile_name("C:\\Users\\foo"));
        assert!(!is_chrome_profile_name("relative/path"));
    }

    /// Helper to create a fake Chrome user-data dir with a `Local State` file.
    fn create_fake_local_state(base: &Path, profiles: &[(&str, &str)]) {
        let mut info_cache = serde_json::Map::new();
        for (dir_name, display_name) in profiles {
            let mut entry = serde_json::Map::new();
            entry.insert(
                "name".to_string(),
                serde_json::Value::String(display_name.to_string()),
            );
            info_cache.insert(dir_name.to_string(), serde_json::Value::Object(entry));
        }

        let local_state = serde_json::json!({
            "profile": {
                "info_cache": info_cache
            }
        });

        std::fs::create_dir_all(base).unwrap();
        std::fs::write(
            base.join("Local State"),
            serde_json::to_string_pretty(&local_state).unwrap(),
        )
        .unwrap();
    }

    /// RAII guard that removes the temp directory on drop (even on panic).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            Self(std::env::temp_dir().join(format!(
                "agent-browser-test-{}-{}-{}",
                name,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl std::ops::Deref for TempDir {
        type Target = PathBuf;
        fn deref(&self) -> &PathBuf {
            &self.0
        }
    }

    /// A handoff nobody finishes closes itself: it was left open *for a person*, and an agent's failed walk has no
    /// person coming (the Eden report ended one run with 88 node and Chrome processes still running).
    #[cfg(unix)]
    #[test]
    fn test_preserve_for_closes_what_nobody_came_for() {
        let child = Command::new("/bin/sh")
            .args(["-c", "exec sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let process = ChromeProcess {
            child,
            ws_url: String::new(),
            temp_user_data_dir: None,
            temp_nss_home: None,
            #[cfg(unix)]
            pgid: None,
            #[cfg(target_os = "linux")]
            xvfb: None,
            hold: None,
            relay: None,
        };
        process.preserve_for(Duration::from_millis(120));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            // The reaper drops the process at its deadline, and the drop kills and reaps it: gone means gone.
            if unsafe { libc::kill(pid as i32, 0) } != 0 {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "the handoff browser outlived its deadline");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn test_list_chrome_profiles_valid() {
        let dir = TempDir::new("list-profiles");
        create_fake_local_state(&dir, &[("Default", "Person 1"), ("Profile 1", "Work")]);

        let profiles = list_chrome_profiles(&dir);
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].directory, "Default");
        assert_eq!(profiles[0].name, "Person 1");
        assert_eq!(profiles[1].directory, "Profile 1");
        assert_eq!(profiles[1].name, "Work");
    }

    #[test]
    fn test_list_chrome_profiles_missing_local_state() {
        let dir = TempDir::new("list-profiles-missing");
        std::fs::create_dir_all(&*dir).unwrap();
        let profiles = list_chrome_profiles(&dir);
        assert!(profiles.is_empty());
    }

    #[test]
    fn test_list_chrome_profiles_malformed_json() {
        let dir = TempDir::new("list-profiles-malformed");
        std::fs::create_dir_all(&*dir).unwrap();
        std::fs::write(dir.join("Local State"), "not json").unwrap();
        let profiles = list_chrome_profiles(&dir);
        assert!(profiles.is_empty());
    }

    #[test]
    fn test_list_chrome_profiles_missing_info_cache() {
        let dir = TempDir::new("list-profiles-no-cache");
        std::fs::create_dir_all(&*dir).unwrap();
        std::fs::write(dir.join("Local State"), r#"{"profile": {}}"#).unwrap();
        let profiles = list_chrome_profiles(&dir);
        assert!(profiles.is_empty());
    }

    #[test]
    fn test_resolve_chrome_profile_exact_directory() {
        let dir = TempDir::new("resolve-exact");
        create_fake_local_state(&dir, &[("Default", "Person 1"), ("Profile 1", "Work")]);

        let result = resolve_chrome_profile(&dir, "Default");
        assert_eq!(result.unwrap(), "Default");
    }

    #[test]
    fn test_resolve_chrome_profile_display_name_case_insensitive() {
        let dir = TempDir::new("resolve-display");
        create_fake_local_state(&dir, &[("Default", "Person 1"), ("Profile 1", "Work")]);

        let result = resolve_chrome_profile(&dir, "work");
        assert_eq!(result.unwrap(), "Profile 1");
    }

    #[test]
    fn test_resolve_chrome_profile_directory_name_case_insensitive() {
        let dir = TempDir::new("resolve-dir-ci");
        create_fake_local_state(&dir, &[("Default", "Person 1"), ("Profile 1", "Work")]);

        let result = resolve_chrome_profile(&dir, "default");
        assert_eq!(result.unwrap(), "Default");
    }

    #[test]
    fn test_resolve_chrome_profile_not_found() {
        let dir = TempDir::new("resolve-notfound");
        create_fake_local_state(&dir, &[("Default", "Person 1")]);

        let result = resolve_chrome_profile(&dir, "Nonexistent");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("not found"));
        assert!(err.contains("Default"));
        assert!(err.contains("full path"));
    }

    #[test]
    fn test_resolve_chrome_profile_ambiguous_display_name() {
        let dir = TempDir::new("resolve-ambiguous");
        create_fake_local_state(&dir, &[("Default", "Work"), ("Profile 1", "Work")]);

        let result = resolve_chrome_profile(&dir, "Work");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Ambiguous"));
        assert!(err.contains("Default"));
        assert!(err.contains("Profile 1"));
    }

    /// Helper to create a fake Chrome profile directory with some files.
    fn create_fake_profile(user_data_dir: &Path, profile_dir: &str) {
        let profile_path = user_data_dir.join(profile_dir);
        std::fs::create_dir_all(profile_path.join("Local Storage/leveldb")).unwrap();
        std::fs::write(profile_path.join("Cookies"), "fake-cookies").unwrap();
        std::fs::write(
            profile_path.join("Local Storage/leveldb/CURRENT"),
            "fake-leveldb",
        )
        .unwrap();
        // Create an excluded directory to verify it's skipped
        std::fs::create_dir_all(profile_path.join("Cache")).unwrap();
        std::fs::write(profile_path.join("Cache/data_0"), "cache-data").unwrap();
    }

    #[test]
    fn test_copy_chrome_profile_structure() {
        let src = TempDir::new("copy-src");
        create_fake_local_state(&src, &[("Default", "Person 1")]);
        create_fake_profile(&src, "Default");

        let temp_path = copy_chrome_profile(&src, "Default").unwrap();
        let temp = TempDir(temp_path);

        assert!(temp.join("Local State").is_file());
        assert!(temp.join("Default/Cookies").is_file());
        assert!(temp.join("Default/Local Storage/leveldb/CURRENT").is_file());
        assert_eq!(
            std::fs::read_to_string(temp.join("Default/Cookies")).unwrap(),
            "fake-cookies"
        );
        assert_eq!(
            std::fs::read_to_string(temp.join("Default/Local Storage/leveldb/CURRENT")).unwrap(),
            "fake-leveldb"
        );
        assert!(!temp.join("Default/Cache").exists());
    }

    /// Upstream #2189: a copy says its profile closed cleanly, and the source is never touched.
    #[test]
    fn test_copy_chrome_profile_normalizes_crashed_exit_type() {
        let compact = r#"{"a":1,"profile":{"exit_type":"Crashed","name":"x"}}"#;
        let spaced = "{ \"profile\": { \"exit_type\" : \"Crashed\" } }";
        for (name, prefs, normalized) in [
            ("compact", Some(compact), true),
            ("spaced", Some(spaced), true),
            ("normal", Some(r#"{"profile":{"exit_type":"Normal"}}"#), false),
            ("missing-field", Some(r#"{"profile":{}}"#), false),
            ("malformed", Some(r#"{"profile":{"exit_type":"Crashed""#), false),
            ("missing-file", None, false),
        ] {
            let src = TempDir::new(&format!("copy-exit-{name}"));
            create_fake_local_state(&src, &[("Default", "Person 1")]);
            create_fake_profile(&src, "Default");
            if let Some(p) = prefs {
                std::fs::write(src.join("Default/Preferences"), p).unwrap();
            }
            let temp = TempDir(copy_chrome_profile(&src, "Default").unwrap());
            let copied = std::fs::read(temp.join("Default/Preferences")).ok();
            match prefs {
                None => assert!(copied.is_none(), "{name}"),
                Some(p) if normalized => {
                    let mut want: serde_json::Value = serde_json::from_str(p).unwrap();
                    want["profile"]["exit_type"] = "Normal".into();
                    let got: serde_json::Value = serde_json::from_slice(&copied.unwrap()).unwrap();
                    assert_eq!(got, want, "{name}");
                }
                Some(p) => assert_eq!(copied.unwrap(), p.as_bytes(), "{name}"),
            }
            if let Some(p) = prefs {
                let source = std::fs::read(src.join("Default/Preferences")).unwrap();
                assert_eq!(source, p.as_bytes(), "{name}");
            }
            let leftovers: Vec<_> = std::fs::read_dir(temp.join("Default"))
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(".Preferences-"))
                .collect();
            assert!(leftovers.is_empty(), "{name}: no temp file is left behind");
        }
    }

    #[test]
    fn test_copy_chrome_profile_missing_source() {
        let src = TempDir::new("copy-missing-src");
        std::fs::create_dir_all(&*src).unwrap();

        let result = copy_chrome_profile(&src, "Nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Profile directory not found"));
    }

    #[test]
    fn test_copy_chrome_profile_missing_local_state() {
        let src = TempDir::new("copy-no-ls");
        let profile_path = src.join("Default");
        std::fs::create_dir_all(&profile_path).unwrap();
        std::fs::write(profile_path.join("Cookies"), "data").unwrap();

        let temp_path = copy_chrome_profile(&src, "Default").unwrap();
        let temp = TempDir(temp_path);

        assert!(!temp.join("Local State").exists());
        assert!(temp.join("Default/Cookies").is_file());
    }

    #[test]
    fn test_copy_dir_recursive_excludes() {
        let src = TempDir::new("copy-excludes-src");
        let dst = TempDir::new("copy-excludes-dst");
        std::fs::create_dir_all(src.join("keep")).unwrap();
        std::fs::write(src.join("keep/data"), "keep-data").unwrap();
        for excluded in PROFILE_COPY_EXCLUDE_DIRS {
            std::fs::create_dir_all(src.join(excluded)).unwrap();
            std::fs::write(src.join(excluded).join("file"), "excluded").unwrap();
        }

        copy_dir_recursive(&src, &dst).unwrap();

        assert!(dst.join("keep/data").is_file());
        for excluded in PROFILE_COPY_EXCLUDE_DIRS {
            assert!(
                !dst.join(excluded).exists(),
                "{} should be excluded",
                excluded
            );
        }
    }

    #[test]
    fn test_build_args_use_real_keychain_true() {
        let opts = LaunchOptions {
            use_real_keychain: true,
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(
            !result.args.iter().any(|a| a == "--password-store=basic"),
            "should NOT have --password-store=basic when use_real_keychain is true"
        );
        assert!(
            !result.args.iter().any(|a| a == "--use-mock-keychain"),
            "should NOT have --use-mock-keychain when use_real_keychain is true"
        );
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_use_real_keychain_false_default() {
        let opts = LaunchOptions::default();
        let result = build_chrome_args(&opts).unwrap();
        assert!(
            result.args.iter().any(|a| a == "--password-store=basic"),
            "should have --password-store=basic by default"
        );
        assert!(
            result.args.iter().any(|a| a == "--use-mock-keychain"),
            "should have --use-mock-keychain by default"
        );
        if let Some(ref dir) = result.temp_user_data_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn test_build_args_profile_path_preserves_keychain_flags() {
        let opts = LaunchOptions {
            profile: Some("/tmp/my-profile".to_string()),
            ..Default::default()
        };
        let result = build_chrome_args(&opts).unwrap();
        assert!(result
            .args
            .iter()
            .any(|a| a == "--user-data-dir=/tmp/my-profile"));
        assert!(
            result.args.iter().any(|a| a == "--password-store=basic"),
            "profile path should keep keychain flags"
        );
    }

    // -------------------------------------------------------------------
    // auto_connect_cdp discovery-order tests (#1210, #1206)
    // -------------------------------------------------------------------

    /// When DevToolsActivePort provides a ws_path and the port is reachable,
    /// `resolve_cdp_from_active_port` should return the exact ws_path URL
    /// WITHOUT calling HTTP discovery first.
    #[tokio::test]
    async fn test_resolve_cdp_from_active_port_prefers_ws_path() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message as WsMsg;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let ws_path = "/devtools/browser/test-uuid-1234".to_string();

        let server = tokio::spawn(async move {
            // accept: verify_ws_endpoint() WebSocket handshake
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            if let Some(Ok(WsMsg::Text(text))) = ws.next().await {
                let req: serde_json::Value = serde_json::from_str(&text).unwrap();
                let id = req.get("id").unwrap();
                let reply = format!(
                    r#"{{"id":{},"result":{{"protocolVersion":"1.3","product":"Chrome/147"}}}}"#,
                    id
                );
                ws.send(WsMsg::Text(reply)).await.unwrap();
            }
            let _ = ws.close(None).await;
        });

        let result = resolve_cdp_from_active_port(port, &ws_path).await;
        assert!(result.is_ok(), "should succeed: {:?}", result);
        let url = result.unwrap();
        assert!(
            url.contains("test-uuid-1234"),
            "should use exact ws_path from DevToolsActivePort, got: {}",
            url
        );
        assert_eq!(url, format!("ws://127.0.0.1:{}{}", port, ws_path));
        server.await.unwrap();
    }

    /// Chrome 144+ holds the WebSocket handshake while the remote-debugging
    /// permission prompt is open. A handshake that completes after a few
    /// seconds must still resolve through the exact ws_path (#1365).
    #[tokio::test]
    async fn test_resolve_cdp_from_active_port_waits_for_permission_prompt() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message as WsMsg;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let ws_path = "/devtools/browser/prompt-uuid".to_string();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(3)).await;
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            if let Some(Ok(WsMsg::Text(text))) = ws.next().await {
                let req: serde_json::Value = serde_json::from_str(&text).unwrap();
                let id = req.get("id").unwrap();
                let reply = format!(
                    r#"{{"id":{},"result":{{"protocolVersion":"1.3","product":"Chrome/148"}}}}"#,
                    id
                );
                ws.send(WsMsg::Text(reply)).await.unwrap();
            }
            let _ = ws.close(None).await;
        });

        let result = resolve_cdp_from_active_port(port, &ws_path).await;
        assert_eq!(result, Ok(format!("ws://127.0.0.1:{}{}", port, ws_path)));
        server.await.unwrap();
    }

    /// When the exact ws_path connection fails, `resolve_cdp_from_active_port`
    /// should fall back to HTTP discovery.
    #[tokio::test]
    async fn test_resolve_cdp_from_active_port_falls_back_to_http_discovery() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = tokio::spawn(async move {
            // 1st accept: verify_ws_endpoint() ws_path probe — reject (just close)
            let (s1, _) = listener.accept().await.unwrap();
            drop(s1);

            // 2nd accept: HTTP /json/version from discover_cdp_url()
            let (mut s2, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = s2.read(&mut buf).await;
            let body = format!(
                r#"{{"webSocketDebuggerUrl":"ws://127.0.0.1:{}/devtools/browser/fallback-uuid"}}"#,
                port
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{}",
                body.len(),
                body
            );
            s2.write_all(resp.as_bytes()).await.unwrap();
        });

        let result = resolve_cdp_from_active_port(port, "/devtools/browser/nonexistent-uuid").await;
        assert!(result.is_ok(), "should fall back to HTTP: {:?}", result);
        let url = result.unwrap();
        assert!(
            url.contains("fallback-uuid"),
            "should use HTTP discovery fallback, got: {}",
            url
        );
        server.await.unwrap();
    }

    /// When neither ws_path nor HTTP discovery works, return an error.
    #[tokio::test]
    async fn test_resolve_cdp_from_active_port_both_fail() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let result = resolve_cdp_from_active_port(port, "/devtools/browser/dead").await;
        assert!(
            matches!(result, Err(ActivePortError::Unreachable(_))),
            "should fail when nothing is listening: {:?}",
            result
        );
    }

    /// A handshake still held open when the timeout expires means Chrome is
    /// showing the permission prompt. Resolution must stop without HTTP
    /// discovery, which would open a second prompt (#1365).
    #[tokio::test]
    async fn test_resolve_cdp_from_active_port_stops_while_prompt_is_open() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = tokio::spawn(async move {
            let (held, _) = listener.accept().await.unwrap();
            let second = tokio::time::timeout(Duration::from_secs(2), listener.accept()).await;
            drop(held);
            second.is_ok()
        });

        let result = resolve_cdp_from_active_port_within(
            port,
            "/devtools/browser/prompt",
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(result, Err(ActivePortError::AwaitingApproval));
        assert!(
            !server.await.unwrap(),
            "HTTP discovery must not run while the prompt is open"
        );
    }

    #[test]
    fn auto_connect_wait_stays_below_client_read_timeout() {
        let client_floor = crate::connection::read_timeout_for(&serde_json::json!({}));
        assert!(AUTO_CONNECT_WS_VERIFY_TIMEOUT < client_floor);
    }
}


/// Runs the calling test alone in a child copy of the test binary, so an environment it changes (a PATH without the
/// system folders, another HOME) never reaches the other tests of this process. Returns true in the child, where the
/// body goes on; in the parent it runs the child, asserts it passed, and returns false for the body to stop.
#[cfg(test)]
pub(crate) fn own_process(module: &str, name: &str) -> bool {
    let path = format!("{}::{name}", module.split_once("::").map_or(module, |(_, rest)| rest));
    if std::env::var("U208B_OWN_PROCESS").is_ok_and(|v| v == path) {
        return true;
    }
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args([path.as_str(), "--exact", "--nocapture", "--test-threads=1"])
        .env("U208B_OWN_PROCESS", &path)
        .output()
        .unwrap();
    assert!(
        out.status.success() && String::from_utf8_lossy(&out.stdout).contains("1 passed"),
        "the test failed in its own process:\n{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    false
}

#[cfg(all(test, target_os = "linux"))]
mod host_lookup_tests {
    use super::*;
    use crate::test_utils::EnvGuard;
    use std::os::unix::fs::PermissionsExt;

    const CA_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIDBTCCAe2gAwIBAgIUFhZ9tlfduuEvOIOcGuOA7E0SSL4wDQYJKoZIhvcNAQEL\n\
BQAwEjEQMA4GA1UEAwwHdGVzdC1jYTAeFw0yNjAzMjUxNDE5MDVaFw0yNzAzMjUx\n\
NDE5MDVaMBIxEDAOBgNVBAMMB3Rlc3QtY2EwggEiMA0GCSqGSIb3DQEBAQUAA4IB\n\
DwAwggEKAoIBAQDcgmzozr7Ia72OCsxk2uKUFhM6wR0H69cv4qO5OViu+0qFoYr6\n\
Bny2o+Q/ooqCCYveamPukYlZMFilnk9b4M2VwxK72pOVTkvyWUWpIJrV6OQKqsaf\n\
DNgDdl4U4i2U/HKKNXTNtaVPzc3d40rcwy8dHVzFaTs8o7UG73foHQ2/7KQ6sY5d\n\
gjOchbLDlhN2Nkyc4WxXEipesonUogLzZxx9gSMZN6VmXaIyijncAFxO9vSenTQd\n\
FstTlTI/FCPQU2cg5K3rtToPli3j7z9oeeMrrt3pp1xmU5/cliz5kQ3CXxbH1UR3\n\
uFAaW09wTsK+fSo8rBgGWO5JU706M1aL5wvXAgMBAAGjUzBRMB0GA1UdDgQWBBR3\n\
yFGDemoQUIFA/YW1BJYhT6hlhzAfBgNVHSMEGDAWgBR3yFGDemoQUIFA/YW1BJYh\n\
T6hlhzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCq5bl2J+JO\n\
LpOZG4n4xbQUi456bV40a9lxFwXyR4toiOnLc9QTiFLtrRRMjiAYBlpnp7Aq7rPK\n\
0dxGhFsNhTHYv5bKF3Wt6EKnfmjC5J2PQ4j4fZbqnBJVNhtP3/QdTg/Alx2DgVlP\n\
vUaYBYvyM8aeAGCvlTr9XbciLgDHrO6xE0mppF87jG3DbVIqhGAa8z7KR286Hmw3\n\
JtnWOCSAT+dNsAXmz4ebm7kp9OnpLLKjvrNEUNPA20J5S+BXTtPv7x/koRwSX35M\n\
9yOorGsG0RB4CaEy4fpiKTewGNMdHNoZNevXB1s7jm3YdW5BDxvG4Su5RGqAjS+Y\n\
49s7jC+okfzl\n\
-----END CERTIFICATE-----\n";

    fn exe(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    /// PATH with `bin` in front: the rest of it stays, so other tests' `sleep` and `true` still resolve.
    fn path_with(guard: &EnvGuard, bin: &Path) {
        let old = std::env::var("PATH").unwrap_or_default();
        guard.set("PATH", &format!("{}:{old}", bin.display()));
    }

    fn real_bundle(dir: &Path) -> CaBundle {
        let file = dir.join("ca.pem");
        std::fs::write(&file, CA_PEM).unwrap();
        crate::ca_bundle::load(file.to_str().unwrap()).unwrap()
    }

    /// The `-d` database path of the first certutil call in the log, and so the temporary home it lives under.
    fn home_of(log: &str) -> PathBuf {
        let db = log.split_whitespace().find_map(|w| w.strip_prefix("sql:")).unwrap();
        PathBuf::from(db).ancestors().nth(4).unwrap().to_path_buf()
    }

    #[test]
    fn a_ca_certificate_is_imported_into_a_private_trust_store_and_the_staged_copy_removed() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        exe(dir.path(), "certutil", &format!("echo \"$@\" >> {l}", l = log.display()));
        let guard = EnvGuard::new(&["PATH"]);
        path_with(&guard, dir.path());

        let home = prepare_nss_home(&real_bundle(dir.path())).unwrap();
        let calls = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = calls.lines().collect();
        assert_eq!(lines.len(), 2, "{calls}");
        assert!(lines[0].starts_with("-N --empty-password -d sql:"), "{calls}");
        assert!(lines[1].starts_with("-A -d sql:") && lines[1].contains("-t C,, -n agent-browser-ca-0 -i "), "{calls}");

        let path = home.path().to_path_buf();
        assert_eq!(path, home_of(&calls));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read_link(path.join(".pki")).unwrap(), PathBuf::from(".local/share/pki"));
        assert!(!path.join("ca-0.der").exists(), "the staged certificate goes once imported");
        drop(home);
        assert!(!path.exists(), "the store goes with its last holder");
    }

    #[test]
    fn a_certutil_that_refuses_the_import_fails_the_launch_and_leaves_no_trust_store() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log");
        exe(
            dir.path(),
            "certutil",
            &format!("echo \"$@\" >> {l}\nif [ \"$1\" = -A ]; then echo 'bad certificate' >&2; exit 1; fi", l = log.display()),
        );
        let guard = EnvGuard::new(&["PATH"]);
        path_with(&guard, dir.path());

        let err = prepare_nss_home(&real_bundle(dir.path())).err().expect("import must fail");
        assert_eq!(err, "Failed to import the CA certificate: bad certificate");
        let home = home_of(&std::fs::read_to_string(&log).unwrap());
        assert!(!home.exists(), "a failed setup removes the store it made");
    }

    #[test]
    fn a_certutil_that_fails_silently_is_reported_by_its_exit_status() {
        let dir = tempfile::tempdir().unwrap();
        exe(dir.path(), "certutil", "exit 4");
        let guard = EnvGuard::new(&["PATH"]);
        path_with(&guard, dir.path());
        let err = prepare_nss_home(&real_bundle(dir.path())).err().unwrap();
        assert!(err.starts_with("Failed to initialize the NSS database: certutil exited with"), "{err}");
        assert!(err.contains("libnss3-tools"), "{err}");
    }

    #[test]
    fn a_missing_certutil_says_how_to_install_it() {
        if !own_process(module_path!(), "a_missing_certutil_says_how_to_install_it") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let guard = EnvGuard::new(&["PATH"]);
        guard.set("PATH", &empty.display().to_string());
        let err = run_certutil(&["-N"], "initialize the NSS database").unwrap_err();
        assert!(err.starts_with("Failed to initialize the NSS database: could not run certutil"), "{err}");
        assert!(err.contains("agent-browser install --with-deps"), "{err}");
    }

    #[test]
    fn a_launch_takes_a_prepared_store_before_a_bundle_and_a_bundle_before_a_file() {
        let dir = tempfile::tempdir().unwrap();
        exe(dir.path(), "certutil", "exit 0");
        let guard = EnvGuard::new(&["PATH"]);
        path_with(&guard, dir.path());

        assert!(resolve_prepared_nss_home(&LaunchOptions::default()).unwrap().is_none());

        let prepared = prepare_nss_home(&real_bundle(dir.path())).unwrap();
        let options = LaunchOptions {
            prepared_nss_home: Some(prepared.clone()),
            ca_cert: Some("/path/that/must/not/be/read".into()),
            ..Default::default()
        };
        let got = resolve_prepared_nss_home(&options).unwrap().unwrap();
        assert_eq!(got.path(), prepared.path());

        let options = LaunchOptions { ca_bundle: Some(real_bundle(dir.path())), ca_cert: Some("/path/that/must/not/be/read".into()), ..Default::default() };
        let made = resolve_prepared_nss_home(&options).unwrap().unwrap();
        assert_ne!(made.path(), prepared.path());

        let file = dir.path().join("ca.pem");
        let options = LaunchOptions { ca_cert: Some(file.display().to_string()), ..Default::default() };
        assert!(resolve_prepared_nss_home(&options).unwrap().is_some(), "a named file is loaded and imported");

        let options = LaunchOptions { ca_cert: Some(dir.path().join("missing.pem").display().to_string()), ..Default::default() };
        let err = resolve_prepared_nss_home(&options).err().unwrap();
        assert!(err.contains("Failed to read CA certificate"), "{err}");
    }

    /// A DevToolsActivePort that names a live server: it answers the first command, as Chrome does.
    async fn live_cdp_server() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use futures_util::{SinkExt, StreamExt};
            while let Ok((stream, _)) = listener.accept().await {
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                if let Some(Ok(_)) = ws.next().await {
                    let _ = ws.send(tokio_tungstenite::tungstenite::Message::Text(r#"{"id":1,"result":{}}"#.into())).await;
                }
            }
        });
        port
    }

    #[test]
    fn the_devtools_port_file_gives_a_port_and_a_path_or_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_devtools_active_port(dir.path()), None);
        let file = dir.path().join("DevToolsActivePort");
        std::fs::write(&file, "9333\n/devtools/browser/abc\n").unwrap();
        assert_eq!(read_devtools_active_port(dir.path()), Some((9333, "/devtools/browser/abc".to_string())));
        std::fs::write(&file, "9333").unwrap();
        assert_eq!(read_devtools_active_port(dir.path()), Some((9333, "/devtools/browser".to_string())), "no path line: the default");
        std::fs::write(&file, "not-a-port\n/x").unwrap();
        assert_eq!(read_devtools_active_port(dir.path()), None);
        std::fs::write(&file, "").unwrap();
        assert_eq!(read_devtools_active_port(dir.path()), None);
    }

    #[test]
    fn chromes_profile_folders_sit_under_the_homes_config() {
        if !own_process(module_path!(), "chromes_profile_folders_sit_under_the_homes_config") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME"]);
        guard.set("HOME", &dir.path().display().to_string());
        let dirs = get_chrome_user_data_dirs();
        assert_eq!(dirs.len(), 4);
        assert_eq!(dirs[0], dir.path().join(".config/google-chrome"));
        assert_eq!(dirs[3], dir.path().join(".config/BraveSoftware/Brave-Browser"));
        assert_eq!(find_chrome_user_data_dir(), None);
        std::fs::create_dir_all(dir.path().join(".config/chromium")).unwrap();
        std::fs::write(dir.path().join(".config/chromium/Local State"), "{}").unwrap();
        assert_eq!(find_chrome_user_data_dir(), Some(dir.path().join(".config/chromium")));
    }

    #[tokio::test]
    async fn an_auto_connect_takes_the_live_browser_a_port_file_names() {
        if !own_process(module_path!(), "an_auto_connect_takes_the_live_browser_a_port_file_names") {
            return;
        }
        let port = live_cdp_server().await;
        let dir = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME"]);
        guard.set("HOME", &dir.path().display().to_string());
        let profile = dir.path().join(".config/google-chrome");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("DevToolsActivePort"), format!("{port}\n/devtools/browser/xyz")).unwrap();

        let url = auto_connect_cdp().await.unwrap();
        assert_eq!(url, format!("ws://127.0.0.1:{port}/devtools/browser/xyz"));
        assert!(profile.join("DevToolsActivePort").exists(), "a live port file stays");
    }

    #[tokio::test]
    async fn an_auto_connect_removes_the_port_file_a_dead_browser_left() {
        if !own_process(module_path!(), "an_auto_connect_removes_the_port_file_a_dead_browser_left") {
            return;
        }
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let dir = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME"]);
        guard.set("HOME", &dir.path().display().to_string());
        let profile = dir.path().join(".config/chromium");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("DevToolsActivePort"), format!("{dead}\n/devtools/browser/old")).unwrap();

        let result = auto_connect_cdp().await;
        assert!(!profile.join("DevToolsActivePort").exists(), "the stale file goes: {result:?}");
    }

    #[tokio::test]
    async fn an_auto_connect_with_no_port_file_finds_nothing_here() {
        if !own_process(module_path!(), "an_auto_connect_with_no_port_file_finds_nothing_here") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME"]);
        guard.set("HOME", &dir.path().display().to_string());
        // 9222 and 9229 are probed last: a machine with a browser on one of them answers, any other gets the refusal.
        if let Err(e) = auto_connect_cdp().await {
            assert!(e.starts_with("No running Chrome instance found"), "{e}");
        }
    }

    #[test]
    fn a_profile_copy_is_marked_cleanly_closed_only_when_it_said_crashed() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = dir.path().join("Preferences");
        let read = || serde_json::from_slice::<serde_json::Value>(&std::fs::read(&prefs).unwrap()).unwrap();

        std::fs::write(&prefs, r#"{"profile":{"exit_type":"Crashed","name":"A"},"x":1}"#).unwrap();
        mark_cleanly_closed(dir.path());
        let v = read();
        assert_eq!(v["profile"]["exit_type"], "Normal");
        assert_eq!((&v["profile"]["name"], &v["x"]), (&serde_json::json!("A"), &serde_json::json!(1)));
        let temps = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(temps, 1, "no temporary file is left behind");

        let other = r#"{"profile":{"exit_type":"SessionEnded"}}"#;
        std::fs::write(&prefs, other).unwrap();
        mark_cleanly_closed(dir.path());
        assert_eq!(std::fs::read_to_string(&prefs).unwrap(), other);

        std::fs::write(&prefs, "{not json").unwrap();
        mark_cleanly_closed(dir.path());
        assert_eq!(std::fs::read_to_string(&prefs).unwrap(), "{not json");

        std::fs::write(&prefs, r#"{"x":1}"#).unwrap();
        mark_cleanly_closed(dir.path());
        assert_eq!(std::fs::read_to_string(&prefs).unwrap(), r#"{"x":1}"#);

        std::fs::remove_file(&prefs).unwrap();
        mark_cleanly_closed(dir.path());
        assert!(!prefs.exists());
    }

    #[test]
    fn a_directory_copy_keeps_nested_files_and_skips_the_cache_folders() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let s = src.path();
        std::fs::create_dir_all(s.join("Default/Local Storage")).unwrap();
        std::fs::create_dir_all(s.join("Default/Cache")).unwrap();
        std::fs::create_dir_all(s.join("Code Cache")).unwrap();
        std::fs::write(s.join("Local State"), "ls").unwrap();
        std::fs::write(s.join("Default/Cookies"), "c").unwrap();
        std::fs::write(s.join("Default/Local Storage/a"), "a").unwrap();
        std::fs::write(s.join("Default/Cache/big"), "x").unwrap();
        std::fs::write(s.join("Code Cache/big"), "x").unwrap();

        let out = dst.path().join("copy");
        copy_dir_recursive(s, &out).unwrap();
        assert_eq!(std::fs::read_to_string(out.join("Local State")).unwrap(), "ls");
        assert_eq!(std::fs::read_to_string(out.join("Default/Cookies")).unwrap(), "c");
        assert_eq!(std::fs::read_to_string(out.join("Default/Local Storage/a")).unwrap(), "a");
        assert!(!out.join("Default/Cache").exists() && !out.join("Code Cache").exists());
    }

    #[test]
    fn a_directory_copy_of_a_missing_folder_names_it() {
        let dst = tempfile::tempdir().unwrap();
        let err = copy_dir_recursive(&dst.path().join("nope"), &dst.path().join("out")).unwrap_err();
        assert!(err.starts_with("Failed to read directory ") && err.contains("nope"), "{err}");
    }

    #[test]
    fn the_sandbox_goes_off_when_the_operator_says_so_and_never_twice() {
        if !own_process(module_path!(), "the_sandbox_goes_off_when_the_operator_says_so_and_never_twice") {
            return;
        }
        let guard = EnvGuard::new(&["AGENT_BROWSER_NO_SANDBOX"]);
        guard.set("AGENT_BROWSER_NO_SANDBOX", "1");
        assert!(should_disable_sandbox(&[]));
        assert!(!should_disable_sandbox(&["--no-sandbox".to_string()]));
    }

    #[test]
    fn the_newest_puppeteer_chrome_wins_by_version_number() {
        if !own_process(module_path!(), "the_newest_puppeteer_chrome_wins_by_version_number") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["PUPPETEER_CACHE_DIR", "HOME", "USERPROFILE"]);
        guard.set("PUPPETEER_CACHE_DIR", &dir.path().display().to_string());
        guard.set("HOME", &home.path().display().to_string());
        guard.set("USERPROFILE", &home.path().display().to_string());
        assert_eq!(find_puppeteer_chrome(), None);
        for v in ["linux-9.0.1", "linux-10.0.0", "linux-8.0.0"] {
            let bin = dir.path().join("chrome").join(v).join("chrome-linux64");
            std::fs::create_dir_all(&bin).unwrap();
            if v != "linux-8.0.0" {
                std::fs::write(bin.join("chrome"), "").unwrap();
            }
        }
        std::fs::create_dir_all(dir.path().join("chrome/linux-99.0.0")).unwrap();
        assert_eq!(find_puppeteer_chrome(), Some(dir.path().join("chrome/linux-10.0.0/chrome-linux64/chrome")));
    }

    #[test]
    fn a_puppeteer_cache_under_the_home_is_searched_too() {
        if !own_process(module_path!(), "a_puppeteer_cache_under_the_home_is_searched_too") {
            return;
        }
        let empty = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["PUPPETEER_CACHE_DIR", "HOME", "USERPROFILE"]);
        guard.set("PUPPETEER_CACHE_DIR", &empty.path().display().to_string());
        guard.set("HOME", &home.path().display().to_string());
        guard.set("USERPROFILE", &home.path().display().to_string());
        let bin = home.path().join(".cache/puppeteer/chrome/linux-1.0.0/chrome-linux64");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("chrome"), "").unwrap();
        assert_eq!(find_puppeteer_chrome(), Some(bin.join("chrome")));
    }

    #[test]
    fn the_newest_playwright_chromium_wins_and_the_testing_layout_is_the_fallback() {
        if !own_process(module_path!(), "the_newest_playwright_chromium_wins_and_the_testing_layout_is_the_fallback") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["PLAYWRIGHT_BROWSERS_PATH", "HOME", "USERPROFILE"]);
        guard.set("PLAYWRIGHT_BROWSERS_PATH", &dir.path().display().to_string());
        guard.set("HOME", &home.path().display().to_string());
        guard.set("USERPROFILE", &home.path().display().to_string());
        assert_eq!(find_playwright_chromium(), None);
        let make = |name: &str, layout: &str| {
            let d = dir.path().join(name).join(layout);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("chrome"), "").unwrap();
        };
        make("chromium-1000", "chrome-linux");
        make("chromium-1100", "chrome-linux64");
        make("firefox-2000", "chrome-linux");
        assert_eq!(find_playwright_chromium(), Some(dir.path().join("chromium-1100/chrome-linux64/chrome")));
        make("chromium-1100", "chrome-linux");
        assert_eq!(find_playwright_chromium(), Some(dir.path().join("chromium-1100/chrome-linux/chrome")), "the standard layout is preferred");
    }

    #[test]
    fn a_playwright_cache_under_the_home_is_searched_too() {
        if !own_process(module_path!(), "a_playwright_cache_under_the_home_is_searched_too") {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["PLAYWRIGHT_BROWSERS_PATH", "HOME", "USERPROFILE"]);
        guard.remove("PLAYWRIGHT_BROWSERS_PATH");
        guard.set("HOME", &home.path().display().to_string());
        guard.set("USERPROFILE", &home.path().display().to_string());
        let d = home.path().join(".cache/ms-playwright/chromium-5/chrome-linux");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("chrome"), "").unwrap();
        assert_eq!(find_playwright_chromium(), Some(d.join("chrome")));
    }

    #[test]
    fn a_chrome_on_the_path_is_found_when_none_was_installed_for_the_engine() {
        if !own_process(module_path!(), "a_chrome_on_the_path_is_found_when_none_was_installed_for_the_engine") {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["PATH", "HOME", "USERPROFILE", "PUPPETEER_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH"]);
        guard.set("HOME", &home.path().display().to_string());
        guard.set("USERPROFILE", &home.path().display().to_string());
        guard.remove("PUPPETEER_CACHE_DIR");
        guard.remove("PLAYWRIGHT_BROWSERS_PATH");
        // `which` is found in the system folders; a stand-in `google-chrome` (the first name asked for) sits first on
        // the PATH, so it is found ahead of any Chrome the machine has installed (CI's runner has one).
        let chrome = exe(bin.path(), "google-chrome", "exit 0");
        path_with(&guard, bin.path());
        assert_eq!(find_chrome(), Some(chrome));
        // A cache folder that exists but holds no browser only warns; the search goes on.
        std::fs::create_dir_all(home.path().join(".agent-browser/browsers")).unwrap();
        assert_eq!(find_chrome().map(|p| p.file_name().unwrap().to_owned()), Some("google-chrome".into()));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod named_profile_tests {
    use super::*;
    use crate::test_utils::EnvGuard;

    /// A Chrome user-data folder holding the given (directory, display name) profiles, each with a crashed-exit Preferences.
    fn user_data(dir: &Path, profiles: &[(&str, &str)]) {
        let cache: serde_json::Map<String, serde_json::Value> =
            profiles.iter().map(|(d, n)| (d.to_string(), serde_json::json!({ "name": n }))).collect();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("Local State"), serde_json::json!({ "profile": { "info_cache": cache } }).to_string()).unwrap();
        for (d, _) in profiles {
            std::fs::create_dir_all(dir.join(d).join("Cache")).unwrap();
            std::fs::write(dir.join(d).join("Cookies"), d).unwrap();
            std::fs::write(dir.join(d).join("Preferences"), r#"{"profile":{"exit_type":"Crashed"}}"#).unwrap();
        }
    }

    #[test]
    fn profiles_are_listed_by_directory_with_their_display_names() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_chrome_profiles(dir.path()).is_empty(), "no Local State");
        std::fs::write(dir.path().join("Local State"), "{oops").unwrap();
        assert!(list_chrome_profiles(dir.path()).is_empty(), "unreadable Local State");
        std::fs::write(dir.path().join("Local State"), r#"{"profile":{"info_cache":[]}}"#).unwrap();
        assert!(list_chrome_profiles(dir.path()).is_empty(), "an info_cache that is no object");
        std::fs::write(dir.path().join("Local State"), r#"{"profile":{"info_cache":{"Profile 2":{"name":"Work"},"Default":{}}}}"#).unwrap();
        let got: Vec<(String, String)> = list_chrome_profiles(dir.path()).into_iter().map(|p| (p.directory, p.name)).collect();
        assert_eq!(got, [("Default".into(), "Default".into()), ("Profile 2".into(), "Work".into())], "sorted; a missing name is the directory's");
    }

    #[test]
    fn a_profile_name_resolves_by_directory_then_display_name_then_either_in_any_case() {
        let dir = tempfile::tempdir().unwrap();
        user_data(dir.path(), &[("Default", "Person 1"), ("Profile 1", "Work"), ("Profile 2", "work")]);
        assert_eq!(resolve_chrome_profile(dir.path(), "Profile 1").unwrap(), "Profile 1");
        assert_eq!(resolve_chrome_profile(dir.path(), "person 1").unwrap(), "Default");
        assert_eq!(resolve_chrome_profile(dir.path(), "DEFAULT").unwrap(), "Default");
        let ambiguous = resolve_chrome_profile(dir.path(), "WORK").unwrap_err();
        assert!(ambiguous.starts_with("Ambiguous profile name \"WORK\"") && ambiguous.contains("Profile 1 (Work)") && ambiguous.contains("Profile 2 (work)"), "{ambiguous}");
        let missing = resolve_chrome_profile(dir.path(), "Nobody").unwrap_err();
        assert!(missing.starts_with("Chrome profile \"Nobody\" not found. Available profiles:\n  Default (Person 1)"), "{missing}");
        let empty = tempfile::tempdir().unwrap();
        assert!(resolve_chrome_profile(empty.path(), "x").unwrap_err().starts_with("No Chrome profiles found in "));
    }

    #[test]
    fn a_profile_copy_holds_the_profile_without_its_caches_and_says_it_closed_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        user_data(dir.path(), &[("Default", "Person 1")]);
        let copy = copy_chrome_profile(dir.path(), "Default").unwrap();
        assert!(copy.join("Local State").is_file());
        assert_eq!(std::fs::read_to_string(copy.join("Default/Cookies")).unwrap(), "Default");
        assert!(!copy.join("Default/Cache").exists());
        let prefs: serde_json::Value = serde_json::from_slice(&std::fs::read(copy.join("Default/Preferences")).unwrap()).unwrap();
        assert_eq!(prefs["profile"]["exit_type"], "Normal");
        std::fs::remove_dir_all(&copy).unwrap();

        let err = copy_chrome_profile(dir.path(), "Profile 9").unwrap_err();
        assert!(err.starts_with("Profile directory not found: ") && err.ends_with("Profile 9"), "{err}");
    }

    #[test]
    fn a_launch_with_no_chrome_anywhere_lists_where_it_looked() {
        if !own_process(module_path!(), "a_launch_with_no_chrome_anywhere_lists_where_it_looked") {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let empty = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["PATH", "HOME", "USERPROFILE", "PUPPETEER_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH"]);
        for v in ["HOME", "USERPROFILE"] {
            guard.set(v, &home.path().display().to_string());
        }
        guard.set("PATH", &empty.path().display().to_string());
        guard.remove("PUPPETEER_CACHE_DIR");
        guard.remove("PLAYWRIGHT_BROWSERS_PATH");
        let err = launch_chrome(&LaunchOptions::default()).err().expect("no browser to launch");
        assert!(err.starts_with("Chrome not found. Checked:\n  - agent-browser cache: "), "{err}");
        assert!(err.contains(&home.path().join(".agent-browser/browsers").display().to_string()), "{err}");
        assert!(err.ends_with("Run `agent-browser install` to download Chrome, or use --executable-path."), "{err}");
    }

    #[test]
    fn a_profile_named_with_no_chrome_user_data_folder_says_to_give_a_path() {
        if !own_process(module_path!(), "a_profile_named_with_no_chrome_user_data_folder_says_to_give_a_path") {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME", "USERPROFILE"]);
        for v in ["HOME", "USERPROFILE"] {
            guard.set(v, &home.path().display().to_string());
        }
        let options = LaunchOptions {
            executable_path: Some(fake_chrome(fixture.path(), "exec sleep 60").display().to_string()),
            profile: Some("Default".into()),
            ..Default::default()
        };
        let err = launch_chrome(&options).err().unwrap();
        assert!(err.starts_with("No Chrome user data directory found. Cannot resolve profile name."), "{err}");
    }

    #[test]
    fn a_profile_named_runs_in_a_copy_that_goes_with_its_browser() {
        if !own_process(module_path!(), "a_profile_named_runs_in_a_copy_that_goes_with_its_browser") {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME", "USERPROFILE"]);
        for v in ["HOME", "USERPROFILE"] {
            guard.set(v, &home.path().display().to_string());
        }
        user_data(&home.path().join(".config/google-chrome"), &[("Default", "Person 1"), ("Profile 1", "Work")]);
        let options = LaunchOptions {
            executable_path: Some(fake_chrome(fixture.path(), "exec sleep 60").display().to_string()),
            profile: Some("work".into()),
            ..Default::default()
        };
        let chrome = launch_chrome(&options).unwrap();
        let copy = chrome.temp_user_data_dir.clone().expect("the copy is the browser's to clean up");
        assert!(copy.starts_with(std::env::temp_dir()) && copy.join("Profile 1/Cookies").is_file());
        assert!(!copy.join("Default/Cookies").exists(), "only the profile asked for is copied");
        let args = std::fs::read_to_string(copy.join("args")).unwrap();
        assert!(args.lines().any(|a| a == "--profile-directory=Profile 1"), "{args}");
        assert!(args.lines().any(|a| a == format!("--user-data-dir={}", copy.display())), "{args}");
        drop(chrome);
        assert!(!copy.exists(), "the copy goes with its browser");
    }

    #[test]
    fn a_profile_name_no_profile_answers_to_fails_the_launch_before_any_browser_starts() {
        if !own_process(module_path!(), "a_profile_name_no_profile_answers_to_fails_the_launch_before_any_browser_starts") {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME", "USERPROFILE"]);
        for v in ["HOME", "USERPROFILE"] {
            guard.set(v, &home.path().display().to_string());
        }
        user_data(&home.path().join(".config/google-chrome"), &[("Default", "Person 1")]);
        let options = LaunchOptions {
            executable_path: Some(fake_chrome(fixture.path(), "exec sleep 60").display().to_string()),
            profile: Some("Nobody".into()),
            ..Default::default()
        };
        let err = launch_chrome(&options).err().unwrap();
        assert!(err.starts_with("Chrome profile \"Nobody\" not found."), "{err}");
        assert!(!fixture.path().join("args").exists(), "the browser was never started");
    }

    #[test]
    fn a_browser_that_fails_every_attempt_is_tried_three_times_and_its_profile_copy_removed() {
        if !own_process(module_path!(), "a_browser_that_fails_every_attempt_is_tried_three_times_and_its_profile_copy_removed") {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let fixture = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&["HOME", "USERPROFILE"]);
        for v in ["HOME", "USERPROFILE"] {
            guard.set(v, &home.path().display().to_string());
        }
        user_data(&home.path().join(".config/google-chrome"), &[("Default", "Person 1")]);
        let executable = fixture.path().join("chrome");
        let log = fixture.path().join("runs");
        std::fs::write(
            &executable,
            format!("#!/bin/sh\nfor arg do case \"$arg\" in --user-data-dir=*) echo \"${{arg#*=}}\" >> {} ;; esac; done\necho 'FATAL: nope' >&2\nexit 5\n", log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let options = LaunchOptions { executable_path: Some(executable.display().to_string()), profile: Some("Default".into()), ..Default::default() };
        let err = launch_chrome(&options).err().unwrap();
        assert!(err.contains("FATAL: nope") || err.contains("pipe"), "{err}");
        let runs = std::fs::read_to_string(&log).unwrap();
        let dirs: Vec<&str> = runs.lines().collect();
        assert_eq!(dirs.len(), 3, "three attempts: {runs}");
        assert!(dirs.iter().all(|d| *d == dirs[0]), "every attempt runs in the same copy");
        assert!(!Path::new(dirs[0]).exists(), "the copy is removed when every attempt has failed");
    }
}
