//! Bounded, local robots.txt policy evaluation. No network or status-code policy lives here.
//!
//! User-agent names match case-insensitive substrings of the supplied client identity;
//! the longest matching name wins, with equally specific groups merged. `*` is a
//! fallback. Paths remain case-sensitive and include the query, but not the fragment.
//! Unreserved percent escapes are decoded and other escape hex digits are uppercased.
//! This is intentionally not a claim of full RFC 9309 compliance: in particular, raw
//! non-ASCII rule text is not converted to percent-encoded UTF-8, and malformed input
//! is tolerated unless a resource limit is exceeded. HTTP errors (including 404),
//! redirects, caching, and the choice of client identity belong to the caller.

use regex::bytes::RegexBuilder;
use url::Url;

pub const MAX_ROBOTS_BYTES: usize = 4 * 1024 * 1024;
const MAX_LINES: usize = 32_768;
const MAX_LINE_BYTES: usize = 16 * 1024;
const MAX_AGENTS: usize = 4_096;
const MAX_AGENT_BYTES: usize = 1_024;
const MAX_RULES: usize = 4_096;
const MAX_PATTERN_BYTES: usize = 2_048;
const MAX_TARGET_BYTES: usize = 64 * 1024;
const MAX_IDENTITY_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct Group<'a> {
    agents: Vec<&'a str>,
    rules: Vec<Rule<'a>>,
    saw_rules: bool,
}

struct Rule<'a> {
    pattern: &'a str,
    allow: bool,
}

/// Whether `url` is permitted by a robots.txt document for `user_agent`.
///
/// An empty document or an unmatched agent allows access. Empty Allow/Disallow
/// values are ignored. Matching is anchored at the start of path + query, supports
/// `*` and terminal `$`, and gives the longest literal normalized byte match
/// precedence (wildcards and the end anchor do not contribute to specificity).
/// Allow wins ties. Parsing, input-size, and regex resource limits fail closed.
/// Parsing limits apply even to directives belonging to a different agent.
pub fn allowed(robots: &str, user_agent: &str, url: &Url) -> bool {
    let query_len = url.query().map_or(0, |query| query.len().saturating_add(1));
    if robots.len() > MAX_ROBOTS_BYTES
        || user_agent.len() > MAX_IDENTITY_BYTES
        || url.path().len().saturating_add(query_len) > MAX_TARGET_BYTES
    {
        return false;
    }

    let Some(groups) = parse(robots) else {
        return false;
    };
    let identity = user_agent.to_ascii_lowercase();
    let specificity = |group: &Group<'_>| {
        group
            .agents
            .iter()
            .filter_map(|agent| {
                if *agent == "*" {
                    Some(0)
                } else if identity.contains(&agent.to_ascii_lowercase()) {
                    Some(agent.len())
                } else {
                    None
                }
            })
            .max()
    };
    let Some(best_agent) = groups.iter().filter_map(&specificity).max() else {
        return true;
    };
    verdict(
        groups
            .iter()
            .filter(|group| specificity(group) == Some(best_agent)),
        url,
    )
    .unwrap_or(false)
}

/// Whether a group naming `token` exactly (case-insensitively, as RFC 9309 matches a product token) disallows `url`.
///
/// Only such a group counts: a `*` group or one naming another agent never does, and neither does a name that only
/// contains the token. Groups naming it are merged, and their rules are judged as in [`allowed`] (longest match wins,
/// Allow wins ties). Unlike [`allowed`], every limit fails open: a document too large, a line too long, too many rules
/// or a pattern that can't be compiled says nothing, so nothing is disallowed. A site opts out by saying so.
pub fn disallowed_by_name(robots: &str, token: &str, url: &Url) -> bool {
    let query_len = url.query().map_or(0, |query| query.len().saturating_add(1));
    if robots.len() > MAX_ROBOTS_BYTES || url.path().len().saturating_add(query_len) > MAX_TARGET_BYTES {
        return false;
    }
    let Some(groups) = parse(robots) else {
        return false;
    };
    let named: Vec<&Group<'_>> = groups
        .iter()
        .filter(|group| group.agents.iter().any(|agent| agent.eq_ignore_ascii_case(token)))
        .collect();
    if named.is_empty() {
        return false;
    }
    verdict(named.into_iter(), url) == Some(false)
}

