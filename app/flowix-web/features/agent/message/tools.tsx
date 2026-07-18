import { TOOL_ICON_PATHS } from "@features/agent/message/tool-icon-paths";
import { translate, type AppLanguage, type I18nKey } from "@features/i18n";
import type { AgentTypeKey } from "@/types/agent";

/* ════════════════════════════════════════════════════════════════════════
 *  Agent 工具元数据 ── 单一真源 (single source of truth)
 * ════════════════════════════════════════════════════════════════════════
 *
 *  加一个新工具只改这一处数组 ── 与 Rust 端
 *  providers/tools/mod.rs::get_all_tools() 的工具名 1:1 对齐。
 *
 *  与 Rust providers/tools/mod.rs 的对应关系:
 *    name         ── Rust *tool() 构造时的 name 字面量 / TOOL_NAME 常量
 *    aliases      ── 同义 toolName 字符串 (历史遗留 / 跨运行时差异)
 *    label        ── 仅前端展示用
 *    iconPath     ── 仅前端展示用 (Phosphor regular path, 256×256 viewBox,
 *                  panel 和 card 共用同一份字符串)
 *
 *  不在本表 (各自归对应层):
 *    - Rust execute_tool match arm    ── providers/tools/mod.rs (行为)
 *    - Rust system prompt 描述         ── prompt/tools.rs (LLM 提示)
 *    - Rust 文件快照 invalidation      ── agent.rs (行为)
 *
 *  ── 模式参考 ──
 *    与 lib/agent-types.ts (类型图标) 同构:
 *      Array<Record> + getX(key) 查找 + 默认 fallback。
 *    与 slash-menu-dropdown.tsx (命令注册) 共享 keywords 概念,
 *      但本表用 aliases 而非 keywords ── 本表的别名是"等价映射"
 *      (同一工具的不同 toolName 字符串), 不是模糊匹配。
 *
 *  ── 模块拆分 (Phase 5) ──
 *    Phosphor path 字典抽到 ./tool-icon-paths.ts, 打破本文件 ↔
 *    ./tool-result-parts.tsx 的循环依赖 (result-parts 的 entry 图标
 *    需要 folder / fileText)。本文件 re-export TOOL_ICON_PATHS 保持
 *    向后兼容, 新代码可直接从 ./tool-icon-paths.ts 导入。
 *
 *  ── 图标统一 (Phase 4) ──
 *    之前 panel 走 lucide 24×24 stroke 2 组件, card 走 Phosphor 256×256
 *    fill regular path ── 视觉上"看起来像但不完全一样"。Phase 4 起统一
 *    到 Phosphor regular 256×256 fill, panel 和 card 共享同一份 iconPath
 *    字符串: 两侧都走 inline `<svg viewBox="0 0 256 256"><path d=...
 *    fill="currentColor" /></svg>`, 唯一差异是 card 是 DOM API,
 *    panel 是 JSX。视觉完全一致。
 * ════════════════════════════════════════════════════════════════════════ */

export interface AgentToolMeta {
  agentType?: AgentTypeKey | "*";
  /** Rust 注册的工具名 (canonical) ── 与 providers/tools/*.rs
   *  的 TOOL_NAME 常量或 *tool() 构造时的 name 字面量保持一致。 */
  name: string;
  /** 同义 toolName ── 同一工具的不同字符串。
   *  典型用例:
   *    - 历史遗留 (read_file → read)
   *    - 跨运行时差异 (execute_command → bash)
   *    - 命名风格对齐 (list_notebooks → ls)
   *  查询走 getToolMeta(name) ── name 和所有 aliases 都命中同一条记录。
   *  Phase 3 起大小写不敏感 ── Rust 端大写 / 大小写混合也命中。 */
  aliases?: readonly string[];
  /** i18n key ── 通过 translate(language, labelKey) 取当前语言展示标签。 */
  labelKey: I18nKey;
  /** Phosphor regular 路径 ── 256×256 viewBox, fill="currentColor" 渲染。
   *  14×14 渲染尺寸, 跨 panel (JSX inline SVG) 和 card (DOM inline SVG)
   *  共用同一份 path 字符串 ── 视觉完全统一。值必须来自 TOOL_ICON_PATHS
   *  的某个 key (类型约束)。 */
  iconPath: string;
}

