import { getStyleProperty, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { MarkdownLexerConfiguration, MarkdownToken } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';

export const FLOWIX_TEXT_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;

export type FlowixTextColor = (typeof FLOWIX_TEXT_COLORS)[number];

export interface FlowixTextMarkAttributes {
  color?: string | null;
  flowixBg?: FlowixTextColor | null;
  flowixFg?: FlowixTextColor | null;
}

export interface FlowixTextStylePatch {
  bg?: FlowixTextColor | null;
  fg?: FlowixTextColor | null;
}

const FLOWIX_TEXT_COLOR_MIGRATION_ALIASES: Record<string, FlowixTextColor> = {
  danger: 'red',
  'on-danger': 'red',
};

const FLOWIX_TEXT_MARK_RE = /^==([^=\n]+)==[ \t]*<!--\s*flowix:text\s+(\{[^}\r\n]*\})\s*-->/;

export function isFlowixTextColor(value: unknown): value is FlowixTextColor {
  return typeof value === 'string'
    && (FLOWIX_TEXT_COLORS as readonly string[]).includes(value);
}

function normalizeFlowixTextColor(value: unknown): FlowixTextColor | undefined {
  if (isFlowixTextColor(value)) return value;
  return typeof value === 'string' ? FLOWIX_TEXT_COLOR_MIGRATION_ALIASES[value] : undefined;
}

export function normalizeFlowixTextStyle(value: unknown): FlowixTextStylePatch | null {
  if (!value || typeof value !== 'object') return null;

  const payload = value as { bg?: unknown; fg?: unknown };
  const bg = payload.bg == null ? null : normalizeFlowixTextColor(payload.bg);
  const fg = payload.fg == null ? null : normalizeFlowixTextColor(payload.fg);

  if (bg === undefined && fg === undefined) return null;

  return { bg: bg ?? null, fg: fg ?? null };
}

export function parseFlowixTextStylePayload(payload: string): FlowixTextStylePatch | null {
  try {
    return normalizeFlowixTextStyle(JSON.parse(payload));
  } catch {
    return null;
  }
}

function normalizeMarkStyle(attrs: Record<string, unknown> | undefined): FlowixTextStylePatch {
  return {
    bg: normalizeFlowixTextColor(attrs?.flowixBg) ?? null,
    fg: normalizeFlowixTextColor(attrs?.flowixFg) ?? null,
  };
}

function hasFlowixTextStyle(attrs: FlowixTextStylePatch): boolean {
  return attrs.bg !== null || attrs.fg !== null;
}

/**
 * Highlight mark with a small semantic color payload.
 *
 * The payload is kept on the mark while editing. Markdown persistence uses
 * the adjacent HTML comment format so older Markdown readers still see the
 * normal `==text==` highlight.
 */
export const FlowixHighlight = Highlight.extend({
  name: 'highlight',

  addAttributes() {
    const parentAttributes = this.parent?.() ?? {};

    return {
      ...parentAttributes,
      flowixBg: {
        default: null,
        parseHTML: element => {
          const value = element.getAttribute('data-flowix-bg');
          return isFlowixTextColor(value) ? value : null;
        },
        renderHTML: attributes => (
          attributes.flowixBg
            ? { 'data-flowix-bg': attributes.flowixBg }
            : {}
        ),
      },
      flowixFg: {
        default: null,
        parseHTML: element => {
          const value = element.getAttribute('data-flowix-fg');
          return isFlowixTextColor(value) ? value : null;
        },
        renderHTML: attributes => (
          attributes.flowixFg
            ? { 'data-flowix-fg': attributes.flowixFg }
            : {}
        ),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'mark' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  renderMarkdown: (node, h) => {
    const style = normalizeMarkStyle(node.attrs as Record<string, unknown> | undefined);
    const content = h.renderChildren(node);

    if (!hasFlowixTextStyle(style)) {
      return `==${content}==`;
    }

    return `==${content}==<!-- flowix:text ${JSON.stringify({
      bg: style.bg,
      fg: style.fg,
    })} -->`;
  },

  parseMarkdown: (token, h) => {
    const style = normalizeFlowixTextStyle(token.attrs);
    return h.applyMark('highlight', h.parseInline(token.tokens || []), {
      color: null,
      flowixBg: style?.bg ?? null,
      flowixFg: style?.fg ?? null,
    });
  },

  markdownTokenizer: {
    name: 'highlight',
    level: 'inline',
    start: (src: string) => src.indexOf('=='),
    tokenize(src: string, _tokens: MarkdownToken[], h: MarkdownLexerConfiguration) {
      const match = FLOWIX_TEXT_MARK_RE.exec(src);
      if (match) {
        const style = parseFlowixTextStylePayload(match[2]);
        if (!style) return undefined;

        const innerContent = match[1].trim();
        return {
          type: 'highlight',
          raw: match[0],
          text: innerContent,
          tokens: h.inlineTokens(innerContent),
          attrs: style,
        };
      }

      const legacyMatch = /^==(?!\s+==)([^=]+?)(?<!\s)==/.exec(src);
      if (!legacyMatch) return undefined;

      const innerContent = legacyMatch[1].trim();
      return {
        type: 'highlight',
        raw: legacyMatch[0],
        text: innerContent,
        tokens: h.inlineTokens(innerContent),
        attrs: { bg: null, fg: null },
      };
    },
  },
});

/** Apply one side of the semantic style while preserving the other side. */
export function setFlowixTextStyle(
  editor: Editor,
  patch: FlowixTextStylePatch,
): boolean {
  const current = editor.getAttributes('highlight') as FlowixTextMarkAttributes;
  const hasBgPatch = Object.prototype.hasOwnProperty.call(patch, 'bg');
  const hasFgPatch = Object.prototype.hasOwnProperty.call(patch, 'fg');
  const nextBg = hasBgPatch ? patch.bg ?? null : current.flowixBg ?? null;
  const nextFg = hasFgPatch ? patch.fg ?? null : current.flowixFg ?? null;

  if (nextBg === null && nextFg === null) {
    return editor.chain().focus().unsetHighlight().run();
  }

  return editor
    .chain()
    .focus()
    .setMark('highlight', {
      color: null,
      flowixBg: nextBg,
      flowixFg: nextFg,
    })
    .run();
}

export function setDefaultFlowixHighlight(editor: Editor): boolean {
  return editor
    .chain()
    .focus()
    .setMark('highlight', {
      color: null,
      flowixBg: null,
      flowixFg: null,
    })
    .run();
}

export function clearFlowixHighlight(editor: Editor): boolean {
  return editor.chain().focus().unsetHighlight().run();
}

// Keep the import surface explicit for consumers that need to parse legacy
// inline HTML marks without duplicating Tiptap's style extraction behavior.
export function parseLegacyHighlightColor(element: HTMLElement): string | null {
  return element.getAttribute('data-color')
    || getStyleProperty(element, 'background-color')
    || element.style.backgroundColor
    || null;
}