/// The winning rule's verdict for `url` among `groups` (true for allow), or allow when none matches; `None` when a
/// pattern can't be compiled within the regex limits.
fn verdict<'a, 'b: 'a>(groups: impl Iterator<Item = &'a Group<'b>>, url: &Url) -> Option<bool> {
    let mut target = url.path().to_owned();
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    let target = normalize_percent(&target);
    let mut winner: Option<(usize, bool)> = None;
    for group in groups {
        for rule in &group.rules {
            if rule.pattern.is_empty() {
                continue;
            }
            let normalized = normalize_percent(rule.pattern);
            let (pattern, end_anchored) = match normalized.strip_suffix('$') {
                Some(pattern) => (pattern, true),
                None => (normalized.as_str(), false),
            };
            let length = pattern.bytes().filter(|byte| *byte != b'*').count();
            let mut expression = String::from("^");
            for (index, literal) in pattern.split('*').enumerate() {
                if index != 0 {
                    expression.push_str(".*");
                }
                expression.push_str(&regex::escape(literal));
            }
            if end_anchored {
                expression.push_str("\\z");
            }
            let Ok(regex) = RegexBuilder::new(&expression)
                .unicode(false)
                .dot_matches_new_line(true)
                .size_limit(1024 * 1024)
                .dfa_size_limit(64 * 1024)
                .build()
            else {
                return None;
            };
            if regex.is_match(target.as_bytes()) {
                match winner {
                    None => winner = Some((length, rule.allow)),
                    Some((previous, _)) if length > previous => {
                        winner = Some((length, rule.allow));
                    }
                    Some((previous, _)) if length == previous && rule.allow => {
                        winner = Some((length, true));
                    }
                    _ => {}
                }
            }
        }
    }
    Some(winner.is_none_or(|(_, allow)| allow))
}

fn parse(robots: &str) -> Option<Vec<Group<'_>>> {
    let mut groups = Vec::new();
    let mut current = Group::default();
    let mut agents = 0;
    let mut rules = 0;
    for (index, line) in robots.trim_start_matches('\u{feff}').lines().enumerate() {
        if index >= MAX_LINES || line.len() > MAX_LINE_BYTES {
            return None;
        }
        let line = line.split('#').next().unwrap_or("").trim();
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("user-agent") {
            if value.is_empty() {
                continue;
            }
            agents += 1;
            if agents > MAX_AGENTS || value.len() > MAX_AGENT_BYTES {
                return None;
            }
            if current.saw_rules {
                groups.push(current);
                current = Group::default();
            }
            current.agents.push(value);
        } else if name.eq_ignore_ascii_case("allow") || name.eq_ignore_ascii_case("disallow") {
            rules += 1;
            if rules > MAX_RULES || value.len() > MAX_PATTERN_BYTES {
                return None;
            }
            if !current.agents.is_empty() {
                current.saw_rules = true;
                current.rules.push(Rule {
                    pattern: value,
                    allow: name.eq_ignore_ascii_case("allow"),
                });
            }
        }
    }
    if !current.agents.is_empty() {
        groups.push(current);
    }
    Some(groups)
}

