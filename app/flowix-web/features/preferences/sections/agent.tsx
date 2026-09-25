'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  listenToUserConfigChanges,
  stopListeningToUserConfigChanges,
  type AgentConfig,
  type DeepSeekHarnessModel,
  type DeepSeekHarnessModelCatalog,
  type DeepSeekHarnessModelListing,
  type TestConnectionResult,
  type TestConnectionErrorKind,
} from '@platform/tauri/client';
import { Input } from '@shared/ui/input';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@shared/ui/select';
import { Button } from '@shared/ui/button';
import { Field, SectionHeader, FIELD_INPUT_CLASS } from '@features/preferences/sections/primitives';
import { Loader2, Plus, Trash2, Pencil } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { catalogProviderForConfiguredModel } from './model-provider';
import { useRegionStore } from '@/lib/i18n';
import iconMinimax from '@/assets/icon-minimax.svg';
import iconGlm from '@/assets/icon-glm.svg';
import iconOpenai from '@/assets/icon-openai.svg';
import iconClaude from '@/assets/icon-claude.svg';
import iconGemini from '@/assets/icon-gemini.svg';
import iconDeepseek from '@/assets/icon-deepseek.svg';
import iconOpenrouter from '@/assets/icon-openrouter.svg';
import iconOllama from '@/assets/icon-ollama.svg';
import type { AgentTypeKey } from '@/types/agent';
import { AgentIcon } from '@features/agent/components/agent-icon';

type TestConnection = (config: AgentConfig) => Promise<TestConnectionResult>;

export interface AgentSectionModelFormActions {
  save(): Promise<boolean>;
  test(): Promise<boolean>;
}

interface AgentConfigStore {
	get: () => Promise<{ model: AgentConfig }>;
	/** Full llm-pi-ai route list; only DeepSeek Harness provides this. */
	list?: () => Promise<{ model: AgentConfig }[]>;
	set: (config: AgentConfig) => Promise<void>;
	/** Optional append operation used by DeepSeek Harness model management. */
	add?: (config: AgentConfig) => Promise<void>;
}

interface ModelDirectory {
  modelCatalog: () => Promise<DeepSeekHarnessModelCatalog>;
  discoverModels: (config: AgentConfig) => Promise<DeepSeekHarnessModelListing>;
}

type ProviderOption = {
  id: string;
  displayKey?: string;
  label?: string;
  region: ProviderRegion;
};

const CUSTOM_PROVIDER_VALUE = '__flowix_custom_provider__';
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const CUSTOM_PROVIDER_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const;

type CustomProviderDraft = {
  id: string;
  displayName: string;
  apiUrl: string;
  apiProtocol: (typeof CUSTOM_PROVIDER_PROTOCOLS)[number];
  apiKey: string;
  models: { id: string; name: string }[];
};

type CustomProviderFormMode =
  | { kind: 'add' }
  | { kind: 'edit'; modelId: string; providerId?: string };

type ConfiguredModelCard = {
  id: string;
  name?: string;
  providerName: string;
  apiUrl: string;
  config: AgentConfig;
};

interface AgentSectionProps {
	/** Configuration persistence surface (DeepSeek Harness settings). */
	configStore: AgentConfigStore;
	/** Event kind emitted after this configuration surface saves. */
	configChangeKind: string;
	/** Connectivity probe bound to the same configuration surface. */
	testConnection: TestConnection;
  /** Optional DeepSeek Harness catalog/discovery surface. */
  modelDirectory?: ModelDirectory;
  /** Open the model add form immediately when embedded in onboarding. */
  startWithAddModel?: boolean;
  /** Render only the model editor card, without configured model cards. */
  modelFormOnly?: boolean;
  /** Expose model form actions so onboarding can place them in its footer. */
  onModelFormActionsReady?: (actions: AgentSectionModelFormActions | null) => void;
}

/** Common provider presets shown in the dropdown. The stored value is
 *  still a free-form `string` in `AgentConfig.provider`, so users with a
 *  custom value can still keep it — the trigger just shows whatever
 *  string is in state, and the dropdown highlights whatever preset (if
 *  any) matches.
 *
 *  Coding-plan providers (MiniMax / GLM) 钉在下拉顶部，按规格把 Base URL
 *  锁死成官方地址，模型走 `PROVIDER_MODEL_OPTIONS` 内的固定选项。
 *
 *  id 是写入磁盘的真值，displayKey 是当前语言展示文案。
 *
 *  region 控制下拉可见性:
 *    0 — 不限 (任何地区都展示)
 *    1 — 仅大陆 (仅 mainland 用户在下拉里看到)
 *    2 — 仅海外 (仅 overseas 用户在下拉里看到)
 *  注意: region 只影响**展示**, 不影响数据查表 (PROVIDER_DEFAULTS /
 *  PROVIDER_MODEL_OPTIONS / PROVIDER_BASE_URL_HINTS) — 老 config 里的
 *  provider 值不论地区, 都按 id 解析, 保证历史配置不失效。 */
type ProviderRegion = 0 | 1 | 2;

const CODING_PLAN_PROVIDER_IDS = [
  'MiniMax Coding Plan',
  'GLM Coding Plan',
] as const;

/** Base URL 由后端固定 / 不允许在前端编辑的供应商 ——
 *  DeepSeek 的接口走 OpenAI Chat Completions，Base URL
 *  锁死为官方根地址 (`https://api.deepseek.com`)。Harness/SDK 会在请求时
 *  追加 `/chat/completions`；Flowix 内置 provider 也兼容这个 base URL。
 *  与 CODING_PLAN_PROVIDER_IDS 的差别是这里**展示**该字段，仅禁用编辑。 */
const LOCKED_BASE_URL_PROVIDER_IDS = [
  'DeepSeek',
] as const;

const PROVIDER_OPTIONS = [
  { id: 'MiniMax Coding Plan', displayKey: 'preferences.agent.provider.minimaxCodingPlan', region: 1 satisfies ProviderRegion },
  { id: 'GLM Coding Plan', displayKey: 'preferences.agent.provider.glmCodingPlan', region: 1 satisfies ProviderRegion },
  { id: 'OpenAI Responses API', displayKey: 'preferences.agent.provider.openaiResponses', region: 0 satisfies ProviderRegion },
  { id: 'OpenAI Chat Completions', displayKey: 'preferences.agent.provider.openaiChatCompletions', region: 0 satisfies ProviderRegion },
  { id: 'Anthropic', displayKey: 'preferences.agent.provider.anthropic', region: 0 satisfies ProviderRegion },
  { id: 'Gemini', displayKey: 'preferences.agent.provider.gemini', region: 0 satisfies ProviderRegion },
  { id: 'Ollama', displayKey: 'preferences.agent.provider.ollama', region: 0 satisfies ProviderRegion },
  { id: 'DeepSeek', displayKey: 'preferences.agent.provider.deepseek', region: 0 satisfies ProviderRegion },
  { id: 'OpenRouter', displayKey: 'preferences.agent.provider.openrouter', region: 2 satisfies ProviderRegion },
] as const;

/** Coding-plan 提供商的固定模型列表：键为 provider id，值为可选模型。
 *  这些供应商在前端只暴露"模型选择 + 秘钥填写"两项，Base URL 走内置默认。 */
const PROVIDER_MODEL_OPTIONS: Record<string, readonly string[]> = {
  'MiniMax Coding Plan': ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
  'GLM Coding Plan': ['GLM-5.2', 'GLM-5-Turbo', 'GLM-4.7'],
};

