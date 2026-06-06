'use client';

import { Check, MonitorSmartphone } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { DEFAULT_USER_SETTINGS, THEME_OPTIONS, type ThemeId } from '../../../constants';
import { cn } from '../../../lib/utils';
import { SectionHeader, FIELD_TITLE_CLASS, FIELD_DESC_CLASS } from './primitives';

interface ThemeSectionProps {
  settings: { theme: ThemeId };
  updateSettings: (updates: Partial<{ theme: ThemeId }>) => Promise<void>;
}

/**
 * 主题预览卡片。点击即应用; 当前激活卡片有强边框 + 右上角对勾。
 * 预览区根据主题画一个迷你窗口 (标题栏 + 内容区 + 主色按钮),
 * 让用户在不切换的情况下也能直观感受主题氛围。
 */
function ThemeCard({
  option,
  active,
  onSelect,
}: {
  option: typeof THEME_OPTIONS[number];
  active: boolean;
  onSelect: () => void;
}) {
  const { preview, id, label, description } = option;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full rounded-xl border bg-[var(--card)] p-3 text-left transition-all',
        'hover:border-[var(--primary)]/60 hover:shadow-sm',
        active
          ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/30'
          : 'border-[var(--border)]'
      )}
    >
      {/* Selected check */}
      {active && (
        <span className="absolute top-2 right-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]">
          <Check className="h-3 w-3" />
        </span>
      )}

      {/* Preview mock window */}
      <div
        className="relative h-24 w-full overflow-hidden rounded-lg border"
        style={{
          background: preview.background,
          borderColor: preview.accent,
        }}
      >
        {id === 'system' ? (
          // 「跟随系统」用左浅右深的对角分割图直观示意
          <>
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(135deg, #ffffff 0%, #ffffff 50%, #0e1014 50%, #0e1014 100%)',
              }}
            />
            <MonitorSmartphone className="absolute top-1/2 left-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 text-[#7aa2ff]" />
          </>
        ) : (
          <>
            {/* 标题栏 */}
            <div
              className="h-4 w-full border-b"
              style={{ background: preview.surface, borderColor: preview.accent }}
            />
            {/* 文本行 */}
            <div className="space-y-1.5 px-2 pt-2">
              <div
                className="h-1.5 w-3/4 rounded-full"
                style={{ background: preview.accent }}
              />
              <div
                className="h-1.5 w-1/2 rounded-full"
                style={{ background: preview.accent }}
              />
            </div>
            {/* 主色按钮 */}
            <div
              className="absolute bottom-2 left-2 h-3 w-8 rounded-md"
              style={{ background: preview.primary }}
            />
          </>
        )}
      </div>

      <div className="mt-2 space-y-0.5">
        <div className={cn(FIELD_TITLE_CLASS)}>{label}</div>
        <div className={cn(FIELD_DESC_CLASS, 'line-clamp-1')}>
          {description}
        </div>
      </div>
    </button>
  );
}

export function ThemeSection({ settings, updateSettings }: ThemeSectionProps) {
  const active = settings.theme ?? 'system';

  return (
    <div className="space-y-6 pb-16">
      <SectionHeader
        title="Theme"
        description="选择应用的整体配色; 「跟随系统」会随设备外观自动切换"
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEME_OPTIONS.map((opt) => (
          <ThemeCard
            key={opt.id}
            option={opt}
            active={active === opt.id}
            onSelect={() => updateSettings({ theme: opt.id })}
          />
        ))}
      </div>

      <div className="flex justify-start">
        <Button
          variant="outline"
          size="sm"
          className="rounded-full px-4"
          onClick={() => updateSettings({ theme: DEFAULT_USER_SETTINGS.theme })}
        >
          恢复默认
        </Button>
      </div>
    </div>
  );
}
