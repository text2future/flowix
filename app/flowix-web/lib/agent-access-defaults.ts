/**
 * Agent access defaults 的纯函数工具 ── 与 store 解耦, 便于在
 * `buildInitialInstanceRuntimeConfig` 等处直接引用而不被 store mock 影响。
 *
 * Legacy `defaults.files` 按 notebook 维度索引: key 为 notebook.id,
 * `DEFAULT_FILES_GLOBAL_KEY` ("_global") 为兜底 (老版单对象迁移落点 /
 * 历史 instance 无 `runtimeConfig.notebookId` 时的回写目标)。 老版本是单个
 * `FilesConfig` 对象, 读取时由 `normalizeFilesDefaults` 归一化到
 * `{ _global: <old> }`, 无须显式数据迁移。
 */
import { DEFAULT_FILES_GLOBAL_KEY } from "@/lib/types/agent-access";
import type { AgentAccessConfig, NotebookAgentConfig } from "@/lib/types/agent-access";
import type { FilesConfig } from "@/types/agent";

/**
 * 判断 `defaults.files` 是老版单对象 `FilesConfig` 还是新索引对象。
 * `FilesConfig` 必有 `folders` 数组; 索引对象的顶层 key 是 notebookId,
 * 值才是 `FilesConfig`。 notebookId 形如 `nb_<ts>` / `_global`, 不会是
 * `folders`, 故无歧义。
 */
function isPlainFilesConfig(value: unknown): value is FilesConfig {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { folders?: unknown }).folders)
  );
}

/**
 * 把任意形状的 `defaults.files` 归一化成索引对象:
 *   - 老版单对象 `FilesConfig` -> `{ _global: <old> }` (迁移)
 *   - 已是索引对象 -> 原样返回
 *   - 缺失 / 非对象 -> `{}`
 *
 * 读取与写入都先过这一层, 让老数据无须显式迁移即可在新 schema 下工作。
 */
export function normalizeFilesDefaults(
  raw: unknown,
): Record<string, FilesConfig> {
  if (!raw || typeof raw !== "object") return {};
  if (isPlainFilesConfig(raw)) {
    return { [DEFAULT_FILES_GLOBAL_KEY]: raw };
  }
  return raw as Record<string, FilesConfig>;
}

/**
 * 按 notebookId 取该 notebook 的默认 files, 缺失时 fallback 到 `_global`。
 * 新卡片取种子 (`buildInitialInstanceRuntimeConfig`) 用它读"本笔记本的默认"。
 */
export function resolveDefaultFiles(
  config: AgentAccessConfig | undefined | null,
  notebookId: string | null | undefined,
): FilesConfig | undefined {
  const indexed = normalizeFilesDefaults(config?.defaults?.files);
  if (notebookId && indexed[notebookId]) return indexed[notebookId];
  return indexed[DEFAULT_FILES_GLOBAL_KEY];
}

/**
 * Resolve one notebook's files and keep only folders that still have an
 * enabled, present entry in the backend-owned global registry. This prevents
 * stale defaults from silently widening a run after an entry disappears.
 */
export function resolveAuthorizedDefaultFiles(
  config: AgentAccessConfig | undefined | null,
  notebookId: string | null | undefined,
): FilesConfig | undefined {
  const files = resolveDefaultFiles(config, notebookId);
  if (!files) return undefined;

  const comparable = (path: string): string =>
    path.trim().replace(/[\\/]+$/, '').toLowerCase();
  const allowed = new Set(
    (config?.entries ?? [])
      .filter((entry) => entry.kind === 'folder' && entry.enabled && !entry.missing)
      .map((entry) => comparable(entry.path)),
  );
  const folders = files.folders.filter((path) => allowed.has(comparable(path)));
  // `null` 是显式取消主空间, 需保留 (UI 把 null 视作 fallback 到 notebook.path);
  // `string` 必须仍命中合法 folders 才保留, 否则清掉让 UI 重新选。
  const rawWorkspace = files.workspace;
  let workspace: string | null | undefined;
  if (rawWorkspace === null) {
    // `null` 是显式取消主空间, 需保留 (UI 把 null 视作 fallback 到
    // notebook.path)。
    workspace = null;
  } else if (typeof rawWorkspace === "string") {
    // `string` 必须仍命中合法 folders 才保留, 否则清掉让 UI 重新选。
    workspace = folders.some(
      (path) => comparable(path) === comparable(rawWorkspace),
    )
      ? rawWorkspace
      : undefined;
  } else {
    workspace = undefined;
  }

  return { workspace, folders, notebooks: [...files.notebooks] };
}

/** Resolve add-dirs from notebook/.flowix/agent.json, intersected with the
 * device-owned authorization registry. */
export function resolveNotebookAgentFiles(
  config: AgentAccessConfig | undefined | null,
  notebookConfigs: Record<string, NotebookAgentConfig> | undefined,
  notebookId: string | null | undefined,
): FilesConfig | undefined {
  if (!notebookId) return undefined;
  // An explicitly supplied notebook-config map is authoritative.  Do not
  // fall back to legacy global defaults when loading it failed or the
  // notebook has no local config: that could silently widen add-dir access.
  if (notebookConfigs !== undefined && !notebookConfigs[notebookId]) {
    return undefined;
  }
  const local = notebookConfigs?.[notebookId];
  if (!local) return resolveAuthorizedDefaultFiles(config, notebookId);
  const comparable = (path: string) => path.trim().replace(/[\\/]+$/, '').toLowerCase();
  const allowed = new Set(
    (config?.entries ?? [])
      .filter((entry) => entry.kind === 'folder' && entry.enabled && !entry.missing)
      .map((entry) => comparable(entry.path)),
  );
  return {
    workspace: null,
    folders: local.addDirs
      .filter((directory) => directory.enabled && allowed.has(comparable(directory.path)))
      .map((directory) => directory.path),
    notebooks: [],
  };
}
