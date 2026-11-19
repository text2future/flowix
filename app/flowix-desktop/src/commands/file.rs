//! 文件树与文件读写命令。
//!
//! 这个模块名是 IPC 的单一入口，实现按「一次调用碰到什么」分成六个子模块：
//!
//! - [`tree`]：磁盘列举 + 索引元数据补水，只有读；
//! - [`view`]：`.flowix/view-preferences.json` 的读写与随目录移动 rebase；
//! - [`read`]：文本、DOCX 预览、DOCX 转 Markdown；
//! - [`media`]：图片/视频/文档缩略图的解码与缓存；
//! - [`mutate`]：新建、保存、删除、建目录；
//! - [`transfer`]：改名、移动、外部导入。
//!
//! 命名空间刻意保持不变：所有命令与类型都在这里重新导出，调用方继续写
//! `commands::file::get_file_tree`。这样拆分对 `bootstrap` 的命令注册表零影响，
//! 也不需要为「文件现在住哪」引入第二套路径。
//!
//! 依赖方向只有三条，都是单向：`mutate` / `transfer` → `tree`（作用域判定与树
//! 节点）、`transfer` → `mutate`（错误码与名字校验）、`transfer` → `view`（移动
//! 之后要改默认笔记目录）。反向没有——`tree` 不认识任何写命令，`view` 不认识
//! `DocTreeItem`。

pub mod editor_components;
pub mod folder_import;
pub mod media;
pub mod mutate;
pub mod path_copy;
pub mod read;
pub mod transfer;
pub mod tree;
pub mod view;

#[cfg(test)]
mod tests;

// 命令与类型整体再导出。用通配而不是逐项列举是必需的：`#[tauri::command]` 会在
// 定义处一并生成 `__cmd__<name>` 宏，`generate_handler!` 查的是这条宏而不是函数，
// 逐个列名字会稳定漏掉它。
pub use editor_components::*;
pub use media::*;
pub use mutate::*;
pub use read::*;
pub use transfer::*;
pub use tree::*;
pub use view::*;

// 仍按 `commands::file::X` 取用的内部函数。其余跨子模块调用的 helper 都直接从
// 兄弟模块引入，不再绕经这一层。
pub(crate) use tree::tree_visibility_for;
pub(crate) use view::{
    default_create_folder_for_notebook, write_default_notebook_view_preferences,
};
