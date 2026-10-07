import { invokeDocumentMutation } from './document-mutation';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { ThemeId } from '@/lib/theme';
import type { NoteColor } from '@/types/note-item';

export interface DocTreeMemoMeta {
  id: string;
  icon: string | null;
  colors: NoteColor[];
  favorited: boolean;
}

export type DocTreeResourceKind = 'note' | 'image' | 'video' | 'other';

export interface MediaResource {
  id: string;
  notebookId: string;
  relativePath: string;
  kind: 'image' | 'video';
  sizeBytes: number;
  modifiedMs: number;
  fingerprint: string | null;
  properties: Record<string, unknown>;
  propertiesRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface MediaResourceResponse {
  resource: MediaResource;
}

export interface MediaResourcePage {
  resources: MediaResource[];
  nextCursor: string | null;
  hasMore: boolean;
}

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
  memoCreatedMs: number | null;
  memoMeta?: DocTreeMemoMeta | null;
  resourceKind?: DocTreeResourceKind | null;
}

export interface NotebookViewPreferences {
  defaultCreateFolder: string | null;
  fileManagement: { includedPaths: string[]; hiddenPaths: string[]; excludedIndexPaths: string[]; legacySkipDirs?: string[]; legacySkipFiles?: string[]; legacyWatcherMigrated?: boolean };
  refreshPending?: boolean;
}

export interface NotebookFolderOption {
  relativePath: string;
  depth: number;
}

export interface NotebookSettingsTreeEntry {
  relativePath: string;
  isDirectory: boolean;
  locked: boolean;
  hidden: boolean;
  defaultHidden: boolean;
  collapsed: boolean;
}

export interface DocumentPageItem {
  fullPath: string;
  name: string;
  resourceKind: 'note' | 'image' | 'video' | 'other' | 'folder';
  sizeBytes: number | null;
  modifiedMs: number | null;
  createdMs: number | null;
}

