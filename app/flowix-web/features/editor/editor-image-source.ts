import { resolveDocumentRelativeHref } from '@/lib/document-relative-path';

/** Context belongs to the document being rendered, independently of notebook selection. */
export interface EditorImageContext {
  documentPath: string;
  scopePath: string | null;
  readImage: (path: string, scopePath?: string) => Promise<string | null>;
}

export type EditorImageSource =
  | { kind: 'url'; key: string; url: string }
  | { kind: 'local'; key: string; path: string; scopePath?: string; readImage: EditorImageContext['readImage'] }
  | { kind: 'unavailable'; key: string };

/** The rendered URL is transient; the image node retains its authored Markdown destination. */
export function resolveEditorImageSource(src: string, context?: EditorImageContext): EditorImageSource {
  const href = src.trim();
  if (/^(https?:|blob:|asset:|data:image\/|\/\/)/i.test(href)) {
    return { kind: 'url', key: href, url: href };
  }
  const target = resolveDocumentRelativeHref(href, context?.documentPath);
  const isAbsolutePath = !!target && (target.path.startsWith('/') || /^[a-z]:\//i.test(target.path) || target.path.startsWith('//'));
  if (!target || target.isDirectory || !context || (!context.scopePath && !isAbsolutePath)) {
    return { kind: 'unavailable', key: JSON.stringify([href, context?.documentPath, context?.scopePath]) };
  }
  const key = JSON.stringify([target.path, context.scopePath, target.search ?? '']);
  return { kind: 'local', key, path: target.path, scopePath: context.scopePath ?? undefined, readImage: context.readImage };
}
