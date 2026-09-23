import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { readClipboardSnapshot, type ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { createManagedPasteRules, executeManagedPasteRules } from '@features/editor/extensions/paste-rules/rules';
import { isInternalEditorHtml, sanitizeExternalHtml } from '@features/editor/extensions/paste-rules/html-sanitizer';
import type { PasteContext } from '@features/editor/extensions/paste-rules/types';
import type { Editor } from '@tiptap/core';

export const ManagedPasteRules = Extension.create<{ memoId?: string }>({
  name: 'managedPasteRules',
  priority: 1100,

  addOptions() {
    return {
      memoId: undefined,
    };
  },

  addProseMirrorPlugins() {
    const rules = createManagedPasteRules();

    return [
      new Plugin({
        key: new PluginKey('managedPasteRules'),
        props: {
          // Clean external webpage markup before ProseMirror parses the
          // clipboard into a Slice. Keeping the native paste path gives us one
          // standard transaction, schema-driven parsing, and native history.
          transformPastedHTML: (html) => isInternalEditorHtml(html)
            ? html
            : sanitizeExternalHtml(html),
          handlePaste: (view, event) => {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;
            const snapshot = readClipboardSnapshot(clipboardData);

            const ctx: PasteContext = {
              editor: this.editor,
              view,
              memoId: this.options.memoId,
              event,
              types: snapshot.types,
              markdown: snapshot.markdown,
              text: snapshot.text,
              html: snapshot.html,
              uriList: snapshot.uriList,
              files: snapshot.files,
              sourceMime: snapshot.sourceMime,
            };

            const result = executeManagedPasteRules(ctx, rules);
            if (result === 'handled') {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }

            return false;
          },
        },
      }),
    ];
  },
});

function createSyntheticPasteEvent(): ClipboardEvent {
  try {
    return new ClipboardEvent('paste', { bubbles: true, cancelable: true });
  } catch {
    return new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  }
}

/**
 * Re-enter the same paste pipeline used by native ProseMirror paste events.
 * The snapshot is intentionally supplied explicitly so callers can paste a
 * transformed payload without exposing the original clipboard contents to
 * the rules a second time.
 */
export function pasteClipboardSnapshot(
  editor: Editor,
  snapshot: ClipboardSnapshot,
  memoId?: string,
): boolean {
  // This path is also used when a title paste sends its body remainder into
  // the editor. Make the target editor explicit for the duration of the
  // programmatic paste; the title editor may restore its own focus on the
  // next animation frame according to the independent undo-domain policy.
  editor.view.focus();
  const event = createSyntheticPasteEvent();
  const ctx: PasteContext = {
    editor,
    view: editor.view,
    memoId,
    event,
    types: snapshot.types,
    markdown: snapshot.markdown,
    text: snapshot.text,
    html: snapshot.html,
    uriList: snapshot.uriList,
    files: snapshot.files,
    sourceMime: snapshot.sourceMime,
  };
  const result = executeManagedPasteRules(ctx);
  if (result === 'handled') return true;

  if (snapshot.markdown.trim().length > 0) {
    return editor.view.pasteText(snapshot.markdown, event);
  }
  if (snapshot.html.trim().length > 0) {
    return editor.view.pasteHTML(snapshot.html, event);
  }
  if (snapshot.text.length > 0) {
    return editor.view.pasteText(snapshot.text, event);
  }
  return false;
}

export default ManagedPasteRules;
