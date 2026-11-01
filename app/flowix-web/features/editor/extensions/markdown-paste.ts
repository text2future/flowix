import { Extension, markPasteRule, nodePasteRule, PasteRule } from '@tiptap/core';
import type { MarkType } from '@tiptap/pm/model';

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  priority: 1000,

  addPasteRules(): PasteRule[] {
    const schema = this.editor.schema;
    const rules: PasteRule[] = [];

    // Tiptap names these marks `bold` / `italic`. Resolving a mark that the
    // schema does not contain used to reach `undefined.create()` inside the
    // paste transaction, which broke the whole paste; skip it instead.
    const addMarkRule = (find: RegExp, type: MarkType | undefined) => {
      if (type) rules.push(markPasteRule({ find, type }));
    };

    addMarkRule(/\*\*([^*]+)\*\*/g, schema.marks.bold);
    addMarkRule(/\*([^*]+)\*/g, schema.marks.italic);
    addMarkRule(/`([^`]+)`/g, schema.marks.code);
    addMarkRule(/~~([^~]+)~~/g, schema.marks.strike);

    if (schema.nodes.fileAttachment) {
      rules.push(nodePasteRule({
        find: /\[([^\]]+)\]\((asset:\/\/[^)]+|https?:\/\/asset\.localhost\/[^)]+)\)/g,
        type: schema.nodes.fileAttachment,
        getAttributes: match => ({
          name: match[1],
          url: match[2],
          storageMode: 'attachment',
          storageKey: decodeURIComponent(
            match[2]
              .replace('asset://localhost/', '')
              .replace('asset://', '')
              .replace('http://asset.localhost/', '')
              .replace('https://asset.localhost/', ''),
          ),
        }),
      }));
    }

    if (schema.nodes.image) {
      rules.push(nodePasteRule({
        find: /!\[([^\]]*)\]\((?!asset:\/\/)(?!https?:\/\/asset\.localhost\/)([^)]+)\)/g,
        type: schema.nodes.image,
        getAttributes: match => ({
          src: match[2],
          alt: match[1],
        }),
      }));
    }

    if (schema.nodes.image) {
      rules.push(nodePasteRule({
        find: /!\[([^\]]*)\]\((asset:\/\/[^)]+|https?:\/\/asset\.localhost\/[^)]+)\)/g,
        type: schema.nodes.image,
        getAttributes: match => ({
          src: match[2],
          alt: match[1] || null,
          title: null,
          storageMode: 'attachment',
          storageKey: decodeURIComponent(
            match[2]
              .replace('asset://localhost/', '')
              .replace('asset://', '')
              .replace('http://asset.localhost/', '')
              .replace('https://asset.localhost/', ''),
          ),
        }),
      }));
    }

    return rules;
  },
});

export default MarkdownPaste;
