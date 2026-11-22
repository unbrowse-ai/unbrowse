//! The node run from a shell as a process of its own: `unbrowse-node` with no words, in a home of its own
//! (`UNBROWSE_HOME`) on a free port, with no browser, no screen, no chain and no network. Each test starts the real program, waits
//! for it to answer on its port, asks what an owner would ask of it, and stops it: a stop is a SIGTERM, as a service stop sends, and
//! the child is killed if a test fails before it.
//!
//! A test build is a dev build, which keeps its root key in a file (`devnet/root.key`), so these tests never touch the
//! system's keystore.
//!
//! Linux only: which process holds a port, and what runs beneath a node, are read from `/proc`.
#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The node program these tests run.
const NODE: &str = env!("CARGO_BIN_EXE_unbrowse-node");

/// The line the node prints once it holds its port (and again each time a restart starts it over).
const LISTENING: &str = "agents and the window reach this node at 127.0.0.1:";

/// A home for one test, with the root key a dev node keeps in a file.
fn home(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("unbrowse-cli-node-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("devnet")).unwrap();
    std::fs::write(d.join("devnet/root.key"), "11".repeat(32)).unwrap();
    d
}

/// A port nothing holds now.
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
}

/// `unbrowse-node <args>` set up to run in `home` on `port`: no browser, no chain, no telemetry, no reports, no update
/// registry, so nothing leaves the machine and nothing outside the home is read.
fn command(home: &Path, port: u16, args: &[&str]) -> Command {
    let mut cmd = Command::new(NODE);
    cmd.args(args)
        .env_remove("UNBROWSE_FROM")
        .env("UNBROWSE_HOME", home)
        .env("HOME", home)
        .env("UNBROWSE_PORT", port.to_string())
        .env("UNBROWSE_PEER_PORT", free_port().to_string())
        .env("UNBROWSE_CHAIN", "devnet")
        .env("UNBROWSE_DEVNET_PORT", "1")
        .env("UNBROWSE_TELEMETRY", "0")
        .env("UNBROWSE_REPORTS", "0")
        .env("UNBROWSE_REGISTRY", "http://127.0.0.1:1")
        .env("UNBROWSE_BROWSER", home.join("no-browser"))
        .env("UNBROWSE_PASSKEYS", "0")
        // No screen: the node asks the owner on a terminal, as on a server, never in a dialog on the test machine's.
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY");
    cmd
}

/// A node this test started: its child, what it has printed so far, and the port it was given. Dropping it kills the
/// child, so a failed assert leaves no node behind.
struct Running {
    child: Child,
    port: u16,
    home: PathBuf,
    stderr: Arc<Mutex<Vec<String>>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Running {
    /// Starts the node with `args` and `env` beyond the usual, and waits until it answers on its port.
    fn start(home: &Path, args: &[&str], env: &[(&str, &str)]) -> Running {
        let port = free_port();
        let mut cmd = command(home, port, args);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let (lines, pipe) = (stderr.clone(), child.stderr.take().unwrap());
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                lines.lock().unwrap().push(line);
            }
        });
        let mut node = Running { child, port, home: home.to_path_buf(), stderr };
        node.wait_answering();
        node
    }

    /// What the node has printed on stderr so far.
    fn said(&self) -> Vec<String> {
        self.stderr.lock().unwrap().clone()
    }

    /// Waits until the node answers on its port, or fails with what it said if it ended first or never did.
    fn wait_answering(&mut self) {
        let until = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!("the node ended with {status} before it answered: {:#?}", self.said());
            }
            if answers(self.port) {
                return;
            }
            assert!(Instant::now() < until, "the node never answered on port {}: {:#?}", self.port, self.said());
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Waits until the node has printed the listening line `times` times, which a restart's second start does.
    fn wait_listening(&self, times: usize) {
        let until = Instant::now() + Duration::from_secs(120);
        while self.said().iter().filter(|l| l.contains(LISTENING)).count() < times {
            assert!(Instant::now() < until, "the node never said it listens {times} times: {:#?}", self.said());
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Stops the node as the system does a service (SIGTERM, which the node answers by leaving the peer network and exiting
    /// cleanly), and waits for it to end.
    fn stop(mut self) {
        let sent = Command::new("kill").args(["-TERM", &self.child.id().to_string()]).status().unwrap();
        assert!(sent.success());
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "a stop the system asks for is a clean one: {status}: {:#?}", self.said());
                return;
            }
            assert!(Instant::now() < until, "the node never stopped when asked: {:#?}", self.said());
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// Whether something answers HTTP on `port`: the node's health probe, which asks for no key.
fn answers(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)) else { return false };
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    if s.write_all(format!("GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes()).is_err() {
        return false;
    }
    let mut got = String::new();
    let _ = s.read_to_string(&mut got);
    got.starts_with("HTTP/1.1 ")
}

/// The pids holding `port` open for listening, found as the system lists them (`/proc/net/tcp` names the socket, each
/// process's `fd` folder names the sockets it holds).
fn listeners(port: u16) -> Vec<u32> {
    let table = std::fs::read_to_string("/proc/net/tcp").unwrap();
    let want = format!(":{port:04X}");
    let inodes: Vec<String> = table
        .lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            (f.get(1)?.ends_with(&want) && *f.get(3)? == "0A").then(|| f[9].to_string())
        })
        .collect();
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else { continue };
        let holds = fds.flatten().any(|fd| {
            std::fs::read_link(fd.path()).ok().and_then(|t| t.to_str().map(str::to_string)).is_some_and(|t| inodes.iter().any(|i| t == format!("socket:[{i}]")))
        });
        if holds {
            pids.push(pid);
        }
    }
    pids.sort_unstable();
    pids
}

/// The pids of processes that run `unbrowse-node` in `home`, whatever started them.
fn nodes_of(home: &Path) -> Vec<u32> {
    let want = format!("UNBROWSE_HOME={}", home.display());
    let mut pids = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(env) = std::fs::read(entry.path().join("environ")) else { continue };
        let ours = env.split(|b| *b == 0).any(|v| v == want.as_bytes());
        let program = std::fs::read_link(entry.path().join("exe")).ok();
        if ours && program.is_some_and(|p| p == Path::new(NODE)) {
            pids.push(pid);
        }
    }
    pids.sort_unstable();
    pids
}

/// The pids whose parent is `pid`.
fn children_of(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Some(child) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        // `pid (name) state ppid ...`: the name may hold spaces and brackets, so read after its last `)`.
        let rest = stat.rsplit_once(')').map(|(_, r)| r).unwrap_or_default();
        if rest.split_whitespace().nth(1).and_then(|p| p.parse::<u32>().ok()) == Some(pid) {
            out.push(child);
        }
    }
    out
}

/// The source tag the home kept, as `from.json` holds it.
fn kept_tag(home: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join("from.json")).ok()?).ok()?;
    v["from"].as_str().map(str::to_string)
}

/// The warning lines about a source tag.
fn tag_warnings(lines: &[String]) -> Vec<String> {
    lines.iter().filter(|l| l.contains("ignored: a source tag is")).cloned().collect()
}

