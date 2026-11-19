import { Node, mergeAttributes } from '@tiptap/core';
import type { NodeViewRendererProps } from '@tiptap/core';
import type { JSONContent, MarkdownToken } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { boundedIndexOf } from '@features/editor/markdown-tokenizer-source';
import {
  componentPreviewDocument,
  decodeComponentPayload,
  encodeComponentPayload,
  getComponentPreviewHeight,
  normalizeCustomComponent,
  type CustomComponent,
} from './custom-component-format';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    customComponentBlock: {
      insertCustomComponent: (component: CustomComponent) => ReturnType;
    };
  }
}

function createCustomComponentNodeView({ node: initialNode }: NodeViewRendererProps) {
  let currentNode = initialNode;
  const dom = document.createElement('div');
  dom.className = 'custom-component-block';
  dom.contentEditable = 'false';

  const preview = document.createElement('iframe');
  preview.className = 'custom-component-block__preview';
  preview.setAttribute('sandbox', '');
  preview.setAttribute('scrolling', 'no');
  preview.tabIndex = -1;
  preview.loading = 'lazy';
  preview.referrerPolicy = 'no-referrer';

  const render = () => {
    const component = normalizeCustomComponent(currentNode.attrs);
    dom.classList.toggle('custom-component-block--invalid', !component);
    if (!component) {
      dom.removeAttribute('data-custom-component-id');
      dom.removeAttribute('data-custom-component-version');
      dom.textContent = '组件数据无法读取';
      return;
    }

    dom.dataset.customComponentId = component.id;
    dom.dataset.customComponentVersion = String(component.version);
    preview.title = component.name;
    preview.style.height = `${getComponentPreviewHeight(component.html)}px`;
    preview.srcdoc = componentPreviewDocument(component.html);
    dom.replaceChildren(preview);
  };

  render();

  return {
    dom,
    update(updatedNode: typeof initialNode) {
      if (updatedNode.type !== initialNode.type) return false;
      if (currentNode.eq(updatedNode)) return true;
      currentNode = updatedNode;
      render();
      return true;
    },
    selectNode() {
      dom.classList.add('is-selected');
    },
    deselectNode() {
      dom.classList.remove('is-selected');
    },
    ignoreMutation() {
      return true;
    },
  };
}

const COMPONENT_MARKER = '<!-- flowix:component-block v1 ';
const COMPONENT_RE = /^<!--[ \t]*flowix:component-block[ \t]+v1[ \t]+([A-Za-z0-9+/=]+)[ \t]*-->[ \t]*(?:\r?\n|$)/;
const COMPONENT_HTML_MARKER = '<flowix-component-block';
const COMPONENT_HTML_CLOSE = '</flowix-component-block>';
const COMPONENT_HTML_OPEN_RE = /^<flowix-component-block\b([^>]*)>/i;

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const point = code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[code.toLowerCase()] ?? entity;
  });
}

function readHtmlAttribute(source: string, name: string): string | undefined {
  const matcher = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = matcher.exec(source);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtmlAttribute(value);
}

