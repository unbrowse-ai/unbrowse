//! What the generated-program gate does with what it is handed: the environment a program is fed, the verdicts that need
//! no runtime, the proposer's command and what it says.

use super::*;
use unbrowse_route::Reach;

fn sample(url: &str, body: Option<&str>, expected: &str) -> Sample {
    Sample { method: "POST".into(), url: url.into(), body: body.map(String::from), cookies: vec![("sid".into(), "c-1".into())], headers: vec![("x-trace".into(), "t-9".into())], expected: expected.into(), pre: None }
}

fn env_with(fingerprint: serde_json::Value) -> Environment {
    Environment { fingerprint, ..Default::default() }
}

/// A program's reads are put where the page's own code finds them: a cookie in the jar, a key in the store it names,
/// a property on `navigator`; a read fed nothing is taken away, as a page that lacked it would find nothing, and a
/// read fed a value replaces what the walk's environment held.
#[test]
fn a_programs_reads_are_put_where_the_pages_code_finds_them_and_a_read_fed_nothing_is_taken_away() {
    let mut env = env_with(serde_json::json!({ "ua": "WalkedUA/1.0", "cores": 4, "langs": ["fr"] }));
    env.storage.local.insert("seed".into(), "old".into());
    env.storage.local.insert("gone".into(), "x".into());
    env.storage.session.insert("tab".into(), "one".into());
    let cookies = vec![("sid".to_string(), "c-1".to_string()), ("theme".to_string(), "dark".to_string())];
    let reads = [
        (Reach::Cookie("sid".into()), Some("c-2".to_string())),
        (Reach::Cookie("theme".into()), None),
        (Reach::Local("seed".into()), Some("new".to_string())),
        (Reach::Local("gone".into()), None),
        (Reach::Session("tab".into()), Some("two".to_string())),
        (Reach::Session("absent".into()), None),
        (Reach::Navigator("userAgent".into()), Some("FedUA/2.0".to_string())),
        (Reach::Navigator("hardwareConcurrency".into()), None),
        (Reach::Navigator("languages".into()), Some("en-SG,en;q=0.9, ;q=0.1,zh".to_string())),
        (Reach::Navigator("webdriver".into()), Some("false".to_string())),
    ];
    let (fed_env, fed_cookies) = fed(&env, &cookies, &reads);
    assert_eq!(fed_cookies, vec![("sid".to_string(), "c-2".to_string())], "the cookie fed replaces, the one fed nothing is gone");
    assert_eq!((fed_env.storage.local.get("seed").map(String::as_str), fed_env.storage.local.get("gone")), (Some("new"), None));
    assert_eq!(fed_env.storage.session.get("tab").map(String::as_str), Some("two"));
    assert_eq!(fed_env.fingerprint["ua"], "FedUA/2.0");
    assert!(fed_env.fingerprint.get("cores").is_none(), "a navigator read fed nothing is removed");
    assert_eq!(fed_env.fingerprint["langs"], serde_json::json!(["en-SG", "en", "zh"]), "languages are said as the header says them, one after another");
    assert!(fed_env.fingerprint.get("webdriver").is_none(), "a property the sandbox answers from no recording is left alone");
    // The walk's own environment is not changed by being fed.
    assert_eq!(env.fingerprint["ua"], "WalkedUA/1.0");
    assert_eq!(env.storage.local.get("seed").map(String::as_str), Some("old"));
}

/// A walk with no recorded browser still has a navigator to read once a read is fed.
#[test]
fn a_fingerprint_that_is_no_object_is_made_one_to_feed() {
    let env = env_with(serde_json::Value::Null);
    let (fed_env, _) = fed(&env, &[], &[(Reach::Navigator("platform".into()), Some("Linux x86_64".to_string()))]);
    assert_eq!(fed_env.fingerprint, serde_json::json!({ "platform": "Linux x86_64" }));
}

