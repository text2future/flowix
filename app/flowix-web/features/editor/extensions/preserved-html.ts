import { Node, type MarkdownToken } from '@tiptap/core';
import { Lexer, Tokenizer } from 'marked';
import { resolveEditorImageSource, type EditorImageContext } from '../editor-image-source';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { scanHead } from '../markdown-tokenizer-source';

// Use CommonMark's HTML boundaries, including quoted > characters, rather than
// a second HTML grammar. This tokenizer is not registered with the editor lexer.
const htmlTokenizer = new Tokenizer();
new Lexer({ tokenizer: htmlTokenizer, gfm: true });
const MEDIA = /<(?:img|picture)\b/i;
const COMMENT = /^<!--[\s\S]*?-->/;
const ORDINARY_COMMENT = /<!--(?![ \t]*flowix:)[\s\S]*?-->/i;
const FLOWIX_COMMENT = /^<!--[ \t]*flowix:/i;

interface PreservedHtmlStorage {
  refreshers: Set<() => void>;
  refreshSources: () => void;
}

declare module '@tiptap/core' {
  interface Storage {
    preservedHtmlBlock: PreservedHtmlStorage;
    preservedHtmlInline: PreservedHtmlStorage;
  }
}

interface PreservedHtmlOptions {
  getImageContext?: () => EditorImageContext | undefined;
  onViewSourceMode?: () => void;
}

function inlineHtml(src: string): string | undefined {
  if (src.startsWith('<!--') && !FLOWIX_COMMENT.test(src)) return COMMENT.exec(src)?.[0];
  if (/^<picture\b/i.test(src)) {
    let depth = 0;
    for (let offset = 0; offset < src.length;) {
      const start = src.indexOf('<', offset);
      if (start < 0) break;
      const tag = htmlTokenizer.tag(src.slice(start));
      if (!tag) { offset = start + 1; continue; }
      if (/^<picture\b/i.test(tag.raw)) depth++;
      if (/^<\/picture\s*>/i.test(tag.raw) && --depth === 0) return src.slice(0, start + tag.raw.length);
      offset = start + tag.raw.length;
    }
    return undefined;
  }
  if (/^<img\b/i.test(src)) return htmlTokenizer.tag(src)?.raw;
  return undefined;
}

