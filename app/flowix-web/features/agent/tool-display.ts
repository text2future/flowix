import type {
  AgentToolDisplay,
  AgentToolDisplayKind,
  AgentTypeKey,
} from "@/types/agent";
import type { AppLanguage } from "@features/i18n";

type ToolDisplayFormatter = (
  input: Record<string, unknown>,
  context: AgentToolDisplayContext,
) => AgentToolDisplay | undefined;

export interface AgentToolDisplayContext {
  agentType?: AgentTypeKey;
  toolName?: string;
  input: unknown;
}

function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || path;
}

function stringField(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function deepStringField(
  input: unknown,
  keys: readonly string[],
  depth = 3,
): string | undefined {
  if (!input || depth < 0) return undefined;
  if (Array.isArray(input)) {
    for (const item of input) {
      const nested = deepStringField(item, keys, depth - 1);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof input !== "object") return undefined;

  const record = input as Record<string, unknown>;
  const direct = stringField(record, keys);
  if (direct) return direct;

  for (const value of Object.values(record)) {
    const nested = deepStringField(value, keys, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

interface StringLeaf {
  key?: string;
  path: string[];
  value: string;
}

const SEARCH_QUERY_KEYS = [
  "query",
  "search_query",
  "searchQuery",
  "search_terms",
  "searchTerms",
  "search_term",
  "searchTerm",
  "q",
  "term",
  "terms",
  "pattern",
  "regex",
  "keywords",
] as const;

const SEARCH_FALLBACK_KEYS = new Set([
  ...SEARCH_QUERY_KEYS,
  "text",
  "content",
  "value",
  "input",
  "title",
  "description",
]);

const SEARCH_NOISE_VALUES = new Set([
  "action",
  "completed",
  "done",
  "failed",
  "in_progress",
  "network_search",
  "open",
  "pending",
  "queued",
  "search",
  "search_query",
  "search_web",
  "succeeded",
  "success",
  "web_search",
  "web_search_call",
  "web_search_preview",
]);

function collectStringLeaves(
  input: unknown,
  depth = 5,
  path: string[] = [],
): StringLeaf[] {
  if (!input || depth < 0) return [];
  if (typeof input === "string") {
    const value = input.trim();
    return value ? [{ key: path[path.length - 1], path, value }] : [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((item, index) =>
      collectStringLeaves(item, depth - 1, [...path, String(index)]),
    );
  }
  if (typeof input !== "object") return [];

  return Object.entries(input as Record<string, unknown>).flatMap(
    ([key, value]) => collectStringLeaves(value, depth - 1, [...path, key]),
  );
}

function isSearchNoiseString(value: string, key?: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || SEARCH_NOISE_VALUES.has(normalized)) return true;
  if (normalized.length <= 2 && !normalized.includes(":")) return true;
  if (key && /(^|_)(id|type|status|state|kind|name)$/.test(key)) return true;
  if (/^(call|item|tool|ws|run|msg)_[a-z0-9_-]+$/i.test(value)) return true;
  return false;
}

function scoreSearchCandidate(leaf: StringLeaf): number {
  const key = leaf.key ?? "";
  const path = leaf.path.join(".");
  const value = leaf.value;
  let score = 0;

  if (SEARCH_FALLBACK_KEYS.has(key)) score += 80;
  if (/query|search|term|keyword|pattern/i.test(path)) score += 40;
  if (/\bsite:/i.test(value)) score += 35;
  if (/https?:\/\//i.test(value)) score += 20;
  if (/\s/.test(value)) score += 15;
  if (value.length >= 12) score += 10;
  if (value.length >= 32) score += 5;
  if (/action|arguments|params|input/i.test(path)) score += 5;
  if (/status|state|type|kind|id/i.test(path)) score -= 60;

  return score;
}

function fallbackSearchQuery(input: unknown): string | undefined {
  const candidates = collectStringLeaves(input)
    .filter((leaf) => !isSearchNoiseString(leaf.value, leaf.key))
    .map((leaf) => ({ leaf, score: scoreSearchCandidate(leaf) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.leaf.value;
}

function display(
  summary: string | undefined,
  kind: AgentToolDisplayKind,
  title?: string,
): AgentToolDisplay | undefined {
  if (!summary) return undefined;
  return {
    summary,
    title: title || summary,
    kind,
  };
}

export function normalizeToolInput(
  input: unknown,
): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (Array.isArray(input)) return { items: input };
  if (typeof input === "string" && input.trim()) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { command: input };
    }
    return { command: input };
  }
  return undefined;
}

function fieldKind(key: string): AgentToolDisplayKind {
  if (
    key === "command" ||
    key === "command_text" ||
    key === "commandText" ||
    key === "cmd" ||
    key === "cmdline" ||
    key === "shell_command" ||
    key === "command_preview" ||
    key === "script"
  )
    return "command";
  if (key === "path" || key === "cwd") return "file";
  if (key === "query" || key === "pattern") return "search";
  if (key === "url" || key === "href") return "network";
  return "generic";
}

function fileDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const path = stringField(input, ["path", "file_path", "filepath"]);
  return display(path ? extractFileName(path) : undefined, "file", path);
}

function directoryDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const path = stringField(input, ["path", "cwd", "directory"]);
  return display(path ? extractFileName(path) : undefined, "file", path);
}

const COMMAND_KEYS = [
  "command_preview",
  "command",
  "command_text",
  "commandText",
  "cmd",
  "cmdline",
  "shell_command",
  "script",
] as const;

function commandDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const command = stringField(input, COMMAND_KEYS);
  // codex 后端用 workdir, 不是 cwd/working_directory
  const cwd = stringField(input, ["workdir", "cwd", "working_directory"]);
  return display(command, "command", cwd ? `${command}\n${cwd}` : command);
}

export type AgentCommandOperator = "&&" | "||" | ";" | "|";

export interface AgentCommandItem {
  op?: AgentCommandOperator;
  command: string;
  args: string[];
  env: string[];
  raw: string;
  wrapper?: {
    label: string;
    payload: AgentCommandList;
  };
}

export interface AgentCommandList {
  items: AgentCommandItem[];
}

interface CommandToken {
  text: string;
  quoted: boolean;
  op?: AgentCommandOperator;
}

const COMMAND_SCRIPT_FLAGS = new Set([
  "-c",
  "-lc",
  "-ic",
  "-lic",
  "-e",
]);

const COMMAND_WRAPPER_NAMES = new Set([
  "bash",
  "dash",
  "fish",
  "ksh",
  "node",
  "perl",
  "php",
  "python",
  "python2",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);

function basenameCommandName(command: string): string {
  return command.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? command;
}

/**
 * 公开的 basename 提取 ── 给前端渲染用 (例: thread card 展示命令名)。
 * 把 Windows / POSIX 路径末尾的文件名/可执行名取出, 非路径输入保持原样。
 *
 *   basenameCommandNameForDisplay("C:\\Windows\\...\\powershell.exe")
 *     === "powershell.exe"
 *   basenameCommandNameForDisplay("/usr/local/bin/node")
 *     === "node"
 *   basenameCommandNameForDisplay("rg")
 *     === "rg"
 *
 * 跟模块内部 `basenameCommandName` 不同: 内部版假设输入已 tokenize,
 * 不带 `\`, 也不关心 unicode 安全; 这里我们保留 backslash 兼容 + 对
 * 路径分隔符做显式检测 ── 调用方可以决定什么时候才走 basename。
 */
export function basenameCommandNameForDisplay(command: string): string {
  return basenameCommandName(command);
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let text = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  const push = () => {
    if (!text) return;
    tokens.push({ text, quoted });
    text = "";
    quoted = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === "\\" && next !== undefined) {
      text += next;
      i += 1;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        text += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (parenDepth > 0 || bracketDepth > 0 || braceDepth > 0) {
        text += ch;
        continue;
      }
      push();
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      text += ch;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      text += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      text += ch;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      text += ch;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      text += ch;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      text += ch;
      continue;
    }

    const atTopLevel =
      parenDepth === 0 && bracketDepth === 0 && braceDepth === 0;

    if (
      atTopLevel &&
      ((ch === "&" && next === "&") || (ch === "|" && next === "|"))
    ) {
      push();
      tokens.push({ text: ch + next, quoted: false, op: ch + next as AgentCommandOperator });
      i += 1;
      continue;
    }

    if (atTopLevel && (ch === ";" || ch === "|")) {
      push();
      tokens.push({ text: ch, quoted: false, op: ch as AgentCommandOperator });
      continue;
    }

    text += ch;
  }
  push();
  return tokens;
}

function tokenText(tokens: CommandToken[]): string {
  return tokens.map((token) => token.text).join(" ").trim();
}

function parseCommandTokens(
  tokens: CommandToken[],
  op: AgentCommandOperator | undefined,
  depth: number,
): AgentCommandItem | null {
  const words = tokens.filter((token) => !token.op && token.text);
  if (words.length === 0) return null;

  const script = findWrapperScript(words);
  const env: string[] = [];
  let commandIndex = 0;
  while (commandIndex < words.length && isEnvAssignment(words[commandIndex].text)) {
    env.push(words[commandIndex].text);
    commandIndex += 1;
  }
  const command = words[commandIndex]?.text;
  if (!command) return null;

  const item: AgentCommandItem = {
    op,
    command,
    args: words.slice(commandIndex + 1).map((token) => token.text),
    env,
    raw: tokenText(words),
  };

  if (script && depth < 2) {
    const payload = parseCommandString(script.payload, depth + 1);
    if (payload) {
      item.wrapper = {
        label: tokenText(words.slice(0, script.payloadIndex)),
        payload,
      };
    }
  }

  return item;
}

function findWrapperScript(
  tokens: CommandToken[],
): { payload: string; payloadIndex: number } | null {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const name = basenameCommandName(tokens[i].text).toLowerCase();
    if (!COMMAND_WRAPPER_NAMES.has(name)) continue;

    for (let j = i + 1; j < tokens.length - 1; j += 1) {
      const flag = tokens[j].text;
      if (!flag.startsWith("-")) break;
      if (COMMAND_SCRIPT_FLAGS.has(flag) || /c$/.test(flag)) {
        return { payload: tokens[j + 1].text, payloadIndex: j + 1 };
      }
    }
  }
  return null;
}

function parseCommandString(
  command: string,
  depth = 0,
): AgentCommandList | null {
  const tokens = tokenizeCommand(command);
  const items: AgentCommandItem[] = [];
  let segment: CommandToken[] = [];
  let op: AgentCommandOperator | undefined;

  for (const token of tokens) {
    if (token.op) {
      const item = parseCommandTokens(segment, op, depth);
      if (item) items.push(item);
      segment = [];
      op = token.op;
    } else {
      segment.push(token);
    }
  }

  const last = parseCommandTokens(segment, op, depth);
  if (last) items.push(last);

  return items.length > 0 ? { items } : null;
}

export function parseAgentCommandInput(
  input: unknown,
): AgentCommandList | null {
  const normalized = normalizeToolInput(input);
  if (!normalized) return null;
  const command = stringField(normalized, COMMAND_KEYS);
  if (!command) return null;
  return parseCommandString(command);
}

function searchDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const query =
    deepStringField(input, SEARCH_QUERY_KEYS) ?? fallbackSearchQuery(input);
  const path = deepStringField(input, ["path", "cwd", "include"]);
  return display(query, "search", path ? `${query}\n${path}` : query);
}

function skillDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  return display(
    stringField(input, ["name", "skill", "skill_name"]),
    "generic",
  );
}

function agentDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  return display(
    stringField(input, ["prompt", "task", "description", "message"]),
    "generic",
  );
}

function urlDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  return display(stringField(input, ["url", "href", "endpoint"]), "network");
}

function mcpToolDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const tool = deepStringField(input, ["tool", "tool_name", "name"]);
  const server = deepStringField(input, ["server"]);
  if (!tool) return undefined;
  const rawArguments = input.arguments;
  let args: Record<string, unknown> | undefined;
  if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    args = rawArguments as Record<string, unknown>;
  } else if (typeof rawArguments === "string" && rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = { input: rawArguments };
    }
  }

  const sensitive = /(^|_)(token|password|passwd|secret|authorization|api_?key)($|_)/i;
  const priority = [
    "command",
    "query",
    "uri",
    "path",
    "url",
    "title",
    "prompt",
    "pattern",
    "name",
    "id",
    "key",
    "input",
    "code",
    "stdin",
  ];
  const entries = Object.entries(args ?? {}).filter(
    ([key, value]) => !sensitive.test(key) && value !== undefined && value !== null,
  );
  entries.sort(([left], [right]) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    return (leftIndex < 0 ? priority.length : leftIndex) -
      (rightIndex < 0 ? priority.length : rightIndex);
  });
  const core = entries.slice(0, 2).flatMap(([key, value]) => {
    const text = valueToText(value).replace(/\s+/g, " ").trim();
    return text ? [`${key}: ${truncate(text, 72)}`] : [];
  });
  const summary = core.length > 0 ? `${tool} · ${core.join(" · ")}` : tool;
  return display(summary, "generic", server ? `${server} · ${summary}` : summary);
}

