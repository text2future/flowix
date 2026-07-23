import { Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Selection } from '@tiptap/pm/state';
import { FrontmatterPropertyNodeView } from '@features/editor/extensions/frontmatter-node-view';

const FRONTMATTER_TOKEN_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const Frontmatter = Node.create({
  name: 'frontmatter',
  priority: 1000,
  group: 'block',
  defining: true,
  selectable: false,
  draggable: false,
  content: '',

  addAttributes() {
    return {
      yamlContent: {
        default: '',
        rendered: false,
      },
    };
  },

  addNodeView() {
    return ({ node, view, getPos }) => new FrontmatterPropertyNodeView(node, view, getPos);
  },

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => selectBodyContent(this.editor, this.name),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('frontmatter-protection'),
        appendTransaction: (_transactions, _oldState, newState) => {
          const firstNode = newState.doc.firstChild;
          if (firstNode?.type.name !== this.name) return null;
          if (!selectionIncludesFrontmatter(newState.selection, firstNode.nodeSize)) return null;

          return newState.tr.setSelection(
            createSelectionAfterFrontmatter(newState.doc, firstNode.nodeSize),
          );
        },
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged) return true;
          const currentFirstNode = state.doc.firstChild;
          if (currentFirstNode?.type.name !== this.name) return true;
          return transaction.doc.firstChild?.type.name === this.name;
        },
      }),
    ];
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="frontmatter"]',
      getAttrs: (dom) => ({
        yamlContent: (dom as HTMLElement).getAttribute('data-yaml-content') ?? '',
      }),
    }];
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        'data-type': 'frontmatter',
        'data-yaml-content': String(node.attrs.yamlContent ?? ''),
      },
    ];
  },

  markdownTokenizer: {
    name: 'frontmatter',
    level: 'block',
    start(src: string) {
      return /^\uFEFF?---/.test(src) ? 0 : -1;
    },
    tokenize(src: string, tokens?: unknown[]): { type: string; raw: string } | undefined {
      if (tokens && tokens.length > 0) return undefined;
      const match = FRONTMATTER_TOKEN_RE.exec(src);
      return match ? { type: 'frontmatter', raw: match[0] } : undefined;
    },
  },

  parseMarkdown(token) {
    const raw = token.raw ?? '';
    const match = FRONTMATTER_TOKEN_RE.exec(raw);
    if (!match) return { type: 'text', text: raw };
    return {
      type: 'frontmatter',
      attrs: { yamlContent: match[1].trim() },
    };
  },

  renderMarkdown(node) {
    return `---\n${String(node.attrs?.yamlContent ?? '')}\n---\n`;
  },
});

function selectBodyContent(editor: Editor, frontmatterNodeName: string) {
  const { state, view } = editor;
  const firstNode = state.doc.firstChild;
  if (firstNode?.type.name !== frontmatterNodeName) return false;

  view.dispatch(
    state.tr
      .setSelection(createSelectionAfterFrontmatter(state.doc, firstNode.nodeSize))
      .scrollIntoView(),
  );
  return true;
}

function selectionIncludesFrontmatter(selection: Selection, frontmatterEnd: number) {
  return (
    selection instanceof AllSelection
    || (!selection.empty && selection.from < frontmatterEnd && selection.to > 0)
  );
}

function createSelectionAfterFrontmatter(doc: ProseMirrorNode, frontmatterEnd: number) {
  const to = doc.content.size;
  const $from = doc.resolve(Math.min(frontmatterEnd, to));
  const $to = doc.resolve(to);
  return frontmatterEnd < to
    ? TextSelection.between($from, $to, 1)
    : TextSelection.near($to, -1);
}

export default Frontmatter;
