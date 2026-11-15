//! `.agents` 工作区的 IPC 门面。
//!
//! 读写规则全在 `flowix_core::notebook_agents`：符号链接拒绝、字段校验、原子替换
//! 都在那边。这里只做三件事 —— 把 `cwd` 收敛成绝对目录、调域函数、把错误原样交给
//! 前端。门面留在这里的唯一理由是命令要进 `generate_handler!`，而 core 不依赖 tauri。

use flowix_core::notebook_agents::{
    notebook_root, read_markdown_collection, read_workspace, write_workspace, NotebookAgentFile,
    NotebookAgentWorkspace,
};

#[tauri::command]
pub fn notebook_agent_workspace_read(cwd: String) -> Result<NotebookAgentWorkspace, String> {
    let root = notebook_root(&cwd)?;
    read_workspace(root)
}

#[tauri::command]
pub fn notebook_agent_skills_read(cwd: String) -> Result<Vec<NotebookAgentFile>, String> {
    let root = notebook_root(&cwd)?;
    read_markdown_collection(root, "skills")
}

#[tauri::command]
pub fn notebook_agent_workspace_write(
    cwd: String,
    workspace: NotebookAgentWorkspace,
) -> Result<NotebookAgentWorkspace, String> {
    let root = notebook_root(&cwd)?;
    write_workspace(root, &workspace)
}
