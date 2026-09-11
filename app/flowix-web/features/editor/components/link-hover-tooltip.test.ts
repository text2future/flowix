import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openerMocks = vi.hoisted(() => ({
  openUrl: vi.fn(async () => undefined),
}));

vi.mock('@platform/tauri/opener', () => openerMocks);

import { attachLinkHoverTooltip } from './link-hover-tooltip';

function createEditorFixture(href: string) {
  const scroller = document.createElement('div');
  scroller.className = 'editor-content';
  const mount = document.createElement('div');
  const editorDom = document.createElement('div');
  editorDom.className = 'ProseMirror';
  editorDom.innerHTML = `
    <p><a href="${href}">link</a></p>
    <h2>基础 Slide 外壳</h2>
  `;
  mount.append(editorDom);
  scroller.append(mount);
  document.body.append(scroller);

  const editor = {
    view: {
      dom: editorDom,
      isDestroyed: false,
    },
  } as unknown as Editor;
  const detach = attachLinkHoverTooltip(editor, mount);

  return {
    anchor: editorDom.querySelector('a') as HTMLAnchorElement,
    detach,
    scroller,
  };
}

describe('link hover tooltip navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    openerMocks.openUrl.mockClear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('handles a heading fragment inside the current editor instead of opening it externally', () => {
    const { anchor, detach, scroller } = createEditorFixture('#基础-slide-外壳');
    scroller.scrollTo = vi.fn();

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(scroller.scrollTo).toHaveBeenCalledOnce();
    expect(openerMocks.openUrl).not.toHaveBeenCalled();
    detach();
  });

  it('keeps using the system opener for a regular external link', () => {
    const { anchor, detach } = createEditorFixture('https://example.com');

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(openerMocks.openUrl).toHaveBeenCalledWith('https://example.com');
    detach();
  });
});