interface FileChangeSummaryEntry {
  path: string;
  action?: string;
}

function fileChangeEntries(input: Record<string, unknown>): FileChangeSummaryEntry[] {
  const changes = input.changes ?? input.items ?? input;
  if (Array.isArray(changes)) {
    return changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const record = change as Record<string, unknown>;
      const path = stringField(record, ["path", "file", "filename"]);
      if (!path) return [];
      return [{ path, action: stringField(record, ["kind", "type", "action"]) }];
    });
  }
  if (!changes || typeof changes !== "object") return [];
  const record = changes as Record<string, unknown>;
  const directPath = stringField(record, ["path", "file", "filename"]);
  if (directPath) {
    return [
      {
        path: directPath,
        action: stringField(record, ["kind", "type", "action"]),
      },
    ];
  }
  return Object.entries(record).flatMap(([path, detail]) => {
    if (!path.includes("/") && !path.includes("\\")) return [];
    const action =
      detail && typeof detail === "object"
        ? stringField(detail as Record<string, unknown>, ["kind", "type", "action"])
        : undefined;
    return [{ path, action }];
  });
}

function fileChangeDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const entries = fileChangeEntries(input);
  if (entries.length === 0) return undefined;
  const first = entries[0];
  const action = first.action?.toLowerCase();
  const verb =
    action === "add" || action === "create"
      ? "Add"
      : action === "delete" || action === "remove"
        ? "Delete"
        : action === "update" || action === "modify"
          ? "Update"
          : "Change";
  const name = extractFileName(first.path);
  const summary =
    entries.length === 1
      ? `${verb} ${name}`
      : `${verb} ${name} (+${entries.length - 1})`;
  return display(summary, "file", first.path);
}

function viewImageDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const directPath = deepStringField(input, ["path", "image_path", "file"]);
  if (directPath) return display(extractFileName(directPath), "file", directPath);
  const command = stringField(input, ["command", "script"]);
  const wrappedPath = command?.match(/\bpath\s*:\s*["']([^"']+)["']/)?.[1];
  return wrappedPath
    ? display(extractFileName(wrappedPath), "file", wrappedPath)
    : undefined;
}

/* ════════════════════════════════════════════════════════════════════════
 *  patchDisplay ── Codex apply_patch 工具
 *
 *  arguments: { command: string }  (command 字段值 = 完整 patch 文本)
 *
 *  patch 文本格式:
 *    apply_patch                  ← 可选前缀
 *    *** Begin Patch
 *    *** Update File: /abs/path
 *    @@
 *     context
 *    -removed
 *    +added
 *    *** End Patch
 *
 *  summary = "Update <basename>" / "Add <basename>" / "Delete <basename>"
 *  title   = 完整 patch 第一行
 *  kind    = "patch"
 * ════════════════════════════════════════════════════════════════════════ */
export interface AgentPatchEntry {
  action: "update" | "add" | "delete" | "move" | "unknown";
  path: string;
}

export function parseAgentPatch(
  input: Record<string, unknown> | undefined,
): AgentPatchEntry[] {
  const raw = input?.command;
  if (typeof raw !== "string" || !raw) return [];
  const entries: AgentPatchEntry[] = [];
  const re = /\*\*\* (?:(Update|Add|Delete) File:|(Move to):) ([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const actionRaw = m[1] || m[2];
    const path = m[3].trim();
    let action: AgentPatchEntry["action"] = "unknown";
    if (actionRaw === "Update") action = "update";
    else if (actionRaw === "Add") action = "add";
    else if (actionRaw === "Delete") action = "delete";
    else if (actionRaw === "Move to") action = "move";
    entries.push({ action, path });
  }
  return entries;
}


/* ════════════════════════════════════════════════════════════════════════
 *  requestUserInputDisplay ── Codex request_user_input 工具
 *
 *  arguments: { questions: Array<{ header, id, question, options }> }
 *
 *  summary = "问 1 个问题" / "问 3 个问题" / "问 1 个问题 (4 选项)"
 *  title   = "Question"
 *  kind    = "question"
 * ════════════════════════════════════════════════════════════════════════ */
export interface AgentRequestUserInputOption {
  label: string;
  description?: string;
}
export interface AgentRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: AgentRequestUserInputOption[];
}
export interface AgentRequestUserInput {
  questions: AgentRequestUserInputQuestion[];
}