export interface DocumentPage {
  folders: DocumentPageItem[];
  items: DocumentPageItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TableDocumentListItem {
  relativePath: string;
  collectionId: string;
  name: string;
  modifiedMs: number;
  fileRevision: number;
  inViews: boolean;
  identityConflict?: boolean;
}

export interface MediaLibraryListItem {
  relativePath: string;
  collectionId: string;
  name: string;
  modifiedMs: number;
  inViews: boolean;
  identityConflict?: boolean;
}

export interface CollectionIndexItem {
  indexSequence: number;
  relativePath: string;
  collectionId: string | null;
  collectionType: 'table' | 'media_library';
  name: string;
  schemaVersion: number | null;
  payloadSchemaVersion: number | null;
  revision: number | null;
  properties: Record<string, { type: string; name?: string; value: string | number | boolean | string[] }>;
  createdAt: string | null;
  updatedAt: string | null;
  modifiedMs: number;
  sizeBytes: number;
  contentHash: string | null;
  parseState: 'valid' | 'invalid' | 'unsupported';
  errorCode: string | null;
  inViews: boolean;
  identityConflict: boolean;
}
export interface CollectionMutationRequest {
  notebookId: string;
  collectionId: string;
  expectedRevision: number;
  operationId: string;
  newName?: string;
  targetRelativePath?: string;
  properties?: Record<string, CollectionIndexItem['properties'][string] | null>;
}
export interface CollectionMutationResult {
  operationId: string;
  status: 'completed' | 'partial' | 'conflict';
  collectionId: string;
  actualName: string;
  actualRelativePath: string;
  actualRevision: number;
  indexSequence: number;
  content: string;
  errorCode: string | null;
}
export const collections = {
  list: (notebookId: string, collectionType?: CollectionIndexItem['collectionType']) =>
    invoke<CollectionIndexItem[]>('list_collections', { notebookId, collectionType }),
  resolve: (notebookId: string, collectionId: string) =>
    invoke<CollectionIndexItem>('resolve_collection', { notebookId, collectionId }),
  mutate: (request: CollectionMutationRequest) =>
    invoke<CollectionMutationResult>('mutate_collection', { request }),
  setInViews: (notebookId: string, collectionId: string, inViews: boolean) =>
    invoke<void>('set_collection_display_state', { notebookId, collectionId, inViews }),
  makeIdentityUnique: (notebookId: string, relativePath: string) =>
    invoke<string>('make_collection_identity_unique', { notebookId, relativePath }),
};

export interface DocxMarkdownImage {
  marker: string;
  contentType: string;
  contentBase64: string;
}

export const files = {
  listDocumentPage: (request: {
    notebookId: string;
    folderPath: string;
    resourceKinds?: string[];
    cursor?: string | null;
    limit?: number;
  }) => invoke<DocumentPage>('list_document_page', { request }),
  listTableDocuments: async (notebookId: string): Promise<TableDocumentListItem[]> =>
    (await collections.list(notebookId, 'table')).filter((item) => item.collectionId !== null).map((item) => ({
      relativePath: item.relativePath, collectionId: item.collectionId!, name: item.name,
      modifiedMs: item.modifiedMs, fileRevision: item.revision ?? 0, inViews: item.inViews, identityConflict: item.identityConflict,
    })),
  setTableDocumentInViews: collections.setInViews,
  listMediaLibraries: async (notebookId: string): Promise<MediaLibraryListItem[]> =>
    (await collections.list(notebookId, 'media_library')).filter((item) => item.collectionId !== null).map((item) => ({
      relativePath: item.relativePath, collectionId: item.collectionId!, name: item.name,
      modifiedMs: item.modifiedMs, inViews: item.inViews, identityConflict: item.identityConflict,
    })),
  setMediaLibraryInViews: collections.setInViews,
  makeViewDocumentIdentityUnique: collections.makeIdentityUnique,
  getTree: (spacePath: string) =>
    invoke<DocTreeItem[] | null>('get_file_tree', { spacePath }),
  getDirChildren: (dirPath: string) =>
    invoke<DocTreeItem[]>('get_dir_children', { dirPath }),
  getNotebookViewPreferences: (notebookPath: string) =>
    invoke<NotebookViewPreferences>('get_notebook_view_preferences', { notebookPath }),
  getFileManagementCandidates: (notebookPath: string) =>
    invoke<Array<{ relativePath: string; isDirectory: boolean; locked: boolean }>>('get_file_management_candidates', { notebookPath }),
  getNotebookFolderOptions: (notebookPath: string) =>
    invoke<NotebookFolderOption[]>('get_notebook_folder_options', { notebookPath }),
  getNotebookSettingsTree: (notebookPath: string) =>
    invoke<NotebookSettingsTreeEntry[]>('get_notebook_settings_tree', { notebookPath }),
  setNotebookViewPreferences: (notebookPath: string, preferences: NotebookViewPreferences) =>
    invoke<void>('set_notebook_view_preferences', { notebookPath, preferences }),
  watchRoot: (rootPath: string) =>
    invoke<string>('watch_file_browser_root', { rootPath }),
  unwatchRoot: (leaseId: string) => invoke<void>('unwatch_file_browser_root', { leaseId }),
  read: (filePath: string, spacePath?: string) => invoke<string | null>('read_file', { filePath, spacePath }),
  readDocxFile: (filePath: string, spacePath?: string) =>
    invoke<string>('read_docx_file', { filePath, spacePath }),
  createDocxMarkdown: (filePath: string, spacePath: string, content: string, images: DocxMarkdownImage[] = []) =>
    invoke<string>('create_docx_markdown', { filePath, spacePath, content, images }),
  readImage: (filePath: string, spacePath?: string) => invoke<string | null>('read_image_file', { filePath, spacePath }),
  readImagePreview: (filePath: string, spacePath?: string) => invoke<string | null>('read_image_preview', { filePath, spacePath }),
  readVideoPreview: (filePath: string, spacePath?: string) =>
    invoke<string | null>('read_video_preview', { filePath, spacePath }),
  // Video stays a native media URL so playback does not load the whole file
  // into a base64 string like the existing image preview does.
  toAssetUrl: (filePath: string) => convertFileSrc(filePath),
  write: (filePath: string, content: string, skipValidation?: boolean, spacePath?: string) =>
    invoke<boolean>('write_file', { filePath, content, skipValidation, spacePath }),
  delete: (filePath: string, spacePath?: string) => invoke<boolean>('delete_file', { filePath, spacePath }),
  deleteFolder: (folderPath: string, spacePath: string) =>
    invoke<boolean>('delete_folder', { folderPath, spacePath }),
  rename: (filePath: string, name: string, spacePath: string) =>
    invokeDocumentMutation<string>('rename_file', { filePath, name, spacePath }),
  move: (filePath: string, targetDirectoryPath: string, spacePath: string) =>
    invoke<string>('move_file', { filePath, targetDirectoryPath, spacePath }),
  moveFolder: (folderPath: string, targetDirectoryPath: string, spacePath: string) =>
    invoke<string>('move_folder', { folderPath, targetDirectoryPath, spacePath }),
  importFile: (filePath: string, targetDirectoryPath: string, spacePath: string) =>
    invoke<string>('import_file', { filePath, targetDirectoryPath, spacePath }),
  renameFolder: (folderPath: string, name: string, spacePath: string) =>
    invoke<string>('rename_folder', { folderPath, name, spacePath }),
  createFolder: (spacePath: string, name: string, parentId?: string) =>
    invoke<DocTreeItem | null>('create_folder', { spacePath, name, parentId }),
  createDocument: (spacePath: string, name: string, parentId?: string) =>
    invoke<DocTreeItem>('create_document', { spacePath, name, parentId }),
};

export const mediaResources = {
  listPage: (notebookPath: string, kinds: Array<'image' | 'video'>, cursor?: string | null, limit?: number) =>
    invoke<MediaResourcePage>('list_media_resources_page', { notebookPath, kinds, cursor, limit }),
  get: (filePath: string, notebookPath: string) => invoke<MediaResourceResponse>(
    'get_media_resource',
    { filePath, notebookPath },
  ),
  thumbnail: (filePath: string, notebookPath: string, kind: 'image' | 'video', requestId: string) =>
    invoke<string | null>('get_media_thumbnail', { filePath, spacePath: notebookPath, kind, requestId }),
  cancelThumbnail: (requestId: string) =>
    invoke<void>('cancel_media_thumbnail', { requestId }),
  update: (
    filePath: string,
    notebookPath: string,
    resourceId: string,
    properties: Record<string, unknown>,
    expectedPropertiesRevision?: number,
  ) => invoke<MediaResourceResponse>('update_media_resource', {
    filePath,
    notebookPath,
    resourceId,
    properties,
    expectedPropertiesRevision,
  }),
  delete: (filePath: string, notebookPath: string) => invoke<boolean>(
    'delete_media_resource',
    { filePath, notebookPath },
  ),
};

// Dialogs
export interface SaveFileFilter {
  name: string;
  extensions: string[];
}

export const dialogs = {
  selectDirectory: () => invoke<string | null>('select_directory'),
  selectFiles: (options?: { accept?: string; multiple?: boolean }) => invoke<string[] | null>('select_files', {
    accept: options?.accept ?? null,
    multiple: options?.multiple ?? true,
  }),
  saveFile: (suggestedName?: string, filters?: SaveFileFilter[]) =>
    invoke<string | null>('save_file_dialog', {
      suggestedName,
      filters: filters?.map((f) => [f.name, ...f.extensions]),
    }),
  writeExportFile: (filePath: string, content: string) =>
    invoke<boolean>('write_export_file', { filePath, content }),
  exportPdf: (filePath: string) =>
    invoke<boolean>('export_pdf', { filePath }),
  copyAttachmentFile: (sourcePath: string, targetPath: string) =>
    invoke<boolean>('copy_attachment_file', { sourcePath, targetPath }),
};

export const attachments = {
  saveFromPath: (sourcePath: string, notebookId: string) =>
    invoke<string | null>('save_attachment', { sourcePath, notebookId, memoId: null }),
};

export interface ExternalDocumentChangedEvent {
  path: string;
  kind: 'modified' | 'deleted';
  revision: string;
  source?: 'user_edit' | 'external';
  originWindowLabel?: string;
}

export interface FileBrowserDirectoriesChangedEvent {
  leaseId: string;
  rootPath: string;
  directories: string[];
  paths?: string[];
}

export const windows = {
  showMain: () => invoke<void>('show_main_window'),
  openPreferences: (tab?: string) => invoke<void>('open_preferences_window', { tab }),
  applyWindowTheme: (theme: ThemeId) => invoke<void>('apply_window_theme', { theme }),
  applyMenuLanguage: (language: 'zh-CN' | 'en-US') =>
    invoke<void>('apply_menu_language', { language }),
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
  revealInFileManager: (filePath: string) => invoke<void>('reveal_in_file_manager', { filePath }),
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
