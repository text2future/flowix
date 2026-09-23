import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 平台判定用 mock 驱动, 避免依赖 jsdom 的 navigator 字段组合。
const platformState = { mac: true };
vi.mock('@features/shortcuts', () => ({
  isMac: () => platformState.mac,
}));

// OnboardingTitlebarMac 是被测目标的主体, 单独导入可绕开 OnboardingScreen
// 对 Tauri IPC / store 的依赖。
import { OnboardingTitlebarMac } from './onboarding-titlebar-mac';
import { isMac } from '@features/shortcuts';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  platformState.mac = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  act(() => root?.unmount());
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('OnboardingTitlebarMac', () => {
  it('exposes a Tauri drag region so the frameless macOS window can be moved', () => {
    // onboarding 是 position:fixed inset:0 的整窗覆盖层; macOS 走 Overlay 标题栏
    // 且 hiddenTitle(true), 没有原生 chrome 可抓。唯一能拖窗的元素就是这里。
    act(() => {
      root?.render(createElement(OnboardingTitlebarMac));
    });

    const dragRegion = container?.querySelector('[data-tauri-drag-region]') ?? null;
    expect(dragRegion).not.toBeNull();
    expect(dragRegion?.classList.contains('flowix-onboarding__titlebar-mac')).toBe(true);
  });

  it('keeps the drag region free of interactive content', () => {
    // 拖拽条内不能出现按钮/输入框, 否则点击与拖拽会互相抢夺事件。
    act(() => {
      root?.render(createElement(OnboardingTitlebarMac));
    });

    expect(container?.querySelector('button, input, a, [role="button"]')).toBeNull();
  });
});

describe('onboarding drag region gating', () => {
  it('renders the strip through the same isMac() gate used by OnboardingScreen', () => {
    // OnboardingScreen 直接内联 `{isMac() && <OnboardingTitlebarMac />}`, 这里用
    // 等价的最小 harness 覆盖该 gate, 避免为渲染整屏而 mock 一大堆 store / IPC。
    const Harness = () =>
      isMac() ? createElement(OnboardingTitlebarMac) : null;

    platformState.mac = true;
    act(() => {
      root?.render(createElement(Harness));
    });
    expect(container?.querySelector('[data-tauri-drag-region]')).not.toBeNull();

    platformState.mac = false;
    act(() => {
      root?.render(createElement(Harness));
    });
    // 非 macOS 不渲染: 那边的拖拽区由 <WindowsTitlebarControls /> 负责。
    expect(container?.querySelector('[data-tauri-drag-region]')).toBeNull();
  });
});