export const CustomComponentBlock = Node.create({
  name: 'customComponentBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: { default: '', rendered: false },
      name: { default: '', rendered: false },
      version: { default: 1, rendered: false },
      html: { default: '', rendered: false },
    };
  },

  parseHTML() {
    return [{
      tag: 'flowix-component-block',
      getAttrs: (element) => {
        const wrapper = element as HTMLElement;
        const component = normalizeCustomComponent({
          id: wrapper.getAttribute('data-flowix-component-id'),
          name: wrapper.getAttribute('data-flowix-component-name'),
          version: Number(wrapper.getAttribute('data-flowix-component-version')),
          html: wrapper.innerHTML,
        });
        return component ? { ...component } : false;
      },
    }, {
      tag: 'div[data-flowix-component-block]',
      getAttrs: (element) => {
        const payload = (element as HTMLElement).getAttribute('data-flowix-component-block');
        const component = payload ? decodeComponentPayload(payload) : null;
        return component ? { ...component } : false;
      },
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const component = normalizeCustomComponent(node.attrs);
    const payload = component ? encodeComponentPayload(component) : '';
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-flowix-component-block': payload,
      'data-flowix-component-id': component?.id ?? '',
    }), 'HTML 组件'];
  },

  addCommands() {
    return {
      insertCustomComponent: (component: CustomComponent) => ({ state, dispatch }) => {
        const normalized = normalizeCustomComponent(component);
        const nodeType = state.schema.nodes[this.name];
        const paragraph = state.schema.nodes.paragraph;
        if (!normalized || !nodeType || !paragraph) return false;
        if (!dispatch) return true;
        const { selection } = state;
        if (!selection.empty || !selection.$from.parent.isTextblock) return false;

        const { $from } = selection;
        const node = nodeType.create(normalized);
        const blockFrom = $from.before($from.depth);
        const blockTo = $from.after($from.depth);
        let transaction = state.tr;
        let insertAt = blockFrom;

        if ($from.parent.content.size === 0) {
          transaction = transaction.replaceWith(blockFrom, blockTo, [node, paragraph.create()]);
        } else if ($from.parentOffset === 0) {
          transaction = transaction.insert(blockFrom, [node, paragraph.create()]);
        } else if ($from.parentOffset === $from.parent.content.size) {
          insertAt = blockTo;
          transaction = transaction.insert(blockTo, [node, paragraph.create()]);
        } else {
          return false;
        }

        const selectionPosition = insertAt + node.nodeSize + 1;
        transaction = transaction.setSelection(TextSelection.create(transaction.doc, selectionPosition));
        dispatch(transaction.scrollIntoView());
        return true;
      },
    };
  },

  addNodeView() {
    // This editor mounts Tiptap directly instead of using React's EditorContent.
    // ReactNodeViewRenderer requires EditorContent's contentComponent, so it
    // silently falls back to renderHTML and shows only its static placeholder.
    return createCustomComponentNodeView;
  },

  markdownTokenizer: {
    name: 'customComponentBlock',
    level: 'block' as const,
    start(src: string) {
      const legacyIndex = boundedIndexOf(src, COMPONENT_MARKER);
      const htmlIndex = boundedIndexOf(src, COMPONENT_HTML_MARKER);
      if (legacyIndex < 0) return htmlIndex;
      if (htmlIndex < 0) return legacyIndex;
      return Math.min(legacyIndex, htmlIndex);
    },
    tokenize(src: string) {
      const legacyMatch = COMPONENT_RE.exec(src);
      if (legacyMatch) {
        const component = decodeComponentPayload(legacyMatch[1]);
        return component ? { type: 'customComponentBlock', raw: legacyMatch[0], component } : undefined;
      }

      const opening = COMPONENT_HTML_OPEN_RE.exec(src);
      if (!opening) return undefined;
      const closingTag = /<\/flowix-component-block>/ig;
      closingTag.lastIndex = opening[0].length;
      const closing = closingTag.exec(src);
      if (!closing) return undefined;
      const closingStart = closing.index;
      const closeEnd = closingStart + closing[0].length;
      const html = src.slice(opening[0].length, closingStart).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      const component = normalizeCustomComponent({
        id: readHtmlAttribute(opening[1], 'data-flowix-component-id'),
        name: readHtmlAttribute(opening[1], 'data-flowix-component-name'),
        version: Number(readHtmlAttribute(opening[1], 'data-flowix-component-version')),
        html,
      });
      return component
        ? { type: 'customComponentBlock', raw: src.slice(0, closeEnd), component }
        : undefined;
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const component = normalizeCustomComponent((token as MarkdownToken & { component?: unknown }).component);
    return component
      ? { type: 'customComponentBlock', attrs: component }
      : { type: 'paragraph', content: [{ type: 'text', text: token.raw ?? '' }] };
  },

  renderMarkdown(node: JSONContent) {
    const component = normalizeCustomComponent(node.attrs);
    if (!component) return '';
    return [
      `<flowix-component-block data-flowix-component-id="${escapeHtmlAttribute(component.id)}" data-flowix-component-name="${escapeHtmlAttribute(component.name)}" data-flowix-component-version="${component.version}">`,
      component.html.trim(),
      COMPONENT_HTML_CLOSE,
    ].join('\n');
  },
});
