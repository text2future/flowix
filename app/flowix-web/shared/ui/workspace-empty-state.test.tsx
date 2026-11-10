import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceEmptyState } from './workspace-empty-state';

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

function render(element: ReactElement): HTMLDivElement {
  act(() => root.render(element));
  return container.firstElementChild as HTMLDivElement;
}

describe('WorkspaceEmptyState', () => {
  it('paints the document fill and the artwork by default', () => {
    const surface = render(<WorkspaceEmptyState message="空" />);

    expect(surface.className).toContain('bg-[var(--document-bg)]');
    expect(surface.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(surface.textContent).toBe('空');
  });

  // 空状态盖在宿主自己的空态之上（例如加载失败的对话下面还挂着一张
  // agent-thread-card__empty 卡片），所以底色必须始终不透明，只允许去掉水印图。
  it('keeps the host fill but drops the artwork when asked', () => {
    const surface = render(<WorkspaceEmptyState tone="agent" artwork={false} message="对话读取失败" />);

    expect(surface.className).toContain('bg-[var(--agent-bg,var(--document-bg))]');
    expect(surface.className).not.toContain('bg-transparent');
    expect(surface.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(surface.textContent).toBe('对话读取失败');
  });

  it('matches the agent surface fill in the agent tone', () => {
    const surface = render(<WorkspaceEmptyState tone="agent" message="空" />);

    expect(surface.className).toContain('bg-[var(--agent-bg,var(--document-bg))]');
    expect(surface.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
