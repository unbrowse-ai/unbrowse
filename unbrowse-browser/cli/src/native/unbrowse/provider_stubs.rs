//! Cloud browser providers talking to local stub servers: what each one sends
//! (method, path, key header, body from the env) and what it hands back.

use crate::native::providers::{
    close_provider_session, close_provider_session_with_plugins, connect_provider,
    connect_provider_with_plugins, ProviderSession,
};
use crate::session_settings::Running;
use crate::test_utils::EnvGuard;
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

type Served = std::thread::JoinHandle<String>;

fn accept(listener: &TcpListener) -> Option<std::net::TcpStream> {
    listener.set_nonblocking(true).unwrap();
    let until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < until {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                return Some(stream);
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    None
}

/// Reads one request (head and body) off the stream, as text.
fn read_request(stream: &std::net::TcpStream) -> String {
    let mut reader = std::io::BufReader::new(stream);
    let mut request = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return request;
        }
        request.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let length = request
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).unwrap();
    request.push_str(std::str::from_utf8(&bytes).unwrap());
    request
}

/// One-shot HTTP server: answers the first request with `status` and `body`
/// and returns the request it saw.
fn stub(status: u16, body: &str) -> (String, Served) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let body = body.to_string();
    let served = std::thread::spawn(move || {
        let Some(mut stream) = accept(&listener) else {
            return String::new();
        };
        let request = read_request(&stream);
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        request
    });
    (base, served)
}

/// A proxy that refuses every CONNECT and reports the request line it got.
fn refusing_proxy() -> (String, Served) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let served = std::thread::spawn(move || {
        let Some(mut stream) = accept(&listener) else {
            return String::new();
        };
        let request = read_request(&stream);
        let _ = stream
            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        request
    });
    (base, served)
}

fn header(request: &str, name: &str) -> Option<String> {
    request.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

fn body_of(request: &str) -> Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

async fn connect(name: &str) -> Result<crate::native::providers::ProviderConnection, String> {
    connect_provider_with_plugins(name, &[], &Running::from_env()).await
}

const BROWSERLESS_VARS: [&str; 5] = [
    "BROWSERLESS_API_KEY",
    "BROWSERLESS_API_URL",
    "BROWSERLESS_BROWSER_TYPE",
    "BROWSERLESS_TTL",
    "BROWSERLESS_STEALTH",
];

fn browserless_env() -> EnvGuard<'static> {
    let guard = EnvGuard::new(&BROWSERLESS_VARS);
    for name in BROWSERLESS_VARS {
        guard.remove(name);
    }
    guard.set("BROWSERLESS_API_KEY", "bl-key");
    guard
}

const KERNEL_VARS: [&str; 7] = [
    "KERNEL_API_KEY",
    "KERNEL_ENDPOINT",
    "KERNEL_PROFILE_NAME",
    "KERNEL_PROFILE_SAVE_CHANGES",
    "KERNEL_HEADLESS",
    "KERNEL_STEALTH",
    "KERNEL_TIMEOUT_SECONDS",
];

fn kernel_env() -> EnvGuard<'static> {
    let guard = EnvGuard::new(&KERNEL_VARS);
    for name in KERNEL_VARS {
        guard.remove(name);
    }
    guard
}

#[tokio::test]
async fn browserless_asks_its_api_url_for_a_session_with_the_ttl_and_stealth_from_the_env() {
    let guard = browserless_env();
    let (base, served) = stub(
        200,
        r#"{"connect":"wss://prod.example/cdp?x=1","stop":"https://prod.example/stop/abc"}"#,
    );
    guard.set("BROWSERLESS_API_URL", &base);
    guard.set("BROWSERLESS_BROWSER_TYPE", "chrome");
    guard.set("BROWSERLESS_TTL", "12345");
    guard.set("BROWSERLESS_STEALTH", "false");

    let connection = connect("Browserless").await.unwrap();
    assert_eq!(connection.ws_url, "wss://prod.example/cdp?x=1");
    assert!(!connection.direct_page);
    assert!(connection.metadata.is_none());
    let session = connection.session.unwrap();
    assert_eq!(session.provider, "browserless");
    assert_eq!(session.session_id, "https://prod.example/stop/abc");

    let request = served.join().unwrap();
    assert!(
        request.starts_with("POST /session?token=bl-key HTTP/1.1"),
        "{request}"
    );
    assert_eq!(
        header(&request, "content-type").as_deref(),
        Some("application/json")
    );
    assert_eq!(
        body_of(&request),
        json!({"ttl": 12345, "stealth": false, "browser": "chrome"})
    );
}

