//! `unb challenge type` run as an agent's shell runs it: what it types is read from stdin and is never among the
//! process's arguments, where any program can read it while unb runs, nor in what unb prints. Words given on the
//! command line are refused before unb reads anything or reaches the node.
#![cfg(unix)]

use std::io::Write;
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SECRET: &str = "s3cr3t-4417";

fn unb(port: u16, args: &[&str]) -> Command {
    let home = std::env::temp_dir().join(format!("unbrowse-cli-challenge-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_unb"));
    cmd.args(args)
        .env("UNBROWSE_HOME", &home)
        .env("UNBROWSE_NODE", format!("http://127.0.0.1:{port}"))
        .env("UNBROWSE_AGENT_TOKEN", "00".repeat(32))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// The text typed is in no argument of the running process and in nothing it prints, though it was read: unb is
/// held at the node (which never answers) after it has read stdin, and its arguments are read then.
#[test]
fn challenge_text_is_absent_from_process_arguments_and_output() {
    let node = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = node.local_addr().unwrap().port();
    let mut child = unb(port, &["challenge", "type", "--text", "-"]).spawn().unwrap();
    child.stdin.take().unwrap().write_all(SECRET.as_bytes()).unwrap();
    // unb reads stdin before it reaches the node: once it has connected, the text has been read.
    node.set_nonblocking(true).unwrap();
    let start = Instant::now();
    let held = loop {
        if let Ok((s, _)) = node.accept() {
            break s;
        }
        assert!(start.elapsed() < Duration::from_secs(60), "unb never reached the node");
        std::thread::sleep(Duration::from_millis(20));
    };
    let ps = Command::new("ps").args(["-ww", "-o", "args=", "-p", &child.id().to_string()]).output().unwrap();
    let args = String::from_utf8_lossy(&ps.stdout).to_string();
    assert!(args.contains("challenge"), "ps read the process: {args}");
    assert!(!args.contains(SECRET), "the typed text is in the process arguments: {args}");
    let _ = child.kill();
    drop(held);
    let out = child.wait_with_output().unwrap();
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(!said.contains(SECRET), "unb printed the typed text: {said}");
}

/// Words on the command line are refused, with why, before unb reads stdin or reaches the node.
#[test]
fn challenge_text_on_the_command_line_is_refused_before_anything_is_sent() {
    let node = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = node.local_addr().unwrap().port();
    let out = unb(port, &["challenge", "type", "--text", SECRET]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("stdin") && err.contains("--text -"), "{err}");
    assert!(!err.contains(SECRET), "{err}");
    node.set_nonblocking(true).unwrap();
    assert!(node.accept().is_err(), "unb reached the node");
}