export interface AgentToolLookup {
  agentType?: AgentTypeKey;
  toolName?: string;
}

/* ── 工具元数据表 ── 单源真源 ─────────────────────────────────
 * 与 Rust providers/tools/mod.rs 的工具集 1:1 对齐。
 * aliases 收敛历史遗留 / 跨运行时差异 ── 加新别名只改这里。 */
export const TOOLS: readonly AgentToolMeta[] = [
  {
    name: "read",
    aliases: ["read_file"],
    labelKey: "agent.tools.read",
    iconPath: TOOL_ICON_PATHS.fileText,
  },
  {
    name: "write",
    aliases: ["write_file", "create_file"],
    labelKey: "agent.tools.write",
    iconPath: TOOL_ICON_PATHS.filePlus,
  },
  {
    name: "edit",
    aliases: ["edit_file"],
    labelKey: "agent.tools.edit",
    iconPath: TOOL_ICON_PATHS.filePlus,
  },
  {
    name: "ls",
    aliases: ["list_directory", "list_notebooks"],
    labelKey: "agent.tools.ls",
    iconPath: TOOL_ICON_PATHS.folder,
  },
  {
    name: "glob",
    aliases: ["search_files"],
    labelKey: "agent.tools.glob",
    iconPath: TOOL_ICON_PATHS.magnify,
  },
  {
    name: "grep",
    labelKey: "agent.tools.grep",
    iconPath: TOOL_ICON_PATHS.magnify,
  },
  {
    name: "web_search",
    aliases: [
      "web_search_preview",
      "web_search_call",
      "search_query",
      "search_web",
      "network_search",
      "web search",
    ],
    labelKey: "agent.tools.webSearch",
    iconPath: TOOL_ICON_PATHS.globe,
  },
  {
    name: "shell",
    aliases: [
      "run_command",
      "execute",
      "terminal",
      "powershell",
      "cmd",
    ],
    labelKey: "agent.tools.shell",
    iconPath: TOOL_ICON_PATHS.terminal,
  },
  {
    name: "bash",
    aliases: [
      "execute_command",
      "command_execution",
      "exec_command",     // Codex CLI 实际 function_call.name (117 个 session 验证)
      "command_execute",
      "shell_command",
    ],
    labelKey: "agent.tools.bash",
    iconPath: TOOL_ICON_PATHS.terminal,
  },
  {
    name: "available_dirs",
    labelKey: "agent.tools.availableDirs",
    iconPath: TOOL_ICON_PATHS.folder,
  },
  {
    name: "delete",
    aliases: ["delete_file"],
    labelKey: "agent.tools.deleteFile",
    iconPath: TOOL_ICON_PATHS.trash,
  },
  {
    name: "code",
    labelKey: "agent.tools.code",
    iconPath: TOOL_ICON_PATHS.code,
  },
  {
    name: "git_branch",
    aliases: ["git_commit", "git_status"],
    labelKey: "agent.tools.gitBranch",
    iconPath: TOOL_ICON_PATHS.gitBranch,
  },
  {
    name: "db_query",
    aliases: ["database"],
    labelKey: "agent.tools.dbQuery",
    iconPath: TOOL_ICON_PATHS.database,
  },
  {
    name: "server",
    aliases: ["api"],
    labelKey: "agent.tools.server",
    iconPath: TOOL_ICON_PATHS.globe,
  },
  {
    name: "settings",
    labelKey: "agent.tools.settings",
    iconPath: TOOL_ICON_PATHS.gear,
  },
  {
    name: "run",
    labelKey: "agent.tools.run",
    iconPath: TOOL_ICON_PATHS.play,
  },
  {
    name: "stop",
    labelKey: "agent.tools.stop",
    iconPath: TOOL_ICON_PATHS.pause,
  },
  {
    name: "restart",
    labelKey: "agent.tools.restart",
    iconPath: TOOL_ICON_PATHS.arrowsClockwise,
  },
  {
    name: "view",
    labelKey: "agent.tools.view",
    iconPath: TOOL_ICON_PATHS.eye,
  },
  {
    name: "load_skill",
    labelKey: "agent.tools.loadSkill",
    iconPath: TOOL_ICON_PATHS.fileText,
  },
  {
    name: "sub_agent",
    labelKey: "agent.tools.subAgent",
    iconPath: TOOL_ICON_PATHS.globe,
  },
  {
    name: "update_plan",
    aliases: [
      "todo_list",
      "todowrite",
      "todo",
      "plan",
      "todolist",
      "update_todo_list",
    ],
    labelKey: "agent.tools.updatePlan",
    iconPath: TOOL_ICON_PATHS.checks,
  },
  {
    name: "apply_patch",
    labelKey: "agent.tools.applyPatch",
    iconPath: TOOL_ICON_PATHS.filePlus,
  },
  {
    name: "request_user_input",
    labelKey: "agent.tools.requestUserInput",
    iconPath: TOOL_ICON_PATHS.chatCircleText,
  },
  // Codex function tools. These names come from function_call.name in the
  // active Codex tool surface; they are distinct from item.type families
  // such as mcp_tool_call and file_change below.
  {
    agentType: "codex",
    name: "list_mcp_resources",
    labelKey: "agent.tools.explored",
    iconPath: TOOL_ICON_PATHS.plug,
  },
  {
    agentType: "codex",
    name: "list_mcp_resource_templates",
    labelKey: "agent.tools.explored",
    iconPath: TOOL_ICON_PATHS.plug,
  },
  {
    agentType: "codex",
    name: "read_mcp_resource",
    labelKey: "agent.tools.explored",
    iconPath: TOOL_ICON_PATHS.plug,
  },
  {
    agentType: "codex",
    name: "get_goal",
    labelKey: "agent.tools.getGoal",
    iconPath: TOOL_ICON_PATHS.checks,
  },
  {
    agentType: "codex",
    name: "create_goal",
    labelKey: "agent.tools.createGoal",
    iconPath: TOOL_ICON_PATHS.checks,
  },
  {
    agentType: "codex",
    name: "update_goal",
    labelKey: "agent.tools.updateGoal",
    iconPath: TOOL_ICON_PATHS.checks,
  },
  {
    agentType: "codex",
    name: "view_image",
    labelKey: "agent.tools.viewImage",
    iconPath: TOOL_ICON_PATHS.image,
  },
  {
    agentType: "codex",
    name: "exec",
    aliases: ["wait", "write_stdin"],
    labelKey: "agent.tools.bash",
    iconPath: TOOL_ICON_PATHS.terminal,
  },
  {
    agentType: "codex",
    name: "apply_patch",
    labelKey: "agent.tools.edited",
    iconPath: TOOL_ICON_PATHS.filePlus,
  },
  {
    agentType: "codex",
    name: "mcp_tool_call",
    labelKey: "agent.tools.mcpToolCall",
    iconPath: TOOL_ICON_PATHS.plug,
  },
  {
    agentType: "codex",
    name: "file_change",
    labelKey: "agent.tools.edited",
    iconPath: TOOL_ICON_PATHS.fileCode,
  },
  {
    agentType: "codex",
    name: "image_generation",
    aliases: ["image_generation_call"],
    labelKey: "agent.tools.imageGeneration",
    iconPath: TOOL_ICON_PATHS.image,
  },
  {
    agentType: "codex",
    name: "dynamic_tool_call",
    labelKey: "agent.tools.dynamicToolCall",
    iconPath: TOOL_ICON_PATHS.wrench,
  },
  {
    agentType: "codex",
    name: "collab_agent_tool_call",
    labelKey: "agent.tools.collabAgentToolCall",
    iconPath: TOOL_ICON_PATHS.usersThree,
  },
  {
    agentType: "codex",
    name: "tool_search",
    aliases: ["tool_search_call", "tool_search_output"],
    labelKey: "agent.tools.explored",
    iconPath: TOOL_ICON_PATHS.magnifyPlus,
  },
] as const;

