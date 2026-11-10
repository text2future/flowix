'use client';

import type { CSSProperties } from 'react';
import { Monitor } from 'lucide-react';
import { Button } from '@shared/ui/button';
import { DEFAULT_THEME_ID, THEME_OPTIONS, sanitizeTheme, type ThemeId } from '@features/theme';
import { cn } from '@/lib/utils';
import { SectionHeader, FIELD_TITLE_CLASS } from '@features/preferences/sections/primitives';
import { useI18n } from '@/lib/i18n';
import { useMembershipAccess } from '@features/preferences/public/membership';
import { setThemePreference } from '@features/preferences/public/runtime-api';
import { windows } from '@platform/tauri/client';

interface ThemeSectionProps {
  settings: { theme: ThemeId };
  updateSettings: (updates: Partial<{ theme: ThemeId }>) => Promise<void>;
}

const THEME_DISPLAY_ORDER: readonly ThemeId[] = ['system', 'rock', 'light', 'dark', 'ember', 'mist'];

/**
 * 主题预览卡片。点击即应用; 当前激活卡片有强边框 + 右上角对勾。
 * 预览区按主界面双列布局画骨架: 左列文件树 (缩进层级 + 品牌色「新建」按钮骨架),
 * 右列为内容骨架, 让用户在不切换的情况下也能直观感受主题氛围。
 */
function ThemeCard({
  option,
  active,
  isDefault,
  memberOnly,
  onSelect,
}: {
  option: typeof THEME_OPTIONS[number];
  active: boolean;
  isDefault: boolean;
  memberOnly?: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const { preview, id, labelKey } = option;
  const previewStyle: CSSProperties & {
    '--theme-preview-background': string;
    '--theme-preview-surface': string;
    '--theme-preview-accent': string;
    '--theme-preview-primary': string;
  } = {
    '--theme-preview-background': preview.background,
    '--theme-preview-surface': preview.surface,
    '--theme-preview-accent': preview.accent,
    '--theme-preview-primary': preview.primary,
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full rounded-[var(--radius)] border p-1.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]',
        active
          ? 'border-[var(--border)] bg-[var(--muted)]'
          : 'border-transparent bg-[var(--background)] hover:bg-[var(--muted)]'
      )}
    >
      {/* Preview mock window — 主界面双列骨架 (flex 行布局: 左文件树列 + 右内容列) */}
      <div
        className="relative flex h-28 w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--theme-preview-background)]"
        style={previewStyle}
        data-theme-preview-dark={id === 'dark' || id === 'mist' ? 'true' : undefined}
      >
        {id === 'system' ? (
          // 「跟随系统」用左浅右深的对角分割图直观示意
          <>
            <div
              className="theme-card__preview-system-split absolute inset-0"
            />
            <Monitor
              className="theme-card__preview-system-icon absolute top-1/2 left-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2"
            />
          </>
        ) : (
          <>
            {/* 左列: 文件树 (侧栏底色 + 缩进骨架行 + 顶部品牌色「新建」方块骨架) */}
            <div className="theme-card__preview-surface flex w-[38%] flex-col gap-1.5 border-r px-2 py-1.5">
              <div className="flex justify-end">
                <div className="theme-card__preview-primary h-2.5 w-2.5 rounded-[4px]" />
              </div>
              <div className="mt-0.5 flex flex-col gap-1.5">
                <div className="theme-card__preview-accent h-1.5 w-[85%] rounded-full" />
                <div className="theme-card__preview-accent ml-2.5 h-1.5 w-[70%] rounded-full" />
                <div className="theme-card__preview-accent ml-2.5 h-1.5 w-[78%] rounded-full" />
                <div className="theme-card__preview-accent ml-5 h-1.5 w-[60%] rounded-full" />
                <div className="theme-card__preview-accent h-1.5 w-[75%] rounded-full" />
                <div className="theme-card__preview-accent ml-2.5 h-1.5 w-[65%] rounded-full" />
              </div>
            </div>
            {/* 右列: 内容骨架 (标题 + 首段正文 + 图片块 + 二段正文, 按真实笔记比例) */}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-2.5 py-2">
              {/* 标题行 */}
              <div className="theme-card__preview-accent h-1.5 w-1/2 rounded-full" />
              {/* 首段正文 */}
              <div className="flex flex-col gap-1">
                <div className="theme-card__preview-accent h-1 w-full rounded-full" />
                <div className="theme-card__preview-accent h-1 w-[94%] rounded-full" />
              </div>
              {/* 图片骨架 (侧栏底色填充 + accent 描边, 与正文行区分层级) */}
              <div className="theme-card__preview-surface h-8 w-full rounded-[4px] border" />
              {/* 二段正文 */}
              <div className="flex flex-col gap-1">
                <div className="theme-card__preview-accent h-1 w-[88%] rounded-full" />
                <div className="theme-card__preview-accent h-1 w-[62%] rounded-full" />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="mt-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className={cn(FIELD_TITLE_CLASS, 'text-xs pl-[0.5em]')}>{t(labelKey)}</span>
          {isDefault && (
            <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--muted-foreground)]">
              {t('preferences.theme.default')}
            </span>
          )}
          {memberOnly && (
            <span className="rounded-full border border-[var(--primary)]/25 bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] px-1.5 py-0.5 text-[9px] font-medium leading-none text-[var(--primary)]">
              {t('preferences.theme.member')}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export function ThemeSection({ settings, updateSettings }: ThemeSectionProps) {
  const { t } = useI18n();
  const { active: canUseMistTheme } = useMembershipAccess();
  const savedTheme = sanitizeTheme(settings.theme ?? DEFAULT_THEME_ID);
  const active = savedTheme === 'mist' && !canUseMistTheme ? DEFAULT_THEME_ID : savedTheme;
  const options = [...THEME_OPTIONS]
    .sort(
    (left, right) => THEME_DISPLAY_ORDER.indexOf(left.id) - THEME_DISPLAY_ORDER.indexOf(right.id),
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-1">
        <SectionHeader
          title={t('preferences.theme.title')}
          size="field"
        />
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {options.map((opt) => (
              <ThemeCard
                key={opt.id}
                option={opt}
                active={active === opt.id}
                isDefault={opt.id === DEFAULT_THEME_ID}
                memberOnly={opt.id === 'mist'}
                onSelect={() => {
                  if (opt.id !== 'mist') {
                    void updateSettings({ theme: opt.id });
                    return;
                  }
                  void setThemePreference(opt.id).then(async (applied) => {
                    if (!applied) await windows.openPreferences('cloudSync');
                  }).catch((error) => {
                    console.warn('Failed to open Mist membership settings', error);
                  });
                }}
              />
            ))}
          </div>

          <div className="flex justify-start">
            <Button
              variant="outline"
              className="px-3"
              onClick={() => updateSettings({ theme: DEFAULT_THEME_ID })}
            >
              {t('preferences.resetDefaults')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