/// C03: a source tag that is not one (`--from "Not A Tag"`) warns in one line and never stops the node: it answers on
/// its port, and no tag is kept.
#[test]
fn a_bad_source_tag_warns_once_and_the_node_still_starts() {
    let home = home("bad-flag");
    let node = Running::start(&home, &["--from", "Not A Tag"], &[]);
    assert!(answers(node.port), "the node starts whatever the tag");
    let said = node.said();
    let warned = tag_warnings(&said);
    assert_eq!(warned.len(), 1, "one warning, once: {said:#?}");
    assert!(warned[0].contains("--from \"Not A Tag\" ignored"), "{}", warned[0]);
    assert_eq!(said.iter().filter(|l| l.contains(LISTENING)).count(), 1, "{said:#?}");
    assert_eq!(kept_tag(&home), None, "a bad tag is never kept");
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// C03: the same for `UNBROWSE_FROM` set to something that is not a tag: one warning naming the variable, the node
/// starts.
#[test]
fn a_bad_source_tag_in_the_environment_warns_once_and_the_node_still_starts() {
    let home = home("bad-env");
    let node = Running::start(&home, &[], &[("UNBROWSE_FROM", "Me@Home")]);
    let said = node.said();
    let warned = tag_warnings(&said);
    assert_eq!(warned.len(), 1, "{said:#?}");
    assert!(warned[0].contains("UNBROWSE_FROM \"Me@Home\" ignored"), "{}", warned[0]);
    assert_eq!(kept_tag(&home), None);
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// C03: `--from` wins over `UNBROWSE_FROM`, the tag is kept in `from.json`, and the first tag a node was ever given
/// stays: a later start with another tag (flag, `--from=` form or environment) changes nothing.
#[test]
fn the_flag_beats_the_environment_and_the_node_keeps_the_first_tag_only() {
    let home = home("first-tag");
    let node = Running::start(&home, &["--from", "hn-e"], &[("UNBROWSE_FROM", "reddit")]);
    assert!(tag_warnings(&node.said()).is_empty(), "{:#?}", node.said());
    assert_eq!(kept_tag(&home).as_deref(), Some("hn-e"), "the flag won over the environment");
    node.stop();

    let node = Running::start(&home, &["--from=reddit"], &[]);
    assert_eq!(kept_tag(&home).as_deref(), Some("hn-e"), "a later flag never replaces the first tag");
    node.stop();

    let node = Running::start(&home, &[], &[("UNBROWSE_FROM", "x-launch")]);
    assert_eq!(kept_tag(&home).as_deref(), Some("hn-e"), "a later environment tag never replaces it either");
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// C03: the environment's tag alone is kept when no flag is given.
#[test]
fn the_environments_tag_is_kept_when_no_flag_is_given() {
    let home = home("env-tag");
    let node = Running::start(&home, &[], &[("UNBROWSE_FROM", "reddit")]);
    assert_eq!(kept_tag(&home).as_deref(), Some("reddit"));
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// C04: the CLI is the node. `unbrowse-node` with no words is the process that answers on the port: the pid holding
/// the port is the pid the test started, and it is running the `unbrowse-node` program itself, not a launcher or a
/// daemon it started.
#[test]
fn the_process_that_answers_on_the_port_is_the_one_started() {
    let home = home("is-the-node");
    let node = Running::start(&home, &[], &[]);
    assert_eq!(listeners(node.port), [node.child.id()], "the started process holds the port");
    assert_eq!(std::fs::read_link(format!("/proc/{}/exe", node.child.id())).unwrap(), Path::new(NODE));
    assert_eq!(nodes_of(&home), [node.child.id()], "no second node process in this home");
    assert!(children_of(node.child.id()).is_empty(), "no daemon or launcher beneath it: {:?}", children_of(node.child.id()));
    let (pid, port) = (node.child.id(), node.port);
    node.stop();
    assert!(!answers(port), "stopping the process stops the node: nothing was left running");
    assert!(listeners(port).is_empty());
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    let _ = std::fs::remove_dir_all(&home);
}

/// C06: `unbrowse-node restart` leaves one node holding the port. The node starts itself over in place (the same
/// process, running the program again), so the port is held by that one process before and after, no second node of
/// the home exists, and nothing runs beneath it.
#[test]
fn a_restart_leaves_one_node_holding_the_port_and_no_stray_process() {
    let home = home("restart");
    let node = Running::start(&home, &[], &[]);
    let pid = node.child.id();
    assert_eq!(listeners(node.port), [pid]);

    let out = command(&home, node.port, &["restart"]).output().unwrap();
    let (said, err) = (String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned());
    assert!(out.status.success(), "{said}{err}");
    assert!(said.contains("restarting into "), "{said}");
    assert!(said.contains(" once no call is under way"), "{said}");

    node.wait_listening(2);
    let mut node = node;
    node.wait_answering();
    assert!(node.child.try_wait().unwrap().is_none(), "the node is still the process the test started");
    assert_eq!(listeners(node.port), [pid], "one process holds the port, and it is the one that was there");
    assert_eq!(nodes_of(&home), [pid], "one node of this home runs, the old one is gone or is the new one");
    assert!(children_of(pid).is_empty(), "no stray process beneath it: {:?}", children_of(pid));
    assert!(node.said().iter().any(|l| l.contains("update: restarting into ")), "{:#?}", node.said());
    let port = node.port;
    node.stop();
    assert!(!answers(port) && listeners(port).is_empty() && nodes_of(&home).is_empty(), "nothing left after the stop");
    let _ = std::fs::remove_dir_all(&home);
}

/// `restart` with no node running says so and fails: it never starts one (a second node fights the first for the port).
#[test]
fn a_restart_with_no_node_running_says_so_and_starts_nothing() {
    let home = home("restart-none");
    let port = free_port();
    let out = command(&home, port, &["restart"]).output().unwrap();
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert_eq!(out.status.code(), Some(1), "{said}");
    assert!(said.contains("the node isn't running: `unbrowse start` starts it"), "{said}");
    assert!(nodes_of(&home).is_empty() && !answers(port));
    let out = command(&home, port, &["restart", "now"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage: unbrowse-node restart"));
    let _ = std::fs::remove_dir_all(&home);
}

/// What one run of `unbrowse-node <args>` did: its exit code, and what it printed.
struct Ran {
    code: Option<i32>,
    out: String,
    err: String,
}

/// Runs `unbrowse-node <args>` in `home` with no node running (the port is one nothing holds) and gives what it did.
fn run(home: &Path, args: &[&str]) -> Ran {
    let o = command(home, free_port(), args).stdin(Stdio::null()).output().unwrap();
    Ran { code: o.status.code(), out: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
}

/// Every word a shell can give the node as a command.
const COMMAND_WORDS: [&str; 31] = [
    "agent new", "agent token", "agent cap", "money", "earnings", "nodes", "browser", "vault", "terms", "checkout", "network", "remote", "coin", "max-fetch", "chain", "bounty",
    "domain", "passkey", "session", "wallet", "share", "sign-in", "onboard", "telemetry", "update", "restart", "reports", "passphrase", "confirm", "agent-user", "--help",
];

/// C02 (the node's part): `unbrowse-node --help`, `-h` and `help` say how to run the node and name every command the node
/// has, `money` and `domain` among them, and exit 0; none of them starts a node.
#[test]
fn help_names_every_command_the_node_runs_and_starts_no_node() {
    let home = home("help");
    for word in ["--help", "-h", "help"] {
        let r = run(&home, &[word]);
        assert_eq!(r.code, Some(0), "{word}: {}", r.err);
        assert!(r.out.starts_with("usage: unbrowse-node [--from <tag>]  run the node"), "{word}: {}", r.out);
        for c in COMMAND_WORDS {
            assert!(r.out.contains(c), "`{word}` doesn't name the command {c:?}: {}", r.out);
        }
        assert!(r.out.contains(&format!("one of: {}\n", COMMAND_WORDS.join(", "))), "{}", r.out);
    }
    assert!(nodes_of(&home).is_empty());
    let _ = std::fs::remove_dir_all(&home);
}

/// A word the node has no command for exits 2 naming the word and the usage, and starts no node (a second node fights the
/// first for the port); `agent` alone is not a command either.
#[test]
fn an_unknown_command_exits_2_with_the_usage_and_starts_no_node() {
    let home = home("unknown");
    for word in [&["bogus"][..], &["agent"], &["--frm", "hn"], &["--from", "hn", "wallet"], &["start"]] {
        let r = run(&home, word);
        assert_eq!(r.code, Some(2), "{word:?}: {}{}", r.out, r.err);
        assert!(r.err.starts_with(&format!("unbrowse-node: no command {:?}\n", word[0])), "{}", r.err);
        assert!(r.err.contains("usage: unbrowse-node [--from <tag>]") && r.err.contains("agent new, agent token"), "{}", r.err);
        assert!(r.out.is_empty(), "{}", r.out);
    }
    assert!(nodes_of(&home).is_empty());
    let _ = std::fs::remove_dir_all(&home);
}

/// `learn-walk` is the lab's measure, not an owner's command: without `UNBROWSE_LAB=1` it is a word the node doesn't
/// have (exit 2, the usage, no node started); with it, given the wrong words, it says how to use it and exits 2.
#[test]
fn learn_walk_runs_only_in_the_lab() {
    let home = home("lab");
    let o = command(&home, free_port(), &["learn-walk"]).env_remove("UNBROWSE_LAB").stdin(Stdio::null()).output().unwrap();
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(2), "{err}");
    assert!(err.starts_with("unbrowse-node: no command \"learn-walk\"\n"), "{err}");
    let o = command(&home, free_port(), &["learn-walk"]).env("UNBROWSE_LAB", "1").stdin(Stdio::null()).output().unwrap();
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(2), "{err}");
    assert!(err.contains("usage: UNBROWSE_LAB=1 unbrowse-node learn-walk <capture.jsonl> <url> <goal>"), "{err}");
    assert!(nodes_of(&home).is_empty());
    let _ = std::fs::remove_dir_all(&home);
}

/// A command given the wrong words says how to use it and exits 2, and changes nothing.
#[test]
fn a_command_given_the_wrong_words_prints_its_usage_and_exits_2() {
    let home = home("usage");
    for (args, says) in [
        (&["restart", "extra"][..], "usage: unbrowse-node restart"),
        (&["network", "bogus"], "usage: unbrowse-node network [on|off|light|full|kept on|kept off|addrs]"),
        (&["max-fetch", "1", "2"], "usage: unbrowse-node max-fetch [dollars]"),
        (&["max-fetch", "abc"], "a sum of dollars, zero or more (e.g. 0.05)"),
        (&["share", "bogus"], "usage: unbrowse-node share [status | used | all | off |"),
        (&["telemetry", "bogus"], "usage: unbrowse-node telemetry [on | off]"),
        (&["update", "now"], "usage: unbrowse-node update [channel [stable|canary|auto]]"),
        (&["checkout", "foo"], "usage: unbrowse-node checkout [list] | done <site> | dismiss <site|all>"),
        (&["chain", "foo"], "usage: unbrowse-node chain [devnet | arc-mainnet | arc-testnet | deploy"),
        (&["agent", "cap"], "usage: unbrowse-node agent cap <index> <dollars a day>"),
        (&["agent", "new"], "usage: unbrowse-node agent new <name> [cap_usdc, 5 by default] [days]"),
        (&["agent-user"], "usage: unbrowse-node agent-user install"),
        (&["session"], "usage: unbrowse-node session list | import <host>"),
        (&["passkey"], "usage: unbrowse-node passkey on | off | never <site>"),
        (&["passphrase", "foo"], "usage: unbrowse-node passphrase"),
        (&["remote", "status"], "usage: unbrowse-node remote [on [<gateway>]|public [<gateway>]|off"),
        (&["bounty"], "usage: unbrowse-node bounty post <site> <amount>"),
        (&["vault"], "usage: unbrowse-node vault list | add <site> <account>"),
        (&["domain"], "usage: unbrowse-node domain status <domain>"),
        (&["coin", "bogus"], "usage: unbrowse-node coin [list | launch <entry> <unb>"),
        (&["nodes", "foo"], "usage: unbrowse-node nodes [grant | renew]"),
    ] {
        let r = run(&home, args);
        assert_eq!(r.code, Some(if args[0] == "nodes" { 1 } else { 2 }), "{args:?}: {}{}", r.out, r.err);
        assert!(r.err.contains(says) || r.out.contains(says), "{args:?}: {}{}", r.out, r.err);
    }
    let _ = std::fs::remove_dir_all(&home);
}

/// A command that asks the running node, run with no node running, says to start it and exits 1, whatever it was asked.
#[test]
fn a_command_that_needs_the_node_says_to_start_it_when_none_runs() {
    let home = home("needs-node");
    for args in [&["money"][..], &["earnings"], &["nodes"], &["coin"], &["sign-in"], &["agent", "cap", "1", "2"], &["share", "delist"]] {
        let r = run(&home, args);
        assert_eq!(r.code, Some(1), "{args:?}: {}{}", r.out, r.err);
        assert!(r.err.contains("start the node first (`unbrowse-node` or the app)"), "{args:?}: {}", r.err);
        assert!(r.out.is_empty(), "{args:?}: {}", r.out);
    }
    let r = run(&home, &["update"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "this node was built from source, so it doesn't update itself\n"));
    let r = run(&home, &["agent", "token"]);
    assert_eq!(r.code, Some(3));
    assert!(r.err.contains("no live agent key yet"), "{}", r.err);
    assert!(nodes_of(&home).is_empty());
    let _ = std::fs::remove_dir_all(&home);
}

/// `max-fetch` says what the node pays at most for one fetch, sets it, and the next run reads it back; 0 means no paid fetch.
#[test]
fn max_fetch_sets_what_the_node_pays_and_reads_it_back() {
    let home = home("max-fetch");
    assert_eq!(run(&home, &["max-fetch"]).out, "$0.05: the most the node pays to fetch one route; a route that costs more is passed over\n");
    let r = run(&home, &["max-fetch", "0.2"]);
    assert_eq!((r.code, r.out.as_str()), (Some(0), "$0.20: from now the node pays at most this to fetch one route\n"));
    assert!(run(&home, &["max-fetch"]).out.starts_with("$0.20: the most the node pays"));
    let r = run(&home, &["max-fetch", "0"]);
    assert_eq!((r.code, r.out.as_str()), (Some(0), "$0: from now the node pays for no fetch, and uses only free routes and its own\n"));
    assert!(run(&home, &["max-fetch"]).out.starts_with("$0: the node pays for no fetch"));
    let _ = std::fs::remove_dir_all(&home);
}

/// `network` says where the peer network stands (waiting on the terms until the owner accepts them), `on` and `off` set it,
/// and `light` turns on the mode that answers no lookups.
#[test]
fn the_network_command_says_where_the_peer_network_stands_and_sets_it() {
    let home = home("network");
    assert!(run(&home, &["network"]).out.starts_with("waiting: this node stays off the peer network until its owner acknowledges terms"));
    assert_eq!(run(&home, &["network", "on"]).out, "on, once the terms are acknowledged (`unbrowse-node terms show`, then `unbrowse-node terms accept`)\n");
    assert_eq!(run(&home, &["network", "off"]).out, "off: the node leaves the peer network once no call is under way\n");
    assert!(run(&home, &["network"]).out.starts_with("off: the node stays off the peer network"));
    let r = run(&home, &["network", "light"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.starts_with("light: once no call is under way the node restarts, then only asks the peer network and seeds no body it fetched"), "{}", r.out);
    let _ = std::fs::remove_dir_all(&home);
}

/// `share` says which routes the node lists by itself, and `used`, `all`, `off` and `per-day` set it, each said back.
#[test]
fn the_share_command_sets_which_routes_the_node_lists() {
    let home = home("share");
    assert!(run(&home, &["share"]).out.starts_with("used: the node lists the routes your agents keep using"));
    assert!(run(&home, &["share", "all"]).out.starts_with("all: the node lists every route it learns once it has run successfully, at most 20 a day"));
    assert!(run(&home, &["share", "status"]).out.starts_with("all: the node lists every route the node learns"));
    assert!(run(&home, &["share", "used"]).out.starts_with("used: the node lists a route once your agents keep using it"));
    assert!(run(&home, &["share", "off"]).out.starts_with("off: the node lists nothing by itself; what is listed stays listed"));
    assert_eq!(run(&home, &["share", "per-day", "5"]).out, "from now the node lists at most 5 routes a day by itself\n");
    let r = run(&home, &["share", "per-day", "x"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "the most routes listed a day is a whole number, zero or more\n"));
    let r = run(&home, &["share", "route", "x", "on"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "no route x\n"));
    let _ = std::fs::remove_dir_all(&home);
}

/// `telemetry` and `reports` say whether they are on and what they send, and `on` and `off` set the choice for the next run.
#[test]
fn telemetry_and_reports_say_what_they_send_and_can_be_switched() {
    let home = home("telemetry");
    let r = run(&home, &["telemetry"]);
    assert!(r.out.starts_with("telemetry: off (set by UNBROWSE_TELEMETRY)\nsends: "), "{}", r.out);
    assert!(run(&home, &["telemetry", "off"]).out.starts_with("telemetry off; a running node stops sending at once"));
    assert!(run(&home, &["telemetry", "on"]).out.starts_with("telemetry on; a running node takes it at its next start"));
    let r = run(&home, &["reports"]);
    assert!(r.out.starts_with("bug reports: off (telemetry is off)\na report holds: "), "{}", r.out);
    assert!(run(&home, &["reports", "off"]).out.starts_with("bug reports off; a running node stops sending them at once"));
    assert!(run(&home, &["reports", "on"]).out.starts_with("bug reports on; a running node takes it at its next start"));
    let _ = std::fs::remove_dir_all(&home);
}

/// The commands that read no node say what they hold: no checkout, the chain in use, the wallet address (alone with
/// `address`), the terms and that they are not accepted yet, the browser missing, the remote address off, and bearer tokens off.
#[test]
fn the_commands_that_ask_no_node_say_what_the_home_holds() {
    let home = home("reads");
    assert_eq!(run(&home, &["checkout"]).out, "no checkout is held\n");
    assert!(run(&home, &["chain"]).out.starts_with("devnet (UNBROWSE_CHAIN): the node's own Anvil on 127.0.0.1"));
    let r = run(&home, &["wallet", "address"]);
    assert_eq!(r.out, "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\n");
    let r = run(&home, &["wallet"]);
    assert!(r.out.starts_with("this node's wallet: 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\n"), "{}", r.out);
    assert!(r.out.contains("network: devnet") && r.out.contains("linked wallet: none"), "{}", r.out);
    let r = run(&home, &["terms"]);
    assert!(r.out.starts_with("terms 2026-11-01: `unbrowse-node terms show` prints them\nnot acknowledged yet: `unbrowse-node terms accept` records it"), "{}", r.out);
    assert!(run(&home, &["terms", "show"]).out.starts_with("# Terms of Service\n"));
    let r = run(&home, &["browser"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.starts_with("browser: ") && r.out.contains("The node runs without it"), "{}", r.out);
    assert!(run(&home, &["remote"]).out.starts_with("off: `unbrowse-node remote on` gives this node an MCP address"));
    assert!(run(&home, &["agent", "bearer"]).out.starts_with("off: the node takes signed requests only; a token is never sent."));
    let r = run(&home, &["session", "list"]);
    assert_eq!((r.code, r.out.as_str()), (Some(0), ""));
    let r = run(&home, &["confirm"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("this needs a terminal to type the owner passphrase on"), "{}", r.err);
    let _ = std::fs::remove_dir_all(&home);
}

/// Runs `unbrowse-node <args>` against the running `node` (its port, its home), as an owner at a shell does.
fn ask(node: &Running, args: &[&str]) -> Ran {
    let o = command(&node.home, node.port, args).stdin(Stdio::null()).output().unwrap();
    Ran { code: o.status.code(), out: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
}

/// C04: the node is the program the shell runs. Commands run beside a node that is up reach it on its port with the owner's
/// token and print what it says: the money it holds (offline here, with no network), the agent keys it made (the first one
/// by itself, one more on `agent new`), the bearer-token switch, and the weights of the coin and bounty commands.
#[test]
fn owner_commands_beside_a_running_node_print_what_it_answers() {
    let home = home("owner");
    let node = Running::start(&home, &[], &[]);
    std::thread::sleep(Duration::from_secs(2));

    let r = ask(&node, &["money"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.starts_with("Payments offline: the node can't reach the network now; it tries again by itself.\n"), "{}", r.out);
    assert!(r.out.contains("of a $5.00 daily limit spent today"), "{}", r.out);
    assert!(r.out.contains("Earnings: $"), "{}", r.out);

    let first = ask(&node, &["agent", "token"]);
    assert_eq!(first.code, Some(0), "{}", first.err);
    assert!(first.out.trim().starts_with("unb_") && first.out.trim().len() > 20, "{}", first.out);
    assert_eq!(ask(&node, &["agent", "token"]).out, first.out, "the first agent's token is the same each time");

    let r = ask(&node, &["agent", "new", "probe", "5"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.contains("claude mcp add --scope user unbrowse") && r.out.contains(&format!("UNBROWSE_NODE=http://127.0.0.1:{}", node.port)), "{}", r.out);
    assert!(r.out.contains("mcp --agent 1"), "{}", r.out);
    assert!(r.err.contains("this agent uses this node's own and free routes now"), "{}", r.err);

    assert!(ask(&node, &["agent", "bearer", "on"]).out.starts_with("on: the node takes a token sent as a plain bearer token"));
    assert!(ask(&node, &["agent", "bearer"]).out.starts_with("on: "));
    assert!(ask(&node, &["agent", "bearer", "off"]).out.starts_with("off: the node takes signed requests only"));

    let r = ask(&node, &["coin", "dev-buy"]);
    assert_eq!((r.code, r.out.as_str()), (Some(0), "{\n  \"bps\": 100\n}\n"), "{}", r.err);
    let r = ask(&node, &["coin", "buy", "x", "1"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "entry: x isn't an entry id (0x and 64 hex digits)\n"));
    let r = ask(&node, &["bounty", "show", "x"]);
    assert_eq!((r.code, r.err.as_str()), (Some(2), "x isn't a bounty id (a whole number, as `bounty list` shows)\n"));

    let r = ask(&node, &["nodes"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.starts_with("no linked wallet: this node pays from its own wallet, and needs none."), "{}", r.err);
    let r = ask(&node, &["nodes", "renew"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "no linked wallet, so no wallet grant to renew: this node pays from its own wallet\n"));

    let r = ask(&node, &["agent", "cap", "0", "3"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("this needs the owner's yes") && r.err.ends_with("nothing was done\n"), "{}", r.err);

    let r = ask(&node, &["share", "delist"]);
    assert_eq!((r.code, r.out.as_str()), (Some(0), "delisted 0 routes; each stays off the network until you share it again\n"));
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// The settings commands beside a running node: `update channel` says and sets the channel, `network` says and sets how
/// the node joins the peer network (light, full, on once the terms are accepted), and the terms are recorded.
#[test]
fn settings_commands_beside_a_running_node_are_kept_and_said_back() {
    let home = home("settings");
    let node = Running::start(&home, &[], &[]);
    let r = ask(&node, &["update", "channel"]);
    assert_eq!((r.code, r.out.as_str()), (Some(0), "auto: the node's identity places it on stable or, for a share of releases, canary\n"));
    assert!(ask(&node, &["update", "channel", "canary"]).out.starts_with("canary: the node's next check updates on it"));
    assert!(ask(&node, &["update", "channel"]).out.starts_with("canary: "));
    assert!(ask(&node, &["network", "light"]).out.starts_with("light: once no call is under way the node restarts"));
    assert!(ask(&node, &["network", "full"]).out.starts_with("full: once no call is under way the node restarts, then answers lookups"));
    assert!(ask(&node, &["network", "addrs"]).out.starts_with("the node hasn't published where it is yet"));
    let r = ask(&node, &["terms", "accept"]);
    assert_eq!(r.out, "accepted terms 2026-11-01: the node joins the peer network (`unbrowse-node network off` keeps it off)\n", "{}", r.err);
    assert!(ask(&node, &["network", "on"]).out.starts_with("on: the node joins the peer network"));
    assert!(ask(&node, &["network"]).out.starts_with("on: the node joins the peer network and announces only the routes you list"));
    assert!(ask(&node, &["passkey", "on"]).out.starts_with("passkeys are on:"));
    assert_eq!(ask(&node, &["passkey", "list"]).code, Some(0));
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// The first agent's token, once the node has made its first key (it does so a moment after it answers).
fn token_of(node: &Running) -> String {
    let until = Instant::now() + Duration::from_secs(60);
    loop {
        let r = ask(node, &["agent", "token"]);
        if r.code == Some(0) {
            return r.out.trim().to_string();
        }
        assert!(Instant::now() < until, "the node never made its first agent key: {}", r.err);
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// `unb <args>` as an agent runs it: against the node at `port` with `token` (none when `None`), in `home`, with `stdin`
/// typed to it.
fn unb(home: &Path, port: u16, token: Option<&str>, args: &[&str], stdin: &str) -> Ran {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_unb"));
    cmd.args(args)
        .env("UNBROWSE_HOME", home)
        .env("HOME", home)
        .env("UNBROWSE_NODE", format!("http://127.0.0.1:{port}"))
        .env_remove("UNBROWSE_AGENT_TOKEN")
        .env_remove("UNBROWSE_PORT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(t) = token {
        cmd.env("UNBROWSE_AGENT_TOKEN", t);
    }
    let mut child = cmd.spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let o = child.wait_with_output().unwrap();
    Ran { code: o.status.code(), out: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
}

/// `unb` with no agent token says how to get one and exits 2, reaching no node; a command it doesn't know, or one missing
/// its words, prints the usage and exits 2 and sends nothing (the token never leaves for it).
#[test]
fn unb_without_a_token_or_with_a_wrong_command_exits_2_and_asks_no_node() {
    let home = home("unb-usage");
    let r = unb(&home, free_port(), None, &["whoami"], "");
    assert_eq!(r.code, Some(2), "{}", r.err);
    assert!(r.err.starts_with("set UNBROWSE_AGENT_TOKEN, or run `unbrowse connect`"), "{}", r.err);
    for words in [&[][..], &["bogus"], &["do"], &["call"], &["judge"], &["report"], &["open"], &["browse"], &["challenge"]] {
        let r = unb(&home, free_port(), Some("unb_x"), words, "");
        assert_eq!(r.code, Some(2), "{words:?}: {}{}", r.out, r.err);
        assert!(r.err.starts_with("usage: unb do <goal>") && r.out.is_empty(), "{words:?}: {}{}", r.out, r.err);
    }
    let _ = std::fs::remove_dir_all(&home);
}

/// `unb` run beside a node answers as the agent: who it is, its logins and cards (none yet), a search with no routes, and
/// each wrong ask (an unknown route, a bad judgment, a bad report kind, a bad link) with the node's own error and exit 1.
#[test]
fn unb_beside_a_running_node_prints_the_nodes_answers_and_its_errors() {
    let home = home("unb-asks");
    let node = Running::start(&home, &[], &[]);
    let token = token_of(&node);
    let json = |r: &Ran| serde_json::from_str::<serde_json::Value>(&r.out).unwrap_or_else(|e| panic!("{e}: {}{}", r.out, r.err));

    let r = unb(&home, node.port, Some(&token), &["whoami"], "");
    assert_eq!(r.code, Some(0), "{}", r.err);
    let who = json(&r);
    assert!(who["address"].as_str().is_some_and(|a| a.starts_with("0x")), "{who}");
    assert_eq!(who["browser"], "missing", "{who}");

    let r = unb(&home, node.port, Some(&token), &["logins"], "");
    let v = json(&r);
    assert_eq!((r.code, v["logins"].as_array().map(Vec::len), v["cards"].as_array().map(Vec::len)), (Some(0), Some(0), Some(0)), "{v}");

    for words in [&["search"][..], &["search", "weather"]] {
        let r = unb(&home, node.port, Some(&token), words, "");
        assert_eq!((r.code, json(&r)["routes"].as_array().map(Vec::len)), (Some(0), Some(0)), "{words:?}");
    }

    for (words, outcome, says) in [
        (&["call", "x"][..], Some("no_route"), "no such route"),
        (&["judge", "x", "right"], None, "no such route on this node"),
        (&["report", "bug", "summary", "--expected", "a", "--got", "b"], None, "kind is one of wrong_data"),
        (&["open", "unbrowse://x"], None, "a link names a site by its plain domain"),
    ] {
        let r = unb(&home, node.port, Some(&token), words, "");
        let v = json(&r);
        assert_eq!(r.code, Some(1), "{words:?}: {v}");
        assert!(v["error"].as_str().is_some_and(|e| e.contains(says)), "{words:?}: {v}");
        if let Some(o) = outcome {
            assert_eq!(v["outcome"], o, "{v}");
        }
    }
    for words in [&["browse", "status"][..], &["challenge", "look"], &["do", "get", "weather", "--url", "https://example.com"]] {
        let r = unb(&home, node.port, Some(&token), words, "");
        let v = json(&r);
        assert_eq!((r.code, v["code"].as_str()), (Some(1), Some("browser_missing")), "{words:?}: {v}");
        assert_eq!(v["install"], "unbrowse browser install");
    }
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// `unb` given a wrong token by a node it can't prove itself to, or no node at all, says so and fails; it never prints
/// what an unproven answer said.
#[test]
fn unb_with_no_node_listening_fails_and_says_what_it_could_not_reach() {
    let home = home("unb-nonode");
    let r = unb(&home, free_port(), Some("unb_x"), &["whoami"], "");
    assert_eq!(r.code, Some(1), "{}", r.out);
    assert!(r.out.is_empty() && !r.err.is_empty(), "{}", r.err);
    let _ = std::fs::remove_dir_all(&home);
}

/// `unb grant` records the owner's yes for an agent (the first, or a numbered one) so `unb mcp --agent` can act as it; an
/// agent that has no key is refused, and `unb mcp --agent N` with no grant exits 2 naming the step to take.
#[test]
fn unb_grant_lets_an_agent_in_and_an_ungranted_one_is_told_the_step() {
    let home = home("unb-grant");
    let node = Running::start(&home, &[], &[]);
    let token = token_of(&node);
    let run = |words: &[&str]| unb(&home, node.port, Some(&token), words, "");
    let r = run(&["mcp", "--agent", "99"]);
    assert_eq!(r.code, Some(2));
    assert!(r.err.starts_with("the owner hasn't let agent 99 in on this machine yet: run `unbrowse grant 99` once"), "{}", r.err);
    let r = run(&["grant", "9"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.starts_with("no live agent key 9:"), "{}", r.err);
    for words in [&["grant"][..], &["grant", "first"]] {
        let r = run(words);
        assert_eq!(r.code, Some(0), "{words:?}: {}", r.err);
        assert!(r.err.contains("granted: `unb mcp --agent first` can act as that agent now"), "{}", r.err);
    }
    let r = run(&["mcp", "--agent"]);
    assert_eq!((r.code, r.err.trim()), (Some(2), "usage: unb mcp [--agent <index> | --agent first]"));
    let r = run(&["mcp", "--peer", "x"]);
    assert_eq!((r.code, r.err.trim()), (Some(2), "x isn't a peer ID"));
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// `unb mcp` is the node's MCP server over stdio: a message a line in, the node's answer a line out, in the order asked,
/// and a line that is not JSON is answered with a parse error rather than dropped.
#[test]
fn unb_mcp_relays_each_line_to_the_node_and_answers_bad_lines() {
    let home = home("unb-mcp");
    let node = Running::start(&home, &[], &[]);
    let token = token_of(&node);
    let input = [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "this is not json",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
    ]
    .join("\n")
        + "\n";
    let r = unb(&home, node.port, Some(&token), &["mcp"], &input);
    assert_eq!(r.code, Some(0), "{}", r.err);
    let answers: Vec<serde_json::Value> = r.out.lines().map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}"))).collect();
    let by_id = |id: i64| answers.iter().find(|a| a["id"] == id).unwrap_or_else(|| panic!("no answer to {id}: {}", r.out));
    assert_eq!(by_id(1)["jsonrpc"], "2.0");
    assert!(by_id(1)["result"]["serverInfo"].is_object(), "{}", by_id(1));
    assert!(by_id(2)["result"]["tools"].as_array().is_some_and(|t| !t.is_empty()), "{}", by_id(2));
    assert!(answers.iter().any(|a| a["id"].is_null() && a["error"]["code"] == -32700 && a["error"]["message"] == "not JSON"), "{}", r.out);
    assert_eq!(answers.len(), 3, "a notification gets no answer: {}", r.out);
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// With no token and no grant, `unb mcp` is still an MCP server: it answers the agent's initialize and calls with the one
/// step that connects it (`unbrowse connect`), so the agent shows its person that rather than a server that failed.
#[test]
fn unb_mcp_with_no_grant_answers_with_the_one_step_that_connects_it() {
    let home = home("unb-mcp-none");
    let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\nnot json\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";
    let r = unb(&home, free_port(), None, &["mcp"], input);
    assert_eq!(r.code, Some(0), "{}", r.err);
    let answers: Vec<serde_json::Value> = r.out.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(answers.len(), 3, "{}", r.out);
    assert!(answers.iter().all(|a| a["jsonrpc"] == "2.0"), "{}", r.out);
    assert!(r.out.contains("unbrowse connect"), "the step that connects it: {}", r.out);
    let _ = std::fs::remove_dir_all(&home);
}

/// `unbrowse connect --dry-run` says what it would do to this machine's agents and changes nothing; a wrong word gets its
/// usage and exit 2.
#[test]
fn connect_dry_run_changes_nothing_and_a_wrong_word_gets_the_usage() {
    let home = home("unb-connect");
    let r = unb(&home, free_port(), None, &["connect", "--dry-run"], "");
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.starts_with("Unbrowse is connecting this machine's agents to your own node.\n"), "{}", r.out);
    assert!(r.out.contains("Dry run: nothing was changed."), "{}", r.out);
    let r = unb(&home, free_port(), None, &["connect", "--help"], "");
    assert_eq!(r.code, Some(2));
    assert!(r.err.starts_with("usage: unbrowse connect [agent index] [--dry-run] [--yes]"), "{}", r.err);
    let _ = std::fs::remove_dir_all(&home);
}

/// `unbrowse-node <args>` run in `home` with `stdin` typed to it (a passphrase, a recovery phrase), as a pipe does.
fn run_typed(home: &Path, args: &[&str], stdin: &str) -> Ran {
    let mut child = command(home, free_port(), args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let o = child.wait_with_output().unwrap();
    Ran { code: o.status.code(), out: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
}

/// The address of the root key every test home holds (`11` repeated).
const ADDRESS: &str = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

/// `wallet export <file>` writes an encrypted backup of the node's key under the passphrase typed on stdin (ten characters
/// at least), and says whose it is; the file holds no trace of the key. `wallet import <file>` on a machine with another
/// key puts the first key back (the other is kept beside it), under the same passphrase and no other.
#[test]
fn a_wallet_backup_restores_the_same_address_under_its_passphrase_and_no_other() {
    let from = home("backup-from");
    let file = from.join("w.bak");
    let r = run_typed(&from, &["wallet", "export", file.to_str().unwrap()], "short\n");
    assert_eq!(r.code, Some(1), "{}", r.out);
    assert!(r.err.contains("a backup's passphrase is at least 10 characters"), "{}", r.err);
    assert!(!file.exists(), "a refused export writes nothing");

    let r = run_typed(&from, &["wallet", "export", file.to_str().unwrap()], "correct horse battery\n");
    assert_eq!(r.code, Some(0), "{}{}", r.out, r.err);
    assert!(r.err.starts_with("the backup's passphrase (at least 10 characters), then Enter:"), "{}", r.err);
    assert_eq!(r.out, format!("wrote an encrypted backup of {ADDRESS} to {}: keep it, and its passphrase, off this machine\n", file.display()));
    let kept = std::fs::read_to_string(&file).unwrap();
    assert!(!kept.contains(&"11".repeat(32)) && !kept.is_empty(), "the backup is sealed");
    let again = run_typed(&from, &["wallet", "export", file.to_str().unwrap()], "correct horse battery\n");
    assert_eq!(again.code, Some(1), "an export never overwrites a file: {}", again.out);

    let to = home("backup-to");
    std::fs::write(to.join("devnet/root.key"), "22".repeat(32)).unwrap();
    let other = run(&to, &["wallet", "address"]).out.trim().to_string();
    assert_ne!(other, ADDRESS);
    let r = run_typed(&to, &["wallet", "import", file.to_str().unwrap()], "not the passphrase\n");
    assert_eq!(r.code, Some(1), "{}", r.out);
    assert_eq!(run(&to, &["wallet", "address"]).out.trim(), other, "a wrong passphrase changes nothing");
    let r = run_typed(&to, &["wallet", "import", file.to_str().unwrap()], "correct horse battery\n");
    assert_eq!(r.code, Some(0), "{}{}", r.out, r.err);
    assert!(r.out.starts_with(&format!("restored {ADDRESS}")), "{}", r.out);
    assert_eq!(run(&to, &["wallet", "address"]).out.trim(), ADDRESS, "the first key is back");
    let r = run_typed(&to, &["wallet", "import", to.join("missing.bak").to_str().unwrap()], "x\n");
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("missing.bak: No such file or directory"), "{}", r.err);
    let _ = std::fs::remove_dir_all(&from);
    let _ = std::fs::remove_dir_all(&to);
}

/// `wallet restore` takes 12 or 24 words and nothing else, and a wrong word of the wallet command gets all its usages.
#[test]
fn wallet_restore_wants_a_recovery_phrase_and_a_wrong_word_gets_the_usage() {
    let home = home("wallet-words");
    let r = run_typed(&home, &["wallet", "restore"], "");
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("a recovery phrase is 12 words (a node's seed words) or 24 words (an older node's key); this is 0"), "{}", r.err);
    let r = run_typed(&home, &["wallet", "restore"], "one two three\n");
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("this is 3"), "{}", r.err);
    assert_eq!(run(&home, &["wallet", "address"]).out.trim(), ADDRESS, "a refused phrase changes nothing");
    let r = run(&home, &["wallet", "bogus"]);
    assert_eq!(r.code, Some(2));
    for usage in ["unbrowse-node wallet [--copy]", "wallet address [--copy]", "wallet restore            the 12 or 24 words on stdin", "wallet export <file>", "wallet import <file>"] {
        assert!(r.err.contains(usage), "{usage}: {}", r.err);
    }
    let _ = std::fs::remove_dir_all(&home);
}

/// `browser` says what the node's browser is (missing here), as text or as JSON; `fetch` and `headless` set whether the
/// node fetches it; `install` on a build from source says how to get one; a wrong word gets the usage.
#[test]
fn the_browser_command_says_what_the_node_has_and_sets_whether_it_fetches() {
    let home = home("browser");
    let r = run(&home, &["browser", "--json"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    let v: serde_json::Value = serde_json::from_str(&r.out).unwrap();
    assert_eq!((v["state"].as_str(), v["fetch"].as_bool()), (Some("missing"), Some(true)), "{v}");
    assert_eq!(v["program"], serde_json::Value::Null);
    assert_eq!(run(&home, &["browser", "fetch", "off"]).out, "off: the node never fetches its browser by itself\n");
    assert!(run(&home, &["browser", "status", "--json"]).out.contains("\"fetch\":false"));
    assert!(run(&home, &["browser"]).out.contains("fetches it when needed: no (unbrowse browser fetch on)"));
    assert_eq!(run(&home, &["browser", "fetch", "on"]).out, "on: the node fetches its browser the first time something needs it\n");
    let r = run(&home, &["browser", "install"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.starts_with("this node was built from source, so no release holds its browser"), "{}", r.err);
    let r = run(&home, &["browser", "bogus"]);
    assert_eq!(r.code, Some(2));
    assert!(r.err.contains("usage: unbrowse-node browser [status [--json] | install [--from <path>] | remove [--chromium] | fetch [on|off] | headless [on|off]]"), "{}", r.err);
    let _ = std::fs::remove_dir_all(&home);
}

/// `terms accept` records the owner's yes to the terms in force and `terms` then says so; `chain` and `update channel`
/// keep a choice the next run reads; `chain deploy` refuses on the devnet, which deploys its own contracts.
#[test]
fn the_terms_the_channel_and_the_chain_are_kept_from_one_run_to_the_next() {
    let home = home("terms-chain");
    assert!(run(&home, &["terms"]).out.contains("not acknowledged yet: `unbrowse-node terms accept` records it"));
    let r = run(&home, &["terms", "accept"]);
    assert_eq!(r.out, "accepted terms 2026-11-01: the node joins the peer network (`unbrowse-node network off` keeps it off)\n", "{}", r.err);
    assert!(run(&home, &["terms"]).out.contains("\nacknowledged\n"), "{}", run(&home, &["terms"]).out);
    let r = run(&home, &["terms", "bogus"]);
    assert_eq!((r.code, r.err.as_str()), (Some(2), "usage: unbrowse-node terms [show|accept]\n"));
    assert!(run(&home, &["update", "channel", "stable"]).out.starts_with("stable: the node's next check updates on it"));
    assert_eq!(run(&home, &["update", "channel"]).out, "stable: the owner picked it\n");
    assert!(run(&home, &["update", "channel", "auto"]).out.starts_with("auto: "));
    assert!(run(&home, &["update", "channel"]).out.starts_with("auto: the node's identity places it"));
    let r = run(&home, &["update", "channel", "beta"]);
    assert_eq!((r.code, r.err.as_str()), (Some(2), "usage: unbrowse-node update [channel [stable|canary|auto]]\n"));
    let r = run(&home, &["chain", "deploy"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("`chain deploy` is for a live chain (`unbrowse-node chain arc-testnet` first)"), "{}", r.err);
    let r = run(&home, &["agent-user", "status"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("there is no OS user unbrowse-agent: `unbrowse-node agent-user install` makes it"), "{}", r.err);
    let r = run(&home, &["agent-user", "run"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("usage: unbrowse-node agent-user install"), "{}", r.err);
    let _ = std::fs::remove_dir_all(&home);
}

/// Passkeys: `on` and `off` set whether the node keeps them (said back, and `list` says when they are off), `never` and
/// `allow` keep a site out and let it back, and a site must be named.
#[test]
fn passkeys_are_switched_and_a_site_is_kept_out_and_let_back() {
    let home = home("passkeys");
    let pk = |args: &[&str]| {
        let o = command(&home, free_port(), args).env_remove("UNBROWSE_PASSKEYS").stdin(Stdio::null()).output().unwrap();
        Ran { code: o.status.code(), out: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
    };
    assert!(pk(&["passkey", "off"]).out.starts_with("passkeys are off: the node no longer enrols or signs in with them"));
    assert!(pk(&["passkey", "list"]).out.starts_with("(passkeys are off: `unbrowse-node passkey on` turns them back on"));
    assert!(pk(&["passkey", "on"]).out.starts_with("passkeys are on: a site this node signs in to with a vault login may get a passkey"));
    let r = pk(&["passkey", "never", "example.com"]);
    assert_eq!(r.out, "example.com: the node never enrols a passkey there, nor signs in with one it holds (`passkey list` shows any to remove)\n", "{}", r.err);
    assert_eq!(pk(&["passkey", "allow", "example.com"]).out, "example.com: passkeys allowed again\n");
    let r = pk(&["passkey", "never", "x"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "name the site, like google.com or https://accounts.google.com\n"));
    let r = pk(&["passkey", "remove", "1"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "no such passkey: `unbrowse-node passkey list` names them\n"));
    let r = pk(&["passkey", "use", "x"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("`use` is for another browser: --cdp <address>"), "{}", r.err);
    let _ = std::fs::remove_dir_all(&home);
}

/// The remote address: `remote on` names the node's MCP address, keys are made and shown once and revoked, sign-in
/// waits on `on`, and `off` stops the node attaching; the peer-network key is made and revoked the same way.
#[test]
fn the_remote_address_and_its_keys_are_made_shown_once_and_revoked() {
    let home = home("remote");
    let node = Running::start(&home, &[], &[]);
    let r = ask(&node, &["remote", "sign-in"]);
    assert_eq!((r.code, r.err.as_str()), (Some(1), "turn the remote on first: `unbrowse-node remote on`\n"));
    let r = ask(&node, &["remote", "on"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.starts_with("on: this node's MCP is at https://unbrowse.ai/p/") && r.out.contains("/mcp\n"), "{}", r.out);
    assert!(r.out.contains("claude mcp add --transport http unbrowse-remote https://unbrowse.ai/p/"), "{}", r.out);
    assert!(ask(&node, &["remote"]).out.starts_with("on: this node's MCP is at https://unbrowse.ai/p/"));
    let r = ask(&node, &["remote", "key"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.contains("Remote key \"Remote agents\"") && r.out.contains("shown once:\n  unb_"), "{}", r.out);
    assert_eq!(ask(&node, &["remote", "revoke"]).out, "revoked 1 remote key\n");
    assert!(ask(&node, &["remote", "peer"]).out.starts_with("off: this node takes no MCP over the peer network."));
    let r = ask(&node, &["remote", "peer", "key"]);
    assert!(r.out.contains("Peer key \"Peer agents\"") && r.out.contains("unb mcp --peer <peer id> --addr <address>"), "{}{}", r.out, r.err);
    assert_eq!(ask(&node, &["remote", "peer", "off"]).out, "off: revoked 1 key for the peer network; the node takes no MCP over it now\n");
    assert!(ask(&node, &["remote", "off"]).out.starts_with("off: the node stops attaching to https://unbrowse.ai within a few seconds; its remote keys stay"));
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// A node's session for a site: `session import --from <cookie file>` keeps the cookies (and says to delete the file, which
/// signs in as the owner), `session list` names the site and how many, and `forget` drops it. The checkout holds say
/// when a site wasn't held.
#[test]
fn a_sites_session_is_kept_from_a_cookie_file_listed_and_forgotten() {
    let home = home("session");
    let node = Running::start(&home, &[], &[]);
    let cookies = home.join("cookies.json");
    std::fs::write(&cookies, r#"[{"name":"sid","value":"abc","domain":"example.com","path":"/","secure":true,"httpOnly":true}]"#).unwrap();
    let r = ask(&node, &["session", "import", "example.com", "--from", cookies.to_str().unwrap()]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.out.starts_with("kept 1 cookies for example.com: calls send them."), "{}", r.out);
    assert!(r.out.contains(&format!("the cookie file signs in as you: delete {} now", cookies.display())), "{}", r.out);
    assert_eq!(ask(&node, &["session", "list"]).out, "example.com\t1 cookies\n");
    assert_eq!(ask(&node, &["session", "forget", "example.com"]).out, "dropped the node's session for example.com\n");
    assert_eq!(ask(&node, &["session", "list"]).out, "");
    assert_eq!(ask(&node, &["checkout", "done", "x"]).out, "x wasn't held\n");
    assert_eq!(ask(&node, &["checkout", "dismiss", "all"]).out, "all wasn't held\n");
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// The commands that reach the chain say so when it isn't up, and exit 1; the argument checks come first (an entry id is
/// 0x and 64 hex digits, a bounty id a whole number), and what the node itself holds answers (the dev-buy share, the
/// bounty steps and the agent keys it makes).
#[test]
fn the_chain_commands_say_when_the_chain_is_not_up_and_check_their_arguments_first() {
    let home = home("chain-cmds");
    let node = Running::start(&home, &[], &[]);
    let entry = format!("0x{}1", "0".repeat(63));
    for args in [&["coin", "list"][..], &["coin", "delay", "5"], &["bounty", "list"], &["bounty", "list", "--mine", "--json"], &["domain", "status", "example.com"], &["earnings"]] {
        let r = ask(&node, args);
        assert_eq!(r.code, Some(1), "{args:?}: {}{}", r.out, r.err);
        assert!(r.out.is_empty() && !r.err.trim().is_empty(), "{args:?}: {}{}", r.out, r.err);
    }
    for args in [vec!["coin", "launch", entry.as_str(), "1"], vec!["coin", "sell", entry.as_str(), "1"], vec!["coin", "stake", entry.as_str(), "1", "5"], vec!["coin", "claim", entry.as_str()]] {
        let r = ask(&node, &args);
        assert_eq!(r.code, Some(1), "{args:?}: {}{}", r.out, r.err);
        assert!(!r.err.contains("isn't an entry id"), "a good entry id is accepted: {args:?}: {}", r.err);
    }
    assert_eq!(ask(&node, &["coin", "dev-buy", "50"]).out, "{\n  \"bps\": 50\n}\n");
    assert!(ask(&node, &["bounty", "auto"]).out.starts_with("Bounty steps: off. The node confirms nothing by itself"));
    let r = ask(&node, &["bounty", "auto", "on"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("this needs the owner's yes in a dialog on this machine's screen"), "{}", r.err);
    let r = ask(&node, &["domain", "status"]);
    assert_eq!(r.code, Some(2));
    assert!(r.err.starts_with("usage: unbrowse-node domain status <domain>\nnot proven: a domain is proven only by DNSSEC"), "{}", r.err);
    let r = ask(&node, &["agent", "token", "2"]);
    assert_eq!((r.code, r.err.contains("no live agent key 2")), (Some(3), true), "{}", r.err);
    let r = ask(&node, &["agent", "token", "x"]);
    assert_eq!((r.code, r.err.as_str()), (Some(2), "usage: unbrowse-node agent token [index]\n"));
    let r = ask(&node, &["agent", "bearer", "bogus"]);
    assert_eq!((r.code, r.err.as_str()), (Some(2), "usage: unbrowse-node agent bearer [on | off]\n"));
    let r = ask(&node, &["sign-in", "bogus"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("usage: unbrowse-node sign-in [--wallet <address>"), "{}", r.err);
    let r = ask(&node, &["passphrase"]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("this needs a terminal to type the owner passphrase on"), "{}", r.err);
    let r = ask(&node, &["confirm", "x"]);
    assert_eq!((r.code, r.err.as_str()), (Some(2), "usage: unbrowse-node confirm [--wait <seconds>]\n"));
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// `unbrowse connect --yes` beside a running node reads the agent's key from the node, proves the node, and says the
/// agent is live; with no Claude Code on the machine it says the entry wasn't taken and exits 1, touching nothing else.
/// `--undo` with nothing to undo says so.
#[test]
fn connect_beside_a_running_node_proves_the_agent_live_and_says_when_claude_is_missing() {
    let home = home("connect");
    let node = Running::start(&home, &[], &[]);
    let _ = token_of(&node);
    let nothing = home.join("no-tools");
    std::fs::create_dir_all(&nothing).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_unb"));
    cmd.args(["connect", "--yes"])
        .env("UNBROWSE_HOME", &home)
        .env("HOME", &home)
        .env("PATH", &nothing)
        .env("UNBROWSE_NODE", format!("http://127.0.0.1:{}", node.port))
        .env_remove("UNBROWSE_PORT")
        .stdin(Stdio::null());
    let o = cmd.output().unwrap();
    let (out, err) = (String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    assert_eq!(o.status.code(), Some(1), "{out}{err}");
    assert!(out.starts_with("Unbrowse is connecting this machine's agents to your own node.\n"), "{out}");
    assert!(out.contains("Found: no Unbrowse entry in any agent's settings."), "{out}");
    assert!(err.contains("your first agent is live on the node: "), "{err}");
    assert!(err.contains("Claude Code didn't take the new entry") && err.contains("Nothing was removed"), "{err}");
    let r = unb(&home, node.port, None, &["connect", "--undo"], "");
    assert_eq!(r.code, Some(1), "{}", r.out);
    assert!(r.err.contains(&format!("There is no backup in {} to undo.", home.join("migration").display())), "{}", r.err);
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

/// A program run on a terminal of its own (`script` gives it one), so what it reads from `/dev/tty` (the owner
/// passphrase, a code to type back) is typed by the test, as an owner on a server would type it over SSH.
struct OnTerminal {
    child: Child,
    typed: std::process::ChildStdin,
    shown: Arc<Mutex<String>>,
}

impl OnTerminal {
    fn start(home: &Path, port: u16, args: &[&str]) -> OnTerminal {
        let line = std::iter::once(NODE).chain(args.iter().copied()).collect::<Vec<_>>().join(" ");
        let cmd = command(home, port, &[]);
        let mut child = Command::new("script")
            .args(["-q", "-e", "-c", &line, "/dev/null"])
            .envs(cmd.get_envs().filter_map(|(k, v)| v.map(|v| (k.to_owned(), v.to_owned()))))
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("script (util-linux) runs");
        let shown = Arc::new(Mutex::new(String::new()));
        let (into, mut pipe) = (shown.clone(), child.stdout.take().unwrap());
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                into.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
        OnTerminal { typed: child.stdin.take().unwrap(), child, shown }
    }

    /// Waits until the terminal shows `text`, and gives everything it showed.
    fn wait_for(&self, text: &str) -> String {
        let until = Instant::now() + Duration::from_secs(90);
        loop {
            let now = self.shown.lock().unwrap().clone();
            if now.contains(text) {
                return now;
            }
            assert!(Instant::now() < until, "the terminal never showed {text:?}: {now}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn type_line(&mut self, line: &str) {
        self.typed.write_all(format!("{line}\r").as_bytes()).unwrap();
        self.typed.flush().unwrap();
    }

    fn ended(mut self) -> (Option<i32>, String) {
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                std::thread::sleep(Duration::from_millis(100));
                return (status.code(), self.shown.lock().unwrap().clone());
            }
            assert!(Instant::now() < until, "it never ended: {}", self.shown.lock().unwrap());
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for OnTerminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A file holding `key` (a wallet key, or anything) with `mode`.
fn key_file(home: &Path, key: &str, mode: u32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = home.join("owner-wallet.key");
    let _ = std::fs::remove_file(&path);
    std::fs::write(&path, format!("0x{key}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    path
}

/// The headless sign-in, end to end on the real program with no window and no screen: a node started from a shell, the
/// owner's wallet key in a file of their own, and the owner's yes typed on a terminal. It fails, linking nothing, on a
/// key file others can read, on one that holds no key, and while no owner passphrase is set to say yes with; once one
/// is, `sign-in --key-file` links the wallet when the owner allows it with `confirm`, and the node says it is linked.
#[test]
fn the_owner_signs_in_with_no_window_from_a_wallet_key_and_a_yes_typed_on_a_terminal() {
    const KEY: &str = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
    const PASSPHRASE: &str = "the owner's own words, typed";
    let home = home("headless-sign-in");
    let node = Running::start(&home, &[], &[]);
    let unlinked = |r: Ran| assert!(r.out.contains("linked wallet: none"), "{}{}", r.out, r.err);

    let r = ask(&node, &["sign-in", "--key-file", key_file(&home, KEY, 0o644).to_str().unwrap()]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("chmod 600") && !r.err.contains(KEY), "{}", r.err);
    let r = ask(&node, &["sign-in", "--key-file", key_file(&home, "not a key", 0o600).to_str().unwrap()]);
    assert_eq!(r.code, Some(1));
    assert!(r.err.contains("isn't a wallet key"), "{}", r.err);
    let file = key_file(&home, KEY, 0o600);
    let r = ask(&node, &["sign-in", "--key-file", file.to_str().unwrap()]);
    assert_eq!(r.code, Some(1), "{}", r.out);
    assert!(r.err.contains("no owner passphrase is set"), "no screen and no passphrase is a no: {}", r.err);
    assert!(!r.out.contains(KEY) && !r.err.contains(KEY), "the key is never said");
    unlinked(ask(&node, &["wallet"]));

    // The owner sets their passphrase on the terminal: the code it shows, typed back, then the passphrase twice.
    let mut set = OnTerminal::start(&home, node.port, &["passphrase"]);
    let shown = set.wait_for("to allow it");
    let code = shown.rsplit("Type ").next().and_then(|t| t.split_whitespace().next()).unwrap().to_string();
    set.type_line(&code);
    set.wait_for("A new owner passphrase");
    set.type_line(PASSPHRASE);
    set.wait_for("The same again");
    set.type_line(PASSPHRASE);
    let (code, shown) = set.ended();
    assert_eq!(code, Some(0), "{shown}");

    // The sign-in waits on the owner's yes; the owner gives it on the terminal.
    let signing = command(&home, node.port, &["sign-in", "--key-file", file.to_str().unwrap()]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut yes = OnTerminal::start(&home, node.port, &["confirm"]);
    let shown = yes.wait_for("Type the owner passphrase to allow it");
    assert!(shown.contains("link this wallet to this node"), "the owner is shown what they allow: {shown}");
    yes.type_line(PASSPHRASE);
    let (code, shown) = yes.ended();
    assert_eq!(code, Some(0), "{shown}");
    let signed = signing.wait_with_output().unwrap();
    let (out, err) = (String::from_utf8_lossy(&signed.stdout).into_owned(), String::from_utf8_lossy(&signed.stderr).into_owned());
    assert_eq!(signed.status.code(), Some(0), "{out}{err}");
    let wallet = out.lines().find_map(|l| l.strip_prefix("linked ")?.strip_suffix(" to this node")).unwrap_or_else(|| panic!("{out}"));
    assert!(wallet.starts_with("0x") && wallet.len() == 42, "{out}");
    assert!(!out.contains(KEY) && !err.contains(KEY), "the key is never said");
    let r = ask(&node, &["wallet"]);
    assert!(r.out.contains(wallet), "the node says the wallet is linked: {}", r.out);
    node.stop();
    let _ = std::fs::remove_dir_all(&home);
}

impl OnTerminal {
    /// Waits until the terminal has shown `text` `times` times, for a prompt asked again.
    fn wait_for_times(&self, text: &str, times: usize) -> String {
        let until = Instant::now() + Duration::from_secs(90);
        loop {
            let now = self.shown.lock().unwrap().clone();
            if now.matches(text).count() >= times {
                return now;
            }
            assert!(Instant::now() < until, "the terminal never showed {text:?} {times} times: {now}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// A node `onboard` started in the background, stopped when the test ends however it ends.
struct Started(Option<u32>);

impl Drop for Started {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            let _ = Command::new("kill").arg(pid.to_string()).status();
            let until = Instant::now() + Duration::from_secs(30);
            while Path::new(&format!("/proc/{pid}")).exists() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// The CLI onboarding, end to end on the real program from a clean home, with no node running, no window and no
/// screen: `unbrowse-node onboard` starts the node, sets the owner passphrase (the code it shows typed back), takes the
/// terms only once `accept` is typed (a word it doesn't know asked again, `show` printing them), asks how to sign in
/// (a choice that isn't one asked again, a key file others can read refused and asked again), and links the wallet once
/// the owner's yes is typed on the same terminal (a wrong passphrase asked again). `onboard status` says not signed in
/// before and signed in after; the key is never said.
#[test]
fn a_new_owner_onboards_from_a_clean_home_on_one_terminal_with_no_window() {
    use std::os::unix::fs::PermissionsExt;
    const KEY: &str = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
    const PASSPHRASE: &str = "the owner's own words, typed";
    let home = home("onboard");
    let port = free_port();
    let status = |home: &Path| {
        let o = command(home, port, &["onboard", "status"]).stdin(Stdio::null()).output().unwrap();
        Ran { code: o.status.code(), out: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
    };
    let before = status(&home);
    assert_eq!(before.code, Some(1), "{}{}", before.out, before.err);
    assert!(before.out.contains("node: not running") && before.out.contains("signed in: no") && before.out.contains("not acknowledged"), "{}", before.out);

    let mut on = OnTerminal::start(&home, port, &["onboard"]);
    let shown = on.wait_for("Signing in needs one");
    let node = Started(shown.split("(pid ").nth(1).and_then(|t| t.split(|c: char| !c.is_ascii_digit()).next()).and_then(|p| p.parse().ok()));
    assert!(node.0.is_some() && shown.contains("1/4 node: started"), "{shown}");
    assert!(answers(port), "the node it started answers on its port");
    let shown = on.wait_for("to allow it, or press Enter");
    assert!(shown.contains("Signing in needs one"), "with no screen the passphrase is asked for, said why: {shown}");
    let code = shown.rsplit("Type ").next().and_then(|t| t.split_whitespace().next()).unwrap().to_string();
    on.type_line(&code);
    on.wait_for("A new owner passphrase");
    on.type_line(PASSPHRASE);
    on.wait_for("The same again");
    on.type_line(PASSPHRASE);

    on.wait_for("Type `accept`");
    on.type_line("maybe");
    on.wait_for("isn't one of accept, show or Enter");
    on.wait_for_times("Type `accept`", 2);
    on.type_line("show");
    on.wait_for("Unbrowse AI Pte. Ltd.");
    on.wait_for_times("Type `accept`", 3);
    on.type_line("accept");
    on.wait_for("3/4 terms 2026-11-01: acknowledged; the node joins the peer network");

    on.wait_for("Type 1, 2 or 3");
    on.type_line("4");
    on.wait_for("that isn't 1, 2 or 3");
    on.wait_for_times("Type 1, 2 or 3", 2);
    on.type_line("2");
    on.wait_for("The key file's path");
    // Made now, with the node up: a node starting tightens what is in its home.
    let loose = home.join("loose.key");
    std::fs::write(&loose, format!("0x{KEY}\n")).unwrap();
    std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).unwrap();
    let file = key_file(&home, KEY, 0o600);
    on.type_line(loose.to_str().unwrap());
    on.wait_for("chmod 600");
    on.wait_for_times("The key file's path", 2);
    on.type_line(file.to_str().unwrap());

    let shown = on.wait_for("Type the owner passphrase to allow it");
    assert!(shown.contains("link this wallet to this node"), "the owner is shown what they allow: {shown}");
    on.type_line("not it");
    on.wait_for("more tries");
    on.wait_for_times("Type the owner passphrase to allow it", 2);
    on.type_line(PASSPHRASE);
    let (code, shown) = on.ended();
    assert_eq!(code, Some(0), "{shown}");
    assert!(shown.contains("done: this node is signed in"), "{shown}");
    let wallet = shown.lines().find_map(|l| l.trim().strip_prefix("4/4 signed in as ")).unwrap_or_else(|| panic!("{shown}")).to_string();
    assert!(wallet.starts_with("0x") && wallet.len() == 42, "{shown}");
    assert!(!shown.contains(KEY), "the key is never said");

    let after = status(&home);
    assert_eq!(after.code, Some(0), "{}{}", after.out, after.err);
    assert!(after.out.contains(&format!("signed in: yes, as {wallet}")) && after.out.contains("owner passphrase: set") && after.out.contains("terms 2026-11-01: acknowledged"), "{}", after.out);

    // Run again, everything done already: nothing is asked, and it ends signed in.
    let on = OnTerminal::start(&home, port, &["onboard"]);
    let (code, shown) = on.ended();
    assert_eq!(code, Some(0), "{shown}");
    assert!(!shown.contains("Type "), "nothing is asked: {shown}");
    for done in ["1/4 node: running", "2/4 owner passphrase: set already", "3/4 terms 2026-11-01: acknowledged already", format!("4/4 signed in already as {wallet}").as_str()] {
        assert!(shown.contains(done), "{done}: {shown}");
    }
    drop(node);
    let _ = std::fs::remove_dir_all(&home);
}
