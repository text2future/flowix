import { memos as memosClient, type AgentRoleMemoItem } from "@platform/tauri/client";
import { useMemoStore } from "@features/memo";
import { joinPath } from "@features/document/components/session/document-utils";
import {
  getMemoAgentRoleName,
  getMemoIconValue,
  type AgentRoleOption,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-role";

export const AGENT_ROLE_OPTIONS_LOAD_TIMEOUT_MS = 8000;

export function fallbackAgentRoleOptionsFromStore(): AgentRoleOption[] {
  const { memos, selectedMemo, selectedNotebook } = useMemoStore.getState();
  const candidates = selectedMemo ? [selectedMemo, ...memos] : memos;
  const seen = new Set<string>();
  const entries: AgentRoleOption[] = [];

  for (const memo of candidates) {
    if (!memo || seen.has(memo.id)) continue;
    seen.add(memo.id);
    const name = getMemoAgentRoleName(memo.properties);
    if (!name) continue;
    entries.push({
      memoId: memo.id,
      name,
      filename: memo.filename,
      memoIcon: getMemoIconValue(memo.icon, memo.properties),
      notebookId: selectedNotebook?.id ?? "",
      notebookName: selectedNotebook?.name ?? "",
      notebookIcon: selectedNotebook?.icon ?? null,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function listAgentRoleMemosWithTimeout(): Promise<AgentRoleMemoItem[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out while loading agent-role memos"));
    }, AGENT_ROLE_OPTIONS_LOAD_TIMEOUT_MS);

    void memosClient.listAgentRoleMemos().then(
      (items) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(items);
      },
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export async function loadAgentRoleBodyFromMemo(options: {
  memoId: string;
  roleOptions: AgentRoleOption[];
  cache: Map<string, string | null>;
  isDestroyed: () => boolean;
}): Promise<string | null> {
  const { memoId, roleOptions, cache, isDestroyed } = options;
  if (cache.has(memoId)) {
    return cache.get(memoId) ?? null;
  }
  if (isDestroyed()) return null;

  const entry = roleOptions.find((option) => option.memoId === memoId);
  if (!entry) {
    cache.set(memoId, null);
    return null;
  }
  const notebook = useMemoStore
    .getState()
    .notebooks.find((nb) => nb.id === entry.notebookId);
  if (!notebook?.path) {
    cache.set(memoId, null);
    return null;
  }

  try {
    const docPath = joinPath(notebook.path, entry.filename);
    const body = await memosClient.readDocument(docPath);
    cache.set(memoId, body ?? null);
    return body ?? null;
  } catch (err) {
    console.error("[AgentThreadCard] Failed to read agent-role memo body:", err);
    cache.set(memoId, null);
    return null;
  }
}
