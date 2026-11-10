import type { ThemeId } from './types';
import type { I18nKey } from '@/lib/i18n';

/** 设置面板预览卡片用的色板 — 与 CSS vars 解耦, 这里只是元数据, 不参与运行。 */
export interface ThemeOption {
  id: ThemeId;
  labelKey: I18nKey;
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
 * 不需要暴露完整 token 集。
 *
 * label / description 用 i18n key ── 渲染时调用方通过 translate(language, key) 取值。
 */
export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'system',
    labelKey: 'theme.system.label',
    preview: { background: '#ffffff', surface: '#0e1014', primary: '#e4bf46', accent: '#5262dc' },
  },
  {
    id: 'light',
    labelKey: 'theme.light.label',
    preview: { background: '#ffffff', surface: '#e8ebf0', primary: '#5262DC', accent: '#e5e7eb' },
  },
  {
    id: 'dark',
    labelKey: 'theme.dark.label',
    preview: { background: '#0e1014', surface: '#16191f', primary: '#e4bf46', accent: '#262a31' },
  },
  {
    id: 'mist',
    labelKey: 'theme.mist.label',
    preview: { background: '#0e1014', surface: '#16191f', primary: '#e4bf46', accent: '#262a31' },
  },
  {
    id: 'rock',
    labelKey: 'theme.rock.label',
    preview: { background: '#fbfaf4', surface: '#fffefb', primary: '#55524d', accent: '#f5f3ed' },
  },
  {
    id: 'ember',
    labelKey: 'theme.ember.label',
    /* 预览: 近白暖纸 (#faf5ee) + 几乎纯白卡片 (#fefcf8) + CF432C 主色 +
     * 浅米描边 (#ede5d8) ── 与 ember.css v2 的 OKLCH 值取最接近的 sRGB
     * hex (ΔL<0.005), 让偏好面板小样与真实主题渲染视觉一致。 */
    preview: { background: '#faf5ee', surface: '#fefcf8', primary: '#cf432c', accent: '#ede5d8' },
  },
];
