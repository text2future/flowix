import type { ThemeId } from './types';

/** 设置面板预览卡片用的色板 — 与 CSS vars 解耦, 这里只是元数据, 不参与运行。 */
export interface ThemeOption {
  id: ThemeId;
  label: string;
  description: string;
  preview: {
    background: string;
    surface: string;
    primary: string;
    accent: string;
  };
}

/**
 * 主题设置面板展示元数据。
 * 与 css/theme/*.css 的实际色板保持视觉一致, 但解耦 — 卡片用最代表性的 3-4 色呈现,
 * 不用暴露全部 24 个 token。
 */
export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'system',
    label: '跟随系统',
    description: '随系统外观自动切换浅色 / 深色',
    preview: { background: '#ffffff', surface: '#0e1014', primary: '#09244B', accent: '#7aa2ff' },
  },
  {
    id: 'light',
    label: '浅色',
    description: '明亮、清爽,适合白天',
    preview: { background: '#ffffff', surface: '#e8ebf0', primary: '#5262DC', accent: '#e5e7eb' },
  },
  {
    id: 'dark',
    label: '深色',
    description: '低光、护眼,适合夜间',
    preview: { background: '#0e1014', surface: '#16191f', primary: '#7aa2ff', accent: '#262a31' },
  },
  {
    id: 'rock',
    label: '岩灰',
    description: '温润的淡黄灰,稳重低饱和',
    preview: { background: '#f1f0eb', surface: '#f6f5f0', primary: '#55524d', accent: '#d4d1cb' },
  },
];
