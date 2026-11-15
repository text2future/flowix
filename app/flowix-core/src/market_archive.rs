//! Origin policy for packages installed from the Flowix Skill Market.
//!
//! Both the notebook-template installer and the agent-skill installer gate on
//! this, and the gate must be identical in both — a package accepted by one
//! entry point and rejected by the other is a bug, not a policy.
//!
//! It lives in the core crate because it is a domain rule about which archives
//! are trusted, not an IPC concern. The desktop shell still owns the HTTP
//! transport (`commands::market_package::download_market_zip`); this module only
//! answers "may we fetch from this URL at all".
use url::Url;

/// True for the official market origins (plus localhost during development).
///
/// Rejects everything else: plain http in release builds, non-default ports,
/// look-alike hosts such as `flowix.cc.evil.test`, and credentials embedded in
/// the URL authority.
pub fn is_market_archive_origin(url: &Url) -> bool {
    (url.scheme() == "https"
        && matches!(url.host_str(), Some("skills.flowix.cc" | "flowix.cc"))
        && url.port_or_known_default() == Some(443))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn accepts_official_https_origins() {
        assert!(is_market_archive_origin(&parse(
            "https://skills.flowix.cc/templates/archives/a.zip"
        )));
        assert!(is_market_archive_origin(&parse(
            "https://flowix.cc/templates/archives/a.zip"
        )));
    }

    #[test]
    fn rejects_look_alike_hosts_and_plain_http() {
        assert!(!is_market_archive_origin(&parse(
            "https://flowix.cc.evil.test/templates/archives/a.zip"
        )));
        assert!(!is_market_archive_origin(&parse(
            "https://evil.test/templates/archives/a.zip"
        )));
        assert!(!is_market_archive_origin(&parse(
            "http://flowix.cc/templates/archives/a.zip"
        )));
    }

    #[test]
    fn rejects_non_default_ports() {
        assert!(!is_market_archive_origin(&parse(
            "https://flowix.cc:8443/templates/archives/a.zip"
        )));
    }

    #[test]
    fn localhost_is_only_allowed_in_debug_builds() {
        let local = parse("http://localhost:8080/archive.zip");
        assert_eq!(is_market_archive_origin(&local), cfg!(debug_assertions));
    }
}
