import YAML from 'yaml';
import { sanitizeFileName } from '@/lib/export-utils';
import { joinNotebookMemoPath } from '@/lib/path';
import { files } from '@platform/tauri/client';

export type MediaLibraryKind = 'image' | 'video';

export interface MediaLibraryDocument {
  format: 'flowix.media-library';
  version: 1;
  library: { id: string; name: string; revision: number };
  view: {
    id: string;
    layout: 'waterfall';
    kinds: MediaLibraryKind[];
    sort?: { field: 'created_at'; direction: 'desc' };
  };
}

const LIBRARY_ID_PATTERN = /^lib_[0-9a-f]{32}$/;
const VIEW_ID_PATTERN = /^view_[0-9a-f]{32}$/;

function createUuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createMediaLibrary(name: string): MediaLibraryDocument {
  const libraryId = createUuidV7();
  const viewId = createUuidV7();
  return {
    format: 'flowix.media-library',
    version: 1,
    library: { id: `lib_${libraryId}`, name, revision: 0 },
    view: {
      id: `view_${viewId}`,
      layout: 'waterfall',
      kinds: ['image', 'video'],
      sort: { field: 'created_at', direction: 'desc' },
    },
  };
}

export function serializeMediaLibrary(document: MediaLibraryDocument): string {
  return YAML.stringify(validateMediaLibraryDocument(document), { lineWidth: 0 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMediaLibrary(source: string): MediaLibraryDocument {
  return validateMediaLibraryDocument(YAML.parse(source));
}

export function validateMediaLibraryDocument(value: unknown): MediaLibraryDocument {
  if (!isRecord(value) || value.format !== 'flowix.media-library' || value.version !== 1
    || !hasOnlyKeys(value, ['format', 'version', 'library', 'view'])
    || !isRecord(value.library) || !hasOnlyKeys(value.library, ['id', 'name', 'revision'])
    || !isRecord(value.view) || !hasOnlyKeys(value.view, ['id', 'layout', 'kinds', 'sort'])) {
    throw new Error('不支持的媒体库文件格式');
  }
  const { library, view } = value;
  const kinds = view.kinds;
  if (typeof library.id !== 'string' || !LIBRARY_ID_PATTERN.test(library.id)
    || typeof library.name !== 'string' || !library.name.trim() || library.name !== library.name.trim()
    || !Number.isInteger(library.revision) || (library.revision as number) < 0
    || !Number.isSafeInteger(library.revision)
    || typeof view.id !== 'string' || !VIEW_ID_PATTERN.test(view.id) || view.layout !== 'waterfall'
    || !Array.isArray(kinds) || kinds.some((kind) => kind !== 'image' && kind !== 'video')
    || new Set(kinds).size !== kinds.length
    || (view.sort !== undefined && (!isRecord(view.sort)
      || !hasOnlyKeys(view.sort, ['field', 'direction'])
      || view.sort.field !== 'created_at' || view.sort.direction !== 'desc'))) {
    throw new Error('媒体库配置无效');
  }
  return {
    format: 'flowix.media-library', version: 1,
    library: { id: library.id, name: library.name, revision: library.revision as number },
    view: {
      id: view.id,
      layout: 'waterfall',
      kinds: [...kinds as MediaLibraryKind[]],
      ...(view.sort ? { sort: { field: 'created_at', direction: 'desc' } as const } : {}),
    },
  };
}

function hasOnlyKeys(value: object, allowedKeys: string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

export async function createMediaLibraryFile(
  notebookPath: string,
  relativeFolder: string | null | undefined,
  name: string,
): Promise<{ filePath: string; document: MediaLibraryDocument }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('请输入媒体库名称');
  const notebookRoot = notebookPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const folderPath = relativeFolder ? joinNotebookMemoPath(notebookRoot, relativeFolder) : notebookRoot;
  if (!folderPath) throw new Error('媒体库目录无效');
  const stem = sanitizeFileName(trimmedName).replace(/\.lib\.ya?ml$/i, '');
  if (!stem) throw new Error('媒体库名称无效');
  const children = await files.getDirChildren(folderPath);
  const existing = new Set(children.map((entry) => entry.name.toLocaleLowerCase()));
  let filename = `${stem}.lib.yaml`;
  let suffix = 2;
  while (existing.has(filename.toLocaleLowerCase())) {
    filename = `${stem} (${suffix}).lib.yaml`;
    suffix += 1;
  }
  const relativePath = [relativeFolder, filename].filter(Boolean).join('/');
  const filePath = joinNotebookMemoPath(notebookRoot, relativePath);
  if (!filePath) throw new Error('媒体库路径无效');
  const document = createMediaLibrary(stem);
  if (!await files.write(filePath, serializeMediaLibrary(document), false, notebookRoot)) {
    throw new Error('创建媒体库失败');
  }
  return { filePath, document };
}
