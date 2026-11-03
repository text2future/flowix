import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { PropertyIconPickerPanel } from '@features/document/public/property-display-api';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';

/**
 * 编辑器是原生 DOM 环境，共享的 PropertyIconPickerPanel 是 React 组件，
 * 这里只负责「独立 React root + 当前语言 Provider」这层挂载胶水：
 * 面板用 useI18n 取文案，不套 Provider 会回退到默认语言。
 */
export interface MountedIconPickerMenu {
  readonly host: HTMLElement;
  render: (value: string) => void;
  unmount: () => void;
}

export function mountIconPickerMenu(options: {
  onSelect: (next: string) => void;
}): MountedIconPickerMenu {
  const host = document.createElement('div');
  host.className = 'frontmatter-property__edit-icon-content';
  const root: Root = createRoot(host);

  return {
    host,
    render: (value) => {
      root.render(
        createElement(I18nProvider, {
          language: getCurrentAppLanguage(),
          children: createElement(PropertyIconPickerPanel, {
            value,
            onSelect: options.onSelect,
          }),
        }),
      );
    },
    unmount: () => root.unmount(),
  };
}
