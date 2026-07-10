import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { readClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import { createManagedPasteRules } from '@features/editor/extensions/paste-rules/rules';
import type { PasteContext, PasteRuleResult } from '@features/editor/extensions/paste-rules/types';

export const ManagedPasteRules = Extension.create({
  name: 'managedPasteRules',
  priority: 1100,

  addProseMirrorPlugins() {
    const rules = createManagedPasteRules();

    return [
      new Plugin({
        key: new PluginKey('managedPasteRules'),
        props: {
          handlePaste: (view, event) => {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;
            const snapshot = readClipboardSnapshot(clipboardData);

            const ctx: PasteContext = {
              editor: this.editor,
              view,
              event,
              types: snapshot.types,
              text: snapshot.text,
              html: snapshot.html,
              files: snapshot.files,
            };

            for (const rule of rules) {
              let result: PasteRuleResult;
              try {
                if (!rule.match(ctx)) continue;
                result = rule.run(ctx);
              } catch (err) {
                console.warn('[paste-rules] rule failed:', {
                  ruleId: rule.id,
                  kind: rule.kind,
                  error: err,
                });
                continue;
              }

              if (result === 'handled') {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }

              if (result === 'default') {
                return false;
              }
            }

            return false;
          },
        },
      }),
    ];
  },
});

export default ManagedPasteRules;
