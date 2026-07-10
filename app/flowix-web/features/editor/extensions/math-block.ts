import { Node as TiptapNode, mergeAttributes } from '@tiptap/core';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { translate, type I18nKey } from '@features/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathBlock: {
      insertMathBlock: (latex?: string) => ReturnType;
    };
  }
}

const DEFAULT_LATEX = '';
const PLACEHOLDER_LATEX = '\\frac{a}{b}';
const BLOCK_MATH_RE = /^\$\$\s*\n?([\s\S]*?)\n?\s*\$\$(?:\n|$)/;

// NodeView 不在 React 树内, 不能用 useI18n, 走 user-settings-store 直读当前语言。
function tKey(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(useUserSettingsStore.getState().settings.language, key, params);
}

function normalizeLatex(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function renderKatex(target: HTMLElement, latex: string) {
  const source = latex || PLACEHOLDER_LATEX;

  try {
    katex.render(source, target, {
      displayMode: true,
      throwOnError: false,
      strict: false,
    });
  } catch {
    target.textContent = source;
  }
}

export const MathBlock = TiptapNode.create({
  name: 'mathBlock',

  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: {
        default: DEFAULT_LATEX,
        parseHTML: (element) => element.getAttribute('data-latex') ?? DEFAULT_LATEX,
        renderHTML: (attributes) => ({
          'data-latex': normalizeLatex(attributes.latex),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="math-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'math-block' })];
  },

  addCommands() {
    return {
      insertMathBlock:
        (latex = DEFAULT_LATEX) =>
        ({ state, dispatch, tr }) => {
          const nodeType = state.schema.nodes[this.name];
          if (!nodeType) return false;

          const node = nodeType.create({ latex: normalizeLatex(latex) });
          tr.replaceSelectionWith(node);

          dispatch?.(tr.scrollIntoView());
          return true;
        },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let latex = normalizeLatex(node.attrs.latex);
      let active = latex.length === 0;

      const dom = document.createElement('div');
      dom.className = 'math-block-node';
      dom.dataset.type = 'math-block';

      const display = document.createElement('div');
      display.className = 'math-block-display';
      dom.append(display);

      const editorWrap = document.createElement('div');
      editorWrap.className = 'math-block-editor';

      const hint = document.createElement('div');
      hint.className = 'math-block-hint';
      hint.textContent = tKey('editor.math.hint');

      const textarea = document.createElement('textarea');
      textarea.className = 'math-block-input';
      textarea.placeholder = tKey('editor.math.placeholder');
      textarea.rows = 2;
      textarea.spellcheck = false;
      textarea.value = latex;

      editorWrap.append(hint, textarea);
      dom.append(editorWrap);

      const setActive = (nextActive: boolean) => {
        active = nextActive;
        dom.classList.toggle('is-active', active);
        if (active) {
          window.requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
          });
        }
      };

      const commit = () => {
        latex = normalizeLatex(textarea.value);
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (typeof pos === 'number') {
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              latex,
            })
          );
        }
        renderKatex(display, latex);
      };

      textarea.addEventListener('input', () => {
        latex = normalizeLatex(textarea.value);
        renderKatex(display, latex);
      });

      textarea.addEventListener('blur', () => {
        commit();
        setActive(false);
      });

      textarea.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          textarea.blur();
        }
      });

      dom.addEventListener('mousedown', (event) => {
        if (active) return;
        event.preventDefault();
        setActive(true);
      });

      renderKatex(display, latex);
      setActive(active);

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type.name !== this.name) return false;
          latex = normalizeLatex(updatedNode.attrs.latex);
          if (textarea.value !== latex) textarea.value = latex;
          renderKatex(display, latex);
          return true;
        },
        stopEvent: (event) => active && editorWrap.contains(event.target as Node),
        ignoreMutation: () => true,
      };
    };
  },

  markdownTokenizer: {
    name: 'mathBlock',
    level: 'block' as const,
    start(src: string) {
      return src.indexOf('$$');
    },
    tokenize(src: string) {
      const match = BLOCK_MATH_RE.exec(src);
      if (!match) return undefined;
      return {
        type: 'mathBlock',
        raw: match[0],
        text: match[1],
      };
    },
  },

  parseMarkdown(token: any) {
    return {
      type: 'mathBlock',
      attrs: {
        latex: normalizeLatex(token.text),
      },
    };
  },

  renderMarkdown(node: any) {
    const latex = normalizeLatex(node.attrs?.latex);
    return `$$\n${latex}\n$$`;
  },
});
