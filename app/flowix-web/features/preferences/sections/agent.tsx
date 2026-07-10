'use client';

import { useState, useEffect } from 'react';
import {
  aiConfig,
  listenToUserConfigChanges,
  stopListeningToUserConfigChanges,
  type AgentConfig,
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
import { toast } from '@/lib/toast';
import { Loader2, Check } from 'lucide-react';
import { useI18n } from '@features/i18n';
import { useRegionStore } from '@features/i18n';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import iconMinimax from '@/assets/icon-minimax.svg';
import iconGlm from '@/assets/icon-glm.svg';
import iconOpenai from '@/assets/icon-openai.svg';
import iconClaude from '@/assets/icon-claude.svg';
import iconGemini from '@/assets/icon-gemini.svg';
import iconDeepseek from '@/assets/icon-deepseek.svg';
import iconOpenrouter from '@/assets/icon-openrouter.svg';
import iconOllama from '@/assets/icon-ollama.svg';

/** Common provider presets shown in the dropdown. The stored value is
 *  still a free-form `string` in `AgentConfig.provider`, so users with a
 *  custom value can still keep it — the trigger just shows whatever
 *  string is in state, and the dropdown highlights whatever preset (if
 *  any) matches.
 *
 *  Coding-plan providers (MiniMax / GLM) 钉在下拉顶部，按规格把 Base URL
 *  锁死成官方地址，模型走 `PROVIDER_MODEL_OPTIONS` 内的固定选项。
 *
 *  id 是写入磁盘的真值（保持兼容老 config 文件），displayKey 是当前语言
 *  展示文案。
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
    apiUrl: 'https://api.minimaxi.com/v1/',
  },
  'GLM Coding Plan': {
    model: PROVIDER_MODEL_OPTIONS['GLM Coding Plan'][0],
    apiUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  'OpenAI Responses API': { model: 'gpt-5.5', apiUrl: '' },
  'OpenAI Chat Completions': { model: 'gpt-5.5', apiUrl: 'https://api.openai.com/v1' },
  Anthropic: { model: 'claude-opus-4-8', apiUrl: '' },
  Gemini: { model: 'gemini-3.1-pro-preview', apiUrl: '' },
  Ollama: { model: 'qwen3.6', apiUrl: '' },
  DeepSeek: { model: 'deepseek-v4-pro', apiUrl: '' },
  OpenRouter: { model: 'openai/gpt-5.5', apiUrl: '' },
  OpenAI: { model: 'gpt-5.5', apiUrl: '' },
  'OpenAI Compatible': { model: 'gpt-5.5', apiUrl: 'https://api.openai.com/v1' },
};

const PROVIDER_BASE_URL_HINTS: Record<string, string> = {
  'MiniMax Coding Plan': 'https://api.minimaxi.com/v1/',
  'GLM Coding Plan': 'https://open.bigmodel.cn/api/coding/paas/v4',
  'OpenAI Responses API': 'https://api.openai.com/v1',
  'OpenAI Chat Completions': 'https://api.openai.com/v1',
  OpenAI: 'https://api.openai.com/v1',
  Anthropic: 'https://api.anthropic.com/v1',
  Gemini: 'https://generativelanguage.googleapis.com',
  Ollama: 'http://localhost:11434',
  DeepSeek: 'https://api.deepseek.com/v1',
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

/** Coding-plan 供应商：Base URL 走内置默认，前端不展示该字段。 */
function isCodingPlanProvider(provider: string): boolean {
  return (CODING_PLAN_PROVIDER_IDS as readonly string[]).includes(provider);
}

/** provider 是否在当前地区可见 — 0 永远显示, 1 仅 mainland, 2 仅 overseas。 */
function isProviderVisibleInRegion(
  region: ProviderRegion,
  isMainland: boolean,
): boolean {
  if (region === 0) return true;
  // region=1 wantsMainland, region=2 wantsOverseas, 两者对 isMainland 取等
  return (region === 1) === isMainland;
}

/** Provider dropdown item 左侧的 icon 规格。
 *  - icon: 真 SVG 的 url（Vite 静态资源 import 返回值）
 *  - letter + color: 没有 SVG 时用品牌色背景 + 首字母占位，后续可直接替换为真 svg
 *
 *  真实 SVG 之后补全：把对应 `import iconXxx from '@/assets/icon-xxx.svg'` 加到
 *  顶部、写入 `icon: iconXxx` 即可，无需动其他位置。 */
interface ProviderIconSpec {
  icon: string | null;
  letter: string;
  color: string;
}

const PROVIDER_ICONS: Record<string, ProviderIconSpec> = {
  'MiniMax Coding Plan': { icon: iconMinimax, letter: 'M', color: '#E73562' },
  'GLM Coding Plan': { icon: iconGlm, letter: 'G', color: '#3762FF' },
  'OpenAI Responses API': { icon: iconOpenai, letter: 'O', color: '#10A37F' },
  'OpenAI Chat Completions': { icon: iconOpenai, letter: 'O', color: '#10A37F' },
  // 兼容老 toml 里存的是裸 `OpenAI` / `OpenAI Compatible` 字串 ── 跟
  // `LEGACY_PROVIDER_LABEL_KEYS` / `PROVIDER_BASE_URL_HINTS` 对齐, 不然
  // 老用户首屏回退到默认灰色字母占位。
  OpenAI: { icon: iconOpenai, letter: 'O', color: '#10A37F' },
  'OpenAI Compatible': { icon: iconOpenai, letter: 'O', color: '#10A37F' },
  Anthropic: { icon: iconClaude, letter: 'A', color: '#D97757' },
  Gemini: { icon: iconGemini, letter: 'G', color: '#4285F4' },
  Ollama: { icon: iconOllama, letter: 'O', color: '#000000' },
  DeepSeek: { icon: iconDeepseek, letter: 'D', color: '#1A4FFF' },
  OpenRouter: { icon: iconOpenrouter, letter: 'R', color: '#6066F1' },
};

function providerIconSpec(provider: string): ProviderIconSpec {
  return (
    PROVIDER_ICONS[provider] ?? {
      icon: null,
      letter: provider.charAt(0).toUpperCase() || '?',
      color: '#6B7280',
    }
  );
}

function ProviderIcon({ spec }: { spec: ProviderIconSpec }) {
  if (spec.icon) {
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
  return (
    <span
      aria-hidden
      className="h-4 w-4 shrink-0 rounded-[4px] text-[10px] font-semibold leading-4 text-white text-center select-none"
      style={{ backgroundColor: spec.color }}
    >
      {spec.letter}
    </span>
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
};

export function AgentSection() {
	const { t } = useI18n();
	const refreshFlowixRuntime = useAgentRuntimeStore((s) => s.refreshFlowix);
	// Provider 可见性: 按 PROVIDER_OPTIONS[*].region 字段过滤。
	// region=1 的 (MiniMax/GLM) 大陆用户能看到, 海外看不到。
	// 海外用户配置文件里如果还有 region=1 的 provider 值, 仍能正常使用
	// (PROVIDER_DEFAULTS / PROVIDER_MODEL_OPTIONS / PROVIDER_BASE_URL_HINTS
	// 故意不全删, 兼容老 config), 只是下拉里不展示, 防止误选。
	const isMainland = useRegionStore((s) => s.region === 'mainland');
  /** 编辑中的草稿 — 所有 onChange 只更新这里, 不会写盘。 */
  const [localConfig, setLocalConfig] = useState<AgentConfig | null>(null);
  /** 最近一次成功落盘时的快照, 用于判断 dirty。 */
  const [savedConfig, setSavedConfig] = useState<AgentConfig | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  /** 加载阶段出错时记录, 用错误态 UI 替代"加载中..."。 */
  const [loadError, setLoadError] = useState<string | null>(null);

  // 从后端 ~/.flowix/agent-config.toml 异步加载
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await aiConfig.get();
        if (!cancelled) {
          const merged = { ...DEFAULT_CONFIG, ...cfg.model };
          setLocalConfig(merged);
          setSavedConfig(merged);
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
  }, []);

  // 跨窗口同步: 其它来源 (如未来的导入 / 命令行 / 第二个偏好窗口) 改了
  // ai_config 时, 重新从磁盘拉取。
  // 关键: 用户当前有未保存改动 (isDirty) 时不要覆盖, 避免静默丢编辑。
  useEffect(() => {
    let cancelled = false;
    void listenToUserConfigChanges(async (kind) => {
      if (kind !== "ai_config" || cancelled) return;
      // dirty 状态下不抢用户的编辑, 只在下一次挂载 / 用户主动离开时再刷新
      const stillDirty =
        localConfig !== null &&
        savedConfig !== null &&
        JSON.stringify(localConfig) !== JSON.stringify(savedConfig);
      if (stillDirty) return;
      try {
        const cfg = await aiConfig.get();
        if (cancelled) return;
        const merged = { ...DEFAULT_CONFIG, ...cfg.model };
        setLocalConfig(merged);
        setSavedConfig(merged);
        setSaveStatus("idle");
      } catch (err) {
        console.error("[AgentSection] Failed to reload ai_config:", err);
      }
    });
    return () => {
      cancelled = true;
      stopListeningToUserConfigChanges();
    };
  }, [localConfig, savedConfig]);

  // 用深比较判断是否有未保存修改 — 配置只有 7 个简单字段, JSON.stringify 性能可接受
  const isDirty =
    localConfig !== null &&
    savedConfig !== null &&
    JSON.stringify(localConfig) !== JSON.stringify(savedConfig);
  const currentProviderLabel = (() => {
    const provider = localConfig?.provider;
    if (!provider) return '';
    const preset = PROVIDER_OPTIONS.find((opt) => opt.id === provider);
    const legacyKey = LEGACY_PROVIDER_LABEL_KEYS[provider];
    if (preset) return t(preset.displayKey as Parameters<typeof t>[0]);
    if (legacyKey) return t(legacyKey as Parameters<typeof t>[0]);
    return provider;
  })();

  const handleSave = async () => {
    if (!localConfig) return;
    setSaveStatus('saving');
    try {
      await aiConfig.set(localConfig);
      setSavedConfig(localConfig);
      setSaveStatus('saved');
      void refreshFlowixRuntime();
      // 1.5s 后回到 idle, 避免一直显示"已保存"
      setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus('idle');
      // 之前只 console.error, 用户无感知。现在弹 toast + 状态条提示
      toast.error(`${t('preferences.agent.saveFailed')}: ${msg}`);
      console.error('[AgentSection] Failed to save ai_config:', err);
    }
  };

  const updateField = <K extends keyof AgentConfig>(field: K, value: AgentConfig[K]) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, [field]: value });
  };

  const updateProvider = (provider: string) => {
    if (!localConfig) return;
    const defaults = providerDefaults(provider);
    setLocalConfig({
      ...localConfig,
      provider,
      ...(defaults ?? {}),
    });
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
    return <div className="text-sm text-[var(--muted-foreground)]">{t('preferences.agent.loading')}</div>;
  }

  const defaults = providerDefaults(localConfig.provider);
  const modelOptions = providerModelOptions(localConfig.provider);
  const modelPlaceholder = defaults?.model ?? t('preferences.agent.modelId.placeholder');
  const baseUrlPlaceholder = providerBaseUrlHint(localConfig.provider) ?? 'Provider default';
  const hideBaseUrlField = isCodingPlanProvider(localConfig.provider);
  const usesNativeDefaultBaseUrl =
    defaults !== undefined &&
    localConfig.provider !== 'OpenAI Chat Completions' &&
    localConfig.provider !== 'OpenAI Compatible';
  const baseUrlDescription = usesNativeDefaultBaseUrl
    ? t('preferences.agent.baseUrl.optionalDescription')
    : t('preferences.agent.baseUrl.requiredDescription');
  const apiKeyDescription =
    localConfig.provider === 'Ollama'
      ? t('preferences.agent.apiKey.optionalDescription')
      : t('preferences.agent.apiKey.description');

  return (
    <div className="space-y-3 pb-3">
      <SectionHeader
        title={t('preferences.agent.title')}
        size="compact"
      />

      <div className="space-y-4">
        {/* 1. 供应商 */}
        <Field title={t('preferences.agent.provider.title')}>
          <Select
            value={localConfig.provider}
            onValueChange={updateProvider}
          >
            <SelectTrigger className="w-[16rem]">
              <span className="flex items-center gap-2 min-w-0">
                <ProviderIcon spec={providerIconSpec(localConfig.provider)} />
                <span className="truncate">{currentProviderLabel}</span>
              </span>
            </SelectTrigger>
            <SelectContent align="start">
              {PROVIDER_OPTIONS.filter((opt) =>
                isProviderVisibleInRegion(opt.region, isMainland),
              ).map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  <span className="flex items-center gap-2 min-w-0">
                    <ProviderIcon spec={providerIconSpec(opt.id)} />
                    <span className="truncate">
                      {t(opt.displayKey as Parameters<typeof t>[0])}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* 2. 模型 ID(原"模型"字段,语义改为 API 调用时的模型标识符)
              Coding-plan 供应商走固定选项的 Select，其它供应商保持自由文本。 */}
        <Field title={t('preferences.agent.modelId.title')}>
          {modelOptions ? (
            <Select
              value={localConfig.model}
              onValueChange={(value) => updateField('model', value)}
            >
              <SelectTrigger className={FIELD_INPUT_CLASS}>
                <span>{localConfig.model}</span>
              </SelectTrigger>
              <SelectContent align="start">
                {modelOptions.map((model) => (
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
        </Field>

        {/* 3. Base URL(原"API 地址")。Coding-plan 供应商走内置默认，不展示。 */}
        {hideBaseUrlField ? null : (
          <Field title={t('preferences.agent.baseUrl.title')} description={baseUrlDescription}>
            <Input
              value={localConfig.apiUrl}
              onChange={(e) => updateField('apiUrl', e.target.value)}
              placeholder={baseUrlPlaceholder}
              className={FIELD_INPUT_CLASS}
            />
          </Field>
        )}

        {/* 4. 模型密钥(原"API 密钥") */}
        <Field title={t('preferences.agent.apiKey.title')} description={apiKeyDescription}>
          <Input
            type="password"
            value={localConfig.apiKeys[localConfig.provider] ?? ''}
            onChange={(e) =>
              setLocalConfig((prev) =>
                prev
                  ? {
                      ...prev,
                      apiKeys: {
                        ...prev.apiKeys,
                        [prev.provider]: e.target.value,
                      },
                    }
                  : prev,
              )
            }
            placeholder="sk-..."
            className={FIELD_INPUT_CLASS}
          />
        </Field>
      </div>

      {/* 底部保存区: 仅在点击时落盘, 不做自动保存。
          按钮在无改动 / 保存中时禁用, 旁边显示状态文字反馈。 */}
      <div className="flex justify-start items-center gap-3 min-h-[2.25rem]">
        <Button
          onClick={handleSave}
          disabled={!isDirty || saveStatus === 'saving'}
        >
          {saveStatus === 'saving' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              {t('preferences.agent.saving')}
            </>
          ) : (
            t('preferences.agent.save')
          )}
        </Button>
        {saveStatus === 'saved' && (
          <span className="flex items-center gap-1 text-xs text-[var(--success)]">
            <Check className="w-3.5 h-3.5" />
            {t('preferences.agent.saved')}
          </span>
        )}
        {isDirty && saveStatus === 'idle' && (
          <span className="text-xs text-[var(--muted-foreground)]">{t('preferences.agent.unsaved')}</span>
        )}
      </div>

    </div>
  );
}