/* ── 派生索引 ── 把所有 aliases 摊平到一个 Map, O(1) 查询 ──────
 * 在模块加载时构建一次, 之后所有 getToolMeta 调用都是 Map.get。
 *
 * 为什么不用 Record<name, AgentToolMeta> 重复 key 风格 (icons.ts 的旧模式)?
 *   - 每条工具的 metadata (label / iconPath) 只写一次
 *   - aliases 在 record 里就是字符串数组, 加新别名 = 数组里加字符串
 *   - 查找时不用区分"这个名字是 canonical 还是 alias"
 *
 * key 全部 lowercase ── 见 getToolMeta 的 .toLowerCase() ── Rust 端
 * 工具名按约定都是小写 ("read" / "bash" / "execute_command" 等),
 * 但 Phase 3 起我们放宽匹配, 防御性地 toLowerCase 兜底。 */
const BY_NAME = new Map<string, AgentToolMeta>();
for (const tool of TOOLS) {
  const agentType = tool.agentType ?? "*";
  BY_NAME.set(`${agentType}:${tool.name.toLowerCase()}`, tool);
  for (const alias of tool.aliases ?? []) {
    BY_NAME.set(`${agentType}:${alias.toLowerCase()}`, tool);
  }
}

function normalizeToolLookup(input: string | AgentToolLookup | undefined): {
  agentType?: AgentTypeKey;
  toolName?: string;
} {
  return typeof input === "string" || input === undefined
    ? { toolName: input }
    : input;
}