function createPreservedHtml(inline: boolean) {
  const name = inline ? 'preservedHtmlInline' : 'preservedHtmlBlock';
  return Node.create<PreservedHtmlOptions, PreservedHtmlStorage>({
    name,
    inline,
    group: inline ? 'inline' : 'block',
    atom: true,
    addOptions: () => ({}),
    addStorage: () => {
      const refreshers = new Set<() => void>();
      return { refreshers, refreshSources: () => refreshers.forEach(refresh => refresh()) };
    },
    addAttributes: () => ({ html: { default: '', rendered: false } }),
    parseHTML: () => [{
      tag: `${inline ? 'span' : 'div'}[data-flowix-preserved-html]`,
      getAttrs: element => ({ html: element.getAttribute('data-flowix-preserved-html') ?? '' }),
    }],
    renderHTML: ({ node }) => [inline ? 'span' : 'div', { 'data-flowix-preserved-html': node.attrs.html }, 'HTML'],
    markdownTokenizer: {
      name,
      level: inline ? 'inline' : 'block',
      start(src) {
        // A block start hint inside a paragraph would split ordinary inline
        // images out of their paragraph. Let marked reach block HTML naturally.
        return inline ? scanHead(src).search(/<(?:img\b|picture\b|!--(?![ \t]*flowix:))/i) : -1;
      },
      tokenize(src) {
        if (!(inline ? src.startsWith('<') : /^ {0,3}</.test(src))) return undefined;
        if (inline) {
          const raw = inlineHtml(src);
          return raw ? { type: name, raw } : undefined;
        }
        // Flowix metadata has dedicated parsers and must keep its semantics.
        if (FLOWIX_COMMENT.test(src.trimStart())) return undefined;
        const token = htmlTokenizer.html(src);
        if (!token || (!MEDIA.test(token.raw) && !ORDINARY_COMMENT.test(token.raw))) return undefined;
        return { type: name, raw: token.raw };
      },
    },
    parseMarkdown: (token: MarkdownToken) => ({ type: name, attrs: { html: (token.raw ?? '').replace(/[\r\n]+$/, '') } }),
    renderMarkdown: node => String(node.attrs?.html ?? ''),
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement(inline ? 'span' : 'div');
        dom.contentEditable = 'false';
        dom.className = 'editor-preserved-html';
        dom.title = String(node.attrs.html);
        let generation = 0;
        let destroyed = false;
        const refresh = () => {
          const version = ++generation;
          dom.replaceChildren();
          // Parse inertly and create only image elements ourselves. Never insert
          // authored HTML, event handlers, source/srcset, or scripts into the view.
          const parsed = new DOMParser().parseFromString(String(node.attrs.html), 'text/html');
          const images = parsed.querySelectorAll('img[src]');
          if (!images.length) dom.textContent = String(node.attrs.html);
          const previewImages = new Map<Element, HTMLImageElement>();
          for (const original of images) {
            const img = document.createElement('img');
            img.alt = original.getAttribute('alt') ?? '';
            img.loading = 'lazy';
            img.style.maxWidth = '100%';
            const width = original.getAttribute('width') ?? (original as HTMLElement).style.width;
            if (width && /^\d+(?:\.\d+)?(?:px|%)?$/.test(width)) img.style.width = /^\d+(?:\.\d+)?$/.test(width) ? `${width}px` : width;
            const align = original.getAttribute('align') ?? original.parentElement?.getAttribute('align');
            if (!inline && (align === 'center' || align === 'right')) {
              img.style.display = 'block';
              img.style.marginLeft = 'auto';
              img.style.marginRight = align === 'center' ? 'auto' : '0';
            }
            previewImages.set(original, img);
            const source = resolveEditorImageSource(original.getAttribute('src')!, this.options.getImageContext?.());
            if (source.kind === 'url') img.src = source.url;
            if (source.kind === 'local') {
              void source.readImage(source.path, source.scopePath).then(url => {
                if (!destroyed && version === generation && url) img.src = url;
              }).catch(() => { /* Keep the alt text when the file cannot be read. */ });
            }
          }
          if (images.length) {
            const appendPreview = (original: globalThis.Node, parent: HTMLElement) => {
              if (original.nodeType === globalThis.Node.TEXT_NODE) {
                parent.append(document.createTextNode(original.textContent ?? ''));
              } else if (original instanceof Element) {
                const image = previewImages.get(original);
                if (image) { parent.append(image); return; }
                if (['SCRIPT', 'STYLE', 'SOURCE'].includes(original.tagName)) return;
                const tag = original.tagName === 'BR' ? 'br'
                  : !inline && ['P', 'DIV'].includes(original.tagName) ? 'div' : 'span';
                const container = document.createElement(tag);
                parent.append(container);
                original.childNodes.forEach(child => appendPreview(child, container));
              }
            };
            parsed.body.childNodes.forEach(child => appendPreview(child, dom));
          }
          if (this.options.onViewSourceMode) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = translate(getCurrentAppLanguage(), 'document.action.viewSource');
            button.addEventListener('click', () => this.options.onViewSourceMode?.());
            dom.append(button);
          }
        };
        dom.addEventListener('dblclick', () => this.options.onViewSourceMode?.());
        this.storage.refreshers.add(refresh);
        refresh();
        return {
          dom,
          // Updating reconstructs the preview and invalidates outstanding reads.
          update: () => false,
          ignoreMutation: () => true,
          destroy: () => { destroyed = true; this.storage.refreshers.delete(refresh); },
        };
      };
    },
  });
}

export const PreservedHtmlBlock = createPreservedHtml(false);
export const PreservedHtmlInline = createPreservedHtml(true);
