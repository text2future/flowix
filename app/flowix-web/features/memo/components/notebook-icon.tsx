'use client';

import { pinyin } from 'pinyin-pro';
import { cn } from '@/lib/utils';

export interface NotebookIconOption {
  id: string;
  label: string;
}

// 笔记本图标统一来源: app/flowix-web/assets/notebook-icons/。
// 相对路径: components → memo → features → flowix-web (3 个 `..`) → assets/notebook-icons。
const NOTEBOOK_ICON_MODULES = import.meta.glob<string>('../../../assets/notebook-icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?raw',
});

const NOTEBOOK_ICON_PREFERRED_ORDER = [
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
  'planet_fill',
] as const;

const NOTEBOOK_ICON_COLOR_ATTRIBUTE_RE =
  /\b(fill|stroke)=(["'])(?!none\b|transparent\b|currentColor\b|url\()[^"']+\2/gi;
const NOTEBOOK_ICON_SVG_TAG_RE = /<svg\b([^>]*)>/i;
const NOTEBOOK_ICON_VIEWBOX_RE = /\bviewBox=(["'])[^"']+\1/i;
const NOTEBOOK_ICON_WIDTH_RE = /\bwidth=(["'])(\d+(?:\.\d+)?)\1/i;
const NOTEBOOK_ICON_HEIGHT_RE = /\bheight=(["'])(\d+(?:\.\d+)?)\1/i;

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

function normalizeNotebookIconMarkup(markup: string): string {
  const withCurrentColor = markup.replace(NOTEBOOK_ICON_COLOR_ATTRIBUTE_RE, '$1="currentColor"');

  return withCurrentColor.replace(NOTEBOOK_ICON_SVG_TAG_RE, (svgTag, attrs: string) => {
    if (NOTEBOOK_ICON_VIEWBOX_RE.test(attrs)) return svgTag;

    const width = attrs.match(NOTEBOOK_ICON_WIDTH_RE)?.[2] ?? '24';
    const height = attrs.match(NOTEBOOK_ICON_HEIGHT_RE)?.[2] ?? '24';
    return `<svg${attrs} viewBox="0 0 ${width} ${height}">`;
  });
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

const NOTEBOOK_ICON_MARKUP_BY_ID = Object.fromEntries(
  Object.entries(NOTEBOOK_ICON_MODULES).map(([path, markup]) => [
    getNotebookIconIdFromPath(path),
    normalizeNotebookIconMarkup(markup),
  ]),
) as Record<string, string>;

export function getNotebookIconOption(icon: string | null | undefined): NotebookIconOption | null {
  if (!icon) return null;
  return NOTEBOOK_ICON_BY_ID.get(icon) ?? null;
}

export function getNotebookIconMarkup(icon: string | null | undefined): string | null {
  const option = getNotebookIconOption(icon);
  return option ? NOTEBOOK_ICON_MARKUP_BY_ID[option.id] ?? null : null;
}

export function getNotebookIconLetter(name: string | undefined | null, fallback: string = 'N'): string {
  if (!name) return fallback;
  const trimmed = name.trim();
  if (!trimmed) return fallback;

  const first = trimmed.charAt(0);
  if (/[A-Za-z0-9]/.test(first)) {
    return first.toUpperCase();
  }

  const py = pinyin(trimmed, { pattern: 'first' }).trim();
  if (!py) return fallback;
  return py.charAt(0).toUpperCase();
}

interface NotebookIconProps {
  icon?: string | null;
  name?: string | null;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
}

export function NotebookIcon({
  icon,
  name,
  className,
  imageClassName,
  fallbackClassName,
}: NotebookIconProps) {
  const option = getNotebookIconOption(icon);
  const iconMarkup = option ? NOTEBOOK_ICON_MARKUP_BY_ID[option.id] : null;

  if (option && iconMarkup) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden text-[#3f3f46] dark:text-white [[data-theme='dark']_&]:text-white",
          className,
        )}
        title={option.label}
      >
        <span
          aria-hidden="true"
          className={cn(
            '[&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:opacity-90',
            imageClassName ?? 'h-[78%] w-[78%]',
          )}
          dangerouslySetInnerHTML={{ __html: iconMarkup }}
        />
      </span>
    );
  }

  return (
    <span className={cn('flex shrink-0 items-center justify-center', className, fallbackClassName)}>
      {getNotebookIconLetter(name)}
    </span>
  );
}