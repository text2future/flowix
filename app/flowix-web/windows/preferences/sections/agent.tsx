'use client';

import { useState, useEffect } from 'react';
import {
  aiConfig,
  listenToUserConfigChanges,
  stopListeningToUserConfigChanges,
  type AgentConfig,
} from '../../../lib/tauri/client';
import { Input } from '../../../components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '../../../components/ui/select';
import { Button } from '../../../components/ui/button';
import { Field, SectionHeader, FIELD_INPUT_CLASS } from './primitives';
import { toast } from '../../../lib/toast';
import { Loader2, Check } from 'lucide-react';

/** Common provider presets shown in the dropdown. The stored value is
 *  still a free-form `string` in `AgentConfig.provider`, so users with a
 *  custom value can still keep it — the trigger just shows whatever
 *  string is in state, and the dropdown highlights whatever preset (if
 *  any) matches. */
const PROVIDER_OPTIONS = ['OpenAI', 'Anthropic', 'DeepSeek', 'OpenAI Compatible', '自定义'] as const;

/** Default values for新 / 未配置场景。加载时与后端返回的 config 浅合并。
 *  字段命名走 camelCase, 与后端 AiModelConfig 的 serde rename_all 对齐 — 否则
 *  保存时 apiKey/apiUrl 会被 serde 静默丢, 刷新即丢失。 */
const DEFAULT_CONFIG: AgentConfig = {
  provider: 'OpenAI Compatible',
  model: 'MiniMax-M3',
  apiUrl: 'https://api.minimaxi.com/v1',
  apiKey: '',
};

export function AgentSection() {
  /** 编辑中的草稿 — 所有 onChange 只更新这里, 不会写盘。 */
  const [localConfig, setLocalConfig] = useState<AgentConfig | null>(null);
  /** 最近一次成功落盘时的快照, 用于判断 dirty。 */
  const [savedConfig, setSavedConfig] = useState<AgentConfig | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  /** 加载阶段出错时记录, 用错误态 UI 替代"加载中..."。 */
  const [loadError, setLoadError] = useState<string | null>(null);

  // 从后端 ~/.flowix/flowix-ai-config.toml 异步加载
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

  const handleSave = async () => {
    if (!localConfig) return;
    setSaveStatus('saving');
    try {
      await aiConfig.set(localConfig);
      setSavedConfig(localConfig);
      setSaveStatus('saved');
      // 1.5s 后回到 idle, 避免一直显示"已保存"
      setTimeout(() => setSaveStatus((s) => (s === 'saved' ? 'idle' : s)), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveStatus('idle');
      // 之前只 console.error, 用户无感知。现在弹 toast + 状态条提示
      toast.error(`保存 AI 模型配置失败: ${msg}`);
      console.error('[AgentSection] Failed to save ai_config:', err);
    }
  };

  const updateField = <K extends keyof AgentConfig>(field: K, value: AgentConfig[K]) => {
    if (!localConfig) return;
    setLocalConfig({ ...localConfig, [field]: value });
  };

  if (loadError) {
    return (
      <div className="space-y-3 pb-6">
        <SectionHeader title="AI 模型配置" />
        <div className="rounded-md border border-[color-mix(in_oklch,var(--destructive)_40%,transparent)] bg-[color-mix(in_oklch,var(--destructive)_10%,transparent)] px-4 py-3 text-sm text-[var(--destructive)]">
          加载配置失败: {loadError}
        </div>
        <div className="text-xs text-[var(--muted-foreground)]">
          重新打开偏好设置窗口或重启应用后重试。已保存的 apiKey 等信息仍在磁盘上, 不会丢失。
        </div>
      </div>
    );
  }

  if (!localConfig) {
    return <div className="text-sm text-[var(--muted-foreground)]">加载中...</div>;
  }

  return (
    <div className="space-y-6 pb-6">
      <SectionHeader
        title="AI 模型配置"
      />

      <div className="space-y-4">
        {/* 1. 供应商 */}
        <Field title="供应商">
          <Select
            value={localConfig.provider}
            onValueChange={(value) => updateField('provider', value)}
          >
            <SelectTrigger className="w-48" />
            <SelectContent align="start">
              {PROVIDER_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* 2. 模型 ID(原"模型"字段,语义改为 API 调用时的模型标识符) */}
        <Field title="模型 ID">
          <Input
            value={localConfig.model}
            onChange={(e) => updateField('model', e.target.value)}
            placeholder="如 gpt-4o-mini、claude-3-sonnet、MiniMax-M3"
            className={FIELD_INPUT_CLASS}
          />
        </Field>

        {/* 3. Base URL(原"API 地址") */}
        <Field title="Base URL">
          <Input
            value={localConfig.apiUrl}
            onChange={(e) => updateField('apiUrl', e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={FIELD_INPUT_CLASS}
          />
        </Field>

        {/* 4. 模型密钥(原"API 密钥") */}
        <Field title="模型密钥" description="仅保存在本地,不会上传至第三方">
          <Input
            type="password"
            value={localConfig.apiKey}
            onChange={(e) => updateField('apiKey', e.target.value)}
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
              保存中…
            </>
          ) : (
            '保存'
          )}
        </Button>
        {saveStatus === 'saved' && (
          <span className="flex items-center gap-1 text-xs text-[var(--success)]">
            <Check className="w-3.5 h-3.5" />
            已保存
          </span>
        )}
        {isDirty && saveStatus === 'idle' && (
          <span className="text-xs text-[var(--muted-foreground)]">有未保存的修改</span>
        )}
      </div>
    </div>
  );
}