const QUESTION_TEXT_MAX = 60;
const OPTION_LABEL_MAX = 40;
const HEADER_MAX = 24;

function truncateField(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function parseAgentRequestUserInput(
  input: Record<string, unknown> | undefined,
): AgentRequestUserInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AgentRequestUserInputQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : "";
    const header = typeof obj.header === "string" ? obj.header : "";
    const question = typeof obj.question === "string" ? obj.question : "";
    const rawOptions = obj.options;
    if (!Array.isArray(rawOptions)) continue;
    const options: AgentRequestUserInputOption[] = [];
    for (const opt of rawOptions) {
      if (!opt || typeof opt !== "object") continue;
      const o = opt as Record<string, unknown>;
      if (typeof o.label !== "string" || !o.label.trim()) continue;
      options.push({
        label: truncateField(o.label.trim(), OPTION_LABEL_MAX),
        description:
          typeof o.description === "string" && o.description.trim()
            ? o.description.trim()
            : undefined,
      });
    }
    if (!question.trim() || options.length === 0) continue;
    questions.push({
      id,
      header: header ? truncateField(header, HEADER_MAX) : "Question",
      question: question.trim(),
      options,
    });
  }
  return questions.length > 0 ? { questions } : null;
}

function requestUserInputDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const parsed = parseAgentRequestUserInput(input);
  if (!parsed) return undefined;
  const n = parsed.questions.length;
  const totalOptions = parsed.questions.reduce(
    (sum, q) => sum + q.options.length,
    0,
  );
  // 多个 question 时 summary 拼出选项总数, 单 question 保留 header 提示
  const firstHeader = parsed.questions[0]?.header;
  const summary =
    n === 1
      ? firstHeader
        ? truncateField(firstHeader, QUESTION_TEXT_MAX)
        : truncateField(parsed.questions[0].question, QUESTION_TEXT_MAX)
      : `${n} questions (${totalOptions} options)`;
  return display(summary, "question", "Question");
}

function patchDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const entries = parseAgentPatch(input);
  if (entries.length === 0) return undefined;
  const first = entries[0];
  const verb =
    first.action === "update"
      ? "Update"
      : first.action === "add"
        ? "Add"
        : first.action === "delete"
          ? "Delete"
          : "Patch";
  const name = extractFileName(first.path) || first.path;
  const summary =
    entries.length === 1
      ? `${verb} ${name}`
      : `${verb} ${name} (+${entries.length - 1})`;
  return display(summary, "patch", first.path);
}

/* ════════════════════════════════════════════════════════════════════════
 *  todoDisplay ── Codex update_plan 工具 (含 TodoWrite / todo_list 等别名)
 *
 *  arguments: { plan: Array<{ status, step }> }
 *
 *  summary = "N/M · 正在做: <current step>"   (单行展示)
 *  title   = "Todo" / "待办"                  (卡片标题)
 *  kind    = "todo"                            (新加的 kind, 给 renderer 分支用)
 *
 *  与其它 formatter 同构: 失败返回 undefined, 让 createAgentToolDisplay
 *  走 getAgentToolInputSummary fallback 路径.
 * ════════════════════════════════════════════════════════════════════════ */
export function formatAgentPlanSummaryForDisplay(
  input: Record<string, unknown>,
): string {
  const parsed = parseAgentPlan(input);
  if (!parsed) return "";
  const total = parsed.plan.length;
  const done = parsed.plan.filter((s) => s.status === "completed").length;
  const current = parsed.plan.find((s) => s.status === "in_progress");
  if (current) return `${done}/${total} · ${truncate(current.step, PLAN_SUMMARY_MAX)}`;
  return `${done}/${total}`;
}

function todoDisplay(
  input: Record<string, unknown>,
): AgentToolDisplay | undefined {
  const plan = parseAgentPlan(input);
  if (!plan) return undefined;
  const summary = formatAgentPlanSummaryForDisplay(input);
  if (!summary) return undefined;
  return display(summary, "todo", "Todo");
}

