import type { ClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';

export interface TitlePasteSplit {
  titleLine: string;
  body: ClipboardSnapshot;
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TR', 'UL',
]);

function nextSiblingInDocument(node: Node, root: Node): Node | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current.nextSibling) return current.nextSibling;
    current = current.parentNode;
  }
  return null;
}

function closestBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
  let current = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (current && current !== root) {
    if (BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Remove the first logical line from HTML while retaining inline marks on the
 * remaining content. If the HTML does not expose a reliable line boundary,
 * return null and let the caller fall back to plain text.
 */
function stripFirstHtmlLine(html: string, titleLine: string): string | null {
  if (typeof DOMParser === 'undefined') return null;

  const document = new DOMParser().parseFromString(html, 'text/html');
  const root = document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = titleLine.length;
  let endNode: Text | null = null;
  let endOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (remaining <= node.data.length) {
      endNode = node;
      endOffset = remaining;
      remaining = 0;
      break;
    }
    remaining -= node.data.length;
  }

  if (!endNode || remaining !== 0 || endOffset < endNode.data.length) return null;

  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(endNode, endOffset);
  range.deleteContents();

  const next = nextSiblingInDocument(endNode, root);
  if (next instanceof HTMLElement && next.tagName === 'BR') {
    next.remove();
  } else {
    const block = closestBlock(endNode, root);
    if (block && block.textContent?.trim().length === 0) block.remove();
  }

  return root.innerHTML;
}

export function splitClipboardForTitlePaste(snapshot: ClipboardSnapshot): TitlePasteSplit | null {
  const normalizedText = (snapshot.text || snapshot.markdown).replace(/\r\n?/g, '\n');
  const newline = normalizedText.indexOf('\n');
  if (newline < 0) return null;

  const titleLine = normalizedText.slice(0, newline);
  if (titleLine.trim().length === 0) return null;

  const bodyText = normalizedText.slice(newline + 1);
  const normalizedMarkdown = snapshot.markdown.replace(/\r\n?/g, '\n');
  const markdownNewline = normalizedMarkdown.indexOf('\n');
  const bodyMarkdown = markdownNewline >= 0
    ? normalizedMarkdown.slice(markdownNewline + 1)
    : '';
  const bodyHtml = snapshot.html.trim().length > 0
    ? stripFirstHtmlLine(snapshot.html, titleLine)
    : null;

  return {
    titleLine,
    body: {
      ...snapshot,
      text: bodyText,
      markdown: bodyMarkdown,
      // A failed HTML split must not reinsert the original title. The plain
      // text fallback still enters the normal Markdown/Tiptap paste pipeline.
      html: bodyHtml ?? '',
    },
  };
}
