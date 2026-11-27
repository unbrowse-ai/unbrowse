//! A page that asks for a person, as the agent's own eyes and hands: the node shows the page — a picture and what it
//! says — and the agent says what to do, one step at a time. The model is the agent's; nothing here calls one. The
//! page's own answer decides whether it passed, so a step never claims more than the page gave.

/// How long a hold presses when the agent names no time, and the longest it may: a pressed-and-held button fills in a
/// few seconds, and a hold is one step, its picture after it.
pub const HOLD: u64 = 10_000;
pub const HOLD_MOST: u64 = 20_000;

/// What the node may do to a page, as the agent asks it to.
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    /// A click at a point, in CSS pixels of the picture.
    Click(f64, f64),
    /// A drag from one point to another: a slider, a puzzle piece.
    Drag((f64, f64), (f64, f64)),
    /// A press at a point, held for a while before it is let go: a button that asks to be pressed and held until it
    /// fills. A click lets go at once, so such a button never fills under one.
    Hold(f64, f64, u64),
    /// Type into whatever has the focus.
    Type(String),
    /// Press a key by name: `Enter`, `Tab`, `Escape`, `Backspace`.
    Press(String),
    /// Let the page work for a while.
    Wait(u64),
    /// The agent believes it is done: the page is read once more and says so, or doesn't.
    Done,
    /// The node meets the check itself: it reads the check's public key from the page, asks the captcha solver it has
    /// (the owner's, or Unbrowse's for a signed-in owner) for a token, and hands the token to the page as the check
    /// would. The page's own answer still decides whether it passed.
    Solve,
}

impl Act {
    /// The act an `action` name and its arguments describe, as the agent API takes them: `click` {x,y}, `drag`
    /// {x,y,to_x,to_y}, `hold` {x,y,ms}, `type` {text}, `press` {key}, `wait` {ms} or `done`.
    #[allow(clippy::too_many_arguments)]
    pub fn of(action: &str, x: Option<f64>, y: Option<f64>, to_x: Option<f64>, to_y: Option<f64>, text: Option<&str>, key: Option<&str>, ms: Option<u64>) -> Result<Self, String> {
        Ok(match action {
            "click" => Self::Click(x.ok_or("a click names x and y, in CSS pixels of the picture")?, y.ok_or("a click names x and y")?),
            "drag" => Self::Drag(
                (x.ok_or("a drag names x and y")?, y.ok_or("a drag names x and y")?),
                (to_x.ok_or("a drag names to_x and to_y")?, to_y.ok_or("a drag names to_x and to_y")?),
            ),
            "hold" => Self::Hold(x.ok_or("a hold names x and y, in CSS pixels of the picture")?, y.ok_or("a hold names x and y")?, ms.unwrap_or(HOLD).clamp(500, HOLD_MOST)),
            "type" => Self::Type(text.ok_or("a type names text")?.to_string()),
            "press" => Self::Press(key.ok_or("a press names key")?.to_string()),
            "wait" => Self::Wait(ms.unwrap_or(1000).min(20_000)),
            "done" => Self::Done,
            "solve" => Self::Solve,
            other => return Err(format!("the challenge takes look, click, drag, hold, type, press, wait, solve or done, not {other:?}")),
        })
    }

    /// What the step is, for the reply's `said`.
    /// The step as the browse command it amounts to (`click`, `type`…): what the rules an agent's commands cross read
    /// it as. `done` and `wait` only read the page, as a picture does.
    pub fn command(&self) -> &'static str {
        match self {
            // A solve answers the check, as a click on it does, and crosses the same gates.
            Act::Click(..) | Act::Hold(..) | Act::Solve => "click",
            Act::Drag(..) => "drag",
            Act::Type(_) => "type",
            Act::Press(_) => "press",
            Act::Wait(_) | Act::Done => "screenshot",
        }
    }

    pub fn said(&self) -> String {
        match self {
            Self::Click(x, y) => format!("clicked ({x:.0},{y:.0})"),
            Self::Drag((x, y), (tx, ty)) => format!("dragged ({x:.0},{y:.0}) to ({tx:.0},{ty:.0})"),
            Self::Hold(x, y, ms) => format!("held ({x:.0},{y:.0}) for {ms}ms"),
            Self::Type(t) => format!("typed {:?}", t.chars().take(60).collect::<String>()),
            Self::Press(k) => format!("pressed {k}"),
            Self::Wait(ms) => format!("waited {ms}ms"),
            Self::Done => "done".into(),
            Self::Solve => "solved with the captcha solver".into(),
        }
    }
}

