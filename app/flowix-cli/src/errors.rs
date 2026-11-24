//! CLI 统一错误类型。
//!
//! 错误变体对应不同退出码 (见 `exit_code` 方法):
//! - `Usage`         -> 2  参数 / 用法错
//! - `NotFound`      -> 3  notebook / id 找不到
//! - `Io`            -> 5  磁盘 IO 失败 (业界惯例: io error → 5)
//! - `Conflict`      -> 4  文件已被并发修改
//! - `Other`         -> 1  未分类

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CliError {
    #[error("{0}")]
    Usage(String),

    #[error("{0}")]
    NotFound(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Conflict(String),

    #[error("COLLECTION_SCHEMA_CHANGED")]
    CollectionSchemaChanged,

    #[error("invalid value for `{field}`: expected {expected}")]
    InvalidField {
        field: String,
        expected: String,
        allowed: Option<Vec<String>>,
    },

    #[error("request ID already belongs to a different or unavailable record")]
    RequestIdConflict,

    #[error("request outcome is unknown or still in progress; inspect the target before taking further action{0}")]
    RequestIndeterminate(String),

    #[error("{0}")]
    PreconditionRequired(String),

    #[error("{0}")]
    PermissionDenied(String),

    #[error("{0}")]
    DataChanged(String),

    #[error("{0}")]
    VersionConflict(String),

    #[error("{0}")]
    Other(String),
}

#[cfg(test)]
mod collection_error_tests {
    use super::CliError;

    #[test]
    fn schema_change_has_a_specific_machine_readable_code() {
        let error = CliError::collection_error("COLLECTION_SCHEMA_CHANGED".into());
        assert_eq!(error.code(), "COLLECTION_SCHEMA_CHANGED");
        assert_eq!(error.exit_code(), 4);
    }
}

impl From<flowix_core::FlowixError> for CliError {
    fn from(error: flowix_core::FlowixError) -> Self {
        use flowix_core::FlowixError;
        match error {
            FlowixError::InvalidInput(message) => Self::Usage(message),
            FlowixError::NotFound(message) => Self::NotFound(message),
            FlowixError::Io(error) => Self::Io(error),
            FlowixError::Conflict(message) => Self::Conflict(message),
            FlowixError::PermissionDenied(message)
            | FlowixError::CorruptData(message)
            | FlowixError::Internal(message) => Self::Other(message),
        }
    }
}

impl CliError {
    /// 映射到进程退出码。遵循传统 Unix 退出码约定:
    /// 0=success, 1=一般错误, 2=用法错, 3=找不到, 4=冲突, 5=io 错误。
    pub fn exit_code(&self) -> u8 {
        match self {
            CliError::Usage(_) => 2,
            CliError::NotFound(_) => 3,
            CliError::Io(_) => 5,
            CliError::Conflict(_) => 4,
            CliError::CollectionSchemaChanged => 4,
            CliError::InvalidField { .. } => 2,
            CliError::RequestIdConflict => 4,
            CliError::RequestIndeterminate(_) => 4,
            CliError::PreconditionRequired(_) => 2,
            CliError::PermissionDenied(_) => 1,
            CliError::DataChanged(_) | CliError::VersionConflict(_) => 4,
            CliError::Other(_) => 1,
        }
    }

    /// Stable machine-readable error category used by `--json` output.
    pub fn code(&self) -> &'static str {
        match self {
            CliError::Usage(_) => "INVALID_COMMAND",
            CliError::NotFound(_) => "NOT_FOUND",
            CliError::Io(_) => "IO_ERROR",
            CliError::Conflict(_) => "CONFLICT",
            CliError::CollectionSchemaChanged => "COLLECTION_SCHEMA_CHANGED",
            CliError::InvalidField { .. } => "INVALID_FIELD_VALUE",
            CliError::RequestIdConflict => "REQUEST_ID_CONFLICT",
            CliError::RequestIndeterminate(_) => "REQUEST_INDETERMINATE",
            CliError::PreconditionRequired(_) => "PRECONDITION_REQUIRED",
            CliError::PermissionDenied(_) => "PERMISSION_DENIED",
            CliError::DataChanged(_) => "DATA_CHANGED",
            CliError::VersionConflict(_) => "VERSION_CONFLICT",
            CliError::Other(_) => "EXECUTION_ERROR",
        }
    }

    pub fn details(&self) -> serde_json::Value {
        match self {
            Self::InvalidField {
                field,
                expected,
                allowed,
            } => {
                let mut result = serde_json::json!({"field":field,"expected":expected});
                if let Some(allowed) = allowed {
                    result["allowed"] = serde_json::json!(allowed);
                }
                result
            }
            _ => serde_json::Value::Null,
        }
    }

    pub(crate) fn collection_error(message: String) -> Self {
        if let Some(rest) = message.strip_prefix("INVALID_FIELD_VALUE: ") {
            if let Some((field, expected)) = rest.rsplit_once(" expects ") {
                return Self::InvalidField {
                    field: field.into(),
                    expected: expected.into(),
                    allowed: None,
                };
            }
        }
        if message.contains("REQUEST_ID_CONFLICT") || message.contains("REQUEST_ID_RECORD_MISSING")
        {
            return Self::RequestIdConflict;
        }
        if message == "COLLECTION_SCHEMA_CHANGED" {
            return Self::CollectionSchemaChanged;
        }
        if message.contains("COLLECTION_CONTENT_CONFLICT") {
            return Self::Conflict(message);
        }
        Self::Other(message)
    }
}
