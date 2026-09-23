import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMemoListHoverPreview } from './use-memo-list-hover-preview';

let currentPreview!: ReturnType<typeof useMemoListHoverPreview>;

function PreviewHarness({ navigationDrawerPhase }: { navigationDrawerPhase: 'closed' | 'open' | 'closing' }) {
  currentPreview = useMemoListHoverPreview(true, navigationDrawerPhase);
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

  it('holds an open preview while the navigation drawer is open', async () => {
    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="closed" />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(420);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');

    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="open" />);
    });
    await act(async () => {
      currentPreview.handlePreviewLeave();
      vi.advanceTimersByTime(400);
    });

    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');
  });

  it('releases the preview after the navigation transition completes', async () => {
    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="closed" />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(420);
    });
    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="open" />);
    });
    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="closing" />);
    });
    await act(async () => {
      currentPreview.handlePreviewLeave();
      vi.advanceTimersByTime(400);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');
    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="closed" />);
    });
    await act(async () => {
      vi.advanceTimersByTime(149);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');

    await act(async () => {
      // The drawer transition is complete before the normal close delay and
      // leave animation begin.
      vi.advanceTimersByTime(150 + 160 + 1);
    });
    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closed');
  });

  it('keeps the preview open when the pointer lands on it after the drawer closes', async () => {
    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="closed" />);
    });
    await act(async () => {
      currentPreview.handleTriggerEnter();
      vi.advanceTimersByTime(420);
    });

    const preview = document.createElement('div');
    preview.dataset.memoListHoverPreview = '';
    host.appendChild(preview);
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => preview,
    });

    try {
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
        root.render(<PreviewHarness navigationDrawerPhase="open" />);
      });
      await act(async () => {
        root.render(<PreviewHarness navigationDrawerPhase="closed" />);
        vi.advanceTimersByTime(150 + 160 + 1);
      });

      expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('open');
    } finally {
      if (originalElementFromPoint) {
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: originalElementFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, 'elementFromPoint');
      }
      preview.remove();
    }
  });

  it('does not create a preview from the navigation drawer alone', async () => {
    await act(async () => {
      root.render(<PreviewHarness navigationDrawerPhase="open" />);
    });
    await act(async () => {
      currentPreview.handleCompanionSurfaceEnter();
      vi.advanceTimersByTime(1000);
    });

    expect(host.querySelector('output')?.getAttribute('data-preview-phase')).toBe('closed');
  });
});
