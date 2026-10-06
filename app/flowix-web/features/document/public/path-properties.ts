import { isMap, parseDocument } from 'yaml';
import { ensureFileDisplayIdentity, findFileDisplayPath, pinFileDisplayId } from '@/lib/file-display-registry';
import { documentIdentityFromFile } from '../store/document-identity';
import { getBuffer, applyLoadedContent } from '../store/buffer-registry';
import { captureLatestDocumentContent, saveDocumentContent } from '../store/document-session-service';
import { memoDocumentOperations } from '../use-cases/memo-document-operations';

/** Change only YAML properties; preserve authored body bytes and YAML comments. */
export function patchDocumentProperties(content: string, properties: Record<string, unknown>, removedProperties: string[] = []): string {
  const match = /^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n((?:[^\r\n]*\r?\n)*?)---(?:\r?\n|$)/.exec(content);
  if (!match && Object.keys(properties).length === 0) return content;
  const document = parseDocument(match?.[1] ?? '');
  if (document.errors.length) throw new Error(document.errors[0].message);
  if (document.contents && !isMap(document.contents)) throw new Error('Frontmatter must be a mapping');
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'flowix_key' || key === 'key') throw new Error('Identity properties cannot be generated');
    document.set(key, value);
  }
  for (const key of removedProperties) {
    if (key === 'flowix_key' || key === 'key') throw new Error('Identity properties cannot be removed');
    document.delete(key);
  }
  const body = match ? content.slice(match[0].length) : content.replace(/^\uFEFF/, '');
  return '---\n' + document.toString() + '---\n' + body;
}

/** Property controls and text edits share the same buffer and serial save queue. */
export async function setDocumentProperties(path: string, properties: Record<string, unknown>): Promise<boolean> {
  return updateDocumentProperties(path, properties, []);
}

export async function removeDocumentProperty(path: string, property: string): Promise<boolean> {
  return updateDocumentProperties(path, {}, [property]);
}

async function updateDocumentProperties(path: string, properties: Record<string, unknown>, removedProperties: string[]): Promise<boolean> {
  if (!path) return false;
  const file = ensureFileDisplayIdentity(path);
  const release = pinFileDisplayId(file.displayId);
  const identity = documentIdentityFromFile(file);
  try {
    if (!getBuffer(identity)) {
      const content = await memoDocumentOperations.read({ path, scopePath: null });
      if (content === null) return false;
      if (!getBuffer(identity)) applyLoadedContent(identity, path, content, { setAsCurrent: false });
    }
    captureLatestDocumentContent(identity);
    const buffer = getBuffer(identity);
    if (!buffer) return false;
    const currentPath = findFileDisplayPath(file.displayId);
    if (!currentPath) return false;
    const content = patchDocumentProperties(buffer.content, properties, removedProperties);
    return await saveDocumentContent({ identity, path: currentPath, content });
  } finally {
    release();
  }
}