#[tokio::test]
async fn browserless_defaults_to_chromium_stealth_and_a_five_minute_ttl_and_trims_the_url_slash() {
    let guard = browserless_env();
    let (base, served) = stub(200, r#"{"connect":"wss://h/c","stop":"https://h/s"}"#);
    guard.set("BROWSERLESS_API_URL", &format!("{base}/"));
    guard.set("BROWSERLESS_TTL", "not-a-number");

    let (url, session) = {
        let connection = connect_provider("browserless").await.unwrap();
        (connection.ws_url, connection.session.unwrap())
    };
    assert_eq!(url, "wss://h/c");
    assert_eq!(session.session_id, "https://h/s");
    let request = served.join().unwrap();
    assert!(request.starts_with("POST /session?token=bl-key HTTP/1.1"));
    assert_eq!(
        body_of(&request),
        json!({"ttl": 300000, "stealth": true, "browser": "chromium"})
    );
}

#[tokio::test]
async fn browserless_stealth_one_and_upper_case_true_both_switch_stealth_on() {
    let guard = browserless_env();
    for value in ["1", "TRUE"] {
        let (base, served) = stub(200, r#"{"connect":"c","stop":"s"}"#);
        guard.set("BROWSERLESS_API_URL", &base);
        guard.set("BROWSERLESS_STEALTH", value);
        connect("browserless").await.unwrap();
        assert_eq!(body_of(&served.join().unwrap())["stealth"], json!(true));
    }
    let (base, served) = stub(200, r#"{"connect":"c","stop":"s"}"#);
    guard.set("BROWSERLESS_API_URL", &base);
    guard.set("BROWSERLESS_STEALTH", "off");
    connect("browserless").await.unwrap();
    assert_eq!(body_of(&served.join().unwrap())["stealth"], json!(false));
}

#[tokio::test]
async fn browserless_refuses_an_unsupported_browser_type_before_it_sends_anything() {
    let guard = browserless_env();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    guard.set(
        "BROWSERLESS_API_URL",
        &format!("http://{}", listener.local_addr().unwrap()),
    );
    guard.set("BROWSERLESS_BROWSER_TYPE", "firefox");
    let attempt = tokio::time::timeout(Duration::from_secs(5), connect("browserless"))
        .await
        .expect("sent a request instead of refusing the browser type");
    let error = attempt.unwrap_err();
    assert_eq!(
        error,
        "BROWSERLESS_BROWSER_TYPE \"firefox\" is not supported. Only chromium, chrome are allowed."
    );
    assert!(listener.accept().is_err(), "a request reached the stub");
}

#[tokio::test]
async fn browserless_without_an_api_key_says_which_variable_is_missing() {
    let guard = browserless_env();
    guard.remove("BROWSERLESS_API_KEY");
    assert_eq!(
        connect("browserless").await.unwrap_err(),
        "BROWSERLESS_API_KEY environment variable is not set"
    );
}

#[tokio::test]
async fn browserless_turns_an_error_status_a_bad_body_and_missing_urls_into_errors() {
    let guard = browserless_env();
    let cases = [
        (
            503,
            "overloaded",
            "Browserless API error (503): overloaded".to_string(),
        ),
        (
            401,
            r#"{"error":"bad token"}"#,
            r#"Browserless API error (401): {"error":"bad token"}"#.to_string(),
        ),
        (
            200,
            "<html>",
            "Invalid Browserless response: expected value at line 1 column 1".to_string(),
        ),
        (
            200,
            r#"{"stop":"s"}"#,
            "Browserless response missing 'connect' URL".to_string(),
        ),
        (
            200,
            r#"{"connect":"c"}"#,
            "Browserless response missing 'stop' URL".to_string(),
        ),
    ];
    for (status, body, expected) in cases {
        let (base, served) = stub(status, body);
        guard.set("BROWSERLESS_API_URL", &base);
        assert_eq!(connect("browserless").await.unwrap_err(), expected);
        served.join().unwrap();
    }
}

#[tokio::test]
async fn browserless_closes_a_session_by_deleting_its_stop_url() {
    let _guard = browserless_env();
    let (base, served) = stub(200, "{}");
    let session = ProviderSession {
        provider: "browserless".to_string(),
        session_id: format!("{base}/stop/abc?token=bl-key"),
    };
    close_provider_session(&session).await.unwrap();
    let request = served.join().unwrap();
    assert!(
        request.starts_with("DELETE /stop/abc?token=bl-key HTTP/1.1"),
        "{request}"
    );
}

#[tokio::test]
async fn kernel_posts_headless_stealth_timeout_and_profile_from_the_env_with_its_bearer_key() {
    let guard = kernel_env();
    let (base, served) = stub(
        201,
        r#"{"session_id":"k-1","cdp_ws_url":"wss://kernel.example/cdp"}"#,
    );
    guard.set("KERNEL_ENDPOINT", &format!("{base}/"));
    guard.set("KERNEL_API_KEY", "kn-key");
    guard.set("KERNEL_HEADLESS", "false");
    guard.set("KERNEL_STEALTH", "TRUE");
    guard.set("KERNEL_TIMEOUT_SECONDS", "90");
    guard.set("KERNEL_PROFILE_NAME", "work");
    guard.set("KERNEL_PROFILE_SAVE_CHANGES", "1");

    let connection = connect("kernel").await.unwrap();
    assert_eq!(connection.ws_url, "wss://kernel.example/cdp");
    let session = connection.session.unwrap();
    assert_eq!(session.provider, "kernel");
    assert_eq!(session.session_id, "k-1");

    let request = served.join().unwrap();
    assert!(request.starts_with("POST /browsers HTTP/1.1"), "{request}");
    assert_eq!(
        header(&request, "authorization").as_deref(),
        Some("Bearer kn-key")
    );
    assert_eq!(
        header(&request, "content-type").as_deref(),
        Some("application/json")
    );
    assert_eq!(
        body_of(&request),
        json!({
            "headless": false,
            "stealth": true,
            "timeout_seconds": 90,
            "profile": {"name": "work", "save_changes": true}
        })
    );
}

#[tokio::test]
async fn kernel_without_a_key_or_settings_sends_no_auth_header_and_the_default_body() {
    let guard = kernel_env();
    let (base, served) = stub(200, r#"{"id":"k-2","connectUrl":"wss://k/c"}"#);
    guard.set("KERNEL_ENDPOINT", &base);
    guard.set("KERNEL_TIMEOUT_SECONDS", "soon");

    let connection = connect_provider("kernel").await.unwrap();
    assert_eq!(connection.ws_url, "wss://k/c");
    assert_eq!(connection.session.unwrap().session_id, "k-2");
    let request = served.join().unwrap();
    assert_eq!(header(&request, "authorization"), None);
    assert_eq!(
        body_of(&request),
        json!({"headless": true, "stealth": false, "timeout_seconds": 300})
    );
}

#[tokio::test]
async fn kernel_accepts_each_of_its_alternate_names_for_the_cdp_url() {
    let guard = kernel_env();
    for field in ["connectUrl", "connect_url", "cdpUrl", "cdp_url"] {
        let (base, served) = stub(200, &json!({"id": "k", field: "wss://alt/cdp"}).to_string());
        guard.set("KERNEL_ENDPOINT", &base);
        let connection = connect("kernel").await.unwrap();
        assert_eq!(connection.ws_url, "wss://alt/cdp", "{field}");
        served.join().unwrap();
    }
    let (base, served) = stub(
        200,
        r#"{"cdp_ws_url":"wss://first","connectUrl":"wss://second"}"#,
    );
    guard.set("KERNEL_ENDPOINT", &base);
    let connection = connect("kernel").await.unwrap();
    assert_eq!(connection.ws_url, "wss://first");
    assert_eq!(connection.session.unwrap().session_id, "");
    served.join().unwrap();
}

#[tokio::test]
async fn kernel_turns_an_error_status_a_bad_body_and_a_missing_url_into_errors() {
    let guard = kernel_env();
    let cases = [
        (500, "boom", "Kernel API error (500): boom".to_string()),
        (
            200,
            "<html>",
            "Invalid Kernel response: expected value at line 1 column 1".to_string(),
        ),
        (
            200,
            r#"{"session_id":"x"}"#,
            "Kernel response missing cdp_ws_url, connectUrl, connect_url, cdpUrl, or cdp_url"
                .to_string(),
        ),
    ];
    for (status, body, expected) in cases {
        let (base, served) = stub(status, body);
        guard.set("KERNEL_ENDPOINT", &base);
        assert_eq!(connect("kernel").await.unwrap_err(), expected);
        served.join().unwrap();
    }
}

#[tokio::test]
async fn kernel_closes_a_session_with_a_bearer_delete_on_its_endpoint() {
    let guard = kernel_env();
    let (base, served) = stub(200, "{}");
    guard.set("KERNEL_ENDPOINT", &format!("{base}/"));
    guard.set("KERNEL_API_KEY", "kn-key");
    let session = ProviderSession {
        provider: "kernel".to_string(),
        session_id: "k-9".to_string(),
    };
    close_provider_session_with_plugins(&session, &[])
        .await
        .unwrap();
    let request = served.join().unwrap();
    assert!(
        request.starts_with("DELETE /browsers/k-9 HTTP/1.1"),
        "{request}"
    );
    assert_eq!(
        header(&request, "authorization").as_deref(),
        Some("Bearer kn-key")
    );
}

#[tokio::test]
async fn closing_a_kernel_or_browserbase_session_without_a_key_sends_nothing_and_succeeds() {
    let mut names = KERNEL_VARS.to_vec();
    names.push("BROWSERBASE_API_KEY");
    let guard = EnvGuard::new(&names);
    for name in &names {
        guard.remove(name);
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    guard.set(
        "KERNEL_ENDPOINT",
        &format!("http://{}", listener.local_addr().unwrap()),
    );
    for provider in ["kernel", "browserbase", "something-else"] {
        let session = ProviderSession {
            provider: provider.to_string(),
            session_id: "s".to_string(),
        };
        close_provider_session(&session).await.unwrap();
    }
    assert!(listener.accept().is_err(), "a request reached the stub");
}

#[tokio::test]
async fn browserbase_and_browser_use_without_a_key_say_which_variable_is_missing() {
    let guard = EnvGuard::new(&["BROWSERBASE_API_KEY", "BROWSER_USE_API_KEY"]);
    guard.remove("BROWSERBASE_API_KEY");
    guard.remove("BROWSER_USE_API_KEY");
    assert_eq!(
        connect("browserbase").await.unwrap_err(),
        "BROWSERBASE_API_KEY environment variable is not set"
    );
    for name in ["browser-use", "BrowserUse"] {
        assert_eq!(
            connect(name).await.unwrap_err(),
            "BROWSER_USE_API_KEY environment variable is not set"
        );
    }
}

#[tokio::test]
async fn an_unknown_provider_lists_the_supported_ones() {
    let error = connect("nope").await.unwrap_err();
    assert_eq!(
        error,
        "Unknown provider 'nope'. Supported: browserbase, browserless, browser-use, kernel, agentcore, or a configured plugin with browser.provider"
    );
}

const AGENTCORE_VARS: [&str; 17] = [
    "AGENTCORE_REGION",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AGENTCORE_BROWSER_ID",
    "AGENTCORE_SESSION_TIMEOUT",
    "AGENTCORE_PROFILE_ID",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "PATH",
];

fn agentcore_env() -> EnvGuard<'static> {
    let guard = EnvGuard::new(&AGENTCORE_VARS);
    for name in AGENTCORE_VARS {
        if name != "PATH" {
            guard.remove(name);
        }
    }
    guard
}

fn route_https_through(guard: &EnvGuard, proxy: &str) {
    guard.set("HTTPS_PROXY", proxy);
    guard.set("https_proxy", proxy);
}

#[tokio::test]
async fn agentcore_signs_in_with_env_credentials_and_dials_the_host_of_its_region() {
    let guard = agentcore_env();
    let (proxy, served) = refusing_proxy();
    route_https_through(&guard, &proxy);
    guard.set("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    guard.set("AWS_SECRET_ACCESS_KEY", "secret");
    guard.set("AWS_SESSION_TOKEN", "token");
    guard.set("AGENTCORE_REGION", "eu-west-2");
    guard.set("AWS_REGION", "ap-south-1");

    let error = connect("agentcore").await.unwrap_err();
    assert!(error.starts_with("AgentCore request failed: "), "{error}");
    let request = served.join().unwrap();
    assert!(
        request.starts_with("CONNECT bedrock-agentcore.eu-west-2.amazonaws.com:443 HTTP/1.1"),
        "{request}"
    );
}

#[tokio::test]
async fn agentcore_takes_its_region_from_aws_region_then_aws_default_region_then_us_east_1() {
    let guard = agentcore_env();
    guard.set("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    guard.set("AWS_SECRET_ACCESS_KEY", "secret");
    let steps: [(&[(&str, &str)], &str); 3] = [
        (
            &[
                ("AWS_REGION", "ap-south-1"),
                ("AWS_DEFAULT_REGION", "sa-east-1"),
            ],
            "ap-south-1",
        ),
        (&[("AWS_DEFAULT_REGION", "sa-east-1")], "sa-east-1"),
        (&[], "us-east-1"),
    ];
    for (vars, region) in steps {
        guard.remove("AWS_REGION");
        guard.remove("AWS_DEFAULT_REGION");
        for (name, value) in vars {
            guard.set(name, value);
        }
        let (proxy, served) = refusing_proxy();
        route_https_through(&guard, &proxy);
        connect("agentcore").await.unwrap_err();
        let request = served.join().unwrap();
        assert!(
            request.starts_with(&format!(
                "CONNECT bedrock-agentcore.{region}.amazonaws.com:443 HTTP/1.1"
            )),
            "{region}: {request}"
        );
    }
}

#[cfg(unix)]
fn fake_aws(dir: &std::path::Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("aws");
    std::fs::write(&path, script).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn agentcore_asks_the_aws_cli_for_the_profile_credentials_when_the_env_has_none() {
    let guard = agentcore_env();
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("args.txt");
    fake_aws(
        dir.path(),
        &format!(
            "#!/bin/sh\nprintf '%s ' \"$@\" > '{}'\nprintf 'export AWS_ACCESS_KEY_ID=AKIDCLI\\nexport AWS_SECRET_ACCESS_KEY=clisecret\\nexport AWS_SESSION_TOKEN=clitoken\\n'\n",
            log.display()
        ),
    );
    guard.set("PATH", &dir.path().to_string_lossy());
    guard.set("AWS_PROFILE", "dev");
    let (proxy, served) = refusing_proxy();
    route_https_through(&guard, &proxy);

    let error = connect("agentcore").await.unwrap_err();
    assert!(error.starts_with("AgentCore request failed: "), "{error}");
    assert_eq!(
        std::fs::read_to_string(&log).unwrap(),
        "configure export-credentials --format env --profile dev "
    );
    assert!(served
        .join()
        .unwrap()
        .starts_with("CONNECT bedrock-agentcore.us-east-1"));
}

#[cfg(unix)]
#[tokio::test]
async fn agentcore_reports_a_missing_failing_or_unreadable_aws_cli() {
    let guard = agentcore_env();
    let dir = tempfile::tempdir().unwrap();
    guard.set("PATH", &dir.path().to_string_lossy());
    let error = connect("agentcore").await.unwrap_err();
    assert!(
        error.starts_with("Failed to run aws CLI: ")
            && error.ends_with(". Install AWS CLI or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY"),
        "{error}"
    );

    fake_aws(dir.path(), "#!/bin/sh\necho 'token expired' >&2\nexit 3\n");
    assert_eq!(
        connect("agentcore").await.unwrap_err(),
        "AWS CLI failed: token expired. Run 'aws sso login' or set credentials"
    );

    fake_aws(
        dir.path(),
        "#!/bin/sh\nprintf 'export AWS_ACCESS_KEY_ID=only-the-key\\n'\n",
    );
    assert_eq!(
        connect("agentcore").await.unwrap_err(),
        "Failed to parse credentials from AWS CLI output"
    );
}

#[tokio::test]
async fn agentcore_close_dials_the_regional_host_and_never_fails_the_caller() {
    let guard = agentcore_env();
    guard.set("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    guard.set("AWS_SECRET_ACCESS_KEY", "secret");
    guard.set("AGENTCORE_REGION", "us-west-2");
    guard.set("AGENTCORE_BROWSER_ID", "custom.browser");
    let (proxy, served) = refusing_proxy();
    route_https_through(&guard, &proxy);
    let session = ProviderSession {
        provider: "agentcore".to_string(),
        session_id: "sess-1".to_string(),
    };
    close_provider_session(&session).await.unwrap();
    let request = served.join().unwrap();
    assert!(
        request.starts_with("CONNECT bedrock-agentcore.us-west-2.amazonaws.com:443 HTTP/1.1"),
        "{request}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agentcore_close_without_credentials_sends_nothing_and_still_succeeds() {
    let guard = agentcore_env();
    let dir = tempfile::tempdir().unwrap();
    guard.set("PATH", &dir.path().to_string_lossy());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    route_https_through(
        &guard,
        &format!("http://{}", listener.local_addr().unwrap()),
    );
    let session = ProviderSession {
        provider: "agentcore".to_string(),
        session_id: "sess-1".to_string(),
    };
    close_provider_session(&session).await.unwrap();
    assert!(listener.accept().is_err(), "a request reached the proxy");
}
