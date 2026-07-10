import { canonicalPath } from '@/lib/path';

export type DocumentIdentity =
  | { kind: 'memo'; id: string }
  | { kind: 'external'; path: string };

export function normalizeDocumentIdentity(identity: DocumentIdentity): DocumentIdentity {
  return identity.kind === 'memo'
    ? identity
    : { kind: 'external', path: canonicalPath(identity.path) };
}

export function documentIdentityKey(identity: DocumentIdentity): string {
  const normalized = normalizeDocumentIdentity(identity);
  return normalized.kind === 'memo'
    ? `memo:${normalized.id}`
    : `external:${normalized.path}`;
}

