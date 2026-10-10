import { beforeAll, beforeEach } from 'vitest';
import { loadLanguage } from '@/lib/i18n';

// i18n 按语言分包后, en-US 走动态 import (独立 chunk); 单测不挂 I18nProvider,
// 直接调 translate('en-US', ...) 的测试需预先加载 en-US 消息表, 否则
// getMessages('en-US') 回退到 zh-CN。loadLanguage 内部缓存 promise, 首个文件
// 触发实际加载, 后续文件立即 resolve。
beforeAll(async () => {
  await loadLanguage('en-US');
});

// Individual suites may reset this flag on teardown; restore it for every case.
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// jsdom 未实现 window.matchMedia；组件（如 featured-notes-controller）在渲染期
// 直接调用它做视口分页判断，缺 stub 会产生 unhandled rejection。这里给一个
// 永不匹配的静态实现，监听器仅注册不触发（单测不需要真实视口变化）。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom 缺少滚动 API；锚点定位等逻辑只关心调用不抛错，滚动位置无需断言。
if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.scrollTo !== 'function') {
    (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}
