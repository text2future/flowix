import { sanitizeLinkHref } from '@/lib/safe-link';

const REMOVE_WITH_CONTENT = new Set([
  'embed',
  'iframe',
  'link',
  'meta',
  'noscript',
  'object',
  'script',
  'style',
  'svg',
]);

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li',
  'mark', 'ol', 'p', 'pre', 's', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['alt', 'src', 'title']),
  li: new Set(['data-checked', 'data-type']),
  ol: new Set(['start']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  ul: new Set(['data-type']),
};

function styleValue(element: HTMLElement, property: string): string {
  return element.style.getPropertyValue(property).trim().toLowerCase();
}

function isBold(value: string): boolean {
  if (value === 'bold' || value === 'bolder') return true;
  const weight = Number.parseInt(value, 10);
  return Number.isFinite(weight) && weight >= 600;
}

function semanticTagsForStyle(element: HTMLElement): string[] {
  if (element.tagName.toLowerCase() !== 'span') return [];

  const tags: string[] = [];

  const weight = styleValue(element, 'font-weight');
  if (isBold(weight)) tags.push('strong');

  const fontStyle = styleValue(element, 'font-style');
  if (fontStyle === 'italic' || fontStyle === 'oblique') tags.push('em');

  const decoration = styleValue(element, 'text-decoration');
  if (decoration.includes('line-through')) tags.push('del');
  if (decoration.includes('underline')) tags.push('u');

  return tags;
}

function replaceWithSemanticTags(element: HTMLElement, tagNames: string[]): HTMLElement {
  const first = element.ownerDocument.createElement(tagNames[0]);
  let innermost = first;
  tagNames.slice(1).forEach(tagName => {
    const nested = element.ownerDocument.createElement(tagName);
    innermost.appendChild(nested);
    innermost = nested;
  });
  while (element.firstChild) innermost.appendChild(element.firstChild);
  element.replaceWith(first);
  return first;
}

function sanitizeAttributes(element: HTMLElement): void {
  const tagName = element.tagName.toLowerCase();
  const allowed = ALLOWED_ATTRIBUTES[tagName] ?? new Set<string>();
  const attributes = Array.from(element.attributes);

  attributes.forEach(attribute => {
    if (!allowed.has(attribute.name.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  });

  if (tagName === 'a') {
    const href = sanitizeLinkHref(element.getAttribute('href'));
    if (href) element.setAttribute('href', href);
    else element.removeAttribute('href');
  }

  if (tagName === 'img') {
    const src = sanitizeLinkHref(element.getAttribute('src'));
    if (src) element.setAttribute('src', src);
    else element.removeAttribute('src');
  }

  if (tagName === 'ul' && element.getAttribute('data-type') !== 'taskList') {
    element.removeAttribute('data-type');
  }

  if (tagName === 'li') {
    if (element.getAttribute('data-type') !== 'taskItem') {
      element.removeAttribute('data-type');
      element.removeAttribute('data-checked');
    } else if (!['true', 'false'].includes(element.getAttribute('data-checked') ?? '')) {
      element.removeAttribute('data-checked');
    }
  }
}

function sanitizeChildren(parent: HTMLElement): void {
  Array.from(parent.children).forEach((child) => {
    let element = child as HTMLElement;
    const tagName = element.tagName.toLowerCase();

    if (REMOVE_WITH_CONTENT.has(tagName)) {
      element.remove();
      return;
    }

    sanitizeChildren(element);

    if (element.childNodes.length === 0 && ['div', 'figure', 'span'].includes(tagName)) {
      element.remove();
      return;
    }

    const semanticTags = semanticTagsForStyle(element);
    if (semanticTags.length > 0) {
      element = replaceWithSemanticTags(element, semanticTags);
    }

    sanitizeAttributes(element);

    // A span has no meaning in the editor schema by itself. Browsers commonly
    // add spans for copied presentation styles (font, colour, size, etc.); once
    // those styles have been removed, keep only the span's children.
    if (tagName === 'span' && semanticTags.length === 0) {
      while (element.firstChild) {
        element.parentNode?.insertBefore(element.firstChild, element);
      }
      element.remove();
      return;
    }

    if (ALLOWED_TAGS.has(tagName) || semanticTags.length > 0) return;

    // Unknown containers are unwrapped so their text and supported children
    // remain available to ProseMirror.
    while (element.firstChild) {
      element.parentNode?.insertBefore(element.firstChild, element);
    }
    element.remove();
  });
}

/** HTML emitted by ProseMirror for an internal editor copy. */
export function isInternalEditorHtml(html: string): boolean {
  return /\bdata-pm-slice\s*=\s*["']/i.test(html);
}

/**
 * Remove presentation-only webpage formatting before it reaches the editor.
 * Semantic formatting is retained so the Markdown serializer can represent it.
 */
export function sanitizeExternalHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeChildren(doc.body);
  return doc.body.innerHTML;
}

export function hasImportableHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(sanitizeExternalHtml(html), 'text/html');
  return !!doc.body.textContent?.trim() || !!doc.body.querySelector('img, hr, table');
}
