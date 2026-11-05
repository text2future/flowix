import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { preparePdfPrint } from './pdf-print';

describe('pdf print view', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps the current editor DOM mounted while preparing print styles', async () => {
    const app = document.createElement('div');
    app.id = 'root';
    const host = document.createElement('div');
    host.dataset.workspaceHost = 'column-1';
    const sibling = document.createElement('div');
    sibling.textContent = 'Titlebar';
    const documentContainer = document.createElement('div');
    documentContainer.className = 'document-container';
    documentContainer.dataset.documentSessionMode = 'main';
    documentContainer.textContent = 'Editor';
    const lazyImage = document.createElement('img');
    lazyImage.dataset.src = 'flowix-asset://localhost/attachments/photo.png';
    documentContainer.append(lazyImage);
    host.append(sibling, documentContainer);
    app.append(host);
    document.body.append(app);

    const preparing = preparePdfPrint(null);
    await Promise.resolve();
    lazyImage.dispatchEvent(new Event('load'));
    const restore = await preparing;

    expect(documentContainer.textContent).toContain('Editor');
    expect(lazyImage.getAttribute('src')).toBe(lazyImage.dataset.src);
    expect(lazyImage.loading).toBe('eager');
    expect(documentContainer.classList.contains('flowix-pdf-print-scope')).toBe(true);
    expect(sibling.classList.contains('flowix-pdf-print-hidden')).toBe(true);
    expect(document.documentElement.classList.contains('flowix-pdf-printing')).toBe(true);

    restore();
    expect(documentContainer.classList.contains('flowix-pdf-print-scope')).toBe(false);
    expect(sibling.classList.contains('flowix-pdf-print-hidden')).toBe(false);
    expect(document.documentElement.classList.contains('flowix-pdf-printing')).toBe(false);
  });
});
