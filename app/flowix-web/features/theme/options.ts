import type { ThemeId } from '@features/theme';
import type { I18nKey } from '@features/i18n';

/** 设置面板预览卡片用的色板 — 与 CSS vars 解耦, 这里只是元数据, 不参与运行。 */
export interface ThemeOption {
  id: ThemeId;
  labelKey: I18nKey;
  descriptionKey: I18nKey;
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
 *
 * label / description 用 i18n key ── 渲染时调用方通过 translate(language, key) 取值。
 */
export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'system',
    labelKey: 'theme.system.label',
    descriptionKey: 'theme.system.description',
    preview: { background: '#ffffff', surface: '#0e1014', primary: '#09244B', accent: '#7aa2ff' },
  },
  {
    id: 'light',
    labelKey: 'theme.light.label',
    descriptionKey: 'theme.light.description',
    preview: { background: '#ffffff', surface: '#e8ebf0', primary: '#5262DC', accent: '#e5e7eb' },
  },
  {
    id: 'dark',
    labelKey: 'theme.dark.label',
    descriptionKey: 'theme.dark.description',
    preview: { background: '#0e1014', surface: '#16191f', primary: '#7aa2ff', accent: '#262a31' },
  },
  {
    id: 'rock',
    labelKey: 'theme.rock.label',
    descriptionKey: 'theme.rock.description',
    preview: { background: '#fbfaf4', surface: '#fffefb', primary: '#55524d', accent: '#f5f3ed' },
  },
  {
    id: 'mist',
    labelKey: 'theme.mist.label',
    descriptionKey: 'theme.mist.description',
    preview: { background: '#FDFBF7', surface: '#FFFEFC', primary: '#6FA33B', accent: '#F8F5F1' },
  },
  {
    id: 'ember',
    labelKey: 'theme.ember.label',
    descriptionKey: 'theme.ember.description',
    /* 预览: 近白暖纸 (#faf5ee) + 几乎纯白卡片 (#fefcf8) + FB6A42 主色 +
     * 浅米描边 (#ede5d8) ── 与 ember.css v2 的 OKLCH 值取最接近的 sRGB
     * hex (ΔL<0.005), 让偏好面板小样与真实主题渲染视觉一致。 */
    preview: { background: '#faf5ee', surface: '#fefcf8', primary: '#FB6A42', accent: '#ede5d8' },
  },
];