#[test]
fn each_navigator_property_a_program_reads_is_the_key_the_sandbox_answers_it_under() {
    let said: Vec<_> = ["userAgent", "language", "languages", "platform", "vendor", "hardwareConcurrency", "maxTouchPoints", "plugins", ""].iter().map(|n| navigator_key(n)).collect();
    assert_eq!(said, [Some("ua"), Some("lang"), Some("langs"), Some("platform"), Some("vendor"), Some("cores"), Some("touch"), None, None]);
}

/// The proposer is named by the first word of its command, whatever arguments follow it.
#[test]
fn a_proposer_is_named_by_the_first_word_of_its_command() {
    assert_eq!(who("claude -p --model opus"), "claude");
    assert_eq!(who("  /usr/bin/agent   --flag"), "/usr/bin/agent");
    assert_eq!(who(""), "");
}

/// The evidence a program was proposed from has a name that changes with any part of it a proposer was shown: the
/// header, a call's method, address, body or the value it was to make.
#[test]
fn the_name_of_the_evidence_changes_with_any_part_of_it() {
    let base = [sample("https://shop.example/api?d=1", Some("a"), "x-1")];
    let hash = evidence_hash("x-sig", &base);
    assert_eq!(hash.len(), 64);
    assert_eq!(hash, evidence_hash("x-sig", &base), "the same evidence is the same name");
    assert_ne!(hash, evidence_hash("x-other", &base));
    assert_ne!(hash, evidence_hash("x-sig", &[sample("https://shop.example/api?d=2", Some("a"), "x-1")]));
    assert_ne!(hash, evidence_hash("x-sig", &[sample("https://shop.example/api?d=1", Some("b"), "x-1")]));
    assert_ne!(hash, evidence_hash("x-sig", &[sample("https://shop.example/api?d=1", Some("a"), "x-2")]));
    assert_ne!(hash, evidence_hash("x-sig", &[Sample { method: "GET".into(), ..base[0].clone() }]));
    assert_ne!(hash, evidence_hash("x-sig", &[]), "no sighting is another name");
}

/// The program is the code in what an agent said: itself, or what a fence holds (an agent that explains is still read for
/// its code); prose before an unfenced program is cut at the line that starts it; nothing said is no program.
#[test]
fn the_program_is_the_code_in_what_an_agent_said() {
    assert_eq!(code_of("function sign(ctx) { return 'a'; }"), Some("function sign(ctx) { return 'a'; }".to_string()));
    assert_eq!(code_of("  \n  "), None);
    assert_eq!(code_of(""), None);
    assert_eq!(code_of("Here you go:\n```javascript\nfunction sign(ctx) { return 'b'; }\n```\nHope it helps."), Some("function sign(ctx) { return 'b'; }".to_string()));
    assert_eq!(code_of("```js\r\nfunction sign(ctx) { return 'c'; }\n```"), Some("function sign(ctx) { return 'c'; }".to_string()));
    assert_eq!(code_of("```\nconst sign = (ctx) => 'd';\n```"), Some("const sign = (ctx) => 'd';".to_string()));
    assert_eq!(code_of("I looked at the page code.\nfunction sign(ctx) { return 'e'; }"), Some("function sign(ctx) { return 'e'; }".to_string()), "prose before the program is cut off");
    assert_eq!(code_of("async function sign(ctx) { return 'f'; }"), Some("async function sign(ctx) { return 'f'; }".to_string()));
    assert_eq!(code_of("no code here at all"), Some("no code here at all".to_string()), "nothing marks a start: it is all taken");
    // An empty fence says nothing of its own: what is outside it is read instead.
    assert_eq!(code_of("```\n\n```\nvar sign = function () { return 'g'; }"), Some("var sign = function () { return 'g'; }".to_string()));
    assert_eq!(code_of("```js\nfunction sign(ctx) { return 'h'; }"), Some("function sign(ctx) { return 'h'; }".to_string()), "an unclosed fence is no fence: the program starts where it says");
}

