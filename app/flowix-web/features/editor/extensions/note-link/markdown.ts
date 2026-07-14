export function stripMdSuffix(s: string): string {
  return s.endsWith('.md') ? s.slice(0, -3) : s;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function splitDisplay(text: string): { notebookName: string; title: string } {
  const t = text.trim();
  const slash = t.lastIndexOf('/');
  if (slash < 0) return { notebookName: '', title: t };
  return { notebookName: t.slice(0, slash), title: t.slice(slash + 1) };
}

export function pickAttr(attrsStr: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrsStr.match(re);
  if (!m) return null;
  return unescapeHtml(m[1] ?? m[2] ?? '');
}

export function parseBooleanAttr(value: string | null): boolean {
  if (!value) return false;
  return /^(true|1|yes)$/i.test(value.trim());
}
