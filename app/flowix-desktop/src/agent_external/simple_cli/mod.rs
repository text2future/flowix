// 与 claude/codex/hermes 不同, simple_cli 没有独立的 history 子模块 ──
// Gemini / OpenClaw 的 session 仍由各自的 `~/.gemini/` / `~/.openclaw/`
// 目录持有, 但前端 UI 不直接列历史 (只在本 session 内 chat_stream), 所以
// 这里保持单文件即可。
//
// 整个 simple_cli 子模块的存在意义: 把 Gemini + OpenClaw 两种 "纯 stdout
// 文本输出" 的 small CLI 整合到一个 manager 后面, 共享 ExternalRunRegistry
// 注册表 + kill_child_tree 等 shared 工具, 不再让单个 vendor 自己造一份。

mod cli;
pub use cli::*;
