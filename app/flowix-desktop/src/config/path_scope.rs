//! �?��范围 (path-scope) 工具 —判断一�?��径是否在某个�?��许的根目录之下�?//!
//! 整个 app 有两�?scope 检�?
//! - **Tauri command 边界** (`commands.rs`) —UI/前�?传入�?path 必须在已注册
//!   notebook �?��之内, 否则拒绝读写。允许在 `is_markdown_like` 后�? (任意 .md 文件)�?//! - **AI 工具调用边界** (`providers/tools/`) —必须�?`registered_notebook_paths` 之一�?//!
//! 这两类共用同一�?`path_is_inside` / `canonical_existing_or_parent` 实现 —�?//! 之前 `commands.rs` �?`providers/tools/mod.rs` 各自维护一�? 漂移风险高�?//! 现在统一在这�? 跨模块一处真源�?

// 实现已下沉到 `flowix_core::path_scope`：领域侧（模板安装、集合重定位）
// 与 IPC 侧必须用同一份包含判定，否则会出现「命令层放行、领域层拒绝」。
pub use flowix_core::path_scope::{
    canonical_existing_or_parent, path_is_inside, path_is_inside_reserved_directory,
};
