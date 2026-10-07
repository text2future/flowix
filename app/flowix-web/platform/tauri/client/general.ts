import { invoke } from '@tauri-apps/api/core';
import type { UserSettings } from '@/lib/constants';
import type { AgentAccessConfig, AgentAccessEntry } from '@/lib/types/agent-access';
import type { UsageInfo } from '@/types/agent';
import type { AgentConfig, TestConnectionResult } from './agent';

export const preferences = {
  get: () => invoke<UserSettings>('get_preference'),
  patch: (patch: Record<string, unknown>) => invoke<void>('patch_preference', { patch }),
};

export interface BootFeatures {
  experimental: boolean;
  isIntroductDisplayed: boolean;
  isOnboardingCompleted: boolean;
}

export const boot = {
  getFeatures: () => invoke<BootFeatures>('get_boot_features'),
  setIntroDisplayed: () => invoke<void>('set_boot_intro_displayed'),
  setOnboardingCompleted: () => invoke<void>('set_boot_onboarding_completed'),
  getStartupStatus: () => invoke<StartupStatus>('get_startup_status'),
  getStartupNotebookId: () => invoke<string | null>('get_startup_notebook_id'),
  notifyStartupInteractive: () => invoke<void>('notify_startup_interactive'),
  recordStartupStage: (stage: string, frontendElapsedMs: number, startupAttemptId: string) =>
    invoke<void>('record_startup_stage', { stage, frontendElapsedMs, startupAttemptId }),
  waitForStartupReady: () => invoke<void>('wait_for_startup_ready'),
};

export type StartupPhase = 'pending' | 'running' | 'ready' | 'failed';

export interface StartupStatus {
  phase: StartupPhase;
  step: string;
  error: string | null;
}

export interface FontCacheStatus {
  fontId: string;
  cached: boolean;
}

