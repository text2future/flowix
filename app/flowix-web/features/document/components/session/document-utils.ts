
// Re-exported for callers that import DocumentBuffer from this module.
// The canonical definition lives in lib/store/document-buffer.ts so that
// the document store layer (which is window-agnostic) can use it.
export type { DocumentBuffer } from '@features/document/store/document-buffer';

export function extractBodyContent(content: string): string {
  return content.replace(/^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function countTextUnits(content: string): number {
  const chineseChars = content.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = content.match(/[A-Za-z]+/g)?.length ?? 0;

  return chineseChars + englishWords;
}
