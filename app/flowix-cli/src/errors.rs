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

    #[error("{0}")]
    Other(String),
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
            CliError::Other(_) => "EXECUTION_ERROR",
        }
    }
}
