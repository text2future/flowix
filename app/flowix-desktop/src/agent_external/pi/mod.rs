mod runtime;

pub use runtime::installed_flowix_pi_binary;
pub use runtime::{PiHistoryPage, PiHistoryRevision, PiRpcManager, PiSessionSnapshot};
pub mod config;

pub const AGENT_TYPE: &str = "pi";
