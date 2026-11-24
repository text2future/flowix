//! JSON output helpers shared by the CLI and MCP adapters.
use crate::errors::CliError;
use serde::Serialize;

pub(crate) fn to_json_value<T: Serialize>(value: &T) -> Result<serde_json::Value, CliError> {
    serde_json::to_value(value).map_err(|error| CliError::Other(format!("json serialize: {error}")))
}

pub(crate) fn print_pretty_json<T: Serialize>(value: &T) -> Result<(), CliError> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|error| CliError::Other(format!("json serialize: {error}")))?
    );
    Ok(())
}
