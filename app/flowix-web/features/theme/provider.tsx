'use client';

import { useEffect } from 'react';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { applyTheme } from '@features/theme/apply';
import { sanitizeTheme } from '@features/theme/sanitize';

/**
 * 全局主题应用层。
 *
 * 职责:
 * 1. 订阅 store 里的 settings.theme, 变化时调 applyTheme 写入 <html>。
 * 2. theme = 'system' 时订阅 prefers-color-scheme 变化, 实时跟随。
 * 3. 切换后 dispatch 'app-theme-changed' 事件 — 消费方 (markdown-editor) 借此
 *    强制 Shiki PM 插件重算装饰 (它只听文档变更, 不监听 CSS var)。
 *
 * 不在这里 dispatch 事件会让 markdown-editor 的 shiki 颜色停在旧主题。
 * 不订阅 mq 会让 'system' 模式不会响应系统切换。 都在 useEffect 里, 卸载时清理。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useUserSettingsStore((s) => s.settings.theme);

  useEffect(() => {
    const id = sanitizeTheme(theme);
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = applyTheme(root, id, { prefersDark: mq.matches });
      window.dispatchEvent(new CustomEvent('app-theme-changed', { detail: { theme: resolved } }));
    };
    apply();
    if (id === 'system') {
      const listener = () => apply();
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
  }, [theme]);

  return <>{children}</>;
}