/// A proposer's command is run by the shell with the evidence on its stdin, and what it writes is what it said; a
/// command that fails or cannot be run says nothing.
#[test]
fn a_proposers_command_reads_the_evidence_on_stdin_and_what_it_writes_is_what_it_said() {
    assert_eq!(run_agent("cat", "the evidence").as_deref(), Some("the evidence"));
    let big = "x".repeat(300_000);
    assert_eq!(run_agent("cat", &big).map(|s| s.len()), Some(300_000), "an answer larger than a pipe holds is not a hang");
    assert_eq!(run_agent("printf 'function sign(ctx) { return 1; }'", "").as_deref(), Some("function sign(ctx) { return 1; }"));
    assert_eq!(run_agent("echo said; exit 3", ""), None, "a command that fails says nothing");
    assert_eq!(run_agent("exec 0<&-; echo ignored-the-evidence", &big).as_deref(), Some("ignored-the-evidence\n"), "an agent that never reads its stdin does not block");
}

/// A program that is empty, a call with no sighting, one that carries a sighting's value, and a run with fewer worlds
/// than sightings are refused before anything runs.
#[test]
fn a_program_is_refused_before_it_runs_when_it_is_empty_has_no_sighting_or_carries_one() {
    let two = [sample("https://shop.example/a/1", None, "value-one-1234"), sample("https://shop.example/a/2", None, "value-two-5678")];
    for refused in [verify("  ", &two, &Environment::default()), verify_each(" \n", &two, &[Environment::default(), Environment::default()])] {
        assert_eq!(refused, Verdict::Failed("the agent proposed no program".into()));
    }
    let none = Verdict::Failed("no sighting of the value to judge a program by".into());
    assert_eq!(verify("function sign(ctx) { return 1; }", &[], &Environment::default()), none);
    assert_eq!(verify_each("function sign(ctx) { return 1; }", &[], &[]), none);
    assert_eq!(verify_each("function sign(ctx) { return 1; }", &two, &[Environment::default()]), none, "an environment for each sighting");
    let carried = "function sign(ctx) { return 'value-two-5678'; }";
    let carries = Verdict::Failed("the program carries a sighting's own value instead of computing it".into());
    assert_eq!(verify(carried, &two, &Environment::default()), carries);
    assert_eq!(verify_each(carried, &two, &[Environment::default(), Environment::default()]), carries);
    // A short value is not a carried answer: it may be a constant prefix.
    let short = [sample("https://shop.example/a/1", None, "ab")];
    assert!(!matches!(verify_each("function sign(ctx) { return 'ab'; }", &short, &[Environment::default()]), Verdict::Failed(why) if why.contains("carries")));
}

/// The input a program never saw is moved by a digit of the path where the path has one (a 9 falling to 8, not carrying
/// into a longer number), and by a query otherwise, whether the address reads or not.
#[test]
fn an_input_the_program_never_saw_is_the_sighting_with_one_value_moved() {
    let moved = |url: &str| perturbed(&sample(url, None, "x")).url;
    assert_eq!(moved("https://shop.example/items/41"), "https://shop.example/items/42");
    assert_eq!(moved("https://shop.example/items/49"), "https://shop.example/items/48");
    assert_eq!(moved("https://shop.example/items/a1b?x=1"), "https://shop.example/items/a2b?x=1");
    assert_eq!(moved("https://shop.example/items/all"), "https://shop.example/items/all?ubrowse=1");
    assert_eq!(moved("not an address"), "not an address?ubrowse=1");
    let original = sample("https://shop.example/items/41", Some("b"), "x");
    let changed = perturbed(&original);
    assert_eq!((changed.body, changed.expected, changed.cookies), (original.body, original.expected, original.cookies), "only the address moves");
}

