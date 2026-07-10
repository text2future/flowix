//! CLI 统一错误类型。
//!
//! 5 个变体对应 4 个退出码 (见 `exit_code` 方法):
//! - `Usage`         -> 2  参数 / 用法错
//! - `NotFound`      -> 3  notebook / id 找不到
//! - `Io`            -> 5  磁盘 IO 失败 (业界惯例: io error → 5)
//! - `Other`         -> 1  未分类
//! - `UnknownMethod` -> 1  JSON-RPC method not found (serve 模式专用,
//!                      跟 Other 共用 exit code, 但走不同的 JSON-RPC code)

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

    #[error("unknown method: {0}")]
    UnknownMethod(String),
}

impl CliError {
    /// 映射到进程退出码。遵循传统 Unix 退出码约定:
    /// 0=success, 1=一般错误, 2=用法错, 3=找不到, 5=io 错误。
    pub fn exit_code(&self) -> u8 {
        match self {
            CliError::Usage(_) => 2,
            CliError::NotFound(_) => 3,
            CliError::Io(_) => 5,
            CliError::Other(_) | CliError::UnknownMethod(_) => 1,
        }
    }
}
