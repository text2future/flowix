import { documentFileHref, documentRelativeHref, resolveDocumentRelativeHref } from './document-relative-path';
import { movedPath, type PathMove } from './markdown-path-move';

export interface MarkdownPathLink { href: string; label: string; image: boolean }

interface MarkdownNode {
  type: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Let the Markdown parser decide which spans are links. Only replace their
 * source slices, preserving code, HTML, whitespace, titles and line endings.
 */
export async function mapMarkdownLinks(content: string, map: (link: MarkdownPathLink) => MarkdownPathLink): Promise<string> {
  const { fromMarkdown } = await import('mdast-util-from-markdown');
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: MarkdownNode) => {
    if ((node.type === 'link' || node.type === 'image') && node.url) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const raw = content.slice(start, end);
      const image = node.type === 'image';
      const labelStart = image ? 2 : 1;
      if (!raw.startsWith(image ? '![' : '[')) return; // Autolinks have no label slice.
      const lastChild = node.children?.[node.children.length - 1]?.position?.end.offset;
      const minimum = lastChild === undefined ? labelStart : lastChild - start;
      // The AST URL is decoded. If its literal spelling cannot be located
      // unambiguously, leave that authored syntax untouched rather than guessing.
      let urlStart = raw.lastIndexOf(node.url);
      while (urlStart >= minimum) {
        const labelEnd = raw.lastIndexOf(']', urlStart);
        if (labelEnd >= minimum && /^\(\s*<?$/.test(raw.slice(labelEnd + 1, urlStart))) {
          const link = { href: node.url, label: raw.slice(labelStart, labelEnd), image };
          const updated = map(link);
          if (updated.href !== link.href) {
            edits.push({ start: start + urlStart, end: start + urlStart + node.url.length, text: updated.href });
          }
          if (updated.label !== link.label) {
            edits.push({ start: start + labelStart, end: start + labelEnd, text: updated.label });
          } else node.children?.forEach(visit);
          return;
        }
        urlStart = raw.lastIndexOf(node.url, urlStart - 1);
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(content));
  let result = content;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** Maintain relative and file-URL destinations for source and target moves. */
export async function rewriteDocumentPathLinks(content: string, sourceBefore: string, sourceAfter: string, moves: readonly PathMove[]): Promise<string> {
  return mapMarkdownLinks(content, link => {
    const href = link.href;
    const absolute = /^file:/i.test(href);
    if (!absolute && !/^\.{1,2}\//.test(href)) return link;
    const target = resolveDocumentRelativeHref(href, sourceBefore);
    if (!target) return link;
    const path = moves.reduce((value, move) => movedPath(value, move), target.path);
    if (path === target.path && (absolute || sourceBefore === sourceAfter)) return link;
    const updated = absolute ? documentFileHref({ ...target, path })
      : documentRelativeHref({ ...target, path }, sourceAfter) ?? documentFileHref({ ...target, path });
    return { ...link, href: updated };
  });
}
