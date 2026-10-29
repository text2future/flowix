import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TreeSectionEmptyState } from './tree-section-empty-state';

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

function renderEmptyState(props: Parameters<typeof TreeSectionEmptyState>[0]) {
  act(() => root.render(<TreeSectionEmptyState {...props} />));
  const box = container.querySelector<HTMLElement>('[data-tree-section-empty-state]')!;
  return {
    box,
    message: box.querySelector<HTMLElement>('span')!,
    text: box.querySelectorAll<HTMLElement>('span')[1],
    button: container.querySelector<HTMLButtonElement>('button'),
  };
}

describe('TreeSectionEmptyState', () => {
  it('文案恒定居中，且不参与 hover 布局变化', () => {
    const { box, message } = renderEmptyState({ message: '列表为空', hideLabel: '隐藏', onHide: () => {} });

    expect(box.className).toContain('justify-center');
    expect(box.className).not.toContain('border-dashed');

    expect(message.textContent).toBe('列表为空隐藏');
    expect(message.className).toContain('relative');
    expect(message.className).toContain('inline-flex');
    // 文案自身绝不带 hover 类，否则就会跳位。
    expect(message.className).not.toContain('group-hover');
  });

  it('「隐藏」默认不可见也不吃点击，hover / 聚焦后紧贴文案右侧浮出', () => {
    const { button } = renderEmptyState({ message: '列表为空', hideLabel: '隐藏', onHide: () => {} });

    expect(button).not.toBeNull();
    const className = button!.className;
    expect(button!.textContent).toBe('隐藏');
    // 紧贴文案右侧：left-full + 小间距，绝对定位所以不占位。
    expect(className).toContain('absolute');
    expect(className).toContain('left-full');
    expect(className).toContain('ml-1.5');
    // 按文字撑开，不能因为包含块窄而折行。
    expect(className).toContain('whitespace-nowrap');
    expect(className).toContain('w-max');
    expect(className).toContain('opacity-0');
    expect(className).toContain('pointer-events-none');
    expect(className).toContain('tree-section-empty-state__hide-action');
    // 同款：字号 / 颜色一致，hover 只变色加深、不加底色。
    for (const cls of ['text-xs', 'text-[var(--muted-foreground)]', 'hover:text-[var(--foreground)]', 'hover:!opacity-100']) {
      expect(className).toContain(cls);
    }
    expect(className).not.toContain('hover:bg-');
  });

  it('「隐藏」浮出后与文案同色同透明度（不给父级挂 opacity，避免相乘变浅）', () => {
    const { message, text, button } = renderEmptyState({ message: '列表为空', hideLabel: '隐藏', onHide: () => {} });

    // 文案带淡化档位。
    expect(text?.className).toContain('opacity-[0.48]');
    expect(text?.textContent).toBe('列表为空');

    // 定位父级（量度盒）不得带 opacity：opacity 会作用到整棵子树，
    // 父级 0.48 × 按钮 0.48 ≈ 0.23，按钮就会明显比文案浅。
    expect(message.className).not.toContain('opacity-');

    for (let node = button!.parentElement; node && node !== container; node = node.parentElement) {
      expect(node.className).not.toContain('opacity-');
    }
  });

  it('点击「隐藏」触发 onHide', () => {
    const onHide = vi.fn();
    const { button } = renderEmptyState({ message: '列表为空', hideLabel: '隐藏', onHide });

    act(() => button!.click());
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('没有隐藏回调时不渲染按钮', () => {
    const { box, button } = renderEmptyState({ message: '列表为空' });

    expect(button).toBeNull();
    expect(box.textContent).toBe('列表为空');
  });
});
