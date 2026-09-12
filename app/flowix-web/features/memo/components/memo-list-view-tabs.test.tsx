import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoListViewTabs } from './memo-list-view-tabs';

vi.mock('@shared/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('MemoListViewTabs', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('commits a pointer tab intent before the later click phase', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<MemoListViewTabs activeTab="notes" onChange={onChange} />);
    });

    const button = host.querySelector<HTMLButtonElement>(
      '[data-memo-list-view-tab="conversations"]',
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
      }));
      button!.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        button: 0,
        detail: 1,
      }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('conversations');
  });

  it('keeps keyboard activation on the click path', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<MemoListViewTabs activeTab="notes" onChange={onChange} />);
    });

    const button = host.querySelector<HTMLButtonElement>(
      '[data-memo-list-view-tab="conversations"]',
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        detail: 0,
      }));
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('conversations');
  });
});