/* ── 查询 API ─────────────────────────────────────────────────
 *
 * getToolMeta 返回 undefined ── 让调用方决定 fallback 策略
 * (有时调用方想区分"工具存在但未注册 icon"和"工具完全未知")。
 * 两个便利函数 (getToolIconPath / getToolLabel) 都自带 fallback,
 * 常见场景直接用这两个。 */

export function getToolMeta(
  input: string | AgentToolLookup | undefined,
): AgentToolMeta | undefined {
  const { agentType, toolName } = normalizeToolLookup(input);
  if (!toolName) return undefined;
  const normalizedToolName = toolName.toLowerCase();
  return (
    (agentType
      ? BY_NAME.get(`${agentType}:${normalizedToolName}`)
      : undefined) ?? BY_NAME.get(`*:${normalizedToolName}`)
  );
}

/** Phosphor regular 路径查询 ── 面板 (JSX inline SVG) 和卡片 (DOM inline SVG)
 *  共用同一份 path 字符串。未命中 / name 为空 → terminal path (fallback)。 */
export function getToolIconPath(
  input: string | AgentToolLookup | undefined,
): string {
  return getToolMeta(input)?.iconPath ?? TOOL_ICON_PATHS.terminal;
}

/** 标签查询 ── 未命中时用 titleCase 兜底 (与 formatToolName 原行为一致) */
export function getToolLabel(
  input: string | AgentToolLookup | undefined,
  language: AppLanguage = "zh-CN",
): string {
  const { toolName } = normalizeToolLookup(input);
  const meta = getToolMeta(input);
  if (meta) return translate(language, meta.labelKey);
  if (!toolName) return translate(language, "agent.tools.unknown");
  return toolName
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
