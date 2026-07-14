'use client';

import { useEffect, useRef, useState } from 'react';
import {
  aiConfig,
  listenToUserConfigChanges,
  stopListeningToUserConfigChanges,
  type AgentConfig,
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
import { Loader2, Check, XCircle } from 'lucide-react';
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
 *  锁死为官方 endpoint (`https://api.deepseek.com/chat/completions`)。
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
  Ollama: { model: 'qwen3.6', apiUrl: 'http://localhost:11434' },
  DeepSeek: { model: 'deepseek-v4-pro', apiUrl: 'https://api.deepseek.com/chat/completions' },
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
  DeepSeek: 'https://api.deepseek.com/chat/completions',
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

/** Base URL 被后端锁死的供应商 ——
 *  字段仍然展示（让用户看到实际请求地址），但禁用编辑。
 *  `defaults.apiUrl` 在 provider 切换时会被 `updateProvider` 自动写入，
 *  并在初次 load 时被 `loadInitialConfig` 兜底注入，所以用户不会看到空值。 */
function isLockedBaseUrlProvider(provider: string): boolean {
  return (LOCKED_BASE_URL_PROVIDER_IDS as readonly string[]).includes(provider);
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
  // 老 toml 里可能存的是裸 `OpenAI` / `OpenAI Compatible` 字串 ── 跟
  // `LEGACY_PROVIDER_LABEL_KEYS` / `PROVIDER_BASE_URL_HINTS` 对齐。
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
	// 不全删), 只是下拉里不展示, 防止误选。
	const isMainland = useRegionStore((s) => s.region === 'mainland');
  /** 编辑中的草稿 — 所有 onChange 只更新这里, 不会写盘。 */
  const [localConfig, setLocalConfig] = useState<AgentConfig | null>(null);
  /** 最近一次成功落盘时的快照, 用于判断 dirty。 */
  const [savedConfig, setSavedConfig] = useState<AgentConfig | null>(null);
  /** Save button state machine. Adds `testing` (probe before write) and
   *  `testFailed` (probe rejected, didn't write) on top of the original
   *  idle / saving / saved. */
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'testing' | 'saving' | 'saved' | 'testFailed'
  >('idle');
  /** Independent "Test connection" button state machine. Shares
   *  `lastTestResult` with the save flow so the user always sees a
   *  consistent picture: if Save just probed successfully, the test
   *  button reflects the same green checkmark. */
  const [testStatus, setTestStatus] = useState<
    'idle' | 'testing' | 'success' | 'failed'
  >('idle');
  const [lastTestResult, setLastTestResult] = useState<TestConnectionResult | null>(
    null,
  );
  /** Snapshot of the form at the moment of the last successful probe.
   *  Used to skip re-probing on Save when the user hasn't touched the
   *  form since the last green test. Compared via `JSON.stringify` —
   *  same trick used for `isDirty` (form is small, perf irrelevant). */
  const [lastTestedSnapshot, setLastTestedSnapshot] = useState<string | null>(null);
  /** 加载阶段出错时记录, 用错误态 UI 替代"加载中..."。 */
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // 从后端 ~/.flowix/agent-config.toml 异步加载
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await aiConfig.get();
        if (!cancelled) {
          const merged = { ...DEFAULT_CONFIG, ...cfg.model };
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
          setLocalConfig(merged);
          setSavedConfig(merged);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) return;
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
  //
  // 一次性订阅(空 dep 数组)— 通过 ref 拿最新的 localConfig / savedConfig,
  // 否则每次键入都会重订阅 IPC 通道。原有实现把这两个 state 写进 dep
  // 数组,导致 setup/cleanup 在每个键入周期都跑一次,理论上 Tauri 端
  // unlisten→listen 的微秒窗口可能丢事件。
  useEffect(() => {
    let cancelled = false;
    void listenToUserConfigChanges(async (kind) => {
      if (kind !== "ai_config" || cancelled) return;
      // dirty 状态下不抢用户的编辑, 只在下一次挂载 / 用户主动离开时再刷新
      const local = localConfigRef.current;
      const saved = savedConfigRef.current;
      const stillDirty =
        local !== null &&
        saved !== null &&
        JSON.stringify(local) !== JSON.stringify(saved);
      if (stillDirty) return;
      try {
        const cfg = await aiConfig.get();
        if (cancelled) return;
        const merged = { ...DEFAULT_CONFIG, ...cfg.model };
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
        setSaveStatus("idle");
      } catch (err) {
        console.error("[AgentSection] Failed to reload ai_config:", err);
      }
    });
    return () => {
      cancelled = true;
      stopListeningToUserConfigChanges();
    };
  }, []);

  // 用深比较判断是否有未保存修改 — 配置只有 7 个简单字段, JSON.stringify 性能可接受
  const isDirty =
    localConfig !== null &&
    savedConfig !== null &&
    JSON.stringify(localConfig) !== JSON.stringify(savedConfig);
  /** Either side is mid-flight (probing or saving) → disable *both*
   *  buttons to prevent concurrent in-flight probes / writes. */
  const isBusy =
    saveStatus === 'testing' ||
    saveStatus === 'saving' ||
    testStatus === 'testing';

  /**
   * Coalesce all op-state machine values into a single priority-ranked
   * status. The bottom action area renders one inline message based on
   * this — so the user only ever sees *one* status at a time, never a
   * split "saved" + "failed" across two zones.
   *
   * Priority (high → low):
   *   testing — probe in flight (save-triggered or standalone)
   *   saving  — write in flight
   *   failed  — last probe rejected (covers `saveStatus='testFailed'`
   *             and `testStatus='failed'`; both end up showing the same
   *             inline error)
   *   idle    — everything else. The inline area shows the most recent
   *             persisted result based on `lastTestResult` (success /
   *             failed) or `isDirty` (unsaved hint). This keeps the
   *             success / failure notes visible until the user types
   *             something — no flicker from auto-clearing timers.
   */
  type OpStatus = 'testing' | 'saving' | 'failed' | 'idle';
  const opStatus: OpStatus = (() => {
    if (saveStatus === 'testing' || testStatus === 'testing') return 'testing';
    if (saveStatus === 'saving') return 'saving';
    if (saveStatus === 'testFailed' || testStatus === 'failed') return 'failed';
    return 'idle';
  })();
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

    // 1. Local pre-flight: catches the obvious mistakes (missing key,
    //    bad URL scheme, empty provider/model) without a network round-trip.
    //
    //    Errors surface in the inline status area only — no toast.
    //    We funnel the local message through the same `lastTestResult`
    //    channel as remote failures, so the renderer only needs one
    //    rendering path.
    const localErr = validateBeforeSave(localConfig, t);
    if (localErr) {
      setLastTestResult({
        ok: false,
        latencyMs: 0,
        modelId: localConfig.model,
        summary: '',
        error: { kind: 'bad_config', message: localErr },
      });
      setSaveStatus('testFailed');
      setTestStatus('failed');
      return;
    }

    // 2. Connectivity probe — skip when the form hasn't changed since
    //    the last successful test (user clicked Test then immediately
    //    clicked Save, no edits in between).
    const snapshot = JSON.stringify(localConfig);
    const skipProbe = testStatus === 'success' && lastTestedSnapshot === snapshot;
    let probe = lastTestResult;
    if (!skipProbe) {
      setSaveStatus('testing');
      const probed = await runProbe(localConfig, snapshot);
      // `runProbe` returns null only when the IPC itself threw (network
      // to the Tauri host, command missing, ...). `testStatus` is already
      // in `failed` and the inline area reflects the error. Reset
      // saveStatus so the Save button isn't permanently stuck at "Testing…".
      if (!probed) {
        setSaveStatus('idle');
        return;
      }
      probe = probed;
      if (!probe.ok) {
        setSaveStatus('testFailed');
        // Inline area already shows `formatErrorKind`; no toast.
        return;
      }
    }

    // 3. Probe passed (or skipped) — commit.
    setSaveStatus('saving');
    try {
      await aiConfig.set(localConfig);
      setSavedConfig(localConfig);
      void refreshFlowixRuntime();
      // If the user typed during the in-flight save, the form has moved
      // past `snapshot` — the saved-on-disk state no longer matches the
      // form, so we skip the "saved" celebration and go straight to
      // `idle` (which will then show the unsaved hint).
      const stillClean = snapshot === JSON.stringify(localConfigRef.current);
      if (stillClean) {
        setSaveStatus('saved');
        // No auto-clear: stays visible until the next operation.
      } else {
        setSaveStatus('idle');
        setTestStatus('idle');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus('idle');
      // 同步清 testStatus,避免 skip 路径进去后 testStatus='success' 残留
      // 误导(上一次测试通过了,但这次保存本身失败了)
      setTestStatus('idle');
      // Funnel the IPC write error through the same inline channel.
      setLastTestResult({
        ok: false,
        latencyMs: 0,
        modelId: localConfig.model,
        summary: '',
        error: { kind: 'other', message: msg },
      });
      console.error('[AgentSection] Failed to save ai_config:', err);
    }
  };

  const handleTest = async () => {
    if (!localConfig) return;
    setTestStatus('testing');
    await runProbe(localConfig, JSON.stringify(localConfig));
    // runProbe already updates testStatus / lastTestResult; nothing else
    // to do here. We keep the test status visible until the user changes
    // the form (which `updateField` / `updateProvider` doesn't clear
    // automatically — see "stale result" caveat in the section comments).
  };

  /**
   * Shared probe entry point. Updates both `testStatus` and the shared
   * `lastTestResult` / `lastTestedSnapshot` so callers (Test button, Save
   * button) paint a consistent picture.
   *
   * Returns the result on success, or `null` when the IPC itself threw
   * (in which case `testStatus` is left in `failed` and a toast was fired).
   *
   * **Stale-result guard**: if the form changed *between* the call into
   * `runProbe` and the probe resolving, we drop the result. Without this,
   * the user could see a green "Success (230ms)" badge attached to a form
   * that's no longer the one we just verified — and worse, `skipProbe` on
   * the next Save would trust the stale snapshot.
   */
  const runProbe = async (
    cfg: AgentConfig,
    snapshot: string,
  ): Promise<TestConnectionResult | null> => {
    try {
      const result = await aiConfig.testConnection(cfg);
      // 表单在 probe in-flight 期间被改 → 丢掉这条 stale 结果
      if (snapshot !== JSON.stringify(localConfigRef.current)) {
        return null;
      }
      setLastTestResult(result);
      setLastTestedSnapshot(snapshot);
      if (result.ok) {
        setTestStatus('success');
        // No auto-clear: the success badge should stay visible until the
        // user types something (which clears `testStatus` via the
        // `updateField` / `updateProvider` / `updateApiKey` helpers) or
        // performs another operation. A 3s timer used to flicker the
        // badge away while the user was still reading the latency.
      } else {
        setTestStatus('failed');
      }
      return result;
    } catch (err) {
      // The IPC always returns TestConnectionResult-shaped data; we only
      // land here when the command itself threw (network to the Tauri
      // host, JSON parse, command missing, ...). Wrap as `Other` and
      // surface through the inline channel — no toast.
      const message = err instanceof Error ? err.message : String(err);
      const fallback: TestConnectionResult = {
        ok: false,
        latencyMs: 0,
        modelId: cfg.model,
        summary: '',
        error: { kind: 'other', message },
      };
      setLastTestResult(fallback);
      setTestStatus('failed');
      console.error('[AgentSection] test_ai_connection IPC threw:', err);
      return null;
    }
  };

  const updateField = <K extends keyof AgentConfig>(field: K, value: AgentConfig[K]) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, [field]: value });
    // Any form edit invalidates the "last tested" green checkmark —
    // otherwise the user could think the current form is still verified.
    setTestStatus((s) => (s === 'testing' ? s : 'idle'));
  };

  const updateProvider = (provider: string) => {
    if (!localConfig) return;
    const defaults = providerDefaults(provider);
    setLocalConfig({
      ...localConfig,
      provider,
      ...(defaults ?? {}),
    });
    setTestStatus((s) => (s === 'testing' ? s : 'idle'));
  };

  /** API key change goes through its own helper because the apiKey input
   *  stores into `apiKeys[provider]` (per-provider bucket) rather than a
   *  top-level field, and — crucially — the inline onChange bypasses
   *  `updateField`. Without this helper, a successful test followed by an
   *  apiKey edit would still show "Success (230ms)" even though the
   *  auth-critical field has changed. */
  const updateApiKey = (value: string) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      apiKeys: { ...localConfig.apiKeys, [localConfig.provider]: value },
    });
    setTestStatus((s) => (s === 'testing' ? s : 'idle'));
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
    const keyRequired =
      cfg.provider !== 'Ollama' && cfg.provider !== 'OpenAI Compatible';
    if (keyRequired && (cfg.apiKeys[cfg.provider] ?? '').trim() === '') {
      return translate('preferences.agent.error.noApiKey');
    }
    const url = cfg.apiUrl.trim();
    if (url && !/^https?:\/\//.test(url)) {
      return translate('preferences.agent.error.badUrl');
    }
    const urlRequired =
      cfg.provider === 'Ollama' || cfg.provider === 'OpenAI Compatible';
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
    return <div className="text-sm text-[var(--muted-foreground)]">{t('preferences.agent.loading')}</div>;
  }

  const defaults = providerDefaults(localConfig.provider);
  const modelOptions = providerModelOptions(localConfig.provider);
  const modelPlaceholder = defaults?.model ?? t('preferences.agent.modelId.placeholder');
  const baseUrlPlaceholder = providerBaseUrlHint(localConfig.provider) ?? 'Provider default';
  const hideBaseUrlField = isCodingPlanProvider(localConfig.provider);
  const lockBaseUrl = isLockedBaseUrlProvider(localConfig.provider);
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
            value={localConfig.apiKeys[localConfig.provider] ?? ''}
            onChange={(e) => updateApiKey(e.target.value)}
            placeholder="sk-..."
            className={FIELD_INPUT_CLASS}
          />
        </Field>
      </div>

      {/* 底部操作区: 保存 + 测试 + 合并提示区,全部从左到右排一行。
          提示区按 `opStatus` 优先级显示唯一一个状态 — 不再分两块,
          不再 toast,错误只在提示区出现一次。 */}
      <div className="flex items-center gap-3 min-h-[2.25rem]">
        <Button
          onClick={handleSave}
          disabled={!isDirty || isBusy}
        >
          {opStatus === 'saving' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            t('preferences.agent.save')
          )}
        </Button>
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testStatus === 'testing' || isBusy}
        >
          {opStatus === 'testing' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            t('preferences.agent.test')
          )}
        </Button>

        {/* 合并的提示区 — 一次只显示一个状态,无 toast */}
        <div className="flex items-center gap-1 text-xs">
          {opStatus === 'testing' && (
            <span className="text-[var(--muted-foreground)]">
              {t('preferences.agent.testing')}
            </span>
          )}
          {opStatus === 'saving' && (
            <span className="text-[var(--muted-foreground)]">
              {t('preferences.agent.saving')}
            </span>
          )}
          {opStatus === 'failed' && lastTestResult?.error && (
            <span
              className="flex items-center gap-1 text-[var(--destructive)]"
              title={lastTestResult.error.message}
            >
              <XCircle className="w-3.5 h-3.5" />
              {formatErrorKind(lastTestResult.error.kind, t)}
            </span>
          )}
          {opStatus === 'idle' && isDirty && (
            <span className="text-[var(--muted-foreground)]">
              {t('preferences.agent.unsaved')}
            </span>
          )}
          {opStatus === 'idle' && !isDirty && lastTestResult?.ok && (
            <span
              className="flex items-center gap-1 text-[var(--success)]"
              title={lastTestResult.summary || undefined}
            >
              <Check className="w-3.5 h-3.5" />
              {t('preferences.agent.testSuccess', {
                ms: lastTestResult.latencyMs,
              })}
            </span>
          )}
          {opStatus === 'idle' && !isDirty && lastTestResult?.error && (
            <span
              className="flex items-center gap-1 text-[var(--destructive)]"
              title={lastTestResult.error.message}
            >
              <XCircle className="w-3.5 h-3.5" />
              {formatErrorKind(lastTestResult.error.kind, t)}
            </span>
          )}
        </div>
      </div>

    </div>
  );
}
