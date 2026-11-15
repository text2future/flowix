import { sanitizeLinkHref } from '@/lib/safe-link';
import Link from '@tiptap/extension-link';
import { Extension, markInputRule, markPasteRule } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  findLastMarkdownLink,
  findMarkdownLinkPasteMatches,
  markdownLinkMarkdownSpec,
} from './markdown-link-markdown';
export {
  findMarkdownLinkPasteMatches,
  isPlainMarkdownLinkUrl,
  normalizePlainLinkHref,
} from './markdown-link-markdown';

export const linkSelectionHighlightPluginKey = new PluginKey<DecorationSet>('linkSelectionHighlight');

// @ts-expect-error The Markdown runtime accepts null to let subsequent handlers process non-link tokens.
export const MarkdownLink = Link.extend({
  priority: 50,
  ...markdownLinkMarkdownSpec,

  addInputRules() {
    const parentRules = this.parent?.() ?? [];
    return [
      markInputRule({
        find: findLastMarkdownLink,
        type: this.type,
        getAttributes: match => ({
          href: match.data?.href,
          title: match.data?.title ?? null,
        }),
      }),
      ...parentRules,
    ];
  },

  addPasteRules() {
    const parentRules = this.parent?.() ?? [];
    return [
      markPasteRule({
        find: findMarkdownLinkPasteMatches,
        type: this.type,
        getAttributes: match => ({
          href: match.data?.href,
          title: match.data?.title ?? null,
        }),
      }),
      ...parentRules,
    ];
  },
}).configure({
  openOnClick: false,
  isAllowedUri: href => Boolean(sanitizeLinkHref(href)),
  linkOnPaste: true,
  autolink: true,
  HTMLAttributes: {
    target: '_blank',
    rel: 'noopener noreferrer',
  },
});

export const LinkSelectionHighlight = Extension.create({
  name: 'linkSelectionHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: linkSelectionHighlightPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, value) => {
            const meta = tr.getMeta(linkSelectionHighlightPluginKey) as
              | { from?: number; to?: number; clear?: boolean }
              | undefined;

            if (meta?.clear) {
              return DecorationSet.empty;
            }

            if (typeof meta?.from === 'number' && typeof meta?.to === 'number' && meta.from < meta.to) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, {
                  class: 'editor-link-selection-highlight',
                }),
              ]);
            }

            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
