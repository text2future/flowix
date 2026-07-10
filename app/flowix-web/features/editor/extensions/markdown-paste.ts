import { Extension, markPasteRule, nodePasteRule, PasteRule } from '@tiptap/core';

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  priority: 1000,

  addPasteRules(): PasteRule[] {
    const schema = this.editor.schema;
    const rules: PasteRule[] = [
      markPasteRule({
        find: /\*\*([^*]+)\*\*/g,
        type: schema.marks.strong,
      }),
      markPasteRule({
        find: /\*([^*]+)\*/g,
        type: schema.marks.em,
      }),
      markPasteRule({
        find: /_([^_]+)_/g,
        type: schema.marks.em,
      }),
      markPasteRule({
        find: /`([^`]+)`/g,
        type: schema.marks.code,
      }),
      markPasteRule({
        find: /~~([^~]+)~~/g,
        type: schema.marks.strike,
      }),
    ];

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