/// With a runtime, a program run per sighting in its own world is held to each; the runs that need none are above.
#[test]
fn a_program_held_to_each_sightings_own_world_is_judged_by_what_each_gave() {
    if !crate::sandbox::available() {
        eprintln!("no signing runtime on this machine: the per-world verifier is skipped");
        return;
    }
    let program = "function sign(ctx) { return 'v-' + localStorage.getItem('seed'); }";
    let world = |seed: &str| {
        let mut env = Environment::default();
        env.storage.local.insert("seed".into(), seed.into());
        env
    };
    let samples = [sample("https://shop.example/a/10", None, "v-aaa"), sample("https://shop.example/a/20", None, "v-bbb")];
    assert_eq!(verify_each(program, &samples, &[world("aaa"), world("bbb")]), Verdict::Passed);
    assert_eq!(verify_each(program, &samples, &[world("aaa"), world("zzz")]), Verdict::Differs, "it runs, and its value is not the walk's");
    assert!(matches!(verify_each("function sign(ctx) { throw new Error('no'); }", &samples, &[world("aaa"), world("bbb")]), Verdict::Failed(why) if why.contains("sighting 1 of 2")));
    // It reproduces both but answers nothing on the input it never saw.
    let silent = "function sign(ctx) { return ctx.path.endsWith('/10') ? 'v-aaa' : (ctx.path.endsWith('/20') ? 'v-bbb' : ''); }";
    assert_eq!(verify_each(silent, &samples, &[world("aaa"), world("bbb")]), Verdict::Failed("answered nothing on an input it never saw".into()));
    let picky = "function sign(ctx) { if (ctx.path.endsWith('/10')) return 'v-aaa'; if (ctx.path.endsWith('/20')) return 'v-bbb'; throw new Error('new input'); }";
    assert!(matches!(verify_each(picky, &samples, &[world("aaa"), world("bbb")]), Verdict::Failed(why) if why.starts_with("failed on an input it never saw")));
    // One sighting is a candidate, never a proof.
    assert_eq!(verify_each(program, &samples[..1], &[world("aaa")]), Verdict::Differs);
}

