//! Code-host, package-registry and chat tokens: patterns 5 to 9.

use crate::format::Format;

pub const FORMATS: &[Format] = &[
    Format {
        id: 5,
        name: "code-host-token",
        family: "code host",
        // A personal, OAuth, user-to-server, server-to-server or refresh token: `gh`, a kind letter, `_`, 36 base-62.
        regex: r"(?-u)(?P<t>gh[pousr]_(?P<r>[A-Za-z0-9]{36}))",
        min_millibits: 3500,
        mixed: true,
        keep: None,
        min_kept: 36,
        check: None,
    },
    Format {
        id: 6,
        name: "code-host-fine-grained-token",
        family: "code host",
        // A fine-grained personal token: its prefix and 82 base-62 or `_` characters.
        regex: r"(?-u)(?P<t>github_pat_(?P<r>[A-Za-z0-9_]{82}))",
        min_millibits: 4000,
        mixed: true,
        keep: None,
        min_kept: 82,
        check: None,
    },
    Format {
        id: 7,
        name: "code-host-access-token",
        family: "code host",
        // A personal, project or group access token: `glpat-` and at least 20 base-64-url characters.
        regex: r"(?-u)(?P<t>glpat-(?P<r>[A-Za-z0-9_\-]{20,64}))",
        min_millibits: 3300,
        mixed: true,
        keep: None,
        min_kept: 20,
        check: None,
    },
    Format {
        id: 8,
        name: "package-registry-token",
        family: "code host",
        // A registry access token: `npm_` and 36 base-62 characters.
        regex: r"(?-u)(?P<t>npm_(?P<r>[A-Za-z0-9]{36}))",
        min_millibits: 3500,
        mixed: true,
        keep: None,
        min_kept: 36,
        check: None,
    },
    Format {
        id: 9,
        name: "chat-workspace-token",
        family: "chat",
        // A bot, user, app or refresh token: `xox`, a kind letter, `-`, then dash-separated numbers and a base-62 tail.
        regex: r"(?-u)(?P<t>xox[abposr]-(?P<r>[0-9]{6,16}-[0-9A-Za-z\-]{12,96}))",
        min_millibits: 3300,
        mixed: true,
        keep: None,
        min_kept: 24,
        check: None,
    },
];