const FORMATTERS: Record<string, ToolDisplayFormatter> = {
  "*:read": fileDisplay,
  "*:read_file": fileDisplay,
  "*:write": fileDisplay,
  "*:write_file": fileDisplay,
  "*:create_file": fileDisplay,
  "*:edit": fileDisplay,
  "*:edit_file": fileDisplay,
  "*:delete": fileDisplay,
  "*:delete_file": fileDisplay,
  "*:ls": directoryDisplay,
  "*:list_directory": directoryDisplay,
  "*:list_notebooks": directoryDisplay,
  "*:glob": searchDisplay,
  "*:search_files": searchDisplay,
  "*:grep": searchDisplay,
  "codex:web_search": searchDisplay,
  "codex:web_search_preview": searchDisplay,
  "codex:web_search_call": searchDisplay,
  "codex:search_query": searchDisplay,
  "*:web_search": searchDisplay,
  "*:web_search_preview": searchDisplay,
  "*:web_search_call": searchDisplay,
  "*:search_query": searchDisplay,
  "*:web search": searchDisplay,
  "*:search_web": searchDisplay,
  "*:network_search": searchDisplay,
  "*:shell": commandDisplay,
  "*:bash": commandDisplay,
  "*:exec_command": commandDisplay,
  "*:command_execute": commandDisplay,
  "*:run_command": commandDisplay,
  "*:execute": commandDisplay,
  "*:terminal": commandDisplay,
  "*:powershell": commandDisplay,
  "*:cmd": commandDisplay,
  "codex:command_execution": commandDisplay,
  "codex:shell_command": commandDisplay,
  "claude:bash": commandDisplay,
  "claude:shell": commandDisplay,
  "claude:run_command": commandDisplay,
  "hermes:shell": commandDisplay,
  "hermes:bash": commandDisplay,
  "hermes:run_command": commandDisplay,
  "flowix:shell": commandDisplay,
  "flowix:bash": commandDisplay,
  "flowix:run_command": commandDisplay,
  "*:execute_command": commandDisplay,
  "*:command_execution": commandDisplay,
  "*:shell_command": commandDisplay,
  "codex:mcp_tool_call": mcpToolDisplay,
  "codex:file_change": fileChangeDisplay,
  "codex:view_image": viewImageDisplay,
  "*:load_skill": skillDisplay,
  "*:sub_agent": agentDisplay,
  "*:server": urlDisplay,
  "*:api": urlDisplay,
  // update_plan / TodoWrite / todo_list 统一走 todoDisplay
  "*:update_plan": todoDisplay,
  "*:update_todo_list": todoDisplay,
  "*:todo_list": todoDisplay,
  "*:todowrite": todoDisplay,
  "*:todolist": todoDisplay,
  "*:todo": todoDisplay,
  "*:plan": todoDisplay,
  "codex:update_plan": todoDisplay,
  "codex:update_todo_list": todoDisplay,
  "codex:todo_list": todoDisplay,
  "codex:todowrite": todoDisplay,
  "codex:todolist": todoDisplay,
  "codex:todo": todoDisplay,
  "codex:plan": todoDisplay,
  // apply_patch 工具 ── Codex 实际 function_call.name
  "*:apply_patch": patchDisplay,
  "codex:apply_patch": patchDisplay,
  "*:request_user_input": requestUserInputDisplay,
  "codex:request_user_input": requestUserInputDisplay,
};

function formatterKeys(
  agentType: AgentTypeKey | undefined,
  toolName: string,
): string[] {
  return agentType
    ? [`${agentType}:${toolName}`, `*:${toolName}`]
    : [`*:${toolName}`];
}

export function getAgentToolInputSummary(
  input?: Record<string, unknown>,
): string {
  if (!input || typeof input !== "object") return "";

  const preferred =
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    input.command_preview ??
    input.command ??
    input.command_text ??
    input.commandText ??
    input.cmd ??
    input.cmdline ??
    input.shell_command ??
    input.script ??
    input.cwd;
  if (typeof preferred === "string" && preferred.length > 0) {
    const kind = fieldKind(
      Object.keys(input).find((key) => input[key] === preferred) ?? "",
    );
    return kind === "file" ? extractFileName(preferred) : preferred;
  }

  const first = Object.entries(input)[0];
  return first ? `${first[0]}: ${valueToText(first[1]).split("\n")[0]}` : "";
}

