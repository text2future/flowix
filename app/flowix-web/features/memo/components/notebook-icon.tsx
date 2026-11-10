'use client';

import { cn } from '@/lib/utils';
import type { CSSProperties } from 'react';

export interface NotebookIconOption {
  id: string;
  label: string;
}

// 笔记本图标统一来源: app/flowix-web/assets/notebook-icons/。
// 相对路径: components -> memo -> features -> flowix-web (3 个 `..`) -> assets/notebook-icons。
const NOTEBOOK_ICON_MODULES = import.meta.glob<string>('../../../assets/notebook-icons/*.svg', {
  eager: true,
  import: 'default',
});

export const DEFAULT_NOTEBOOK_ICON_ID = 'planet_fill';

const NOTEBOOK_ICON_PREFERRED_ORDER = [
  'planet_fill',
  'notebook_2_fill',
  'board_fill',
  'mark_pen_fill',
  'bulb_2_ai_fill',
  'ai_fill',
  'chat_4_ai_fill',
  'calendar_month_fill',
  'chart_bar_fill',
  'chart_pie_2_fill',
  'world_fill',
  'compass_fill',
] as const;


function getNotebookIconIdFromPath(path: string): string {
  return path.split('/').pop()?.replace(/\.svg$/i, '') ?? path;
}

function getNotebookIconLabel(id: string): string {
  return id
    .replace(/_fill$/i, '')
    .split('_')
    .filter(Boolean)
    .map((part) => {
      const upper = part.toUpperCase();
      if (['AI', 'API', 'CNY', 'SOL', 'VIP', 'VR'].includes(upper)) return upper;
      if (part.toLowerCase() === 'vscode') return 'VS Code';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function getNotebookIconSortIndex(id: string): number {
  const index = NOTEBOOK_ICON_PREFERRED_ORDER.indexOf(
    id as (typeof NOTEBOOK_ICON_PREFERRED_ORDER)[number],
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}


export const NOTEBOOK_ICON_OPTIONS: readonly NotebookIconOption[] = Object.keys(NOTEBOOK_ICON_MODULES)
  .map((path) => {
    const id = getNotebookIconIdFromPath(path);
    return { id, label: getNotebookIconLabel(id) };
  })
  .sort((a, b) => getNotebookIconSortIndex(a.id) - getNotebookIconSortIndex(b.id) || a.label.localeCompare(b.label));

const NOTEBOOK_ICON_BY_ID = new Map<string, NotebookIconOption>(
  NOTEBOOK_ICON_OPTIONS.map((option) => [option.id, option] as const),
);
const DEFAULT_NOTEBOOK_ICON_OPTION = NOTEBOOK_ICON_BY_ID.get(DEFAULT_NOTEBOOK_ICON_ID)
  ?? NOTEBOOK_ICON_OPTIONS[0]
  ?? { id: DEFAULT_NOTEBOOK_ICON_ID, label: getNotebookIconLabel(DEFAULT_NOTEBOOK_ICON_ID) };

const NOTEBOOK_ICON_URL_BY_ID = Object.fromEntries(
  Object.entries(NOTEBOOK_ICON_MODULES).map(([path, url]) => [
    getNotebookIconIdFromPath(path),
    url,
  ]),
) as Record<string, string>;

export function getNotebookIconOption(icon: string | null | undefined): NotebookIconOption | null {
  if (!icon) return null;
  return NOTEBOOK_ICON_BY_ID.get(icon) ?? null;
}

export function resolveNotebookIconOption(icon: string | null | undefined): NotebookIconOption {
  return getNotebookIconOption(icon) ?? DEFAULT_NOTEBOOK_ICON_OPTION;
}

export function resolveNotebookIconId(icon: string | null | undefined): string {
  return resolveNotebookIconOption(icon).id;
}

export function getNotebookIconUrl(icon: string | null | undefined): string | null {
  const option = getNotebookIconOption(icon);
  return option ? NOTEBOOK_ICON_URL_BY_ID[option.id] ?? null : null;
}

interface NotebookIconProps {
  icon?: string | null;
  className?: string;
  imageClassName?: string;
  /** 关闭图标自带的原生 title tooltip (例如用作 hover 下拉窗触发器时避免遮挡)。 */
  disableTitle?: boolean;
}

export function NotebookIcon({
  icon,
  className,
  imageClassName,
  disableTitle,
}: NotebookIconProps) {
  const option = resolveNotebookIconOption(icon);
  const iconUrl = option ? NOTEBOOK_ICON_URL_BY_ID[option.id] : null;

  // 图标 SVG 自带硬编码深色填充（#09244B），不能用 <img> 渲染 —— 深色主题下
  // 深色填充贴深色背景几乎不可见，且文字色类对 img 不生效。改用 CSS mask +
  // bg-current，让图标颜色跟随容器文字色（含各调用点的 text-* 覆盖）。
  if (option && iconUrl) {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden text-[var(--secondary-foreground)]',
          className,
        )}
        title={disableTitle ? undefined : option.label}
      >
        <span
          aria-hidden="true"
          className={cn('shrink-0 bg-current', imageClassName ?? 'h-[78%] w-[78%]')}
          style={{
            mask: `url("${iconUrl}") center / contain no-repeat`,
            WebkitMask: `url("${iconUrl}") center / contain no-repeat`,
          } as CSSProperties}
        />
      </span>
    );
  }

  return <span className={cn('flex shrink-0 items-center justify-center', className)} />;
}
