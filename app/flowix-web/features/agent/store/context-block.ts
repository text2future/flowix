import type { AgentTypeKey } from "@/types/agent";
import { getActiveDocumentDraft, useDocumentStore } from "@features/document";
import { CONTEXT_PROMPT_MARKER } from "@features/agent/message";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useMemoStore } from "@features/memo/store/memo-store";
import { useTagStore } from "@features/memo/store/tag-store";

function joinPath(basePath: string, filePath: string): string {
  if (
    /^[a-zA-Z]:[\\/]/.test(filePath) ||
    filePath.startsWith("/") ||
    filePath.startsWith("\\")
  ) {
    return filePath;
  }
  return `${basePath.replace(/[\\/]+$/, "")}\\${filePath.replace(/^[\\/]+/, "")}`;
}

export function normalizeContextValue(
  value: string | null | undefined,
): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

function truncateContextContent(content: string, maxLength = 500): string {
  return Array.from(normalizeContextValue(content))
    .slice(0, maxLength)
    .join("");
}

function getCurrentTaskTag(): string {
  const memoState = useMemoStore.getState();
  const tagState = useTagStore.getState();
  if (memoState.activeFilter !== "tagged" || !tagState.selectedTagId) {
    return "";
  }
  const tag = tagState.tags.find((item) => item.id === tagState.selectedTagId);
  return normalizeContextValue(tag?.name).replace(/^#+/, "");
}

export function getCurrentNotePath(): string {
  const memoState = useMemoStore.getState();
  const documentState = useDocumentStore.getState();
  const draft = getActiveDocumentDraft();
  const notebookPath = memoState.selectedNotebook?.path?.trim();
  return (
    documentState.currentDocumentPath?.trim() ||
    draft?.path?.trim() ||
    (notebookPath && memoState.selectedMemo?.filename
      ? joinPath(notebookPath, memoState.selectedMemo.filename)
      : "")
  );
}

function buildContextPromptBlock(currentNoteContent?: string): string {
  const memoState = useMemoStore.getState();
  const accessEntries = useAgentAccessStore.getState().config.entries;
  const draft = getActiveDocumentDraft();
  const currentNotebookPath = normalizeContextValue(
    memoState.selectedNotebook?.path,
  );
  const allNotebookPaths = accessEntries
    .filter(
      (entry) => entry.kind === "notebook" && entry.enabled && !entry.missing,
    )
    .map((entry) => {
      const notebook = memoState.notebooks.find((item) => item.id === entry.id);
      return normalizeContextValue(notebook?.path || entry.path);
    })
    .filter(Boolean)
    .join("\n");
  const notePreview = truncateContextContent(
    currentNoteContent || draft?.content || "",
  );
  const currentTaskTag = getCurrentTaskTag();

  return [
    CONTEXT_PROMPT_MARKER,
    `当前笔记路径: ${normalizeContextValue(getCurrentNotePath()) || "none"}`,
    `当前笔记本路径: ${currentNotebookPath || "none"}`,
    ...(currentTaskTag
      ? [`当前任务标签：#${currentTaskTag} (注：创建新笔记需写入)`]
      : []),
    "",
    "全部笔记本路径:",
    allNotebookPaths || "none",
    "",
    "当前笔记内容（前500字）:",
    notePreview || "none",
  ].join("\n");
}

function buildAgentRolePromptBlockFromContent(
  agentRoleMemoId: string,
  agentRoleName: string | undefined,
  body: string | null,
): string | null {
  const preview = body ? truncateContextContent(body, 10000) : "";
  if (!preview) return null;
  const label = agentRoleName?.trim() || agentRoleMemoId;
  return [
    `## Agent Role: ${label} 请在接下来的对话中,始终扮演这个角色,遵循角色规范行动`,
    "",
    preview,
  ].join("\n");
}

const FLOWIX_CLI_PROMPT_BLOCK = [
  "# flowix CLI",
  "非交互笔记 CLI:8 个子命令(列/读/搜/改/写/建/删笔记),--json 取 JSON 输出。",
  "",
  '只在显式触发时调:用户说"搜/列/改/删/新建笔记",或给了 8 位 ID / 笔记本名要求"看/改/删"。',
  "如果上下文包含当前任务标签, 创建新笔记时必须在正文写入该 #标签。",
  "",
  "- `flowix notebooks` — list all notebooks.",
  "- `flowix list <notebook>` — list notes in a notebook.",
  "- `flowix show <id>` — print a note to stdout.",
  "- `flowix search <query> [-b <notebook>] [-l N]` — full-text search.",
  "- `flowix edit <id> --old <text> --new <text>` — exact-string replace (always `read` first).",
  "- `flowix write <id>` (body from stdin) — overwrite a note.",
  "- `flowix create <notebook>` (body from stdin) — create a note.",
  "- `flowix delete <id>` — delete a note.",
].join("\n");

export function appendFirstMessageContext(
  content: string,
  isFirstMessage: boolean,
  currentNoteContent?: string,
  agentType?: AgentTypeKey,
  agentRoleMemoId?: string,
  agentRoleName?: string,
  agentRoleBody?: string | null,
): string {
  if (!isFirstMessage) return content;
  const blocks = [buildContextPromptBlock(currentNoteContent)];
  if (agentRoleMemoId) {
    const roleBlock = buildAgentRolePromptBlockFromContent(
      agentRoleMemoId,
      agentRoleName,
      agentRoleBody ?? null,
    );
    if (roleBlock) {
      blocks.push(roleBlock);
    }
  }
  if (agentType && agentType !== "flowix") {
    blocks.push(FLOWIX_CLI_PROMPT_BLOCK);
  }
  return `${content}\n${blocks.join("\n\n")}`;
}

export function buildUserLlmContent(content: string): {
  llmContent: string;
  systemReminderDirectory?: string;
  systemReminderDocumentPath?: string;
} {
  const memoState = useMemoStore.getState();
  const documentState = useDocumentStore.getState();
  const currentDirectory = memoState.selectedNotebook?.path?.trim();
  if (!currentDirectory) {
    return { llmContent: content };
  }

  const currentNotePath =
    documentState.currentDocumentPath?.trim() ||
    (memoState.selectedMemo?.filename
      ? joinPath(currentDirectory, memoState.selectedMemo.filename)
      : undefined);

  return {
    llmContent: content,
    systemReminderDirectory: currentDirectory,
    systemReminderDocumentPath: currentNotePath,
  };
}