export interface FontDownloadProgress {
  fontId: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface CachedFontFile {
  family: string;
  weight: string;
  style: string;
}

export interface CachedFontResult {
  fontId: string;
  downloaded: boolean;
  files: CachedFontFile[];
}

export const fontCache = {
  beginSelection: () => invoke<number>('begin_font_selection'),
  commitSelection: (selectionId: number, fontId: string, fontFamily: string) =>
    invoke<boolean>('commit_font_selection', { selectionId, fontId, fontFamily }),
  getStatus: () => invoke<FontCacheStatus[]>('get_font_cache_status'),
  ensureCached: (fontId: string) => invoke<CachedFontResult>('ensure_font_cached', { fontId }),
  getCachedBytes: (fontId: string, fileIndex: number) =>
    invoke<ArrayBuffer>('get_cached_font_bytes', { fontId, fileIndex }),
};

export interface WebPageMetadata {
  url: string;
  title: string;
  description: string;
  image: string;
}

export const web = {
  parsePage: (url: string) => invoke<WebPageMetadata>('parse_web_page', { url }),
};

/** DeepSeek Harness model probe. This uses dsh-host/runtime and owns its
 * provider configuration separately from the legacy AI config document. */
export const deepseekHarness = {
  // DeepSeek Harness uses its own llm-pi-ai settings document. The old
  // agent-config.toml is read only as a migration source by the backend.
  get: () => invoke<{ model: AgentConfig }>('get_deepseek_harness_config'),
  // The Rust command returns Vec<AiConfigFile> directly. Each item keeps the
  // same `{ model: ... }` envelope as the single-config response above.
  list: () => invoke<{ model: AgentConfig }[]>('get_deepseek_harness_configs'),
  set: (config: AgentConfig) =>
    invoke<void>('set_deepseek_harness_config', { config: { model: config } }),
  add: (config: AgentConfig) =>
    invoke<void>('add_deepseek_harness_model', { config: { model: config } }),
  testConnection: (config: AgentConfig) =>
    invoke<TestConnectionResult>('test_deepseek_harness_connection', { config }),
  modelCatalog: () =>
    invoke<DeepSeekHarnessModelCatalog>('deepseek_harness_model_catalog'),
  pluginCatalog: () =>
    invoke<DeepSeekHarnessPluginCatalog>('deepseek_harness_plugin_catalog'),
  setPluginEnabled: (pluginKey: string, enabled: boolean) =>
    invoke<DeepSeekHarnessPluginCatalog>('set_deepseek_harness_plugin_enabled', {
      pluginKey,
      enabled,
    }),
  manageProfilePlugin: (action: 'remove', packageSpec?: string) =>
    invoke<string>('dsh_manage_profile_plugin', {
      action,
      package: packageSpec?.trim() || null,
    }),
  discoverModels: (config: AgentConfig) =>
    invoke<DeepSeekHarnessModelListing>('discover_deepseek_harness_models', { config }),
  sessionUsage: async (threadId: string): Promise<DeepSeekHarnessSessionSnapshot | null> => {
    const usage = await invoke<DeepSeekHarnessSessionUsage | null>(
      'deepseek_harness_session_usage',
      { threadId },
    );
    if (usage === null) return null;
    return snapshotFromHarnessUsage(usage);
  },
};

export interface PiModelEntryConfig {
  id: string;
  name: string;
  api?: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiProviderConfig {
  id: string;
  displayName: string;
  api: string;
  baseUrl: string;
  /** Write-only. Empty preserves the credential already saved for this provider. */
  apiKey?: string;
  credentialConfigured: boolean;
  defaultModelId?: string;
  models: PiModelEntryConfig[];
}

export interface PiModelCatalogProvider {
  id: string;
  displayName: string;
  api: string;
  baseUrl: string;
  takesApiKey: boolean;
  models: PiModelEntryConfig[];
}

export interface PiModelCatalog {
  piVersion: string;
  piAiVersion: string;
  apis: string[];
  providers: PiModelCatalogProvider[];
}

export const piModels = {
  list: () => invoke<PiProviderConfig[]>('get_pi_model_configs'),
  catalog: () => invoke<PiModelCatalog>('get_pi_model_catalog'),
  save: (config: PiProviderConfig) => invoke<void>('save_pi_model_config', { config }),
  delete: (providerId: string) => invoke<void>('delete_pi_model_config', { providerId }),
  test: (config: PiProviderConfig) => invoke<number>('test_pi_model_config', { config }),
  discover: (config: PiProviderConfig) => invoke<PiModelEntryConfig[]>('discover_pi_models', { config }),
};

export interface DshIntegrationStatus {
  installed: boolean;
  executablePath?: string | null;
  version?: string | null;
  harnessVersion?: string | null;
  source?: string | null;
  profile: string;
  message?: string | null;
  archiveSize?: number | null;
}

export interface DshDownloadProgress {
  phase: 'checking' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'up-to-date' | 'cancelled' | 'failed';
  downloadedBytes: number;
  totalBytes?: number | null;
  percent?: number | null;
  resumed: boolean;
}

export interface DshUpdateCheck {
  currentVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable: boolean;
}

export const dshIntegration = {
  status: () => invoke<DshIntegrationStatus>('dsh_status'),
  checkUpdate: () => invoke<DshUpdateCheck>('dsh_check_update'),
  archiveSize: () => invoke<number | null>('dsh_archive_size'),
  downloadStatus: () => invoke<DshDownloadProgress | null>('dsh_download_status'),
  installRuntime: () => invoke<DshIntegrationStatus>('dsh_install_runtime'),
  updateRuntime: () => invoke<DshIntegrationStatus>('dsh_update'),
  ensureRuntime: () => invoke<DshIntegrationStatus>('dsh_ensure_runtime'),
  cancelUpdate: () => invoke<boolean>('dsh_cancel_update'),
  uninstallRuntime: () => invoke<DshIntegrationStatus>('dsh_uninstall'),
};

function snapshotFromHarnessUsage(
  usage: DeepSeekHarnessSessionUsage,
): DeepSeekHarnessSessionSnapshot {
  return {
    sessionId: usage.sessionId,
    model: usage.modelId ?? undefined,
    usage: {
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cacheReadTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens
        + usage.cacheReadTokens
        + usage.cacheWriteTokens
        + usage.outputTokens,
      model_context_window: usage.contextWindow ?? null,
      context_used_tokens: usage.contextTokens ?? null,
    },
  };
}

export interface DeepSeekHarnessSessionSnapshot {
  sessionId: string;
  model?: string;
  usage: UsageInfo;
}

export interface DeepSeekHarnessSessionUsage {
  sessionId: string;
  modelId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens?: number | null;
  contextWindow?: number | null;
}

export interface DeepSeekHarnessModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface DeepSeekHarnessCatalogProvider {
  provider: string;
  displayName?: string;
  baseUrl?: string;
  api?: string;
  takesApiKey: boolean;
  models: DeepSeekHarnessModel[];
}

export interface DeepSeekHarnessModelCatalog {
  providers: DeepSeekHarnessCatalogProvider[];
}

export interface DeepSeekHarnessModelListing {
  models: DeepSeekHarnessModel[];
}

export interface DeepSeekHarnessPlugin {
  key: string;
  id: string;
  name: string;
  enabled: boolean;
  toggleable: boolean;
  removable?: boolean;
  scope: 'host' | 'preset' | 'profile';
  preset?: string;
}

export interface DeepSeekHarnessPluginCatalog {
  platform: string;
  host: DeepSeekHarnessPlugin[];
  presets: Record<string, DeepSeekHarnessPlugin[]>;
  profile: DeepSeekHarnessPlugin[];
}

// Agent access roots (backend ~/.flowix/agent-access.json).
// Source of truth is `agent_access::AgentAccessStore`; it mirrors notebooks and user-added folders.
// 鏁翠唤 set 鏇夸唬閫愭潯 patch, 閬垮厤鍓嶇瀵瑰崟鏉?entry 绠?diff; 鍐欐椂璧颁箰瑙傛洿鏂?
// (鏈湴鍏堟敼, 澶辫触 `loadInitial` 鍥炴粴)銆?
export const agentAccess = {
  get: () => invoke<AgentAccessConfig>('get_agent_access'),
  set: (config: AgentAccessConfig) => invoke<void>('set_agent_access', { config }),
  addFolderFromPicker: () =>
    invoke<AgentAccessEntry | null>('add_agent_access_folder_from_picker'),
  getNotebookConfigs: () =>
    invoke<Record<string, import('@/lib/types/agent-access').NotebookAgentConfig>>(
      'get_notebook_agent_configs',
    ),
  setNotebookConfig: (
    notebookId: string,
    expectedRevision: number,
    config: import('@/lib/types/agent-access').NotebookAgentConfig,
  ) => invoke<import('@/lib/types/agent-access').NotebookAgentConfig>(
    'set_notebook_agent_config',
    { notebookId, expectedRevision, config },
  ),
};

export interface SystemTagLayoutItem {
  id: string;
  parentId: string | null;
}

export interface NotebookTagSystemMetadata {
  hidden: string[];
  order: string[];
  layout: SystemTagLayoutItem[];
  /**
   * 置顶标签簿: parent fullPath → MRU 顺序的子 fullPath 列表。
   * 空 key (`""`) 表示 root 级别。Vec 索引 0 = 最近置顶 = 渲染最前。
   * 旧版持久化可能没有这个字段, 加载时会默认空对象。
   */
  pinnedByParent: Record<string, string[]>;
}

/** 单条常用笔记筛选条件。字段可为空, 由前端回落/丢弃。 */
export interface NotebookFeaturedNoteCondition {
  key: string;
  operator: string;
  value: string;
}

/** 常用笔记筛选配置 (Agent 空状态)。conditions 之间是并集关系。 */
export interface NotebookFeaturedNoteFilter {
  conditions: NotebookFeaturedNoteCondition[];
  tableSelection?: {
    relativePath: string;
    collectionId: string;
    viewId?: string;
  } | null;
}

export interface NotebookCustomViewFilter {
  id: string;
  name: string;
  documentType?: 'note' | 'image' | 'video';
  key: string;
  operator: 'contains' | 'equals';
  value: string;
}

export interface NotebookCustomViews {
  filters: NotebookCustomViewFilter[];
}

export interface NotebookFileTreePreferences {
  sectionOrder: string[];
  hiddenSections: string[];
}

// System metadata (backend ~/.flowix/boot/system.json).
export const system = {
  getTagMetadata: (notebookId: string) =>
    invoke<NotebookTagSystemMetadata>('get_tag_system_metadata', { notebookId }),
  setTagLayout: (notebookId: string, layout: SystemTagLayoutItem[]) =>
    invoke<void>('set_tag_system_layout', { notebookId, layout }),
  /**
   * 写回某 parent 下的 pinned 列表。
   * - `parentId` 是空字符串时表 root。
   * - `pinned` 数组顺序 = MRU（index 0 = 最近置顶）。
   * - 空数组语义 = 该 parent 下不再有 pinned（持久化层会清空 key）。
   */
  setTagPinned: (notebookId: string, parentId: string, pinned: string[]) =>
    invoke<void>('set_tag_system_pinned', { notebookId, parentId, pinned }),
  /**
   * Notebook-scoped metadata, stored in `<notebook>/.flowix/system.json`.
   *
   * 与 tag 元数据同文件不同段; 后端会校验 operator 枚举, 非法值直接报错。
   */
  getFeaturedNoteFilter: (notebookId: string) =>
    invoke<NotebookFeaturedNoteFilter>('get_featured_note_filter', { notebookId }),
  setFeaturedNoteFilter: (notebookId: string, filter: NotebookFeaturedNoteFilter) =>
    invoke<void>('set_featured_note_filter', { notebookId, filter }),
  getCustomViews: (notebookId: string) =>
    invoke<NotebookCustomViews>('get_custom_views', { notebookId }),
  setCustomViews: (notebookId: string, views: NotebookCustomViews) =>
    invoke<void>('set_custom_views', { notebookId, views }),
  getNotebookFileTreePreferences: (notebookId: string) =>
    invoke<NotebookFileTreePreferences>('get_notebook_file_tree_preferences', { notebookId }),
  setNotebookFileTreeSectionOrder: (notebookId: string, sectionOrder: string[], hiddenSections?: string[]) =>
    invoke<void>('set_notebook_file_tree_section_order', { notebookId, sectionOrder, hiddenSections }),
};

// Memos
