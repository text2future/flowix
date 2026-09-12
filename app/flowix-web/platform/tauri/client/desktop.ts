import { invoke } from '@tauri-apps/api/core';
import type { ThemeId } from '@/lib/theme';

export interface DocTreeItem {
  id: string;
  fullPath: string;
  name: string;
  type: 'folder' | 'document';
  parentId: string | null;
  children: DocTreeItem[] | null;
  sizeBytes: number | null;
  modifiedMs: number | null;
  createdMs: number | null;
}

export const files = {
  getTree: (spacePath: string) => invoke<DocTreeItem[] | null>('get_file_tree', { spacePath }),
  getDirChildren: (dirPath: string) => invoke<DocTreeItem[]>('get_dir_children', { dirPath }),
  watchRoot: (rootPath: string) => invoke<string>('watch_file_browser_root', { rootPath }),
  unwatchRoot: (leaseId: string) => invoke<void>('unwatch_file_browser_root', { leaseId }),
  read: (filePath: string, spacePath?: string) => invoke<string | null>('read_file', { filePath, spacePath }),
  readImage: (filePath: string, spacePath?: string) => invoke<string | null>('read_image_file', { filePath, spacePath }),
  write: (filePath: string, content: string, skipValidation?: boolean, spacePath?: string) =>
    invoke<boolean>('write_file', { filePath, content, skipValidation, spacePath }),
  delete: (filePath: string, spacePath?: string) => invoke<boolean>('delete_file', { filePath, spacePath }),
  deleteFolder: (folderPath: string, spacePath: string) =>
    invoke<boolean>('delete_folder', { folderPath, spacePath }),
  rename: (filePath: string, name: string, spacePath: string) =>
    invoke<string>('rename_file', { filePath, name, spacePath }),
  createFolder: (spacePath: string, name: string, parentId?: string) =>
    invoke<DocTreeItem | null>('create_folder', { spacePath, name, parentId }),
  createDocument: (spacePath: string, name: string, parentId?: string) =>
    invoke<DocTreeItem>('create_document', { spacePath, name, parentId }),
};

// Dialogs
export interface SaveFileFilter {
  name: string;
  extensions: string[];
}

export const dialogs = {
  selectDirectory: () => invoke<string | null>('select_directory'),
  selectFiles: () => invoke<string[] | null>('select_files'),
  saveFile: (suggestedName?: string, filters?: SaveFileFilter[]) =>
    invoke<string | null>('save_file_dialog', {
      suggestedName,
      filters: filters?.map((f) => [f.name, ...f.extensions]),
    }),
  writeExportFile: (filePath: string, content: string) =>
    invoke<boolean>('write_export_file', { filePath, content }),
  copyAttachmentFile: (sourcePath: string, targetPath: string) =>
    invoke<boolean>('copy_attachment_file', { sourcePath, targetPath }),
};

export interface ExternalDocumentChangedEvent {
  path: string;
  kind: 'modified' | 'deleted';
  revision: string;
}

export interface FileBrowserDirectoriesChangedEvent {
  leaseId: string;
  rootPath: string;
  directories: string[];
}

export const windows = {
  showMain: () => invoke<void>('show_main_window'),
  openPreferences: (tab?: string) => invoke<void>('open_preferences_window', { tab }),
  applyWindowTheme: (theme: ThemeId) => invoke<void>('apply_window_theme', { theme }),
  watchExternalDocument: (filePath: string, scopePath?: string | null) =>
    invoke<string>('watch_external_document', { filePath, scopePath: scopePath ?? null }),
  unwatchExternalDocument: (leaseId: string) =>
    invoke<void>('unwatch_external_document', { leaseId }),
};

export interface ProductInfo {
  productName: string;
  version: string;
  configDir: string;
  dataDir: string;
  logDir: string;
  os: string;
  arch: string;
}

export const product = {
  getInfo: () => invoke<ProductInfo>('get_product_info'),
  openLogDir: () => invoke<void>('open_log_dir'),
};

export interface PluginManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  kind: string;
  ui: { placement: string; order: number; icon: string };
  input: {
    fields: PluginField[];
    prompt?: PluginField;
    agentType?: PluginField;
  };
  agent?: { skill: string } | null;
  tool?: {
    command: string;
    input: string;
    contentType: string;
    instructions: string;
  } | null;
  discovery?: { noteType?: string | null };
  execution?: { runtime?: string | null };
  engines?: { flowix?: string | null };
  permissions?: Array<'agent.invoke' | 'notebook.read' | 'artifact.write'>;
  integrity?: { algorithm: 'sha256'; files: Record<string, string> } | null;
  output: {
    format: string;
    directory: string;
    extension: string;
    renderer: string;
    parser?: string;
  };
}

