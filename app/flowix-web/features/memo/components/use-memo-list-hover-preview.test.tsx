import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMemoListHoverPreview } from './use-memo-list-hover-preview';

let currentPreview!: ReturnType<typeof useMemoListHoverPreview>;

function PreviewHarness({ enabled }: { enabled: boolean }) {
  currentPreview = useMemoListHoverPreview(enabled);
  return <output data-preview-phase={currentPreview.phase} />;
}

describe('useMemoListHoverPreview', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('opens the preview after the hover delay', async () => {
    await act(async () => {
      root.render(<PreviewHarness enabled={true} />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(419);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closed');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');
  });

  it('closes through the closing animation after the pointer leaves', async () => {
    await act(async () => {
      root.render(<PreviewHarness enabled={true} />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(420);
    });
    await act(async () => {
      currentPreview.handleTriggerLeave();
      vi.advanceTimersByTime(149);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closing');

    await act(async () => {
      vi.advanceTimersByTime(159);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closing');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closed');
  });

  it('cancels the close when the pointer lands on the preview', async () => {
    await act(async () => {
      root.render(<PreviewHarness enabled={true} />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(420);
    });
    await act(async () => {
      currentPreview.handleTriggerLeave();
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      currentPreview.handlePreviewEnter();
      vi.advanceTimersByTime(1000);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');

    await act(async () => {
      currentPreview.handlePreviewLeave();
      vi.advanceTimersByTime(150 + 160 + 1);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closed');
  });

  it('reopens immediately when the pointer returns during the leave animation', async () => {
    await act(async () => {
      root.render(<PreviewHarness enabled={true} />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(420);
    });
    await act(async () => {
      currentPreview.handleTriggerLeave();
      vi.advanceTimersByTime(150 + 80);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closing');

    await act(async () => {
      currentPreview.handleTriggerEnter();
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');
  });

  it('resets to closed when disabled', async () => {
    await act(async () => {
      root.render(<PreviewHarness enabled={true} />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(420);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');

    await act(async () => {
      root.render(<PreviewHarness enabled={false} />);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closed');
  });
});
