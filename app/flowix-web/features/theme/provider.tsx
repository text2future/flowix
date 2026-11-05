'use client';

import { useEffect } from 'react';
import { useAppTheme } from '@features/preferences/public/runtime-api';
import { DEFAULT_THEME_ID, applyTheme, sanitizeTheme } from '@/lib/theme';
import { createLogger } from '@/lib/logger';
import { useMembershipAccess } from '@features/preferences/public/membership';
import { windows } from '@platform/tauri/client';

const logger = createLogger('theme-provider');

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
  const theme = useAppTheme();
  const { active: canUseMistTheme } = useMembershipAccess();

  useEffect(() => {
    const savedTheme = sanitizeTheme(theme);
    const id = savedTheme === 'mist' && !canUseMistTheme ? DEFAULT_THEME_ID : savedTheme;
    const root = document.documentElement;
    let active = true;
    // The IPC resolves after native UI work, so CSS reflects the actual backdrop.
    void windows.applyWindowTheme(id).then((material) => {
      if (!active) return;
      if (material === 'none') delete root.dataset.windowMaterial;
      else root.dataset.windowMaterial = material;
      try {
        if (material === 'none') localStorage.removeItem('flowix-window-material');
        else localStorage.setItem('flowix-window-material', material);
      } catch {
        // Storage is optional; the live native result remains authoritative.
      }
    }).catch((error) => {
      logger.warn('Failed to apply native window theme', { error });
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = applyTheme(root, id, { prefersDark: mq.matches });
      window.dispatchEvent(new CustomEvent('app-theme-changed', { detail: { theme: resolved } }));
    };
    apply();
    const listener = () => apply();
    if (id === 'system') mq.addEventListener('change', listener);
    return () => {
      active = false;
      mq.removeEventListener('change', listener);
    };
  }, [theme, canUseMistTheme]);

  return <>{children}</>;
}
