//! The agent's flow through the test shop: sign in, search, add to cart, place an order.

use unbrowse_learn::Session;

use super::agent::Agent;

pub struct Run {
    pub user: &'static str,
    pub query: &'static str,
    pub note: &'static str,
}

/// The agent places an order; returns the session the node captured.
pub fn browse(base: &str, session: &str, run: &Run) -> Session {
    let agent = Agent::new(session);
    let password = format!("pw-{}", run.user);
    agent.run(&["open", &format!("{base}/")]);
    agent.run(&["wait", "500"]);
    agent.run(&["fill", "#user", run.user]);
    agent.run(&["fill", "#pass", &password]);
    agent.run(&["click", "#login"]);
    agent.run(&["wait", "500"]);
    agent.run(&["fill", "#q", run.query]);
    agent.run(&["click", "#search"]);
    agent.run(&["wait", ".add"]);
    agent.run(&["click", ".add"]);
    agent.run(&["wait", "500"]);
    agent.run(&["fill", "#note", run.note]);
    agent.run(&["click", "#checkout"]);
    agent.run(&["wait", "800"]);
    assert_eq!(agent.run(&["get", "text", "#order"]).trim(), "placed", "the flow itself must succeed");
    Session::from_log(&agent.finish()).unwrap()
}

/// The request the "Place order" click set off.
pub fn checkout_request(session: &Session) -> String {
    let triggered = session.triggered_by("click", "#checkout");
    assert_eq!(triggered.len(), 1, "one API call per click");
    session.trace.exchanges[triggered[0]].url.to_string()
}

