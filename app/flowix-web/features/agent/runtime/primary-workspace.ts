/**
 * Resolve the sole primary workspace.  A notebook is always the agent cwd;
 * folders from `.flowix/agent.json` are add-dir roots and never participate
 * in cwd selection.  The `defaultFiles` argument remains for API compatibility
 * with persisted/legacy callers, but is intentionally ignored here.
 */
import type { FilesConfig } from "@/types/agent";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";

export type PrimaryWorkspaceSource =
  | { kind: "default.workspace"; path: string }
  | { kind: "default.folders[0]"; path: string }
  | { kind: "notebook"; path: string }
  | { kind: "empty" };

export interface ResolvePrimaryWorkspaceInput {
  /** Legacy argument retained for compatibility; add-dirs do not affect cwd. */
  defaultFiles?: FilesConfig;
  /** 当前选中笔记本路径 ── 无资料时的主空间。 */
  notebookPath?: string;
}

/**
 * 严格按字面顺序短路: 第一段命中即返回, 最后落到 `empty`。
 */
export function resolvePrimaryWorkspace(
  input: ResolvePrimaryWorkspaceInput,
): PrimaryWorkspaceSource {
  const normalize = (path: string | null | undefined): string | undefined =>
    normalizeWorkspacePath(path) || undefined;

  // The notebook is the sole workspace/cwd. Additional folders are mapped to
  // runtime add-dir roots and never participate in cwd resolution.
  const notebookPath = normalize(input.notebookPath);
  if (notebookPath) {
    return { kind: "notebook", path: notebookPath };
  }

  // 4. empty
  return { kind: "empty" };
}
