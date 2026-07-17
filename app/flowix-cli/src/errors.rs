//! CLI 统一错误类型。
//!
//! 4 个变体对应 4 个退出码 (见 `exit_code` 方法):
//! - `Usage`         -> 2  参数 / 用法错
//! - `NotFound`      -> 3  notebook / id 找不到
//! - `Io`            -> 5  磁盘 IO 失败 (业界惯例: io error → 5)
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
    Other(String),
}

impl From<flowix_core::FlowixError> for CliError {
    fn from(error: flowix_core::FlowixError) -> Self {
        use flowix_core::FlowixError;
        match error {
            FlowixError::InvalidInput(message) => Self::Usage(message),
            FlowixError::NotFound(message) => Self::NotFound(message),
            FlowixError::Io(error) => Self::Io(error),
            FlowixError::Conflict(message)
            | FlowixError::PermissionDenied(message)
            | FlowixError::CorruptData(message)
            | FlowixError::Internal(message) => Self::Other(message),
        }
    }
}

impl CliError {
    /// 映射到进程退出码。遵循传统 Unix 退出码约定:
    /// 0=success, 1=一般错误, 2=用法错, 3=找不到, 5=io 错误。
    pub fn exit_code(&self) -> u8 {
        match self {
            CliError::Usage(_) => 2,
            CliError::NotFound(_) => 3,
            CliError::Io(_) => 5,
            CliError::Other(_) => 1,
        }
    }
}