const PROVIDER_DEFAULTS: Record<string, Pick<AgentConfig, 'model' | 'apiUrl'>> = {
  'MiniMax Coding Plan': {
    model: PROVIDER_MODEL_OPTIONS['MiniMax Coding Plan'][0],
    apiUrl: 'https://api.minimaxi.com/anthropic',
  },
  'GLM Coding Plan': {
    model: PROVIDER_MODEL_OPTIONS['GLM Coding Plan'][0],
    apiUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  'OpenAI Responses API': { model: 'gpt-5.5', apiUrl: '' },
  'OpenAI Chat Completions': { model: 'gpt-5.5', apiUrl: 'https://api.openai.com/v1' },
  Anthropic: { model: 'claude-opus-4-8', apiUrl: '' },
  Gemini: { model: 'gemini-3.1-pro-preview', apiUrl: '' },
  Ollama: { model: 'qwen3.6', apiUrl: 'http://localhost:11434' },
  DeepSeek: { model: 'deepseek-v4-flash', apiUrl: 'https://api.deepseek.com' },
  OpenRouter: { model: 'openai/gpt-5.5', apiUrl: '' },
  OpenAI: { model: 'gpt-5.5', apiUrl: '' },
  'OpenAI Compatible': { model: 'gpt-5.5', apiUrl: 'https://api.openai.com/v1' },
};

const PROVIDER_BASE_URL_HINTS: Record<string, string> = {
  'MiniMax Coding Plan': 'https://api.minimaxi.com/anthropic',
  'GLM Coding Plan': 'https://open.bigmodel.cn/api/coding/paas/v4',
  'OpenAI Responses API': 'https://api.openai.com/v1',
  'OpenAI Chat Completions': 'https://api.openai.com/v1',
  OpenAI: 'https://api.openai.com/v1',
  Anthropic: 'https://api.anthropic.com/v1',
  Gemini: 'https://generativelanguage.googleapis.com',
  Ollama: 'http://localhost:11434',
  DeepSeek: 'https://api.deepseek.com',
  OpenRouter: 'https://openrouter.ai/api/v1',
  'OpenAI Compatible': 'https://api.openai.com/v1',
};

const LEGACY_PROVIDER_LABEL_KEYS: Record<string, string> = {
  OpenAI: 'preferences.agent.provider.openaiResponses',
  'OpenAI Compatible': 'preferences.agent.provider.openaiChatCompletions',
};

function providerDefaults(provider: string): Pick<AgentConfig, 'model' | 'apiUrl'> | undefined {
  return PROVIDER_DEFAULTS[provider];
}

function providerBaseUrlHint(provider: string): string | undefined {
  return PROVIDER_BASE_URL_HINTS[provider];
}

function providerModelOptions(provider: string): readonly string[] | undefined {
  return PROVIDER_MODEL_OPTIONS[provider];
}

function addModelToConfig(
  config: AgentConfig,
  mode: CustomProviderFormMode,
  originalConfig?: AgentConfig,
): AgentConfig {
  const modelId = config.model.trim();
  if (!modelId) return config;
  const sameProviderAsOriginal = !originalConfig || originalConfig.provider === config.provider;
  const existingModels = mode.kind === 'add' && !sameProviderAsOriginal
    ? []
    : config.models ?? [];
  const existingModel = existingModels.find((model) =>
    mode.kind === 'edit' ? model.id === mode.modelId : model.id === modelId,
  );
  const nextModel = { id: modelId, name: existingModel?.name ?? '' };
  const withoutReplacedModel = existingModels.filter((model) =>
    mode.kind === 'edit'
      ? model.id !== mode.modelId && model.id !== modelId
      : model.id !== modelId,
  );
  return {
    ...config,
    models: [...withoutReplacedModel, nextModel],
  };
}

function catalogProviderFor(
  provider: string,
  catalog?: DeepSeekHarnessModelCatalog | null,
): string | undefined {
  switch (provider.trim().toLowerCase().replace(/[\s_-]/g, '')) {
    case 'anthropic':
    case 'claude':
      return 'anthropic';
    case 'deepseek':
      return 'deepseek';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
      return 'ollama';
    case 'openai':
    case 'openairesponsesapi':
    case 'openaichatcompletions':
      return 'openai';
    default: {
      const catalogProvider = catalog?.providers.find(
        (entry) => entry.provider === provider.trim(),
      );
      return catalogProvider?.provider;
    }
  }
}

function catalogProviderDefaults(
  provider: string,
  catalog: DeepSeekHarnessModelCatalog | null,
): Pick<AgentConfig, 'model' | 'apiUrl'> | undefined {
  const entry = catalog?.providers.find((item) => item.provider === provider);
  if (!entry) return undefined;
  const model = entry.models[0]?.id;
  if (!model) return undefined;
  return { model, apiUrl: entry.baseUrl ?? '' };
}

function catalogProviderOptions(
  catalog: DeepSeekHarnessModelCatalog | null,
): ProviderOption[] {
  if (!catalog) return [];
  return catalog.providers
    .map((entry) => ({
      id: entry.provider,
      label: entry.displayName ?? entry.provider,
      region: 0 as const,
    }));
}

function compareProviderOptions(a: ProviderOption, b: ProviderOption): number {
  return a.id.localeCompare(b.id, 'en', {
    numeric: true,
    sensitivity: 'base',
  });
}

/** Coding-plan 供应商：Base URL 走内置默认，前端不展示该字段。 */
function isCodingPlanProvider(provider: string): boolean {
  return (CODING_PLAN_PROVIDER_IDS as readonly string[]).includes(provider);
}

/** Base URL 被后端锁死的供应商 ——
 *  字段仍然展示（让用户看到实际请求地址），但禁用编辑。
 *  `defaults.apiUrl` 在 provider 切换时会被 `updateProvider` 自动写入，
 *  并在初次 load 时被 `loadInitialConfig` 兜底注入，所以用户不会看到空值。 */
function isLockedBaseUrlProvider(provider: string): boolean {
  return (LOCKED_BASE_URL_PROVIDER_IDS as readonly string[]).includes(provider);
}

/** Provider visibility for the legacy single-route settings form — 0 always,
 * 1 mainland only, 2 overseas only. */
function isProviderVisibleInRegion(
  region: ProviderRegion,
  isMainland: boolean,
): boolean {
  if (region === 0) return true;
  // region=1 wantsMainland, region=2 wantsOverseas, 两者对 isMainland 取等
  return (region === 1) === isMainland;
}

/** Provider dropdown item 左侧的 icon 规格。没有对应图标时不渲染占位图。 */
interface ProviderIconSpec {
  icon: string | null;
  agentTypeKey?: AgentTypeKey;
}

const iconKimi = 'https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/kimi/default.svg';
const iconQwen = 'https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/qwen/light.svg';
const iconGrok = 'https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/grok/default.svg';

const PROVIDER_ICONS: Record<string, ProviderIconSpec> = {
  'MiniMax Coding Plan': { icon: iconMinimax },
  'GLM Coding Plan': { icon: iconGlm },
  'OpenAI Responses API': { icon: iconOpenai },
  'OpenAI Chat Completions': { icon: iconOpenai },
  // 老 toml 里可能存的是裸 `OpenAI` / `OpenAI Compatible` 字串 ── 跟
  // `LEGACY_PROVIDER_LABEL_KEYS` / `PROVIDER_BASE_URL_HINTS` 对齐。
  OpenAI: { icon: iconOpenai },
  'OpenAI Compatible': { icon: iconOpenai },
  Anthropic: { icon: iconClaude },
  Gemini: { icon: iconGemini },
  Ollama: { icon: iconOllama },
  DeepSeek: { icon: iconDeepseek, agentTypeKey: 'deepseek-harness' },
  OpenRouter: { icon: iconOpenrouter },
  Kimi: { icon: iconKimi },
  Moonshot: { icon: iconKimi },
  Qwen: { icon: iconQwen },
  Grok: { icon: iconGrok },
};

const PROVIDER_ICON_ALIASES: Record<string, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  openai: 'OpenAI Responses API',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  minimax: 'MiniMax Coding Plan',
  'minimax-cn': 'MiniMax Coding Plan',
  kimi: 'Kimi',
  'kimi-coding': 'Kimi',
  moonshot: 'Moonshot',
  moonshotai: 'Moonshot',
  'moonshotai-cn': 'Moonshot',
  qwen: 'Qwen',
  'qwen-token-plan': 'Qwen',
  'qwen-token-plan-cn': 'Qwen',
  grok: 'Grok',
  xai: 'Grok',
};

function providerIconSpec(provider: string): ProviderIconSpec {
  const normalizedProvider = provider.trim().toLowerCase();
  const alias = PROVIDER_ICON_ALIASES[normalizedProvider]
    ?? (normalizedProvider.startsWith('kimi-') ? 'Kimi' : undefined)
    ?? (normalizedProvider.startsWith('moonshot') ? 'Moonshot' : undefined)
    ?? (normalizedProvider.startsWith('qwen-') ? 'Qwen' : undefined)
    ?? (normalizedProvider.startsWith('grok-') ? 'Grok' : undefined);
  return (
    PROVIDER_ICONS[provider] ?? (alias ? PROVIDER_ICONS[alias] : undefined) ?? {
      icon: null,
    }
  );
}

function ProviderIcon({ spec }: { spec: ProviderIconSpec }) {
  if (!spec.icon) return null;
  if (spec.agentTypeKey) {
    return <AgentIcon typeKey={spec.agentTypeKey} alt="" className="h-4 w-4 shrink-0 object-contain" />;
  }
  return (
    <img
      src={spec.icon}
      alt=""
      aria-hidden
      className="h-4 w-4 shrink-0 object-contain"
      draggable={false}
    />
  );
}

/** Default values for新 / 未配置场景。加载时与后端返回的 config 浅合并。
 *  字段命名走 camelCase, 与后端 AiModelConfig 的 serde rename_all 对齐 — 否则
 *  保存时 apiKey/apiUrl 会被 serde 静默丢, 刷新即丢失。 */
const DEFAULT_CONFIG: AgentConfig = {
  provider: 'OpenAI Responses API',
  model: 'gpt-5.5',
  apiUrl: '',
  apiKeys: {},
  credentialConfigured: false,
};

