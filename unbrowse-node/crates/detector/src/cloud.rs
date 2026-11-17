//! Cloud and payment provider keys: patterns 1 to 4. Each is a vendor's published prefix and the length and alphabet of
//! what follows it. Payment patterns match live secret keys only: a publishable key is public by design, and a test-mode
//! key moves no money.

use crate::format::Format;

pub const FORMATS: &[Format] = &[
    Format {
        id: 1,
        name: "cloud-access-key-id",
        family: "cloud",
        // A long-term or temporary access key id: a four-letter prefix and sixteen base-32 characters.
        regex: r"(?-u)(?P<t>(?:AKIA|ASIA)(?P<r>[A-Z2-7]{16}))",
        // None of 10,000 random draws of sixteen fell under 2.5 bits (README).
        min_millibits: 2500,
        mixed: false,
        keep: None,
        min_kept: 16,
        check: None,
    },
    Format {
        id: 2,
        name: "cloud-api-key",
        family: "cloud",
        // A browser or server API key: a four-character prefix and 35 base-64-url characters.
        regex: r"(?-u)(?P<t>AIza(?P<r>[0-9A-Za-z_\-]{35}))",
        min_millibits: 3500,
        mixed: true,
        keep: None,
        min_kept: 35,
        check: None,
    },
    Format {
        id: 3,
        name: "payment-live-secret-key",
        family: "payment",
        // A live-mode secret or restricted key: a two-letter kind, `_live_`, and at least 24 base-62 characters.
        regex: r"(?-u)(?P<t>(?:sk|rk)_live_(?P<r>[0-9A-Za-z]{24,247}))",
        min_millibits: 3300,
        mixed: true,
        keep: None,
        min_kept: 24,
        check: None,
    },
    Format {
        id: 4,
        name: "payment-application-secret",
        family: "payment",
        // An application secret: a seven-character prefix and 43 base-64-url characters.
        regex: r"(?-u)(?P<t>sq0csp-(?P<r>[0-9A-Za-z_\-]{43}))",
        min_millibits: 3500,
        mixed: true,
        keep: None,
        min_kept: 43,
        check: None,
    },
];
