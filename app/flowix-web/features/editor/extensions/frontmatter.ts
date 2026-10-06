import { Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Selection } from '@tiptap/pm/state';
import { FrontmatterPropertyNodeView } from '@features/editor/extensions/frontmatter-node-view';
import { updateVisibleFrontmatterProperty } from '@features/document/properties/frontmatter-model';
import { resolvePropertyPreset } from '@features/document/properties/presets';
import { getPropertyFieldPreferences } from '@features/preferences/public/runtime-api';

// Consume a BOM both at the true file boundary and immediately after the
// frontmatter block. The latter repairs legacy imports where key injection
// displaced the UTF-8 signature into the Markdown body.
const FRONTMATTER_TOKEN_RE = /^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n\uFEFF?|$)/;

const Frontmatter = Node.create({
  name: 'frontmatter',
  priority: 1000,
  group: 'block',
  defining: true,
  selectable: false,
  draggable: false,
  content: '',

  addOptions() {
    return {
      propertyTargetId: undefined as string | undefined,
      onViewSourceMode: undefined as (() => void) | undefined,
    };
  },

  addAttributes() {
    return {
      yamlContent: {
        default: '',
        rendered: false,
      },
    };
  },

  addNodeView() {
    return ({ node, view, getPos }) => new FrontmatterPropertyNodeView(
      node,
      view,
      getPos,
      this.options.propertyTargetId,
      this.options.onViewSourceMode,
    );
  },

  addKeyboardShortcuts() {
    return {
      'Mod-a': () => selectEditableDocumentContent(this.editor),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('frontmatter-add-first-property'),
        view: (view) => {
          const handleAddProperty = (event: Event) => {
            const detail = (event as CustomEvent<{ propertyTargetId?: string; presetKey?: string }>).detail;
            if (!this.options.propertyTargetId || detail?.propertyTargetId !== this.options.propertyTargetId || !view.editable) return;
            if (view.state.doc.firstChild?.type.name === this.name) return;
            // When a preset is requested, seed the frontmatter with that preset's
            // key/kind so the first row matches the user's pick.
            const preset = detail?.presetKey
              ? resolvePropertyPreset(detail.presetKey, getPropertyFieldPreferences())
              : null;
            const yamlContent = updateVisibleFrontmatterProperty(
              '',
              null,
              preset?.key ?? 'key1',
              '',
              preset?.kind ?? 'Text',
            );
            view.dispatch(view.state.tr.insert(0, view.state.schema.nodes.frontmatter.create({ yamlContent })));
          };
          window.addEventListener('flowix:add-property', handleAddProperty);
          return { destroy: () => window.removeEventListener('flowix:add-property', handleAddProperty) };
        },
      }),
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
      return /^\uFEFF?(?:[ \t]*\r?\n)*---/.test(src) ? 0 : -1;
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

/**
 * Select the user-editable document body while keeping the protected YAML
 * frontmatter outside the selection. Documents without frontmatter use the
 * editor's regular select-all command.
 */
export function selectEditableDocumentContent(editor: Editor): boolean {
  const { state, view } = editor;
  const firstNode = state.doc.firstChild;
  if (firstNode?.type.name !== Frontmatter.name) {
    return editor.commands.selectAll();
  }

  view.dispatch(
    state.tr
      .setSelection(createSelectionAfterFrontmatter(state.doc, firstNode.nodeSize)),
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
