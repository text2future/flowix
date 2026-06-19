/**
 * 语义归一 + 字节级比较工具 ── "用户实际编辑了吗?" 的统一判断依据。
 *
 * ## 设计动机
 *
 * 解决 rich editor 的"伪编辑"问题 ── Tiptap 在 mount 阶段会解析 + 规范化
 * markdown, 规范化后的字节可能跟磁盘原文不一致, 但语义相同:
 *
 * 1. **行尾归一 (CRLF → LF)** ── Windows 磁盘原文 (\r\n) 跟 Tiptap 输出 (\n)
 *    字节差 1, 是 Windows 上"打开即写盘" bug 的根因 (见 [use-document-autosave.ts]
 *    `isInitialMountRef` 注释)。
 * 2. **末尾补/去换行** ── Tiptap `getMarkdown()` 习惯性追加 `\n`。
 * 3. **frontmatter 字段重排** ── YAML 解析后字段按 key 字母序重排。
 * 4. **块间空行折叠** ── 连续空行压成单个。
 *
 * 这些都是结构化编辑器的固有不变量 (Obsidian / Typora / Bear 同款), 不能也
 * 不该"保留原字节" ── 见根因调查记录。但应当视为语义等同, 不应触发
 * dirty / 写盘。
 *
 * ## 统一基准
 *
 * 取代原来散落在 `buffer-registry.ts` / `document-session-service.ts` 的
 * byte equality, 三处 dirty 检查必须保持一致, 否则状态机不自洽:
 *
 * - `recordDocumentEdit` ── 编辑检测
 * - `flushDocument` ── 写盘前 dirty 检查 + onSaved 后同步检查
 * - `hasUnsavedLocalChanges` / `hasUnsavedLocalChangesForMemo` ── 冲突
 *   检测
 *
 * ## 已知 trade-off
 *
 * 用户改 frontmatter 块但 body 不变, 视为不 dirty ── 外部 reloadDocument
 * 会覆盖用户对 frontmatter 的修改。罕见, 用户可手动重新编辑 frontmatter。
 */

/**
 * 把 markdown 字符串归一到"语义比较"形态:
 * - 行尾统一 LF (抹掉 Windows CRLF / 旧版 Mac CR)
 * - 移除 frontmatter 块 (避免 YAML 重排差异)
 * - 去掉首尾空白换行
 *
 * 跟 Rust 后端 `extract_body_content` 的差异 (见 `document-utils.ts`):
 * 本函数额外 trim 首尾, 因 Tiptap 序列化常在 frontmatter 闭合后多生
 * `\n` 或 trailing `\n`, 字节差 1 即被误判为 dirty。
 */
export function normalizeForEquality(content: string): string {
  return content
    .replace(/\r\n/g, '\n')                          // CRLF → LF (Windows 关键)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')  // strip frontmatter
    .replace(/^[\r\n]+/, '')                          // trim leading
    .replace(/[\r\n]+$/, '');                         // trim trailing (Tiptap 必加)
}

/**
 * 语义等同判断 ── 调用方拿到的是否"实质相同"的两个 markdown 字符串。
 */
export function isContentSemanticallyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeForEquality(a) === normalizeForEquality(b);
}