export function createAgentToolDisplay(
  context: AgentToolDisplayContext,
): AgentToolDisplay | undefined {
  const { agentType, toolName, input } = context;
  const normalized = normalizeToolInput(input);
  if (!normalized) return undefined;

  const normalizedToolName = (toolName ?? "").toLowerCase();
  for (const key of formatterKeys(agentType, normalizedToolName)) {
    const formatted = FORMATTERS[key]?.(normalized, {
      agentType,
      toolName: normalizedToolName,
      input,
    });
    if (formatted) return formatted;
  }

  const summary = getAgentToolInputSummary(normalized);
  if (!summary) return undefined;

  const firstPreferredKey = [
    "path",
    "pattern",
    "query",
    "url",
    "command_preview",
    "command",
    "command_text",
    "commandText",
    "cmd",
    "cmdline",
    "shell_command",
    "script",
    "cwd",
  ].find(
    (key) =>
      typeof normalized[key] === "string" && String(normalized[key]).length > 0,
  );

  const inferredKind = firstPreferredKey
    ? fieldKind(firstPreferredKey)
    : toolName === "web_search"
      ? "search"
      : "generic";
  return {
    summary,
    title: summary,
    kind: inferredKind,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 *  update_plan 派生 ── Codex CLI 的 todo/list 工具
 * ════════════════════════════════════════════════════════════════════════
 *
 *  arguments: { plan: Array<{ status: "pending"|"in_progress"|"completed", step: string }> }
 *
 *  - formatAgentPlanSummary → 给单行 header 显示用 ("3/5 · 正在做: …" / "3/5 · Working on: …")
 *  - parseAgentPlan         → 给 checklist 渲染用, 失败返回 null
 *  - 复用 TOOLS 元数据 ── toolName 走 agent.tools.* 的 i18n label
 */

export type AgentPlanStatus = "pending" | "in_progress" | "completed";
export interface AgentPlanStep {
  status: AgentPlanStatus;
  step: string;
}
export interface AgentPlan {
  plan: AgentPlanStep[];
}

const PLAN_STEP_MAX = 200;
const PLAN_SUMMARY_MAX = 60;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

const PLAN_KEYS = ["plan", "Plan", "items", "todos", "steps", "tasks"] as const;
const STATUS_KEYS = ["status", "state", "Status"] as const;
const STEP_KEYS = ["step", "content", "title", "text", "activeForm", "label"] as const;
const STATUS_ALIASES: Record<string, AgentPlanStatus> = {
  pending: "pending",
  todo: "pending",
  not_started: "pending",
  "not-started": "pending",
  queued: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  doing: "in_progress",
  running: "in_progress",
  active: "in_progress",
  executing: "in_progress",
  completed: "completed",
  done: "completed",
  finished: "completed",
  complete: "completed",
  success: "completed",
  succeeded: "completed",
};

function normalizeStatus(value: unknown): AgentPlanStatus | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return STATUS_ALIASES[key] ?? null;
}

function findPlanArray(value: unknown, depth: number): unknown[] | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of PLAN_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  // 深入一层找常见包壳 (input / arguments / data / payload)
  for (const wrap of ["input", "arguments", "data", "payload", "args"]) {
    const v = (value as Record<string, unknown>)[wrap];
    if (v && typeof v === "object") {
      const inner = findPlanArray(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

export function parseAgentPlan(
  input: unknown,
): AgentPlan | null {
  const arr = findPlanArray(input, 0);
  if (!arr || arr.length === 0) return null;
  const plan: AgentPlanStep[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    let status: AgentPlanStatus | null = null;
    for (const k of STATUS_KEYS) {
      status = normalizeStatus(obj[k]);
      if (status) break;
    }
    let step: string | null = null;
    if (typeof obj.step === "string" && obj.step.trim()) step = obj.step.trim();
    if (!step) {
      for (const k of STEP_KEYS) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) { step = v.trim(); break; }
      }
    }
    if (status && step) {
      plan.push({ status, step: truncate(step, PLAN_STEP_MAX) });
    } else if (step) {
      // 没有 status 也能渲染 ── 视作 pending (比丢弃好)
      plan.push({ status: "pending", step: truncate(step, PLAN_STEP_MAX) });
    }
  }
  return plan.length > 0 ? { plan } : null;
}

export function formatAgentPlanSummary(
  input: Record<string, unknown> | undefined,
  language: AppLanguage = "zh-CN",
): string {
  const parsed = parseAgentPlan(input);
  if (!parsed) return "";
  const total = parsed.plan.length;
  const done = parsed.plan.filter((s) => s.status === "completed").length;
  const current = parsed.plan.find((s) => s.status === "in_progress");
  const prefix = `${done}/${total}`;
  if (current) {
    const label =
      language === "zh-CN" ? "正在做" : "Working on";
    return `${prefix} · ${label}：${truncate(current.step, PLAN_SUMMARY_MAX)}`;
  }
  return prefix;
}