fn normalize_percent(value: &str) -> String {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                let decoded = high * 16 + low;
                if decoded.is_ascii_alphanumeric() || b"-._~".contains(&decoded) {
                    output.push(decoded);
                } else {
                    output.push(b'%');
                    output.push(bytes[index + 1].to_ascii_uppercase());
                    output.push(bytes[index + 2].to_ascii_uppercase());
                }
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).expect("percent normalization preserves UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permits(robots: &str, path: &str) -> bool {
        allowed(
            robots,
            "unbrowse-node/1.0",
            &Url::parse(&format!("https://example.test{path}")).unwrap(),
        )
    }

    #[test]
    fn default_allow() {
        assert!(permits("", "/anything"));
        assert!(permits("User-agent: another-bot\nDisallow: /", "/anything"));
        assert!(permits(
            "Sitemap: https://example.test/map.xml",
            "/anything"
        ));
    }

    #[test]
    fn wildcard_disallow() {
        assert!(!permits("User-agent: *\nDisallow: /", "/anything"));
    }

    #[test]
    fn specific_group_overrides_wildcard() {
        let robots = "User-agent: *\nDisallow: /\nUser-agent: unbrowse\nAllow: /";
        assert!(permits(robots, "/anything"));
        let robots = "User-agent: unbrowse\nDisallow: /\nUser-agent: unbrowse-node\nAllow: /";
        assert!(permits(robots, "/anything"));
    }

    #[test]
    fn merge_equally_specific_groups_and_consecutive_agents() {
        let robots = "User-agent: other\nUser-agent: unbrowse-node\nDisallow: /private\n\nUser-agent: UNBROWSE-NODE\nAllow: /private/public";
        assert!(!permits(robots, "/private"));
        assert!(permits(robots, "/private/public"));
        assert!(!allowed(
            robots,
            "other/2",
            &Url::parse("https://example.test/private").unwrap()
        ));
    }

    #[test]
    fn longest_rule_and_allow_tie() {
        let robots = "User-agent: *\nDisallow: /\nAllow: /public\nDisallow: /public/secret\nAllow: /same\nDisallow: /same";
        assert!(permits(robots, "/public/page"));
        assert!(!permits(robots, "/public/secret/page"));
        assert!(permits(robots, "/same"));
    }

    #[test]
    fn directives_and_agents_ignore_case_but_paths_do_not() {
        let robots = "uSeR-aGeNt: UnBrOwSe-NoDe\ndIsAlLoW: /Private";
        assert!(!permits(robots, "/Private"));
        assert!(permits(robots, "/private"));
    }

    #[test]
    fn query_is_included_fragment_is_not() {
        let robots = "User-agent: *\nDisallow: /search?q=private$";
        assert!(!permits(robots, "/search?q=private#fragment"));
        assert!(permits(robots, "/search?q=public"));
        assert!(permits(robots, "/search?q=private&more=1"));
    }

    #[test]
    fn empty_disallow_is_not_a_deny() {
        assert!(permits("User-agent: *\nDisallow: \nAllow:", "/anything"));
        assert!(!permits(
            "User-agent: *\nDisallow: /\nDisallow:",
            "/anything"
        ));
    }

    #[test]
    fn glob_and_end_anchor() {
        let robots = "User-agent: *\nDisallow: /private/*/secret$\nDisallow: /*.pdf$";
        assert!(!permits(robots, "/private/a/b/secret"));
        assert!(permits(robots, "/private/a/secret/extra"));
        assert!(!permits(robots, "/file.pdf"));
        assert!(permits(robots, "/file.pdf?download=1"));
    }

    #[test]
    fn regex_metacharacters_are_literals() {
        let robots = "User-agent: *\nDisallow: /file.[x]+?v=(1)$";
        assert!(!permits(robots, "/file.[x]+?v=(1)"));
        assert!(permits(robots, "/file.axxx?v=1"));
    }

    #[test]
    fn comments_unknown_directives_and_bom() {
        let robots = "\u{feff}User-agent: * # everyone\nSitemap: https://example.test/map\nDisallow: /private # not public\nCrawl-delay: 10";
        assert!(!permits(robots, "/private"));
        assert!(permits(robots, "/public"));
    }

    #[test]
    fn percent_normalization_preserves_reserved_distinctions() {
        let robots = "User-agent: *\nDisallow: /%70rivate/%7euser\nDisallow: /encoded%2fslash";
        assert!(!permits(robots, "/private/~user"));
        assert!(!permits(robots, "/%70rivate/%7Euser"));
        assert!(!permits(robots, "/encoded%2Fslash"));
        assert!(permits(robots, "/encoded/slash"));
    }

    fn named(robots: &str, path: &str) -> bool {
        disallowed_by_name(robots, "Unbrowse", &Url::parse(&format!("https://example.test{path}")).unwrap())
    }

    /// Only a group naming the product token opts a path out: `*` never does, nor another agent, nor a name that
    /// merely contains the token.
    #[test]
    fn only_a_group_naming_the_token_disallows() {
        assert!(named("User-agent: Unbrowse\nDisallow: /api", "/api/items"));
        assert!(named("user-agent: UNBROWSE\ndisallow: /", "/anything"), "the token's case doesn't matter");
        assert!(!named("User-agent: *\nDisallow: /", "/anything"), "a wildcard group never opts out");
        assert!(!named("User-agent: Googlebot\nDisallow: /", "/anything"));
        assert!(!named("User-agent: unbrowse-node\nDisallow: /", "/anything"), "another product's token");
        assert!(!named("User-agent: Unbrowse\nDisallow: /api", "/search"), "another path");
        assert!(!named("", "/anything"));
        // A `*` group beside the named one adds nothing to it.
        assert!(!named("User-agent: *\nDisallow: /\nUser-agent: Unbrowse\nDisallow: /private", "/public"));
    }

    /// Inside the named group the longest rule wins and Allow wins a tie (RFC 9309, 2.2.2); groups naming it merge.
    #[test]
    fn allow_overrides_inside_the_named_group() {
        let robots = "User-agent: Unbrowse\nDisallow: /api\nAllow: /api/public\n\nUser-agent: Unbrowse\nDisallow: /api/public/secret";
        assert!(named(robots, "/api/items"));
        assert!(!named(robots, "/api/public/items"));
        assert!(named(robots, "/api/public/secret/x"));
        assert!(!named("User-agent: Unbrowse\nDisallow: /same\nAllow: /same", "/same"), "Allow wins a tie");
    }

    /// Where `allowed` fails closed, an opt-out fails open: a site's silence, or a file past the limits, is no opt-out.
    #[test]
    fn limits_never_opt_a_site_out() {
        let deny = "User-agent: Unbrowse\nDisallow: /\n";
        assert!(!named(&format!("{deny}{}", " ".repeat(MAX_ROBOTS_BYTES + 1)), "/"));
        assert!(!named(&format!("{deny}{}", "#".repeat(MAX_LINE_BYTES + 1)), "/"));
        let rules = "Disallow: /x\n".repeat(MAX_RULES + 1);
        assert!(!named(&format!("{deny}{rules}"), "/x"));
        assert!(named(deny, "/"), "the same rule within the limits");
    }

    #[test]
    fn parsing_limits_fail_closed_even_for_unmatched_groups() {
        assert!(!permits(&" ".repeat(MAX_ROBOTS_BYTES + 1), "/"));
        assert!(!permits(&"#".repeat(MAX_LINE_BYTES + 1), "/"));
        assert!(!permits(&"\n".repeat(MAX_LINES + 1), "/"));
        let pattern = "x".repeat(MAX_PATTERN_BYTES + 1);
        assert!(!permits(
            &format!("User-agent: other\nDisallow: /{pattern}"),
            "/"
        ));
        let rules = "Disallow: /x\n".repeat(MAX_RULES + 1);
        assert!(!permits(&format!("User-agent: *\n{rules}"), "/"));
    }
}
