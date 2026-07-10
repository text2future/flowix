import { translate, type AppLanguage } from "@features/i18n";
import {
  basenameCommandNameForDisplay,
  type AgentCommandItem,
  type AgentCommandList,
} from "@features/agent/tool-display";

const THREAD_CARD_COMMAND_MAX_ITEMS = 6;
const THREAD_CARD_COMMAND_MAX_INLINE_ARGS = 16;
// 命令名是路径 (powershell.exe / rg 等可执行文件) 时, 卡片只展示末尾文件名。
// 路径检测: 含 / 或 \ 一律视为路径 ── 简单的硬性条件, 覆盖:
//   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe → powershell.exe
//   /usr/local/bin/node                                       → node
//   rg / python3 / script.sh                                  → 原样 (无分隔符)
const COMMAND_PATH_REGEX = /[\\/]/;

function getAgentThreadCardWrapperArgs(item: AgentCommandItem): string[] {
  if (!item.wrapper) return item.args;
  const parts = item.wrapper.label.split(/\s+/).filter(Boolean);
  const commandIndex = parts.findIndex((part) => part === item.command);
  return commandIndex >= 0 ? parts.slice(commandIndex + 1) : parts.slice(1);
}

function createAgentThreadCardCommandLine(
  item: AgentCommandItem,
  args: string[],
): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "agent-thread-card__command-line";

  if (item.env.length > 0) {
    const env = document.createElement("span");
    env.className = "agent-thread-card__command-env";
    env.textContent = item.env.join(" ");
    line.append(env);
  }

  const command = document.createElement("span");
  command.className = "agent-thread-card__command-name";
  // 路径形式 (含 / 或 \) 只展示末尾可执行名, 避免 45% 宽度被长前缀占满
  // (powershell.exe 比 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  // 信息密度高得多, args 的 `-Command rg ...` 也能挤进同一行)。title 保留全路径。
  const displayName = COMMAND_PATH_REGEX.test(item.command)
    ? basenameCommandNameForDisplay(item.command)
    : item.command;
  command.textContent = displayName;
  command.title = item.command;
  line.append(command);

  const inlineArgs = args.slice(0, THREAD_CARD_COMMAND_MAX_INLINE_ARGS);
  if (inlineArgs.length > 0) {
    const argText = document.createElement("span");
    argText.className = "agent-thread-card__command-args-inline";
    argText.textContent = inlineArgs.join(" ");
    argText.title = inlineArgs.join(" ");
    line.append(argText);
  }

  const hidden = args.length - inlineArgs.length;
  if (hidden > 0) {
    const more = document.createElement("span");
    more.className = "agent-thread-card__command-more";
    more.textContent = ` +${hidden} args`;
    line.append(more);
  }

  return line;
}

export function createAgentThreadCardCommandList(
  data: AgentCommandList,
  nested = false,
  skipFirst = false,
): HTMLDivElement {
  const list = document.createElement("div");
  list.className = nested
    ? "agent-thread-card__command-list agent-thread-card__command-list--nested"
    : "agent-thread-card__command-list";

  const sourceItems = skipFirst ? data.items.slice(1) : data.items;
  const items = sourceItems.slice(0, THREAD_CARD_COMMAND_MAX_ITEMS);
  for (const item of items) {
    list.append(createAgentThreadCardCommandItem(item));
  }

  const hidden = sourceItems.length - items.length;
  if (hidden > 0) {
    const more = document.createElement("div");
    more.className = "agent-thread-card__command-more";
    more.textContent = `+${hidden} commands`;
    list.append(more);
  }

  return list;
}

function createAgentThreadCardCommandItem(
  item: AgentCommandItem,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "agent-thread-card__command-item";

  if (item.wrapper) {
    row.append(
      createAgentThreadCardCommandLine(
        item,
        getAgentThreadCardWrapperArgs(item),
      ),
      createAgentThreadCardCommandList(item.wrapper.payload, true),
    );
    return row;
  }

  row.append(createAgentThreadCardCommandLine(item, item.args));
  return row;
}

export function createAgentThreadCardMessageFallback(
  message: unknown,
  language: AppLanguage,
): HTMLElement {
  const item = document.createElement("div");
  item.className =
    "agent-thread-card__message agent-thread-card__message--system";
  const content = document.createElement("div");
  content.className = "agent-thread-card__message-content";
  content.textContent = translate(language, "agent.tools.unknown");
  if (message && typeof message === "object") {
    const role = (message as { role?: unknown }).role;
    const toolName = (message as { toolName?: unknown }).toolName;
    const details = [role, toolName].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (details.length > 0) content.textContent = details.join(" · ");
  }
  item.append(content);
  return item;
}
