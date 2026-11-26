import { preloadDocumentEditor } from '../components/lazy-document-editor';

/**
 * Warm the Markdown editor chunk while the workspace is idle.
 *
 * The editor module is the heaviest lazy chunk in the desktop window — TipTap,
 * ProseMirror, Shiki and the Phosphor icon barrel — and it is imported nowhere
 * in the startup graph on purpose (see the note in `main-window-effects.tsx`
 * about keeping Node views out of the shell). The first document open in a
 * session therefore pays for the whole download + compile *inside* the open:
 * measured 1.7 s in `vite dev` (195 module requests, 14 MB) on top of the
 * ~200 ms the editor itself needs.
 *
 * Startup stage 3 runs after the first workbench paint, which moves that cost
 * to a moment when the user is looking at the workspace instead of waiting for
 * a note. Idle scheduling keeps it out of the shell's critical path; the
 * timeout guarantees it still happens on a busy window.
 */
export function preloadEditorChunkOnIdle(): void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
  };

  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(() => preloadDocumentEditor('preload'), { timeout: 2000 });
    return;
  }

  window.setTimeout(() => preloadDocumentEditor('preload'), 200);
}
