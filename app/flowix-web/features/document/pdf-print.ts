import type { Editor } from '@tiptap/core';

const PRINTING_CLASS = 'flowix-pdf-printing';
const PRINT_SCOPE_CLASS = 'flowix-pdf-print-scope';
const PRINT_ANCESTOR_CLASS = 'flowix-pdf-print-ancestor';
const PRINT_HIDDEN_CLASS = 'flowix-pdf-print-hidden';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function findCurrentDocumentRoot(editor: Editor | null, host: 'column-1' | 'column-2'): HTMLElement | null {
  if (editor && !editor.isDestroyed) {
    const editorRoot = editor.view.dom.closest<HTMLElement>('.document-container');
    if (editorRoot) return editorRoot;
  }

  // Source mode is owned by CodeMirror and therefore has no Tiptap Editor.
  // Scope the fallback to the titlebar's host so an export never prints the
  // other column's document.
  const sessionMode = host === 'column-2' ? 'isolated' : 'main';
  return document.querySelector<HTMLElement>(
    `[data-workspace-host="${host}"] .document-container[data-document-session-mode="${sessionMode}"]`,
  );
}

function classifyPrintDom(root: HTMLElement): Array<[HTMLElement, string]> {
  const changes: Array<[HTMLElement, string]> = [];

  const addClass = (element: HTMLElement, className: string) => {
    if (element.classList.contains(className)) return;
    element.classList.add(className);
    changes.push([element, className]);
  };

  addClass(document.documentElement, PRINTING_CLASS);
  addClass(root, PRINT_SCOPE_CLASS);

  let current: HTMLElement | null = root;
  while (current?.parentElement) {
    const parent: HTMLElement = current.parentElement;

    for (const sibling of Array.from(parent.children)) {
      if (sibling !== current && sibling instanceof HTMLElement) {
        addClass(sibling, PRINT_HIDDEN_CLASS);
      }
    }

    if (parent !== document.body && parent !== document.documentElement) {
      addClass(parent, PRINT_ANCESTOR_CLASS);
    }

    current = parent;
    if (parent === document.body) break;
  }

  return changes;
}

function restorePrintDom(changes: Array<[HTMLElement, string]>): void {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const [element, className] = changes[index];
    element.classList.remove(className);
  }
}

function preparePrintImages(root: HTMLElement): void {
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const deferredSource = image.dataset.src?.trim();
    if (!deferredSource) continue;

    // ImageAttachment intentionally keeps lazy images in data-src until they
    // enter the viewport. Printing bypasses that viewport lifecycle, so make
    // the existing image element request its real source before layout.
    image.loading = 'eager';
    if (!image.getAttribute('src')) {
      image.src = deferredSource;
    }
  }
}

async function waitForPrintResources(root: HTMLElement): Promise<void> {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  await Promise.all(images.map((image) => {
    if (!image.getAttribute('src') || image.complete) return Promise.resolve();

    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  }));
}

/**
 * Prepare the currently displayed document DOM for native PDF printing.
 *
 * No print copy is mounted here. The native WebView prints the same editor
 * surface that the user is viewing; print-only CSS expands its scroll surface
 * to the complete document and hides surrounding application chrome.
 */
export async function preparePdfPrint(editor: Editor | null, host: 'column-1' | 'column-2' = 'column-1'): Promise<() => void> {
  const root = findCurrentDocumentRoot(editor, host);
  if (!root) {
    throw new Error('Current document editor is not mounted');
  }

  const changes = classifyPrintDom(root);
  preparePrintImages(root);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    restorePrintDom(changes);
  };

  try {
    await nextFrame();
    await waitForPrintResources(root);
  } catch (error) {
    restore();
    throw error;
  }

  return restore;
}