/// What the node needs from a browser to show a page and take a step on it.
pub trait Page {
    /// The page as it is now, and the size it is laid out in, in CSS pixels.
    fn shot(&mut self) -> Result<Shot, String>;
    fn click(&mut self, x: f64, y: f64) -> Result<(), String>;
    fn drag(&mut self, from: (f64, f64), to: (f64, f64)) -> Result<(), String>;
    /// Presses at a point and lets go `ms` later.
    fn hold(&mut self, x: f64, y: f64, ms: u64) -> Result<(), String>;
    fn type_text(&mut self, text: &str) -> Result<(), String>;
    fn press(&mut self, key: &str) -> Result<(), String>;
    /// What the page is, and whether it still asks for a person.
    fn state(&mut self) -> Result<State, String>;
    fn settle(&mut self, ms: u64);
}

/// A picture of the page, and the viewport it was taken at.
#[derive(Clone, Debug)]
pub struct Shot {
    pub png: Vec<u8>,
    pub w: f64,
    pub h: f64,
}

/// What the page is, as every step reads it.
#[derive(Clone, Debug, Default)]
pub struct State {
    pub url: String,
    pub title: String,
    /// The readable text of the page, cut by the driver to a few thousand characters.
    pub text: String,
    /// Whether the page still asks for an act a script cannot make.
    pub asks_a_person: bool,
}

/// The markup to decide a page from: the page as it came when it was sent whole, and its body when the reader's cap
/// cut the document before it. A fragment that ends inside the head carries none of the page — no links, no frames,
/// no words — and such a fragment is read as a document that is only a script and a check, so a page that had
/// already served the caller its results would be a door asking for a person.
pub fn page_or_body<'a>(html: &'a str, body: &'a str, cut: bool) -> &'a str {
    if cut && !body.trim().is_empty() { body } else { html }
}

/// Whether a page asks for a person: a document that is only a script and a check (`page::a_door`), or one that shows
/// a challenge widget — another site's frame on a page that is nothing else, the site's own frame at an address whose
/// path says what it is (`verify::challenge_response`), or a container carrying the widget's public key
/// (`data-sitekey`, the attribute every widget mounts on, whatever its frame does). A property of the page, not a
/// vendor's name.
/// Whether a page links to five or more other pages of its own site: a page of the site, not one that stands in
/// front of it.
fn links_around(doc: &scraper::Html, at: &url::Url) -> bool {
    scraper::Selector::parse("a[href]").is_ok_and(|a| {
        doc.select(&a)
            .filter_map(|l| l.value().attr("href"))
            .filter(|h| !h.starts_with('#'))
            .filter_map(|h| at.join(h).ok())
            .filter(|to| to.host_str().zip(at.host_str()).is_some_and(|(to, here)| crate::identity::same_site(to, here)) && to.path() != at.path())
            .map(|to| to.path().to_string())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            >= 5
    })
}

/// Whether a page is a page of its site that carries a check's widget among its own content (a sign-up form with a
/// person check before its submit): it shows a widget (`shows_a_widget`), is no door (`page::a_door`), and asks for
/// something a person types or links around its own site. Such a page is the page asked for, with a check on it; a
/// page that is only the check stands in front of the page.
pub fn a_page_with_a_check(html: &str, at: &url::Url) -> bool {
    if crate::page::a_door(200, html, at) || !shows_a_widget(html, at) {
        return false;
    }
    let doc = scraper::Html::parse_document(html);
    let asks = scraper::Selector::parse("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select").is_ok_and(|s| doc.select(&s).next().is_some());
    asks || links_around(&doc, at)
}

