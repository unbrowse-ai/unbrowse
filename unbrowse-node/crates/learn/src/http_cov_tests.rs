//! The transport's small answers (UNB-208).
use super::*;

/// The sent log says which protocol a call went over, by the version the connection spoke.
#[test]
fn the_sent_log_names_the_protocol_the_connection_spoke() {
    assert_eq!(protocol(wreq::Version::HTTP_2), "h2");
    assert_eq!(protocol(wreq::Version::HTTP_3), "h3");
    for old in [wreq::Version::HTTP_11, wreq::Version::HTTP_10, wreq::Version::HTTP_09] {
        assert_eq!(protocol(old), "h1", "{old:?}");
    }
}
