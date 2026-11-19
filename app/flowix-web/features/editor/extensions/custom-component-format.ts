export interface CustomComponent {
  id: string;
  name: string;
  version: number;
  html: string;
}

export interface NotebookCustomComponent extends CustomComponent {
  formatVersion: number;
}

const COMPONENT_HEADER = /^<!--[ \t]*flowix:component[ \t]+(\{[^\r\n]*\})[ \t]*-->\r?\n/;
const MAX_COMPONENT_BYTES = 64 * 1024;

export function parseNotebookComponent(source: string): NotebookCustomComponent | null {
  const match = COMPONENT_HEADER.exec(source);
  if (!match) return null;
  try {
    const metadata = JSON.parse(match[1]) as Record<string, unknown>;
    const html = source.slice(match[0].length).trim();
    if (metadata.formatVersion !== 1 || typeof metadata.id !== 'string' || !metadata.id
      || typeof metadata.name !== 'string' || !metadata.name.trim()
      || typeof metadata.version !== 'number' || !Number.isFinite(metadata.version)
      || !html || new TextEncoder().encode(html).byteLength > MAX_COMPONENT_BYTES) return null;
    return {
      formatVersion: metadata.formatVersion,
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      html,
    };
  } catch {
    return null;
  }
}

export function normalizeCustomComponent(value: unknown): CustomComponent | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string'
    || typeof candidate.html !== 'string' || typeof candidate.version !== 'number'
    || !Number.isFinite(candidate.version) || !candidate.id || !candidate.name.trim()
    || !candidate.html.trim() || new TextEncoder().encode(candidate.html).byteLength > MAX_COMPONENT_BYTES) return null;
  return {
    id: candidate.id,
    name: candidate.name,
    version: candidate.version,
    html: candidate.html,
  };
}

export function encodeComponentPayload(component: CustomComponent): string {
  const bytes = new TextEncoder().encode(JSON.stringify(component));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeComponentPayload(encoded: string): CustomComponent | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return normalizeCustomComponent(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

export function componentPreviewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;min-height:100%;overflow:hidden;}body{box-sizing:border-box;padding:8px;}</style></head><body>${html}</body></html>`;
}

export function getComponentPreviewHeight(html: string, fallback = 256): number {
  const heightHint = /data-flowix-preview-height\s*=\s*["']?(\d{1,4})/i.exec(html);
  const requestedHeight = heightHint ? Number(heightHint[1]) : fallback;
  return Number.isFinite(requestedHeight)
    ? Math.max(160, Math.min(960, requestedHeight))
    : fallback;
}