/// A program run by a call reads what it is fed, and a decoder is judged by what it makes of each reply: JSON that holds
/// the word asked, different between walks, from a reply the standard readers could not read.
#[test]
fn a_decoder_is_judged_by_what_it_makes_of_each_walks_reply() {
    if !crate::sandbox::available() {
        eprintln!("no signing runtime on this machine: the decoder test is skipped");
        return;
    }
    let env = Environment::default();
    let decoder = "function sign(ctx) { return atob(ctx.body.replace('x:', '')); }";
    let enc = |json: &str| format!("x:{}", crate::sandbox::run_program("function sign(ctx) { return btoa(ctx.body); }", &serde_json::json!({ "body": json }), &serde_json::Value::Null, &Default::default()).expect("btoa"));
    let (lamp, sofa) = (enc(r#"{"items":["lamp one"]}"#), enc(r#"{"items":["sofa one"]}"#));
    let never = |_: &str| false;
    let replies = vec![(lamp.clone(), vec!["lamp".to_string(), String::new()]), (sofa.clone(), vec!["sofa".to_string()])];
    assert!(verify_decoder(decoder, &replies, &never, &env));
    assert_eq!(decode(decoder, &lamp, &env).as_deref(), Some(r#"{"items":["lamp one"]}"#));
    assert_eq!(decode("function sign(ctx) { return ''; }", &lamp, &env), None, "an empty answer is none");
    assert_eq!(decode("function sign(ctx) { throw 1; }", &lamp, &env), None);
    assert!(!verify_decoder(decoder, &replies[..1], &never, &env), "one reply could be a constant");
    assert!(!verify_decoder(decoder, &replies, &|_: &str| true, &env), "a reply the standard readers read is no rung-2 decode");
    let wrong_word = vec![(lamp.clone(), vec!["chair".to_string()]), (sofa.clone(), vec!["sofa".to_string()])];
    assert!(!verify_decoder(decoder, &wrong_word, &never, &env), "the answer holds the word that walk was asked");
    assert!(!verify_decoder("function sign(ctx) { return 'not json'; }", &replies, &never, &env));
    assert!(!verify_decoder("function sign(ctx) { throw 1; }", &replies, &never, &env));
    let constant = "function sign(ctx) { return '{\"items\":[\"lamp sofa\"]}'; }";
    assert!(!verify_decoder(constant, &replies, &never, &env), "the same answer for both walks is no decoding");
}

/// A call runs a program with what it is fed: the walk's world with each read put where the page's code finds it; and
/// what the program read of that world is said back by name.
#[test]
fn a_program_a_call_runs_reads_what_it_is_fed_and_says_what_it_read() {
    if !crate::sandbox::available() {
        eprintln!("no signing runtime on this machine: the fed-program test is skipped");
        return;
    }
    let program = "function sign(ctx) { return localStorage.getItem('seed') + '|' + (document.cookie.match(/sid=([^;]+)/) || [])[1] + '|' + navigator.userAgent; }";
    let env = env_with(serde_json::json!({ "ua": "WalkedUA/1.0" }));
    let request = crate::replay::Request { method: "GET".into(), url: "https://shop.example/api".parse().unwrap(), exchange: 0, headers: vec![], body: None };
    let reads = [(Reach::Local("seed".into()), Some("s-9".to_string())), (Reach::Cookie("sid".into()), Some("c-7".to_string())), (Reach::Navigator("userAgent".into()), Some("FedUA/3".to_string()))];
    assert_eq!(compute_reading(program, &request, &[("sid".into(), "walked".into())], &env, &reads).as_deref(), Some("s-9|c-7|FedUA/3"));
    // A read fed nothing is a page that lacked it: the program cannot answer.
    assert_eq!(compute_reading(program, &request, &[], &env, &[(Reach::Local("seed".into()), None)]).as_deref(), Some("null|undefined|WalkedUA/1.0"));
    let s = sample("https://shop.example/api", None, "x");
    let read = reads_of(program, &s, &env);
    for what in ["localStorage seed", "document.cookie", "navigator.userAgent"] {
        assert!(read.iter().any(|r| r == what), "{what} in {read:?}");
    }
}

/// A page-shaped environment boots the page once for every sighting and the input it never saw: the verdicts are those
/// of the minimal sandbox's, and a sandbox that answers nothing or fails says so.
#[test]
fn a_page_shaped_environment_is_judged_as_the_minimal_one_is() {
    if !crate::sandbox::available() {
        eprintln!("no signing runtime on this machine: the page-shaped verdict test is skipped");
        return;
    }
    let env = Environment { page_url: Some("https://shop.example/search".into()), html: Some("<html></html>".into()), ..Default::default() };
    let two = [sample("https://shop.example/api?d=1", Some("a"), "wanted-1"), sample("https://shop.example/api?d=2", Some("b"), "wanted-2")];
    assert_eq!(verify("function sign(ctx) { return ctx.body; }", &two, &env), Verdict::Differs, "it runs, and its values are not the walk's");
    let right = [sample("https://shop.example/api?d=1", Some("a"), "a"), sample("https://shop.example/api?d=2", Some("b"), "b")];
    assert_eq!(verify("function sign(ctx) { return ctx.body; }", &right, &env), Verdict::Passed);
    assert_eq!(verify("function sign(ctx) { return ctx.body; }", &right[..1], &env), Verdict::Differs, "one sighting is a candidate, never a proof");
    let silent = [sample("https://shop.example/api/x10", Some("a"), "a"), sample("https://shop.example/api/x20", Some("b"), "b")];
    assert_eq!(verify("function sign(ctx) { return ctx.path.endsWith('x10') || ctx.path.endsWith('x20') ? ctx.body : ''; }", &silent, &env), Verdict::Failed("answered nothing on an input it never saw".into()));
    assert!(matches!(verify("function sign(ctx) { throw new Error('no'); }", &right, &env), Verdict::Failed(_)));
}

/// An agent that hangs is killed at the budget the owner set, and the route keeps the page's own code: it is none, and
/// it is none promptly.
#[test]
fn an_agent_that_runs_past_its_budget_is_killed_and_says_nothing() {
    // The only reader of the budget is `run_agent`; the guard keeps two runs from naming it at once.
    static BUDGET: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = BUDGET.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("UNBROWSE_GENERATE_MS", "300");
    let started = std::time::Instant::now();
    let said = run_agent("sleep 30; echo too late", "evidence");
    std::env::remove_var("UNBROWSE_GENERATE_MS");
    assert_eq!(said, None);
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "killed at the budget, not waited for: {:?}", started.elapsed());
}

/// What an agent is shown of a session's secrets is their length: an empty one, and a credential that is not text,
/// are shown as redacted too, and a header that is no credential is left as it was.
#[test]
fn a_secret_an_agent_is_shown_is_redacted_even_when_it_is_empty_or_not_text() {
    let ctx = serde_json::json!({
        "cookies": { "empty": "", "number": 7, "sid": "c-1-2-3-4" },
        "headers": { "x-api-key": "", "x-csrf-token": 12345, "accept": "application/json" },
        "body": null
    });
    let shown = shown_context(&ctx);
    assert_eq!(shown["cookies"]["empty"], "<redacted>");
    assert_eq!(shown["cookies"]["number"], "<redacted>");
    assert_eq!(shown["cookies"]["sid"], "<redacted 9 chars>");
    assert_eq!(shown["headers"]["x-api-key"], "<redacted>");
    assert_eq!(shown["headers"]["x-csrf-token"], "<redacted>");
    assert_eq!(shown["headers"]["accept"], "application/json");
    assert_eq!(shown["body"], serde_json::Value::Null);
    // A context with no cookies or headers is shown as it is.
    assert_eq!(shown_context(&serde_json::json!({ "body": "b" })), serde_json::json!({ "body": "b" }));
}

/// The proposer is asked with the evidence on its stdin (the header, the instruction, each sighting with its secrets
/// redacted and the value to make, the page's code, why a last program was refused) and what it writes back is the program;
/// with no command in the setting there is no proposal. The command is the owner's setting, so a run that names it holds
/// the setting for the others only as long as it takes, and the command answers nobody's evidence but its own.
#[test]
fn a_proposer_is_shown_the_evidence_with_its_secrets_redacted_and_what_it_writes_is_the_program() {
    static SETTING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = SETTING.lock().unwrap_or_else(|e| e.into_inner());
    let dir = std::env::temp_dir().join(format!("proposer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let seen = dir.join("seen.json");
    // Answers only the evidence that names this test's header; any other proposal asked of it in the meantime is refused.
    let command = format!(
        "in=$(cat); case \"$in\" in *x-zzz-unit-header*) printf '%s' \"$in\" > {}; printf '```js\\nfunction sign(ctx) {{ return 1; }}\\n```';; *) exit 1;; esac",
        seen.display()
    );
    std::env::set_var("UNBROWSE_GENERATE_PROGRAM", &command);
    std::env::set_var("UNBROWSE_SIGN_DEBUG", "1");
    let configured = enabled();
    let mut shown = sample("https://shop.example/api?d=1", Some("{\"d\":1}"), "sig-1");
    shown.pre = Some("pre-encoded-text".into());
    let asked = propose("x-zzz-unit-header", &[shown, sample("https://shop.example/api?d=2", None, "sig-2")], Some("function page() {}"), Some("it answered nothing"));
    std::env::remove_var("UNBROWSE_GENERATE_PROGRAM");
    std::env::remove_var("UNBROWSE_SIGN_DEBUG");
    let refused = propose("x-zzz-unit-header", &[], None, None);
    assert!(configured, "a command in the setting is an agent configured");
    assert_eq!(asked.as_deref(), Some("function sign(ctx) { return 1; }"), "the program is what the fence holds");
    assert_eq!(refused, None, "no command, no proposal");
    let said: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&seen).expect("the agent was asked")).unwrap();
    assert_eq!(said["header"], "x-zzz-unit-header");
    assert!(said["instruction"].as_str().is_some_and(|i| i.contains("function sign(ctx)")));
    assert_eq!(said["page_code"], "function page() {}");
    assert_eq!(said["feedback"], "it answered nothing");
    let samples = said["samples"].as_array().expect("the sightings");
    assert_eq!(samples.len(), 2);
    assert_eq!(samples[0]["expected"], "sig-1");
    assert_eq!(samples[0]["pre_encoded_from"], "pre-encoded-text");
    assert!(samples[1].get("pre_encoded_from").is_none());
    assert_eq!(samples[0]["context"]["cookies"]["sid"], "<redacted 3 chars>", "the agent never sees the session's cookie");
    assert_eq!(samples[0]["context"]["body"], "{\"d\":1}");
    let _ = std::fs::remove_dir_all(&dir);
}
