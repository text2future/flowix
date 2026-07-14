/**
 * Type definitions for Flowix app.
 *
 * 历史: 早期版本集中维护在这里 (含 Canva 树 / Bun RPC schema 等已废弃概念),
 * 后迁移到按 feature 拆分的 *.ts 子模块 (types/agent.ts / types/memo*.ts 等)。
 * 这里现在只剩:
 *   1. 真正的死代码删除后剩下的"应用级常量" (SUPPORTED_TEXT_EXTENSIONS)
 *   2. 对 `./agent` 的命名空间 re-export ── 保留 `@/types` 旧 import 路径,
 *      业务侧从 `@/types` 拿 ChatMessage / ThreadListItem / ToolCall 与
 *      从 `@/types/agent` 直接 import 等价。
 */

// ============================================
// Application-level constants
// ============================================

export const SUPPORTED_TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".html",
  ".css",
  ".scss",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".sh",
  ".bash",
  ".zsh",
  ".gitignore",
  ".env",
  ".conf",
  ".ini",
] as const;

// ============================================
// Re-exports from ./agent (canonical definitions live there)
// ============================================

export type {
  ChatMessage,
  ThreadListItem,
  ToolCall,
} from './agent';