export interface PluginOption {
  value: string;
  label: string;
}

export interface PluginField {
  id: string;
  type: string;
  label?: string | null;
  required: boolean;
  placeholder?: string | null;
  options: PluginOption[];
}

export interface PluginDescriptor {
  manifest: PluginManifest;
  installedPath: string;
  skill: string;
  isSystem: boolean;
  enabled: boolean;
  permissions: string[];
  integrityStatus: 'verified' | 'unverified';
}

export interface PluginDiagnostic {
  pluginId?: string | null;
  path: string;
  status: 'ready' | 'disabled' | 'invalid';
  message?: string | null;
}

export interface PluginCatalogSnapshot {
  plugins: PluginDescriptor[];
  diagnostics: PluginDiagnostic[];
}

export interface PluginArtifact {
  pluginId: string;
  path: string;
  name: string;
  createdAt: string;
  format: string;
  renderer: string;
  content?: string | null;
  noteId?: string | null;
}

/** Host-owned artifact session. Its content remains readable even when the
 * producing plugin is unavailable. Plugin runtime state is intentionally not
 * part of this model. */
export interface ArtifactSession {
  pointerMemoId: string;
  pluginId: string;
  pluginVersion: string;
  path: string;
  name: string;
  createdAt: string;
  format: string;
  parser: string;
  renderer: string;
  content?: string | null;
  noteId?: string | null;
  status: 'ready' | 'unavailable' | 'invalid' | 'missing';
  pluginAvailable: boolean;
  error?: string | null;
}

export interface PluginRunStarted {
  runId: string;
  preparedPrompt: string;
}

export interface PluginRunEvent {
  runId: string;
  pluginId: string;
  status: 'started' | 'text' | 'completed' | 'failed' | 'cancelled';
  agentType: string;
  artifact?: PluginArtifact | null;
  error?: string | null;
  content?: string | null;
}

export const plugins = {
  list: () => invoke<PluginDescriptor[]>('plugin_list'),
  refresh: () => invoke<PluginDescriptor[]>('plugin_refresh'),
  catalog: () => invoke<PluginCatalogSnapshot>('plugin_catalog'),
  validate: (sourceDirectory: string) =>
    invoke<PluginDescriptor>('plugin_validate', { sourceDirectory }),
  install: (sourceDirectory: string) =>
    invoke<PluginDescriptor>('plugin_install', { sourceDirectory }),
  uninstall: (pluginId: string) => invoke<void>('plugin_uninstall', { pluginId }),
  setEnabled: (pluginId: string, enabled: boolean) =>
    invoke<void>('plugin_set_enabled', { pluginId, enabled }),
  diagnostics: () => invoke<PluginDiagnostic[]>('plugin_diagnostics'),
  get: (pluginId: string) => invoke<PluginDescriptor>('plugin_get', { pluginId }),
  preparePrompt: (pluginId: string, userPrompt: string, context: string) =>
    invoke<string>('plugin_prepare_prompt', { pluginId, userPrompt, context }),
  run: (params: {
    pluginId: string;
    userPrompt: string;
    context: string;
    agentType: string;
    notebookPath: string;
    sourceNote?: string;
  }) => invoke<PluginRunStarted>('plugin_run', params),
  runStop: (runId: string) => invoke<boolean>('plugin_run_stop', { runId }),
  listNotes: (pluginId: string, notebookId: string) =>
    invoke<import('@/types/memo-item').MemoItem[]>('plugin_list_notes', { pluginId, notebookId }),
  resolveNote: (memoId: string) =>
    invoke<PluginArtifact>('plugin_resolve_note', { memoId }),
};

export const artifacts = {
  resolve: (memoId: string) =>
    invoke<ArtifactSession>('artifact_resolve', { memoId }),
};

// Agent
//
// Legacy AI config remains available to the backend only for migration; DSH
// model config is sourced through `deepseekHarness` in general.ts.
// 骞舵儼鎬ф瀯寤?provider 瀹炰緥 (瑙?backend/src/agent.rs AgentManager::ensure_instance)銆?//
// 瀛楁鍛藉悕: 鍚庣 AiModelConfig 鐢?`#[serde(rename_all = "camelCase")]`, 鎵€浠?// IPC 浼犺繃鍘诲繀椤绘槸 camelCase 鈹€ snake_case 浼氳 serde 闈欓粯涓㈠純, 瀛楁鍏ㄩ儴鍥為€€
// 鍒?#[serde(default)] = 绌轰覆, 琛ㄧ幇灏辨槸"淇濆瓨鍚庡埛鏂?apiKey/apiUrl 閮界┖浜?銆?
