mod runtime;

pub use runtime::PiRpcManager;
pub use runtime::installed_flowix_pi_binary;
pub mod config;

pub const AGENT_TYPE: &str = "pi";
