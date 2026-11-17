//! `unbrowse-node wallet` run from a shell, with no node running, in a home of its own (`UNBROWSE_HOME`): it prints
//! the node's own address from the root key store, and nothing secret. A test build is a dev build, which keeps its
//! root key in a file (`devnet/root.key`), so these tests never touch the system's keystore.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The root key every test here uses, and the address it makes.
const KEY: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const ADDRESS: &str = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

/// A home with the root key in its file. Every test has one: a dev build with no key file falls back to the system's
/// keystore, which these tests never touch.
fn home(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("unbrowse-cli-wallet-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("devnet")).unwrap();
    std::fs::write(d.join("devnet/root.key"), KEY).unwrap();
    d
}

/// Runs `unbrowse-node <args>` in `home` on the devnet, whose chain isn't running, with `path` as its PATH when given.
fn node(home: &Path, args: &[&str], path: Option<&Path>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_unbrowse-node"));
    cmd.args(args).env("UNBROWSE_HOME", home).env("UNBROWSE_CHAIN", "devnet").env("UNBROWSE_DEVNET_PORT", "1");
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    cmd.output().unwrap()
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

/// `wallet address` prints the address alone, one line, so it pipes; no node is running, and the key is never shown.
#[test]
fn the_address_prints_alone_with_no_node_running() {
    let h = home("bare");
    let o = node(&h, &["wallet", "address"], None);
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o), format!("{ADDRESS}\n"));
    assert!(!out(&o).contains(KEY) && !err(&o).contains(KEY), "nothing secret is printed");
    let _ = std::fs::remove_dir_all(&h);
}

/// Plain `wallet` names the node's own wallet and says it is one, the linked wallet (none here, and none is needed), the
/// network, and the gas it couldn't read from a chain that isn't running, without waiting long on it.
#[test]
fn the_wallet_says_the_address_owner_network_and_gas() {
    let h = home("full");
    let t = std::time::Instant::now();
    let o = node(&h, &["wallet"], None);
    assert!(o.status.success(), "{}", err(&o));
    let s = out(&o);
    assert!(s.contains(&format!("this node's wallet: {ADDRESS}")), "{s}");
    assert!(s.contains("an Arc wallet made from the node's own key") && s.contains("with no sign-in"), "{s}");
    assert!(s.contains("linked wallet: none"), "{s}");
    assert!(s.contains("network: devnet"), "{s}");
    assert!(s.contains("gas: couldn't read it"), "{s}");
    assert!(t.elapsed() < std::time::Duration::from_secs(20), "{:?}", t.elapsed());
    assert!(!s.contains(KEY) && !err(&o).contains(KEY));
    let _ = std::fs::remove_dir_all(&h);
}

/// With no clipboard tool on the PATH, `--copy` still prints the address, says none was found, and doesn't fail.
#[test]
fn copy_falls_back_cleanly_with_no_clipboard_tool() {
    let h = home("copy");
    let empty = h.join("no-tools");
    std::fs::create_dir_all(&empty).unwrap();
    let o = node(&h, &["wallet", "address", "--copy"], Some(&empty));
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(out(&o), format!("{ADDRESS}\n"), "stdout stays the address alone");
    assert!(err(&o).contains("no clipboard tool found") && err(&o).contains("copy the address above by hand"), "{}", err(&o));
    let _ = std::fs::remove_dir_all(&h);
}

/// A clipboard tool on the PATH gets the address, and nothing else, on its input.
#[cfg(unix)]
#[test]
fn copy_hands_the_address_to_the_clipboard_tool() {
    use std::os::unix::fs::PermissionsExt;
    let h = home("copy-tool");
    let tools = h.join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    let got = h.join("clipboard.txt");
    let tool = if cfg!(target_os = "macos") { "pbcopy" } else { "wl-copy" };
    let script = tools.join(tool);
    std::fs::write(&script, format!("#!/bin/sh\n/bin/cat > '{}'\n", got.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let o = node(&h, &["wallet", "address", "--copy"], Some(&tools));
    assert!(o.status.success(), "{}", err(&o));
    assert_eq!(std::fs::read_to_string(&got).unwrap(), ADDRESS);
    assert!(err(&o).contains(&format!("({tool})")), "{}", err(&o));
    let _ = std::fs::remove_dir_all(&h);
}

/// Anything else is refused with the usage, and `wallet restore` is still there.
#[test]
fn other_wallet_words_show_the_usage() {
    let h = home("usage");
    let o = node(&h, &["wallet", "send"], None);
    assert_eq!(o.status.code(), Some(2));
    assert!(err(&o).contains("unbrowse-node wallet restore") && err(&o).contains("unbrowse-node wallet address"), "{}", err(&o));
    let _ = std::fs::remove_dir_all(&h);
}

/// `wallet restore` takes 12 seed words on stdin: the node becomes the wallet any wallet app opens with them, keeps the
/// words beside the key, and keeps the key it replaced. The words are never printed back.
#[test]
fn restore_takes_twelve_seed_words_from_stdin() {
    use std::io::Write;
    let h = home("restore-seed");
    let words = "test test test test test test test test test test test junk";
    let mut child = Command::new(env!("CARGO_BIN_EXE_unbrowse-node"))
        .args(["wallet", "restore"])
        .env("UNBROWSE_HOME", &h)
        .env("UNBROWSE_CHAIN", "devnet")
        .env("UNBROWSE_DEVNET_PORT", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(words.as_bytes()).unwrap();
    let o = child.wait_with_output().unwrap();
    assert!(o.status.success(), "{}", err(&o));
    assert!(out(&o).starts_with("restored 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"), "{}", out(&o));
    assert!(out(&o).contains(ADDRESS), "names the key it kept: {}", out(&o));
    assert!(!out(&o).contains("junk") && !err(&o).contains("junk"), "the words are never printed");
    assert!(h.join("devnet/root.key.seed").exists(), "the seed words are kept beside the key");
    assert!(h.join(format!("devnet/root.key.replaced.{ADDRESS}")).exists(), "the old key is kept");
    let o = node(&h, &["wallet", "address"], None);
    assert_eq!(out(&o), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\n");
    let _ = std::fs::remove_dir_all(&h);
}

/// `agent new` on a node the owner keeps off the network makes the key and prints its setup, and touches no chain: a
/// local node writes nothing there (R1.35), and joining grants the key.
#[test]
fn a_local_nodes_agent_key_is_made_without_the_chain() {
    let h = home("agent-local");
    let off = node(&h, &["network", "off"], None);
    assert!(off.status.success(), "{}", err(&off));
    let o = node(&h, &["agent", "new", "drive"], None);
    assert!(o.status.success(), "{}", err(&o));
    assert!(out(&o).contains("export UNBROWSE_AGENT_TOKEN="), "{}", out(&o));
    assert!(err(&o).contains("once the node is on the network and its wallet holds USDC it pays for other people's routes too"), "{}", err(&o));
    assert!(!err(&o).contains("authorising it to pay failed"), "it never tried: {}", err(&o));
    assert!(!h.join("devnet/deployment.json").exists() && !h.join("devnet/state.json").exists(), "no devnet was started or deployed");
    let _ = std::fs::remove_dir_all(&h);
}
