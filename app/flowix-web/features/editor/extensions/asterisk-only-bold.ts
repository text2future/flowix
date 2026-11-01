import { markInputRule, markPasteRule } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';

/**
 * Asterisk-only bold.
 *
 * Tiptap's stock Bold also accepts `__text__`, both while typing and while
 * pasting. That silently swallows identifiers such as `__pycache__` or
 * `__init__.py`, so those two rules are dropped here while the mark itself
 * (HTML parsing, commands, `**` serialization) stays untouched.
 */
const ASTERISK_BOLD_INPUT_RE = /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/;
const ASTERISK_BOLD_PASTE_RE = /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))/g;

export const AsteriskOnlyBold = Bold.extend({
  addInputRules() {
    return [
      markInputRule({
        find: ASTERISK_BOLD_INPUT_RE,
        type: this.type,
      }),
    ];
  },

  addPasteRules() {
    return [
      markPasteRule({
        find: ASTERISK_BOLD_PASTE_RE,
        type: this.type,
      }),
    ];
  },
});

export default AsteriskOnlyBold;
