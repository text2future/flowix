export const RICH_HTML_RE = /<(?:h[1-6]|ul|ol|li|blockquote|pre|table|hr|img|figure)\b/i;
export const HTML_TABLE_RE = /<table\b/i;

const INLINE_HTML_RE = /<(?:a|strong|b|em|i|code|span|mark|u|s|del|sup|sub)\b/i;
const MEANINGFUL_SPAN_STYLE_RE = /(?:font-weight|font-style|text-decoration|color|background|font-family|font-size)\s*:/i;

export function hasMeaningfulInlineHtml(html: string): boolean {
  if (!INLINE_HTML_RE.test(html)) return false;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('a[href], strong, b, em, i, code, mark, u, s, del, sup, sub')) {
    return true;
  }

  return Array.from(doc.querySelectorAll('span')).some((span) => {
    const style = span.getAttribute('style') ?? '';
    return MEANINGFUL_SPAN_STYLE_RE.test(style);
  });
}

export function isStandaloneHtmlTable(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.body.querySelectorAll('table'));
  if (tables.length !== 1) return false;

  const body = doc.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll('table, style, script, meta, link').forEach((node) => node.remove());
  return body.textContent?.trim().length === 0;
}