pub fn asks_a_person(html: &str, at: &url::Url) -> bool {
    crate::page::a_door(200, html, at) || shows_a_widget(html, at)
}

/// Whether a page shows a check's widget (the second half of `asks_a_person`): a container carrying the widget's
/// public key, the site's own frame at an address whose path says what it is, or another site's frame on a page that
/// is nothing else. A door that only waits on its own code shows none: it moves on by itself.
pub fn shows_a_widget(html: &str, at: &url::Url) -> bool {
    let doc = scraper::Html::parse_document(html);
    if scraper::Selector::parse("[data-sitekey]").is_ok_and(|s| doc.select(&s).next().is_some()) {
        return true;
    }
    // Another site's frame is a check's widget on a page that is nothing else. A page that links around its own
    // site is a page of the site, and the frames other sites fill on it are its adverts: read as widgets, every
    // page that carries an advert asked for a person, and a walk that had got through was given up.
    let links_around = links_around(&doc, at);
    let Ok(sel) = scraper::Selector::parse("iframe[src], frame[src]") else { return false };
    doc.select(&sel)
        .filter_map(|f| f.value().attr("src"))
        .filter_map(|src| at.join(src).ok())
        .any(|u| {
            let elsewhere = match (u.host_str(), at.host_str()) {
                (Some(to), Some(here)) => !crate::identity::same_site(to, here),
                _ => false,
            };
            // Another site's frame is a check's widget only on a page that is nothing else; the address of a frame
            // says what it is for the site's own frames, which is where the rule above reads an address. Another
            // site's frame on a page that links around its own site is the page's advert, and a walk that had got
            // through is not given up for it.
            (elsewhere && !links_around) || (!elsewhere && crate::verify::challenge_response(&u, &serde_json::json!({})))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The agent's action names and their arguments, and the ones that name none.
    #[test]
    fn an_action_is_read_from_its_name_and_arguments() {
        assert_eq!(Act::of("click", Some(3.0), Some(4.0), None, None, None, None, None).unwrap(), Act::Click(3.0, 4.0));
        assert_eq!(
            Act::of("drag", Some(1.0), Some(2.0), Some(30.0), Some(40.0), None, None, None).unwrap(),
            Act::Drag((1.0, 2.0), (30.0, 40.0))
        );
        assert_eq!(Act::of("type", None, None, None, None, Some("hello"), None, None).unwrap(), Act::Type("hello".into()));
        assert_eq!(Act::of("press", None, None, None, None, None, Some("Enter"), None).unwrap(), Act::Press("Enter".into()));
        assert_eq!(Act::of("wait", None, None, None, None, None, None, Some(999_999)).unwrap(), Act::Wait(20_000));
        assert_eq!(Act::of("done", None, None, None, None, None, None, None).unwrap(), Act::Done);
        assert_eq!(Act::of("solve", None, None, None, None, None, None, None).unwrap(), Act::Solve);
        assert!(Act::of("click", Some(1.0), None, None, None, None, None, None).is_err());
        assert!(Act::of("teleport", None, None, None, None, None, None, None).is_err());
    }

    /// A button that asks to be pressed and held is met with a hold: a press at a point, let go only after the time
    /// named (ten seconds unsaid, within half a second and twenty), read as the click it amounts to.
    #[test]
    fn a_hold_presses_at_a_point_for_the_time_named() {
        assert_eq!(Act::of("hold", Some(664.0), Some(494.0), None, None, None, None, None).unwrap(), Act::Hold(664.0, 494.0, HOLD));
        assert_eq!(Act::of("hold", Some(1.0), Some(2.0), None, None, None, None, Some(6_000)).unwrap(), Act::Hold(1.0, 2.0, 6_000));
        assert_eq!(Act::of("hold", Some(1.0), Some(2.0), None, None, None, None, Some(999_999)).unwrap(), Act::Hold(1.0, 2.0, HOLD_MOST));
        assert_eq!(Act::of("hold", Some(1.0), Some(2.0), None, None, None, None, Some(1)).unwrap(), Act::Hold(1.0, 2.0, 500));
        assert!(Act::of("hold", Some(1.0), None, None, None, None, None, None).is_err(), "a hold names a point");
        let held = Act::Hold(664.0, 494.0, 8_000);
        assert_eq!((held.command(), held.said().as_str()), ("click", "held (664,494) for 8000ms"));
    }

    /// A page that is only a script and a check asks for a person; so does one that frames another site; a page with a
    /// form and links does not.
    /// Each step reads as the browse command it amounts to, which the rules an agent's commands cross are written
    /// for, and says what it did in a line: waiting and saying done only look at the page, as a picture does.
    #[test]
    fn each_step_is_the_command_it_amounts_to_and_says_what_it_did() {
        let long = "x".repeat(80);
        let steps = [
            (Act::Click(12.4, 33.6), "click", "clicked (12,34)".to_string()),
            (Act::Drag((1.0, 2.0), (310.2, 2.0)), "drag", "dragged (1,2) to (310,2)".to_string()),
            (Act::Type(long.clone()), "type", format!("typed {:?}", &long[..60])),
            (Act::Press("Enter".into()), "press", "pressed Enter".to_string()),
            (Act::Wait(500), "screenshot", "waited 500ms".to_string()),
            (Act::Done, "screenshot", "done".to_string()),
            (Act::Solve, "click", "solved with the captcha solver".to_string()),
        ];
        for (act, command, said) in steps {
            assert_eq!((act.command(), act.said()), (command, said), "{act:?}");
        }
    }

    /// A page of the site with a check's widget among its own content (a sign-up form with a person check before its
    /// submit) is the page asked for, with a check on it: it asks for something typed, or links around its own site.
    /// A widget alone, or a form with no widget, is not such a page.
    #[test]
    fn a_form_with_a_check_on_it_is_the_page_asked_for() {
        let at = url::Url::parse("https://site.example/signup").unwrap();
        let widget = "<div class=\"cf-turnstile\" data-sitekey=\"1x000\"></div>";
        let form = format!("<html><body><h1>Create your account</h1><form><input type=email name=email><input type=password name=pw>{widget}<button>Sign up</button></form></body></html>");
        assert!(a_page_with_a_check(&form, &at));
        let links: String = (0..8).map(|n| format!("<a href=\"/topic/{n}\">Topic {n}</a>")).collect();
        assert!(a_page_with_a_check(&format!("<html><body><nav>{links}</nav><p>Vote below</p>{widget}</body></html>"), &at), "a page that links around its site");
        assert!(!a_page_with_a_check(&format!("<html><body>{widget}</body></html>"), &at), "the widget alone stands in front of the page");
        assert!(!a_page_with_a_check("<html><body><form><input type=email name=email><button>Go</button></form></body></html>", &at), "no widget, no check");
        let hidden = format!("<html><body><form><input type=hidden name=t value=1><input type=checkbox name=c>{widget}</form></body></html>");
        assert!(!a_page_with_a_check(&hidden, &at), "a hidden field or a box is nothing a person types");
    }

    #[test]
    fn a_page_that_asks_for_a_person_is_read_from_the_page() {
        let at = url::Url::parse("https://site.example/").unwrap();
        assert!(asks_a_person("<html><head><title>One moment</title><script src=/c.js></script></head><body>Checking</body></html>", &at));
        assert!(asks_a_person("<html><body><iframe src=\"https://widget.example/frame\"></iframe></body></html>", &at));
        // A widget the site serves itself still asks when its own address says what it is, and so does one whose frame
        // lives out of reach (a closed shadow root): its container carries the widget's public key.
        assert!(asks_a_person("<html><body><iframe src=\"/recaptcha/api2/anchor\"></iframe></body></html>", &at));
        assert!(asks_a_person("<html><body><div class=\"cf-turnstile\" data-sitekey=\"1x000\"></div></body></html>", &at));
        assert!(!asks_a_person("<html><body><iframe src=\"/embed/player\"></iframe><p>Welcome</p></body></html>", &at));
        // A page of the site with an advert in another site's frame asks nobody: it links around its own site.
        let links: String = (0..8).map(|n| format!("<a href=\"/topic/{n}\">Topic {n}</a>")).collect();
        assert!(!asks_a_person(&format!("<html><body><nav>{links}</nav><h1>Results</h1><iframe src=\"https://ads.example/slot\"></iframe></body></html>"), &at));
        assert!(!asks_a_person(
            "<html><body><form><input name=q></form><a href=/about>About</a><p>Welcome to the site</p></body></html>",
            &at
        ));
    }

    /// The walk that exposed it: a search page that links around its own site, has already served the caller its
    /// results, and carries another site's frame whose address says captcha (the widget's own bootstrap, mounted on a
    /// page that never gates on it) was read as a page asking for a person. The door then rested, the walk was given
    /// up and the agent was sent to solve a check that was not there. The site's own frame still asks wherever it
    /// sits, and another site's frame on a page that is nothing else still asks.
    #[test]
    fn another_sites_frame_on_a_page_of_the_site_is_not_a_check() {
        let at = url::Url::parse("https://www.example.com/search?query=volcano").unwrap();
        let links: String = (0..8).map(|n| format!("<a href=\"/topic/{n}\">Topic {n}</a>")).collect();
        let widget = "https://widget.example/recaptcha/api2/aframe";
        assert!(
            !asks_a_person(&format!("<html><body><nav>{links}</nav><h1>Results</h1><iframe src=\"{widget}\"></iframe></body></html>"), &at),
            "a page of its own site with another site's frame is a page, not a check"
        );
        assert!(
            asks_a_person(&format!("<html><body><iframe src=\"{widget}\"></iframe></body></html>"), &at),
            "another site's frame on a page that is nothing else still asks"
        );
        assert!(
            asks_a_person(&format!("<html><body><nav>{links}</nav><iframe src=\"/recaptcha/api2/aframe\"></iframe></body></html>"), &at),
            "the site's own frame says what it is by its address, wherever it sits"
        );
    }

    /// The walk that exposed it: a page of 876 KB whose head ran to 810 KB was sent to the reader as the first 300 KB
    /// of that head — no `<body>`, no link, no frame, no word — and `a_door` read the script-only fragment as a
    /// check, so a page that had already served the caller its results asked for a person. When the cap cut the
    /// document only the body may be decided on; and that body, which links around its own site and carries another
    /// site's frame as an advert, is a page and not a check.
    #[test]
    fn a_document_cut_before_its_body_is_decided_from_its_body() {
        let at = url::Url::parse("https://www.example.com/search?query=volcano").unwrap();
        let head = "<html><head><script src=/app.js></script><style>.a{color:red}</style></head>";
        let links: String = (0..8).map(|n| format!("<a href=\"/topic/{n}\">Topic {n}</a>")).collect();
        let body = format!("<body><nav>{links}</nav><h1>Results</h1><iframe src=\"https://widget.example/recaptcha/api2/aframe\"></iframe></body></html>");
        assert!(asks_a_person(head, &at), "the head's own fragment is only a script and a check: sent alone it reads as a door");
        assert_eq!(page_or_body(head, &body, true), body.as_str(), "cut at the head, the body is what is decided on");
        assert!(!asks_a_person(page_or_body(head, &body, true), &at), "the body links around its own site: a page, not a check");
        assert_eq!(page_or_body(head, "", true), head, "with no body sent, the fragment is what there is");
        let whole = "<html><head><title>Search</title></head><body><h1>Results</h1></body></html>";
        assert_eq!(page_or_body(whole, "", false), whole, "sent whole, the page is not replaced by anything");
    }
}
