import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { isImeKeyboardEvent } from '@/lib/input-method';

/** Keep candidate confirmation away from editor keymaps without cancelling the IME's default action. */
export const ImeEnterGuard = Extension.create({
  name: 'imeEnterGuard',
  addProseMirrorPlugins() {
    return [new Plugin({
      view(view) {
        let composing = false;
        let justEnded = false;
        let resetTimer: ReturnType<typeof setTimeout> | undefined;
        const belongsToEditor = (event: Event) => event.target === view.dom;
        const start = (event: Event) => {
          if (!belongsToEditor(event)) return;
          clearTimeout(resetTimer);
          justEnded = false;
          composing = true;
        };
        const end = (event: Event) => {
          if (!belongsToEditor(event)) return;
          composing = false;
          // WebKit can dispatch the confirming Enter after compositionend in
          // the same event turn, with neither isComposing nor keyCode 229.
          justEnded = true;
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => { justEnded = false; }, 0);
        };
        const keydown = (event: KeyboardEvent) => {
          if (!belongsToEditor(event) || event.key !== 'Enter') return;
          if (isImeKeyboardEvent(event, composing)) {
            justEnded = false;
            event.stopImmediatePropagation();
          } else if (justEnded) {
            justEnded = false;
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        };
        view.dom.addEventListener('compositionstart', start, true);
        view.dom.addEventListener('compositionend', end, true);
        view.dom.addEventListener('keydown', keydown, true);
        return { destroy() {
          clearTimeout(resetTimer);
          view.dom.removeEventListener('compositionstart', start, true);
          view.dom.removeEventListener('compositionend', end, true);
          view.dom.removeEventListener('keydown', keydown, true);
        } };
      },
    })];
  },
});