export function AgentSection({
	configStore,
	configChangeKind,
	testConnection,
  modelDirectory,
  startWithAddModel = false,
  modelFormOnly = false,
  onModelFormActionsReady,
}: AgentSectionProps) {
	const { t } = useI18n();
	// Legacy single-route settings keep their regional provider visibility;
	// DeepSeek Harness's catalog does not apply a regional filter.
	const isMainland = useRegionStore((s) => s.region === 'mainland');
  const dshDefaultModel = useAgentAccessStore(
    (state) => state.config.defaults?.runtime?.['deepseek-harness']?.model,
  );
  /** 编辑中的草稿 — 所有 onChange 只更新这里, 不会写盘。 */
  const [localConfig, setLocalConfig] = useState<AgentConfig | null>(null);
  /** Every llm-pi-ai route, kept separate from the single active draft. */
  const [providerConfigs, setProviderConfigs] = useState<AgentConfig[]>([]);
  /** 最近一次成功落盘时的快照, 用于判断 dirty。 */
  const [savedConfig, setSavedConfig] = useState<AgentConfig | null>(null);
  /** Save and test are independent operations; completion and errors use toast. */
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  /** 加载阶段出错时记录, 用错误态 UI 替代"加载中..."。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<DeepSeekHarnessModelCatalog | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<DeepSeekHarnessModel[]>([]);
  const [modelDiscoveryBusy, setModelDiscoveryBusy] = useState(false);
  const [modelDiscoveryError, setModelDiscoveryError] = useState<string | null>(null);
  const discoveryRequestRef = useRef(0);
  const [modelManagementBusy, setModelManagementBusy] = useState(false);
  const [showModelForm, setShowModelForm] = useState(startWithAddModel);
  const [modelFormMode, setModelFormMode] = useState<CustomProviderFormMode | null>(
    startWithAddModel ? { kind: 'add' } : null,
  );
  /** Selecting "Custom…" swaps the normal model form for the inline
   * provider editor immediately below the selector. */
  const [showCustomProviderForm, setShowCustomProviderForm] = useState(false);
  const [customProviderFormMode, setCustomProviderFormMode] =
    useState<CustomProviderFormMode | null>(null);
  const [customProviderDraft, setCustomProviderDraft] = useState<CustomProviderDraft>({
    id: '',
    displayName: '',
    apiUrl: '',
    apiProtocol: 'openai-completions',
    apiKey: '',
    models: [{ id: '', name: '' }],
  });

  useEffect(() => {
    if (!modelDirectory) return;
    let cancelled = false;
    void modelDirectory.modelCatalog()
      .then((catalog) => {
        if (!cancelled) setModelCatalog(catalog);
      })
      .catch((error: unknown) => {
        if (!cancelled) setModelDiscoveryError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [modelDirectory?.modelCatalog]);

  // Refs mirror the latest `localConfig` / `savedConfig` so async callbacks
  // (probe results resolving after the user has typed, the cross-window
  // config-change listener, ...) can read fresh values without taking the
  // relevant values into their dependency arrays. Without these, closures
  // would see stale snapshots and we'd either (a) over-resubscribe IPC
  // channels on every keystroke or (b) write stale state back from a
  // resolved probe.
  const localConfigRef = useRef(localConfig);
  const savedConfigRef = useRef(savedConfig);
  useEffect(() => {
    localConfigRef.current = localConfig;
  }, [localConfig]);
  useEffect(() => {
    savedConfigRef.current = savedConfig;
  }, [savedConfig]);

	// Load the selected model from the configured persistence surface.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
			const listed = configStore.list ? await configStore.list() : null;
			const cfg = listed?.[0]?.model ?? (await configStore.get()).model;
	        if (!cancelled) {
	          const merged = { ...DEFAULT_CONFIG, ...cfg };
          // 兜底: 早期版本可能把带默认 endpoint 的 provider 落成空 apiUrl。
          // 为空时补默认值；已有自定义 URL 时不覆盖。DeepSeek 这类 locked
          // provider 额外要求必须等于默认 endpoint。
          const lockedDefaults = providerDefaults(merged.provider);
          if (
            lockedDefaults &&
            lockedDefaults.apiUrl &&
            (merged.apiUrl.trim() === '' ||
              (isLockedBaseUrlProvider(merged.provider) &&
                merged.apiUrl.trim() !== lockedDefaults.apiUrl))
          ) {
            merged.apiUrl = lockedDefaults.apiUrl;
          }
	          setLocalConfig(startWithAddModel
            ? { ...DEFAULT_CONFIG, provider: '', model: '', models: [], apiUrl: '', apiKeys: {} }
            : merged);
	          setSavedConfig(merged);
	          setProviderConfigs(listed?.map((entry) => entry.model) ?? []);
          setLoadError(null);
        }
      } catch (err) {
        if (cancelled) return;
        // 关键: 不要把 savedConfig / localConfig 重置成 DEFAULT — 否则
        // 用户点"保存"会覆盖真实配置文件。保持原状, 改用错误态 UI。
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
        console.error('[AgentSection] Failed to load ai_config:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
	}, [configStore, startWithAddModel]);

  // 跨窗口同步: 其它来源 (如未来的导入 / 命令行 / 第二个偏好窗口) 改了
  // ai_config 时, 重新从磁盘拉取。
  // 关键: 用户当前有未保存改动 (isDirty) 时不要覆盖, 避免静默丢编辑。
  //
  // 一次性订阅(空 dep 数组)— 通过 ref 拿最新的 localConfig / savedConfig,
  // 否则每次键入都会重订阅 IPC 通道。原有实现把这两个 state 写进 dep
  // 数组,导致 setup/cleanup 在每个键入周期都跑一次,理论上 Tauri 端
  // unlisten→listen 的微秒窗口可能丢事件。
  useEffect(() => {
    let cancelled = false;
    void listenToUserConfigChanges(async (kind) => {
		if (kind !== configChangeKind || cancelled) return;
      // dirty 状态下不抢用户的编辑, 只在下一次挂载 / 用户主动离开时再刷新
      const local = localConfigRef.current;
      const saved = savedConfigRef.current;
      const stillDirty =
        local !== null &&
        saved !== null &&
        JSON.stringify(local) !== JSON.stringify(saved);
      if (stillDirty) return;
      try {
		const listed = configStore.list ? await configStore.list() : null;
		const cfg = listed?.[0]?.model ?? (await configStore.get()).model;
        if (cancelled) return;
        const merged = { ...DEFAULT_CONFIG, ...cfg };
        // 与初始 load 同款的 provider 默认 endpoint 兜底, 见 useEffect 注释。
        const lockedDefaults = providerDefaults(merged.provider);
        if (
          lockedDefaults &&
          lockedDefaults.apiUrl &&
          (merged.apiUrl.trim() === '' ||
            (isLockedBaseUrlProvider(merged.provider) &&
              merged.apiUrl.trim() !== lockedDefaults.apiUrl))
        ) {
          merged.apiUrl = lockedDefaults.apiUrl;
        }
        setLocalConfig(merged);
        setSavedConfig(merged);
        setProviderConfigs(listed?.map((entry) => entry.model) ?? []);
        setIsSaving(false);
      } catch (err) {
        console.error("[AgentSection] Failed to reload ai_config:", err);
      }
    });
    return () => {
      cancelled = true;
      stopListeningToUserConfigChanges();
    };
	}, [configStore, configChangeKind]);

  // 用深比较判断是否有未保存修改 — 配置只有 7 个简单字段, JSON.stringify 性能可接受
  const isDirty =
    localConfig !== null &&
    savedConfig !== null &&
    JSON.stringify(localConfig) !== JSON.stringify(savedConfig);
  const currentCatalogProvider = modelDirectory && localConfig
    ? modelCatalog?.providers.find((entry) => entry.provider === localConfig.provider)
    : undefined;
  const currentConfiguredProvider = modelDirectory && localConfig
    ? providerConfigs.find((config) =>
        (config.providerId?.trim() || config.provider) === localConfig.provider,
      )
    : undefined;
  /** Disable both actions while either asynchronous operation is running. */
  const isBusy = isSaving || isTesting;
  const currentProviderLabel = (() => {
    const provider = localConfig?.provider;
    if (!provider) return '';
    if (modelDirectory && localConfig?.providerId?.trim()) {
      return localConfig.displayName?.trim()
        || currentCatalogProvider?.displayName
        || currentConfiguredProvider?.displayName
        || localConfig.providerId;
    }
    const catalogEntry = modelCatalog?.providers.find(
      (entry) => entry.provider === provider,
    );
    if (catalogEntry?.displayName) return catalogEntry.displayName;
    if (modelDirectory) return provider;
    const preset = PROVIDER_OPTIONS.find((opt) => opt.id === provider);
    const legacyKey = LEGACY_PROVIDER_LABEL_KEYS[provider];
    if (preset) return t(preset.displayKey as Parameters<typeof t>[0]);
    if (legacyKey) return t(legacyKey as Parameters<typeof t>[0]);
    return provider;
  })();

  const handleSave = async (): Promise<boolean> => {
    if (!localConfig) return false;

    // Model-management forms keep the directory update as a final pure
    // transformation. Build that effective config before validation so a
    // newly added model is persisted together with its provider route.
    const configToSave = modelDirectory && modelFormMode
      ? addModelToConfig(localConfig, modelFormMode, savedConfig ?? undefined)
      : localConfig;
    if (
      modelFormOnly
      && savedConfig
      && JSON.stringify(configToSave) === JSON.stringify(savedConfig)
    ) {
      return true;
    }
    const formSnapshot = JSON.stringify(localConfig);

    // Local pre-flight: catches the obvious mistakes (missing key, bad URL
    // scheme, empty provider/model) without a network round-trip. Saving a
    // setting must not be blocked by provider availability; use Test for that.
    const localErr = validateBeforeSave(configToSave, t);
    if (localErr) {
      setIsSaving(false);
      setIsTesting(false);
      toast.error(localErr);
      return false;
    }

    // Commit independently of network connectivity. This makes Save usable
    // for a new provider, an offline endpoint, and a key that will be tested
    // later, while preserving the explicit Test connection action.
    setIsSaving(true);
    try {
			const appendModel = modelDirectory && modelFormMode?.kind === 'add';
			if (appendModel && configStore.add) {
				await configStore.add(configToSave);
			} else {
				await configStore.set(configToSave);
			}
	      const listed = modelDirectory && configStore.list
	        ? await configStore.list()
	        : null;
        const persistedConfig = listed?.find((entry) => {
          const route = entry.model.providerId?.trim() || entry.model.provider;
          const target = configToSave.providerId?.trim() || configToSave.provider;
          return route === target;
        })?.model
          ?? (appendModel && configStore.add ? (await configStore.get()).model : configToSave);
      const stillClean = formSnapshot === JSON.stringify(localConfigRef.current);
      if (listed) setProviderConfigs(listed.map((entry) => entry.model));
      setSavedConfig(persistedConfig);
      setIsTesting(false);
      if (modelDirectory && stillClean) {
        setLocalConfig(persistedConfig);
        if (!modelFormOnly) {
          setShowModelForm(false);
          setModelFormMode(null);
        }
      }
      toast.success(t('preferences.agent.saved'));
      return true;
      // If the user typed during the in-flight save, the form has moved
      // past `snapshot` — the saved-on-disk state no longer matches the
      // form, so we go straight to `idle` (which will then show the unsaved
      // hint). The toast still confirms the snapshot that was persisted.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 保存失败时清理测试状态，避免上一次测试成功的状态残留。
      setIsTesting(false);
      toast.error(`${t('preferences.agent.saveFailed')}: ${msg}`);
      console.error('[AgentSection] Failed to save ai_config:', err);
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async (): Promise<boolean> => {
    if (!localConfig) return false;
    setIsTesting(true);
    try {
      const result = await runProbe(localConfig, JSON.stringify(localConfig));
      return result?.ok === true;
    } finally {
      setIsTesting(false);
    }
    // runProbe shows the result through the shared toast.
  };

  const saveHandlerRef = useRef(handleSave);
  const testHandlerRef = useRef(handleTest);
  saveHandlerRef.current = handleSave;
  testHandlerRef.current = handleTest;
  const [modelFormActions] = useState<AgentSectionModelFormActions>(() => ({
    save: () => saveHandlerRef.current(),
    test: () => testHandlerRef.current(),
  }));

  useEffect(() => {
    onModelFormActionsReady?.(modelFormActions);
    return () => onModelFormActionsReady?.(null);
  }, [modelFormActions, onModelFormActionsReady]);

  /**
   * Shared probe entry point. Success/failure is shown
   * through the shared toast component.
   *
   * Returns the result on success, or `null` when the IPC itself threw
   * through the shared toast. The caller owns the in-flight flag.
   *
   * **Stale-result guard**: if the form changed *between* the call into
   * `runProbe` and the probe resolving, we drop the result. Without this,
   * the user could see a green "Success (230ms)" badge attached to a form
   * that's no longer the one we just verified.
   */
  const runProbe = async (
    cfg: AgentConfig,
    snapshot: string,
  ): Promise<TestConnectionResult | null> => {
    try {
      const result = await testConnection(cfg);
      // 表单在 probe in-flight 期间被改 → 丢掉这条 stale 结果
      if (snapshot !== JSON.stringify(localConfigRef.current)) {
        return null;
      }
      if (result.ok) {
        toast.success(t('preferences.agent.testSuccess', { ms: result.latencyMs }));
      } else {
        const errorKind = formatErrorKind(result.error?.kind, t);
        const detail = result.error?.message?.trim();
        toast.error(detail ? `${errorKind}: ${detail}` : errorKind);
      }
      return result;
    } catch (err) {
      // The IPC always returns TestConnectionResult-shaped data; we only
      // land here when the command itself threw (network to the Tauri
      // host, JSON parse, command missing, ...). Wrap as `Other` and
      // surface through the shared toast.
      const message = err instanceof Error ? err.message : String(err);
      const fallback: TestConnectionResult = {
        ok: false,
        latencyMs: 0,
        modelId: cfg.model,
        summary: '',
        error: { kind: 'other', message },
      };
      toast.error(`${formatErrorKind(fallback.error?.kind, t)}: ${message}`);
      console.error('[AgentSection] test_ai_connection IPC threw:', err);
      return null;
    }
  };

  const updateField = <K extends keyof AgentConfig>(field: K, value: AgentConfig[K]) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, [field]: value });
  };

  const updateProvider = (provider: string) => {
    if (!localConfig) return;
    if (modelDirectory && provider === CUSTOM_PROVIDER_VALUE) {
      // A pre-providerId Harness document may lack the native route id. When
      // the Add model card starts from a blank draft, use that saved document
      // as the custom-provider draft so the user can explicitly repair it.
      const savedExistingCustom = savedConfig &&
        savedConfig.models?.length &&
        (Boolean(savedConfig.providerId?.trim()) &&
          !modelCatalog?.providers.some((entry) => entry.provider === savedConfig.provider) &&
          !providerConfigs.some((config) =>
            (config.providerId?.trim() || config.provider) === savedConfig.provider,
          ) &&
          !catalogProviderFor(savedConfig.provider, modelCatalog))
        ? savedConfig
        : null;
      const existingCustomConfig = localConfig.providerId?.trim() &&
        !modelCatalog?.providers.some((entry) => entry.provider === localConfig.provider) &&
        !providerConfigs.some((config) =>
          (config.providerId?.trim() || config.provider) === localConfig.provider,
        ) &&
        !catalogProviderFor(localConfig.provider, modelCatalog)
        ? localConfig
        : savedExistingCustom;
      const isExistingCustom = Boolean(existingCustomConfig);
      const existingKeyBucket = existingCustomConfig?.providerId?.trim()
        || existingCustomConfig?.provider?.trim()
        || '';
      setCustomProviderDraft({
        id: isExistingCustom
          ? existingCustomConfig?.providerId?.trim() || existingCustomConfig?.provider || ''
          : '',
        displayName: isExistingCustom
          ? existingCustomConfig?.displayName || existingCustomConfig?.provider || ''
          : '',
        apiUrl: isExistingCustom ? existingCustomConfig?.apiUrl ?? '' : '',
        apiProtocol: (isExistingCustom && CUSTOM_PROVIDER_PROTOCOLS.includes(
          existingCustomConfig?.apiProtocol as (typeof CUSTOM_PROVIDER_PROTOCOLS)[number],
        )
          ? existingCustomConfig?.apiProtocol
          : 'openai-completions') as (typeof CUSTOM_PROVIDER_PROTOCOLS)[number],
        apiKey: isExistingCustom && existingKeyBucket
          ? existingCustomConfig?.apiKeys[existingKeyBucket] ?? ''
          : '',
        models: isExistingCustom && existingCustomConfig?.models?.length
          ? existingCustomConfig.models.map((model) => ({ id: model.id, name: model.name ?? '' }))
          : [{ id: '', name: '' }],
      });
      setShowCustomProviderForm(true);
      setCustomProviderFormMode(
        modelFormMode?.kind === 'add'
          ? { kind: 'add' }
          : isExistingCustom
            ? { kind: 'edit', modelId: localConfig.model }
            : { kind: 'add' },
      );
      return;
    }
    const defaults =
      providerDefaults(provider) ?? catalogProviderDefaults(provider, modelCatalog);
    const catalogEntry = modelDirectory
      ? modelCatalog?.providers.find((entry) => entry.provider === provider)
      : undefined;
    const configuredEntry = modelDirectory
      ? providerConfigs.find((config) =>
          (config.providerId?.trim() || config.provider) === provider,
        )
      : undefined;
    const preserveModelDirectory = Boolean(
      modelDirectory &&
      modelFormMode &&
      savedConfig?.provider === provider,
    );
    setLocalConfig({
      ...localConfig,
      provider,
      // llm-pi-ai routes are first-class configuration identities. Keep the
      // selected catalog route in the persisted providerId instead of routing
      // every provider through a Flowix-specific alias.
      providerId: provider,
      displayName: catalogEntry?.displayName ?? configuredEntry?.displayName ?? '',
      apiProtocol: catalogEntry?.api ?? configuredEntry?.apiProtocol ?? '',
      models: preserveModelDirectory ? localConfig.models ?? savedConfig?.models ?? [] : [],
      ...(defaults ?? {}),
    });
    setDiscoveredModels([]);
    setModelDiscoveryError(null);
    discoveryRequestRef.current += 1;
    setShowCustomProviderForm(false);
    setCustomProviderFormMode(null);
  };

  /** API key change goes through its own helper because the apiKey input
   *  stores into `apiKeys[provider]` (per-provider bucket) rather than a
   *  top-level field, and — crucially — the inline onChange bypasses
   *  `updateField`. Without this helper, a successful test followed by an
   *  apiKey edit would still show "Success (230ms)" even though the
   *  auth-critical field has changed. */
  const updateApiKey = (value: string) => {
    if (!localConfig) return;
    const keyBucket = localConfig.providerId?.trim() || localConfig.provider;
    setLocalConfig({
      ...localConfig,
      apiKeys: { ...localConfig.apiKeys, [keyBucket]: value },
      credentialConfigured: value.trim().length > 0,
    });
  };

  const discoverModels = async () => {
    if (!modelDirectory || !localConfig) return;
    const requestId = ++discoveryRequestRef.current;
    const providerAtRequest = localConfig.provider;
    setModelDiscoveryBusy(true);
    setModelDiscoveryError(null);
    try {
      const result = await modelDirectory.discoverModels(localConfig);
      if (requestId !== discoveryRequestRef.current || localConfigRef.current?.provider !== providerAtRequest) return;
      setDiscoveredModels(result.models);
    } catch (error) {
      if (requestId !== discoveryRequestRef.current) return;
      setModelDiscoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === discoveryRequestRef.current) setModelDiscoveryBusy(false);
    }
  };

  /** A custom provider is an llm-pi-ai route rather than a Flowix preset.
   * Persist it immediately from the inline form so its route ID, protocol, and
   * model directory stay together in the Harness settings document. */
  const createCustomProvider = async (draft: CustomProviderDraft): Promise<string | null> => {
    const reject = (message: string): string => {
      toast.error(message);
      return message;
    };
    if (!localConfig) return reject(t('preferences.agent.provider.customError'));
    const id = draft.id.trim();
    const displayName = draft.displayName.trim();
    const apiUrl = draft.apiUrl.trim().replace(/\/+$/, '');
    const models = draft.models
      .map((model) => ({ id: model.id.trim(), name: model.name.trim() }))
      .filter((model) => model.id.length > 0);
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      return reject(t('preferences.agent.provider.customDuplicateModelError'));
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
      return reject(t('preferences.agent.provider.customIdError'));
    }
    if (
      !displayName ||
      !/^https?:\/\//.test(apiUrl) ||
      !draft.apiKey.trim() ||
      models.length === 0
    ) {
      return reject(t('preferences.agent.provider.customError'));
    }
    const formMode = customProviderFormMode;
    const existingModels = (localConfig.models ?? [])
      .map((model) => ({ id: model.id, name: model.name ?? '' }));
    const existingProviderId = localConfig.providerId?.trim()
      || savedConfig?.providerId?.trim();
    // Older Harness configs may lack a providerId while storing the route in
    // `provider`. Treat that as repair input; newly saved configs always use
    // the native llm-pi-ai route explicitly.
    const legacyProviderName = savedConfig?.provider?.trim()
      || localConfig.provider?.trim();
    const normalizeEndpoint = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();
    const isSameExistingProvider = Boolean(
      existingProviderId && existingProviderId === id,
    ) || Boolean(
      !existingProviderId &&
      legacyProviderName &&
      legacyProviderName === id &&
      existingModels.length > 0,
    ) || Boolean(
      !existingProviderId &&
      existingModels.length > 0 &&
      legacyProviderName &&
      normalizeEndpoint(savedConfig?.apiUrl ?? '') === normalizeEndpoint(apiUrl),
    );
    const submittedModels = models.map((model) => ({ id: model.id, name: model.name }));
    let nextModels = submittedModels;
    if (formMode?.kind === 'edit') {
      nextModels = existingModels
        .filter((model) => model.id !== formMode.modelId && !submittedModels.some((entry) => entry.id === model.id))
        .concat(submittedModels);
    } else if (isSameExistingProvider) {
      nextModels = existingModels
        .filter((model) => !submittedModels.some((entry) => entry.id === model.id))
        .concat(submittedModels);
    }
    const nextActiveModel = formMode?.kind === 'edit'
      ? localConfig.model === formMode.modelId
        ? submittedModels[0].id
        : localConfig.model
      : localConfig.providerId?.trim() && localConfig.model
        ? localConfig.model
        : nextModels[0].id;
    const nextConfig: AgentConfig = {
      ...localConfig,
      provider: id,
      providerId: id,
      displayName,
      apiProtocol: draft.apiProtocol,
      model: nextActiveModel,
      models: nextModels,
      apiUrl,
      apiKeys: { ...localConfig.apiKeys, [id]: draft.apiKey },
    };
    try {
      if (formMode?.kind === 'add' && configStore.add) {
        await configStore.add(nextConfig);
      } else {
        await configStore.set(nextConfig);
      }
      const listed = modelDirectory && configStore.list
        ? await configStore.list()
        : null;
      const persistedConfig = listed?.find((entry) => {
        const route = entry.model.providerId?.trim() || entry.model.provider;
        return route === id;
      })?.model
        ?? (formMode?.kind === 'add' && configStore.add
          ? (await configStore.get()).model
          : nextConfig);
      if (listed) setProviderConfigs(listed.map((entry) => entry.model));
      setLocalConfig(persistedConfig);
      setSavedConfig(persistedConfig);
      setIsSaving(false);
      setIsTesting(false);
      toast.success(t('preferences.agent.saved'));
      setDiscoveredModels([]);
      setModelDiscoveryError(null);
      setShowCustomProviderForm(false);
      setCustomProviderFormMode(null);
      setShowModelForm(false);
      setModelFormMode(null);
      return null;
    } catch (error) {
      console.error('[AgentSection] Failed to create custom DSH provider:', error);
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`${t('preferences.agent.saveFailed')}: ${message}`);
      return message;
    }
  };

  /** Open the same editor used when adding a custom provider.  Keeping model
   * edits on this path means provider credentials and the model directory are
   * updated atomically instead of letting a model row drift away from its
   * provider route. */
  const editCustomModel = (card: ConfiguredModelCard) => {
    const cardConfig = card.config;
    setLocalConfig({ ...cardConfig, model: card.id });
    setSavedConfig(cardConfig);
    const routeKey = cardConfig.providerId?.trim() || cardConfig.provider;
    setModelFormMode({ kind: 'edit', modelId: card.id, providerId: routeKey });
    setShowModelForm(true);
    const cardIsCatalogProvider = Boolean(
      modelDirectory && modelCatalog?.providers.some(
        (entry) => entry.provider === cardConfig.provider,
      ),
    );
    const cardIsCustomProvider = modelDirectory && !cardIsCatalogProvider;
    if (!cardIsCustomProvider) {
      setShowCustomProviderForm(false);
      setCustomProviderFormMode(null);
      return;
    }
    const model = (cardConfig.models ?? []).find((entry) => entry.id === card.id);
    setCustomProviderDraft({
      id: cardConfig.providerId ?? cardConfig.provider,
      displayName: cardConfig.displayName ?? cardConfig.provider,
      apiUrl: cardConfig.apiUrl,
      apiProtocol: (CUSTOM_PROVIDER_PROTOCOLS.includes(
        cardConfig.apiProtocol as (typeof CUSTOM_PROVIDER_PROTOCOLS)[number],
      )
        ? cardConfig.apiProtocol
        : 'openai-completions') as (typeof CUSTOM_PROVIDER_PROTOCOLS)[number],
      apiKey: cardConfig.apiKeys[cardConfig.providerId?.trim() || cardConfig.provider] ?? '',
      models: [{ id: card.id, name: model?.name ?? card.name ?? '' }],
    });
    setCustomProviderFormMode({ kind: 'edit', modelId: card.id, providerId: routeKey });
    setShowCustomProviderForm(true);
  };

  const addCustomModel = () => {
    setLocalConfig({
      ...DEFAULT_CONFIG,
      provider: '',
      model: '',
      models: [],
      apiUrl: '',
      apiKeys: {},
    });
    setCustomProviderDraft({
      id: '',
      displayName: '',
      apiUrl: '',
      apiProtocol: 'openai-completions',
      apiKey: '',
      models: [{ id: '', name: '' }],
    });
    setCustomProviderFormMode({ kind: 'add' });
    setModelFormMode({ kind: 'add' });
    setShowModelForm(true);
    setShowCustomProviderForm(false);
  };

  const cancelModelForm = () => {
    if (savedConfigRef.current) setLocalConfig(savedConfigRef.current);
    setShowCustomProviderForm(false);
    setCustomProviderFormMode(null);
    setShowModelForm(false);
    setModelFormMode(null);
  };

  /** Remove one model from the persisted custom provider directory. The
   * remaining first model becomes the active model; deleting the final entry
   * leaves an empty directory so the user can add a replacement later. */
  const deleteCustomModel = async (card: ConfiguredModelCard) => {
    // The visible card is the source of truth. `localConfig` is only the
    // active/first route kept for the editor, so using it here would delete a
    // model from DeepSeek when the user clicked Delete on a GLM card.
    const cardConfig = card.config;
    const remainingModels = (cardConfig.models ?? []).filter((model) => model.id !== card.id);
    const providerKeyBucket = cardConfig.providerId?.trim() || cardConfig.provider;
    const nextConfig: AgentConfig = {
      ...cardConfig,
      model: cardConfig.model === card.id
        ? remainingModels[0]?.id ?? ''
        : cardConfig.model,
      models: remainingModels,
      apiKeys: remainingModels.length > 0
        ? cardConfig.apiKeys
        : { ...cardConfig.apiKeys, [providerKeyBucket]: '' },
      credentialConfigured: remainingModels.length > 0
        ? cardConfig.credentialConfigured
        : false,
    };
    const persistedConfig = remainingModels.length > 0
      ? nextConfig
      : { ...DEFAULT_CONFIG, apiKeys: {} };
    setModelManagementBusy(true);
    try {
      await configStore.set(nextConfig);
      const listed = modelDirectory && configStore.list
        ? await configStore.list()
        : null;
      const nextActiveConfig = listed?.[0]?.model ?? persistedConfig;
      if (listed) setProviderConfigs(listed.map((entry) => entry.model));
      setLocalConfig(nextActiveConfig);
      setSavedConfig(nextActiveConfig);
      setIsTesting(false);
      setIsSaving(false);
      toast.success(t('preferences.agent.saved'));
      if (customProviderFormMode?.kind === 'edit' && customProviderFormMode.modelId === card.id) {
        setShowCustomProviderForm(false);
        setCustomProviderFormMode(null);
      }
      setShowModelForm(false);
      setModelFormMode(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`${t('preferences.agent.saveFailed')}: ${message}`);
      console.error('[AgentSection] Failed to delete custom DSH model:', error);
    } finally {
      setModelManagementBusy(false);
    }
  };

  /**
   * Zero-cost local validation — runs *before* the connectivity probe so
   * we don't burn an HTTP request on something we can reject locally.
   *
   * Mirrors the backend's `precheck` in `agent/provider.rs::probe_chat`,
   * but the message comes from i18n for the user-facing toast.
   *
   * Returns the already-translated error message, or `null` when valid.
   */
  const validateBeforeSave = (
    cfg: AgentConfig,
    translate: typeof t,
  ): string | null => {
    if (!cfg.provider.trim()) return translate('preferences.agent.error.noProvider');
    if (!cfg.model.trim()) return translate('preferences.agent.error.noModel');
    // Match backend `provider_kind` rule: Ollama and OpenAI-compatible
    // self-host are key-less; everything else needs a key.
    const catalogEntry = modelDirectory
      ? modelCatalog?.providers.find((entry) => entry.provider === cfg.provider)
      : undefined;
    const configuredEntry = modelDirectory
      ? providerConfigs.find((config) =>
          (config.providerId?.trim() || config.provider) === cfg.provider,
        )
      : undefined;
    const keyRequired = modelDirectory
      ? (catalogEntry?.takesApiKey ?? !configuredEntry)
      : cfg.provider !== 'Ollama' && cfg.provider !== 'OpenAI Compatible';
    const keyBucket = cfg.providerId?.trim() || cfg.provider;
    if (keyRequired && !cfg.credentialConfigured && (cfg.apiKeys[keyBucket] ?? '').trim() === '') {
      return translate('preferences.agent.error.noApiKey');
    }
    const url = cfg.apiUrl.trim();
    if (url && !/^https?:\/\//.test(url)) {
      return translate('preferences.agent.error.badUrl');
    }
    const urlRequired = modelDirectory
      ? !(catalogEntry?.baseUrl ?? configuredEntry?.apiUrl)
      : cfg.provider === 'Ollama' || cfg.provider === 'OpenAI Compatible';
    if (urlRequired && url === '') {
      return translate('preferences.agent.error.badUrl');
    }
    return null;
  };

  /**
   * Exhaustive mapping `TestConnectionErrorKind → i18n key`. The
   * `as const satisfies` check makes TS verify two invariants at compile
   * time:
   *   1. Every variant of `TestConnectionErrorKind` has an entry here.
   *   2. Each literal key is a registered `I18nKey` (i.e. exists in both
   *      `messages["zh-CN"]` and `messages["en-US"]`).
   * If someone later adds a 11th variant without a matching key, this
   * line refuses to compile.
   */
  const TEST_CONNECTION_ERROR_I18N_KEYS = {
    bad_config: 'preferences.agent.testError.bad_config',
    unsupported_provider: 'preferences.agent.testError.unsupported_provider',
    auth_failed: 'preferences.agent.testError.auth_failed',
    not_found: 'preferences.agent.testError.not_found',
    rate_limited: 'preferences.agent.testError.rate_limited',
    server_error: 'preferences.agent.testError.server_error',
    bad_request: 'preferences.agent.testError.bad_request',
    network_unreachable: 'preferences.agent.testError.network_unreachable',
    invalid_response: 'preferences.agent.testError.invalid_response',
    other: 'preferences.agent.testError.other',
  } as const satisfies Record<TestConnectionErrorKind, Parameters<typeof t>[0]>;

  /**
   * Map a `TestConnectionErrorKind` to a user-facing translated string.
   *
   * We use an explicit lookup table instead of a template literal so
   * TypeScript will *fail to compile* if a new variant is added to
   * `TestConnectionErrorKind` without an accompanying i18n key — the
   * `satisfies Record<...>` check forces exhaustive coverage.
   */
  const formatErrorKind = (
    kind: TestConnectionErrorKind | undefined,
    translate: typeof t,
  ): string => {
    const key = TEST_CONNECTION_ERROR_I18N_KEYS[kind ?? 'other'];
    return translate(key);
  };


  if (loadError) {
    return (
      <div className="space-y-3 pb-6">
        <SectionHeader title={t('preferences.agent.title')} size="compact" />
        <div className="rounded-md border border-[color-mix(in_oklch,var(--destructive)_40%,transparent)] bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] px-4 py-3 text-sm text-[var(--destructive)]">
          {t('preferences.agent.loadFailed')}: {loadError}
        </div>
        <div className="text-xs text-[var(--muted-foreground)]">
          {t('preferences.agent.loadFailedHint')}
        </div>
      </div>
    );
  }

  if (!localConfig) {
    return (
      <div className="flex h-[100px] items-center justify-center text-center text-sm text-[var(--muted-foreground)]">
        {t('preferences.agent.loading')}
      </div>
    );
  }

  const defaults = modelDirectory
    ? catalogProviderDefaults(localConfig.provider, modelCatalog)
    : providerDefaults(localConfig.provider);
  const modelOptions = modelDirectory
    ? undefined
    : providerModelOptions(localConfig.provider);
  const isCatalogProvider = Boolean(
    modelDirectory && modelCatalog?.providers.some(
      (entry) => entry.provider === localConfig.provider,
    ),
  );
  const isConfiguredProvider = Boolean(currentConfiguredProvider);
  const isCustomProvider = Boolean(
    modelDirectory && localConfig.providerId?.trim() && !isCatalogProvider && !isConfiguredProvider,
  );
  const catalogProvider = modelDirectory
    ? localConfig.provider
    : catalogProviderFor(localConfig.provider, modelCatalog);
  const catalogModels = modelCatalog?.providers.find(
    (provider) => provider.provider === catalogProvider,
  )?.models ?? [];
  const customModels = isCustomProvider ? localConfig.models ?? [] : [];
  const savedModels = localConfig.models ?? [];
  const dynamicModels = isCustomProvider && customModels.length > 0
    ? customModels
    : savedModels.length > 0
      ? savedModels
      : discoveredModels.length > 0
        ? discoveredModels
        : catalogModels;
  const dynamicModelOptions = dynamicModels.length > 0
    ? [...new Set(dynamicModels.map((model) => model.id))]
    : undefined;
  const selectedModel = [...savedModels, ...customModels, ...catalogModels, ...discoveredModels].find(
    (model) => model.id === localConfig.model,
  );
  const selectedModelContextWindow = selectedModel && 'contextWindow' in selectedModel
    && typeof selectedModel.contextWindow === 'number'
    ? selectedModel.contextWindow
    : undefined;
  const selectedModelMaxTokens = selectedModel && 'maxTokens' in selectedModel
    && typeof selectedModel.maxTokens === 'number'
    ? selectedModel.maxTokens
    : undefined;
  const modelPlaceholder = defaults?.model ?? t('preferences.agent.modelId.placeholder');
  const baseUrlPlaceholder = providerBaseUrlHint(localConfig.provider) ?? 'Provider default';
  const hideBaseUrlField = !modelDirectory && isCodingPlanProvider(localConfig.provider);
  const lockBaseUrl = !modelDirectory && isLockedBaseUrlProvider(localConfig.provider);
  const apiKeyDescription = (
    (!modelDirectory && localConfig.provider === 'Ollama') ||
    (modelDirectory && modelCatalog?.providers.find(
      (entry) => entry.provider === localConfig.provider,
    )?.takesApiKey === false)
  )
      ? t('preferences.agent.apiKey.optionalDescription')
      : t('preferences.agent.apiKey.description');

  // DSH providers come from the appserver catalog and saved routes. If the
  // catalog is temporarily unavailable, saved routes remain selectable.
  const providerOptions: ProviderOption[] = modelDirectory
    ? [
        ...catalogProviderOptions(modelCatalog),
        ...providerConfigs.map((config) => ({
          id: config.providerId?.trim() || config.provider,
          label: config.displayName?.trim() || config.provider,
          region: 0 as const,
        })),
      ].filter((option, index, all) =>
        all.findIndex((candidate) => candidate.id === option.id) === index,
      )
    : [...PROVIDER_OPTIONS];
  const visibleProviderOptions = (modelDirectory
    ? providerOptions
    : providerOptions.filter((option) =>
        isProviderVisibleInRegion(option.region, isMainland),
      )
  ).sort(compareProviderOptions);
  if (
    !modelDirectory &&
    localConfig.provider.trim() &&
    !visibleProviderOptions.some((option) => option.id === localConfig.provider)
  ) {
    visibleProviderOptions.unshift({
      id: localConfig.provider,
      label: currentProviderLabel || localConfig.provider,
      region: 0,
    });
    visibleProviderOptions.sort(compareProviderOptions);
  }
  if (modelDirectory) {
    visibleProviderOptions.unshift({
      id: CUSTOM_PROVIDER_VALUE,
      displayKey: 'preferences.agent.provider.custom',
      region: 0,
    });
    if (
      localConfig.providerId?.trim() &&
      !isCatalogProvider &&
      !isConfiguredProvider &&
      !visibleProviderOptions.some((option) => option.id === localConfig.provider)
    ) {
      visibleProviderOptions.splice(1, 0, {
        id: localConfig.provider,
        label: currentProviderLabel,
        region: 0,
      });
    }
  }
  const apiKeyBucket = localConfig.providerId?.trim() || localConfig.provider;
  const modelListConfig = modelDirectory && showModelForm
    ? savedConfig ?? localConfig
    : localConfig;
  const configuredRouteConfigs = modelDirectory && configStore.list
    ? providerConfigs
    : modelListConfig
      ? [modelListConfig]
      : [];
  const configuredModels: ConfiguredModelCard[] = modelDirectory
    ? configuredRouteConfigs.flatMap((config) => {
        const models = config.models?.length
          ? config.models
          : config.model.trim()
            ? [{ id: config.model, name: '' }]
            : [];
        return models.map((model) => {
          // A legacy route can contain a model that belongs to a different
          // installed llm-pi-ai catalog provider. Use the catalog
          // as the source of truth for the card preview and construct a
          // route-specific edit draft; otherwise the old bridge metadata
          // makes (for example) GLM appear to be DeepSeek.
          const catalogOwnerId = catalogProviderForConfiguredModel(
            config,
            model.id,
            modelCatalog,
          );
          const catalogOwner = modelCatalog?.providers.find((entry) =>
            entry.provider === catalogOwnerId,
          );
          const legacyMisassigned = !config.providerId?.trim()
            && catalogOwner
            && catalogOwner.provider !== config.provider;
          const cardConfig = legacyMisassigned
            ? {
                ...config,
                provider: catalogOwner.provider,
                providerId: catalogOwner.provider,
                displayName: catalogOwner.displayName ?? catalogOwner.provider,
                apiProtocol: catalogOwner.api ?? config.apiProtocol,
                apiUrl: catalogOwner.baseUrl ?? config.apiUrl,
                model: model.id,
                models: [{ id: model.id, name: model.name ?? '' }],
                apiKeys: {
                  [catalogOwner.provider]: config.apiKeys[config.provider]
                    ?? config.apiKeys[config.providerId ?? '']
                    ?? '',
                },
              }
            : { ...config, model: model.id };
          const providerName = cardConfig.displayName?.trim() || cardConfig.provider;
          return {
            id: model.id,
            name: model.name,
            providerName,
            apiUrl: cardConfig.apiUrl,
            config: cardConfig,
          };
        });
      })
    : [];
  const activeModelId = dshDefaultModel?.key && dshDefaultModel.key !== 'inherit'
    ? dshDefaultModel.key
    : modelListConfig.model;
  const activeProviderId = dshDefaultModel?.key && dshDefaultModel.key !== 'inherit'
    ? dshDefaultModel.providerId
    : modelListConfig.providerId;
  // DeepSeek Harness model management is card-driven: the form is opened by
  // Add/Edit and stays closed while the saved model cards are being browsed.
  // Legacy single-route settings keep their original always-visible form.
  const showGenericModelConfiguration = !modelDirectory || showModelForm || modelFormOnly;
  const modelFieldClass = modelFormOnly ? 'flowix-onboarding__dsh-model-field' : undefined;
  const modelSelectContentClass = cn(
    'flowix-preferences-select-content',
    modelFormOnly && 'z-[230]',
  );

  const renderOperationActions = (includeCancel: boolean) => (
    <div className="flex min-h-[2.25rem] items-center gap-3">
      {includeCancel && (
        <Button variant="outline" onClick={cancelModelForm}>
          {t('common.cancel')}
        </Button>
      )}
      <Button type="button" onClick={() => void handleSave()} disabled={isBusy}>
        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('preferences.agent.save')}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => void handleTest()}
        disabled={isBusy}
      >
        {isTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('preferences.agent.test')}
      </Button>
      <div className="flex items-center gap-1 text-xs" aria-live="polite">
        {isTesting && <span className="text-[var(--muted-foreground)]">{t('preferences.agent.testing')}</span>}
        {isSaving && <span className="text-[var(--muted-foreground)]">{t('preferences.agent.saving')}</span>}
        {!isBusy && isDirty && <span className="text-[var(--muted-foreground)]">{t('preferences.agent.unsaved')}</span>}
      </div>
    </div>
  );

  const renderModelConfiguration = () => (
    <div className="space-y-4">
      {(showCustomProviderForm || showGenericModelConfiguration) && <Field title={t('preferences.agent.provider.title')} className={modelFieldClass}>
        <Select
          value={showCustomProviderForm ? CUSTOM_PROVIDER_VALUE : localConfig.provider}
          onValueChange={updateProvider}
        >
          <SelectTrigger className={modelFormOnly ? 'h-10 w-full' : 'w-[16rem]'}>
            {showCustomProviderForm ? (
              <span className="truncate">{t('preferences.agent.provider.custom')}</span>
            ) : localConfig.provider.trim() ? (
              <span className="flex items-center gap-2 min-w-0">
                <ProviderIcon spec={providerIconSpec(localConfig.provider)} />
                <span className="truncate">{currentProviderLabel}</span>
              </span>
            ) : (
              <span className="truncate text-[var(--muted-foreground)]">
                {t('common.pleaseSelect')}
              </span>
            )}
          </SelectTrigger>
          <SelectContent
            align="start"
            fitViewport
            maxHeight={modelFormOnly ? 240 : undefined}
            className={modelSelectContentClass}
          >
            {visibleProviderOptions.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                <span className="flex items-center gap-2 min-w-0">
                  {opt.id === CUSTOM_PROVIDER_VALUE ? null : (
                    <ProviderIcon spec={providerIconSpec(opt.id)} />
                  )}
                  <span className="truncate">
                    {opt.displayKey
                      ? t(opt.displayKey as Parameters<typeof t>[0])
                      : opt.label ?? opt.id}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>}

      {showCustomProviderForm ? (
        <CustomProviderInlineForm
          draft={customProviderDraft}
          onDraftChange={setCustomProviderDraft}
          onCreate={createCustomProvider}
          onCancel={cancelModelForm}
          isEditing={customProviderFormMode?.kind === 'edit'}
        />
      ) : showGenericModelConfiguration ? (
        <>
          <Field title={t('preferences.agent.modelId.title')} className={modelFieldClass}>
            {modelOptions || dynamicModelOptions ? (
              <Select
                value={localConfig.model}
                onValueChange={(value) => updateField('model', value)}
              >
                <SelectTrigger asChild>
                  <div className="relative">
                    <Input
                      value={localConfig.model}
                      onChange={(e) => updateField('model', e.target.value)}
                      placeholder={modelPlaceholder}
                      className={modelFormOnly ? 'h-10' : FIELD_INPUT_CLASS}
                    />
                  </div>
                </SelectTrigger>
                <SelectContent
                  align="start"
                  fitViewport
                  maxHeight={modelFormOnly ? 240 : undefined}
                  className={modelSelectContentClass}
                >
                  {(modelOptions ?? dynamicModelOptions ?? []).map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={localConfig.model}
                onChange={(e) => updateField('model', e.target.value)}
                placeholder={modelPlaceholder}
                className={modelFormOnly ? 'h-10' : FIELD_INPUT_CLASS}
              />
            )}
            <div className="mt-1 flex min-h-5 items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
              {selectedModel && (
                <span>
                  {selectedModelContextWindow ? `${Math.round(selectedModelContextWindow / 1024)}K context` : ''}
                  {selectedModelMaxTokens ? ` · ${Math.round(selectedModelMaxTokens / 1024)}K output` : ''}
                </span>
              )}
              {modelDirectory && !isCustomProvider && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-5 px-1.5 text-[11px]"
                  onClick={() => void discoverModels()}
                  disabled={modelDiscoveryBusy}
                >
                  {modelDiscoveryBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  {t('preferences.agent.modelId.discover')}
                </Button>
              )}
              {modelDiscoveryError && (
                <span className="truncate text-[var(--destructive)]" title={modelDiscoveryError}>
                  {modelDiscoveryError}
                </span>
              )}
            </div>
          </Field>

          {!hideBaseUrlField && (
            <Field title={t('preferences.agent.baseUrl.title')} className={modelFieldClass}>
              <Input
                value={localConfig.apiUrl}
                onChange={(e) => updateField('apiUrl', e.target.value)}
                placeholder={baseUrlPlaceholder}
                className={modelFormOnly ? 'h-10' : FIELD_INPUT_CLASS}
                disabled={lockBaseUrl}
                readOnly={lockBaseUrl}
              />
            </Field>
          )}

          <Field title={t('preferences.agent.apiKey.title')} description={apiKeyDescription} className={modelFieldClass}>
            <Input
              type="password"
              value={localConfig.apiKeys[apiKeyBucket] ?? ''}
              onChange={(e) => updateApiKey(e.target.value)}
              placeholder={localConfig.credentialConfigured ? '•••••••• (DSH)' : 'sk-...'}
              className={modelFormOnly ? 'h-10' : FIELD_INPUT_CLASS}
            />
          </Field>
        </>
      ) : null}

      {!modelFormOnly && !showCustomProviderForm && showGenericModelConfiguration && renderOperationActions(Boolean(modelDirectory))}
    </div>
  );

  return (
    <>
    <div className={cn('pb-3', !modelFormOnly && 'space-y-2')}>
      {!modelFormOnly && (
        <>
          <SectionHeader
            title={t('preferences.agent.title')}
            className="flex h-8 items-center border-b-0 pb-0"
          />
          <div className="border-b border-[var(--divider)]" />
        </>
      )}

      <div className={cn('space-y-4', modelFormOnly && 'flowix-onboarding__dsh-model-form')}>
        {modelDirectory && modelFormOnly && (
          renderModelConfiguration()
        )}

        {modelDirectory && !modelFormOnly && (
          <ConfiguredModelsList
            models={configuredModels}
            selectedModelId={activeModelId}
            selectedProviderId={activeProviderId}
            editor={showModelForm ? renderModelConfiguration() : null}
            editingModelKey={modelFormMode?.kind === 'edit'
              ? `${modelFormMode.providerId ?? modelListConfig.provider}:${modelFormMode.modelId}`
              : null}
            adding={modelFormMode?.kind === 'add'}
            onAdd={addCustomModel}
            onEdit={editCustomModel}
            onDelete={(model) => void deleteCustomModel(model)}
            busy={modelManagementBusy || isBusy || showModelForm}
          />
        )}

        {/* 1. 供应商 */}
        {!modelDirectory && (showCustomProviderForm || showGenericModelConfiguration) && <Field title={t('preferences.agent.provider.title')}>
          <Select
            value={showCustomProviderForm ? CUSTOM_PROVIDER_VALUE : localConfig.provider}
            onValueChange={updateProvider}
          >
            <SelectTrigger className="w-[16rem]">
              {showCustomProviderForm ? (
                <span className="truncate">{t('preferences.agent.provider.custom')}</span>
              ) : localConfig.provider.trim() ? (
                <span className="flex items-center gap-2 min-w-0">
                  <ProviderIcon spec={providerIconSpec(localConfig.provider)} />
                  <span className="truncate">{currentProviderLabel}</span>
                </span>
              ) : (
                <span className="truncate text-[var(--muted-foreground)]">
                  {t('common.pleaseSelect')}
                </span>
              )}
            </SelectTrigger>
            <SelectContent align="start" fitViewport className="flowix-preferences-select-content">
              {visibleProviderOptions.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  <span className="flex items-center gap-2 min-w-0">
                    {opt.id === CUSTOM_PROVIDER_VALUE ? null : (
                      <ProviderIcon spec={providerIconSpec(opt.id)} />
                    )}
                    <span className="truncate">
                      {opt.displayKey
                        ? t(opt.displayKey as Parameters<typeof t>[0])
                        : opt.label ?? opt.id}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>}

        {!modelDirectory && (showCustomProviderForm ? (
          <CustomProviderInlineForm
            draft={customProviderDraft}
            onDraftChange={setCustomProviderDraft}
            onCreate={createCustomProvider}
            onCancel={() => {
              cancelModelForm();
            }}
            isEditing={customProviderFormMode?.kind === 'edit'}
          />
        ) : showGenericModelConfiguration ? (
          <>

        {/* 2. 模型 ID(原"模型"字段,语义改为 API 调用时的模型标识符)
              有目录时支持自由输入，并提供当前供应商的模型列表提示。 */}
        <Field title={t('preferences.agent.modelId.title')}>
          {modelOptions || dynamicModelOptions ? (
            <Select
              value={localConfig.model}
              onValueChange={(value) => updateField('model', value)}
            >
              <SelectTrigger asChild>
                <div className="relative">
                  <Input
                    value={localConfig.model}
                    onChange={(e) => updateField('model', e.target.value)}
                    placeholder={modelPlaceholder}
                    className={FIELD_INPUT_CLASS}
                  />
                </div>
              </SelectTrigger>
              <SelectContent align="start" fitViewport className="flowix-preferences-select-content">
                {(modelOptions ?? dynamicModelOptions ?? []).map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={localConfig.model}
              onChange={(e) => updateField('model', e.target.value)}
              placeholder={modelPlaceholder}
              className={FIELD_INPUT_CLASS}
            />
          )}
          <div className="mt-1 flex min-h-5 items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
            {selectedModel && (
              <span>
                {selectedModelContextWindow ? `${Math.round(selectedModelContextWindow / 1024)}K context` : ''}
                {selectedModelMaxTokens ? ` · ${Math.round(selectedModelMaxTokens / 1024)}K output` : ''}
              </span>
            )}
            {modelDirectory && !isCustomProvider && (
              <Button
                type="button"
                variant="ghost"
                className="h-5 px-1.5 text-[11px]"
                onClick={() => void discoverModels()}
                disabled={modelDiscoveryBusy}
              >
                {modelDiscoveryBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                {t('preferences.agent.modelId.discover')}
              </Button>
            )}
            {modelDiscoveryError && (
              <span className="truncate text-[var(--destructive)]" title={modelDiscoveryError}>
                {modelDiscoveryError}
              </span>
            )}
          </div>
        </Field>

        {/* 3. Base URL(原"API 地址")。
            Coding-plan 供应商走内置默认，不展示。
            Locked-base-url 供应商（如 DeepSeek）展示字段但禁用编辑，
            值由 `updateProvider` / `loadInitialConfig` 自动写入 PROIVDER_DEFAULTS。
            注: 不渲染 description 副文案 ——
            `optionalDescription` 暗示"留空走默认", 但 DeepSeek 等
            locked 供应商不允许留空; 与其显示容易误解的提示, 不如不显示。 */}
        {hideBaseUrlField ? null : (
          <Field title={t('preferences.agent.baseUrl.title')}>
            <Input
              value={localConfig.apiUrl}
              onChange={(e) => updateField('apiUrl', e.target.value)}
              placeholder={baseUrlPlaceholder}
              className={FIELD_INPUT_CLASS}
              disabled={lockBaseUrl}
              readOnly={lockBaseUrl}
            />
          </Field>
        )}

        {/* 4. 模型密钥(原"API 密钥") */}
        <Field title={t('preferences.agent.apiKey.title')} description={apiKeyDescription}>
          <Input
            type="password"
            value={localConfig.apiKeys[apiKeyBucket] ?? ''}
            onChange={(e) => updateApiKey(e.target.value)}
            placeholder={localConfig.credentialConfigured ? '•••••••• (DSH)' : 'sk-...'}
            className={FIELD_INPUT_CLASS}
          />
        </Field>
          </>
        ) : null)}
      </div>

      {/* 底部操作区: 保存 + 测试 + 进行中/未保存提示,全部从左到右排一行。
          成功/失败通过公共 toast 展示。 */}
      {!modelDirectory && !showCustomProviderForm && showGenericModelConfiguration && renderOperationActions(false)}

    </div>
    </>
  );
}

/** Whether one card's provider has a non-empty API key in its key bucket. */
function hasConfiguredApiKey(card: ConfiguredModelCard): boolean {
  const bucket = card.config.providerId?.trim() || card.config.provider;
  return card.config.credentialConfigured === true
    || (card.config.apiKeys[bucket] ?? '').trim().length > 0;
}

function ConfiguredModelsList({
  models,
  selectedModelId,
  selectedProviderId,
  editor,
  editingModelKey,
  adding,
  onAdd,
  onEdit,
  onDelete,
  busy,
}: {
  models: ConfiguredModelCard[];
  selectedModelId: string;
  selectedProviderId?: string;
  editor: ReactNode | null;
  editingModelKey: string | null;
  adding: boolean;
  onAdd: () => void;
  onEdit: (model: ConfiguredModelCard) => void;
  onDelete: (model: ConfiguredModelCard) => void;
  busy: boolean;
}) {
  const { t } = useI18n();

  return (
    <section className="space-y-3">
      <div className="min-w-0">
        {models.length === 0 && (
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
            {t('preferences.agent.provider.configuredModelsEmpty')}
          </p>
        )}
      </div>

      {models.length > 0 && (
        <div className="space-y-2">
          {models.map((model) => (
            <article
              key={`${model.config.providerId || model.config.provider}:${model.id}`}
              className="rounded-md border border-[var(--divider)] bg-[var(--card)] p-2.5"
            >
              {editingModelKey !== `${model.config.providerId || model.config.provider}:${model.id}` && (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="truncate rounded bg-[var(--muted)] px-1.5 py-0.5 text-[var(--muted-foreground)]" title={model.providerName}>
                        {model.providerName}
                      </span>
                      {model.id === selectedModelId
                        && (model.config.providerId ?? '') === (selectedProviderId ?? '') && (
                        <span className="shrink-0 text-[var(--muted-foreground)]">
                          {t('preferences.agent.provider.configuredModelActive')}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-sm font-semibold leading-[2] text-[var(--foreground)]" title={model.id}>
                      {model.id}
                    </div>
                    <div className="truncate text-xs leading-[1.3] text-[var(--muted-foreground)]" title={model.apiUrl || undefined}>
                      {model.apiUrl || '—'}
                    </div>
                    {hasConfiguredApiKey(model) && (
                      <span
                        className="block truncate text-xl leading-[1.4] text-[var(--foreground)]"
                        role="img"
                        aria-label={t('preferences.agent.provider.configuredModelKeyMask')}
                        title={t('preferences.agent.provider.configuredModelKeyMask')}
                      >
                        {'•••••••••'}
                      </span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t('preferences.agent.provider.configuredModelEdit')}
                    title={t('preferences.agent.provider.configuredModelEdit')}
                    onClick={() => onEdit(model)}
                    disabled={busy}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--destructive)]"
                    aria-label={t('preferences.agent.provider.configuredModelDelete')}
                    title={t('preferences.agent.provider.configuredModelDelete')}
                    onClick={() => {
                      if (window.confirm(t('preferences.agent.provider.configuredModelDeleteConfirm', { model: model.id }))) {
                        onDelete(model);
                      }
                    }}
                    disabled={busy}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              )}
              {editingModelKey === `${model.config.providerId || model.config.provider}:${model.id}` && editor}
            </article>
          ))}
        </div>
      )}

      {adding && editor && (
        <article className="rounded-md border border-[var(--divider)] bg-[var(--card)] p-2.5">
          <div className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">
            {t('preferences.agent.provider.customAddModel')}
          </div>
          {editor}
        </article>
      )}

      <Button type="button" variant="outline" className="h-8" onClick={onAdd} disabled={busy}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {t('preferences.agent.provider.customAddModel')}
      </Button>

    </section>
  );
}

function CustomProviderInlineForm({
  draft,
  onDraftChange,
  onCreate,
  onCancel,
  isEditing,
}: {
  draft: CustomProviderDraft;
  onDraftChange: (draft: CustomProviderDraft) => void;
  onCreate: (draft: CustomProviderDraft) => Promise<string | null>;
  onCancel: () => void;
  isEditing: boolean;
}) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);

  const updateModel = (index: number, field: 'id' | 'name', value: string) => {
    onDraftChange({
      ...draft,
      models: draft.models.map((model, modelIndex) =>
        modelIndex === index ? { ...model, [field]: value } : model,
      ),
    });
  };

  const submit = async () => {
    setSubmitting(true);
    await onCreate(draft);
    setSubmitting(false);
    // `onCreate` commits the provider and closes the editor after it has
    // received the persisted route. Calling onCancel here as well can run
    // before the parent's savedConfig ref has refreshed and restore the old
    // draft, making a successful save look as if it did nothing.
  };

  return (
    <section className="space-y-4">
        <div className="space-y-4">
          <Field
            title={t('preferences.agent.provider.customId')}
          >
            <Input
              value={draft.id}
              onChange={(event) => onDraftChange({ ...draft, id: event.target.value })}
              placeholder="acme-gateway"
              className={FIELD_INPUT_CLASS}
            />
          </Field>
          <Field title={t('preferences.agent.provider.customDisplayName')}>
            <Input
              value={draft.displayName}
              onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })}
              placeholder={t('preferences.agent.provider.customDisplayName')}
              className={FIELD_INPUT_CLASS}
            />
          </Field>
          <Field title={t('preferences.agent.provider.customProtocol')}>
            <Select
              value={draft.apiProtocol}
              onValueChange={(apiProtocol) => onDraftChange({
                ...draft,
                apiProtocol: apiProtocol as CustomProviderDraft['apiProtocol'],
              })}
            >
              <SelectTrigger className="w-full" />
              <SelectContent align="start" fitViewport className="flowix-preferences-select-content">
                {CUSTOM_PROVIDER_PROTOCOLS.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>{protocol}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field title={t('preferences.agent.baseUrl.title')}>
            <Input
              value={draft.apiUrl}
              onChange={(event) => onDraftChange({ ...draft, apiUrl: event.target.value })}
              placeholder="https://gateway.example/v1"
              className={FIELD_INPUT_CLASS}
            />
          </Field>
          <Field title={t('preferences.agent.apiKey.title')}>
            <Input
              type="password"
              value={draft.apiKey}
              onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
              placeholder="sk-..."
              className={FIELD_INPUT_CLASS}
            />
          </Field>

          <div className="border-t border-[var(--divider)] pt-4">
            <div className="mb-3 flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-[var(--foreground)]">
                {t('preferences.agent.provider.customModels')}
              </span>
            </div>
            <div className="space-y-2">
              {draft.models.map((model, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={model.id}
                    onChange={(event) => updateModel(index, 'id', event.target.value)}
                    placeholder={t('preferences.agent.modelId.title')}
                    className={FIELD_INPUT_CLASS}
                  />
                  <Input
                    value={model.name}
                    onChange={(event) => updateModel(index, 'name', event.target.value)}
                    placeholder={t('preferences.agent.provider.customModelName')}
                    className={FIELD_INPUT_CLASS}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--destructive)]"
                    aria-label={t('preferences.agent.provider.customDeleteModel')}
                    disabled={draft.models.length === 1}
                    onClick={() => onDraftChange({
                      ...draft,
                      models: draft.models.filter((_, modelIndex) => modelIndex !== index),
                    })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              onClick={() => onDraftChange({
                ...draft,
                models: [...draft.models, { id: '', name: '' }],
              })}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('preferences.agent.provider.customAddModel')}
            </Button>
          </div>
          <div className="flex justify-start gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={submitting}>
              {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t(isEditing
                ? 'preferences.agent.provider.customSave'
                : 'preferences.agent.provider.customCreate')}
            </Button>
          </div>
        </div>
    </section>
  );
}
