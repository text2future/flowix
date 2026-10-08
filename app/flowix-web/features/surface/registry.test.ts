import { describe, expect, it } from 'vitest';
import {
  getWorkColumnSurfaceDefinition,
  surfaceSupports,
  workColumnSurfaceRegistry,
} from './registry';
import type { WorkColumnSurface, WorkColumnSurfaceKind } from './types';

function fileIdentity(path: string) {
  return { path, displayId: `display:${path}` };
}

function surface(kind: WorkColumnSurfaceKind): WorkColumnSurface {
  switch (kind) {
    case 'document-list':
      return { kind, displayId: 'document-list:/notebook', instanceKey: 'document-list:/notebook', folderPath: '/notebook', notebookPath: '/notebook', notebookId: 'notebook-1', filters: {} };
    case 'md':
      return { kind, instanceKey: 'md:1', fileIdentity: fileIdentity('/workspace/readme.md'), props: { isExternalDocument: true } };
    case 'code':
      return { kind, instanceKey: 'code:1', fileIdentity: fileIdentity('/workspace/main.ts'), props: { isExternalDocument: true } };
    case 'csv-file':
      return { kind, instanceKey: 'csv:1', fileIdentity: fileIdentity('/workspace/data.csv'), scopePath: '/workspace' };
    case 'image-file':
      return {
        kind, instanceKey: 'image:1', fileIdentity: fileIdentity('/workspace/logo.png'), scopePath: '/workspace',
        props: { isExternalDocument: true },
      };
    case 'video-file':
      return {
        kind, instanceKey: 'video:1', fileIdentity: fileIdentity('/workspace/demo.mp4'), scopePath: '/workspace',
        props: { isExternalDocument: true },
      };
    case 'table-file':
      return {
        kind,
        instanceKey: 'table:1',
        fileIdentity: fileIdentity('/workspace/r1.table.yml'),
        props: { filePath: '/workspace/r1.table.yml', notebookPath: '/workspace', notebookId: null },
      };
    case 'media-library-file':
      return { kind, instanceKey: 'library:1', fileIdentity: fileIdentity('/workspace/Media.lib.yaml'), notebookPath: '/workspace', notebookId: null };
    case 'table-file':
      return { kind, instanceKey: 'table:1', fileIdentity: fileIdentity('/workspace/r1.table.yml'), props: { filePath: '/workspace/r1.table.yml', notebookPath: '/workspace', notebookId: null } };
    case 'html-file':
      return {
        kind, instanceKey: 'html-file:1', fileIdentity: fileIdentity('/workspace/index.html'), scopePath: '/workspace',
        props: { isExternalDocument: true },
      };
    case 'unavailable-file':
      return {
        kind, instanceKey: 'unavailable:1', fileIdentity: fileIdentity('/workspace/archive.bin'),
        scopePath: '/workspace',
        props: { isExternalDocument: true },
      };
    case 'media':
      return {
        kind,
        instanceKey: 'media:1',
        fileIdentity: fileIdentity('/notebook/image.png'),
        notebookId: 'notebook-1',
        notebookPath: '/notebook',
        resourceKind: 'image',
      };
    case 'mindmap':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'markmap',
        props: { memoId: 'memo-1' },
      };
    case 'html':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'html',
        props: { memoId: 'memo-1' },
      };
    case 'json':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'json-viewer',
        props: { memoId: 'memo-1' },
      };
    case 'text':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'text',
        props: { memoId: 'memo-1' },
      };
    case 'plugin-artifact':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: null,
        props: { memoId: 'memo-1' },
      };
    case 'agent-conversation':
      return { kind, instanceKey: 'agent:1', instanceId: 'agent-1' };
    case 'plugin-workbench':
      throw new Error('Plugin workbench is not needed by these capability tests');
    case 'web':
      return { kind, instanceKey: 'web:1', url: 'https://example.com' };
  }
}

describe('workColumnSurfaceRegistry', () => {
  it('registers every supported product-level surface kind', () => {
    expect(Object.keys(workColumnSurfaceRegistry).sort()).toEqual([
      'agent-conversation',
      'code',
      'html',
      'html-file',
      'image-file',
      'json',
      'md',
      'media',
      'media-library-file',
      'mindmap',
      'plugin-artifact',
      'plugin-workbench',
      'text',
      'unavailable-file',
      'video-file',
      'table-file',
      'web',
    ]);
  });

  it('exposes Markdown editing actions on the path surface', () => {
    const markdown = surface('md');

    expect(getWorkColumnSurfaceDefinition(markdown).chrome).toBe('document');
    expect(surfaceSupports(markdown, 'edit')).toBe(true);
    expect(surfaceSupports(markdown, 'search')).toBe(true);
    expect(surfaceSupports(markdown, 'copy-content')).toBe(true);
    expect(surfaceSupports(markdown, 'memo-colors')).toBe(false);
    expect(surfaceSupports(markdown, 'export-content')).toBe(true);
    expect(surfaceSupports(markdown, 'fit')).toBe(false);
  });

  it('exposes canvas controls without leaking pointer-note editing actions', () => {
    const mindmap = surface('mindmap');

    expect(getWorkColumnSurfaceDefinition(mindmap).chrome).toBe('document');
    expect(surfaceSupports(mindmap, 'fit')).toBe(true);
    expect(surfaceSupports(mindmap, 'zoom')).toBe(true);
    expect(surfaceSupports(mindmap, 'fullscreen')).toBe(true);
    expect(surfaceSupports(mindmap, 'edit')).toBe(false);
    expect(surfaceSupports(mindmap, 'export-content')).toBe(false);
    expect(surfaceSupports(surface('html'), 'fullscreen')).toBe(true);
  });

  it('uses media chrome for media resources', () => {
    const media = surface('media');

    expect(getWorkColumnSurfaceDefinition(media).chrome).toBe('media');
    expect(surfaceSupports(media, 'properties')).toBe(false);
    expect(surfaceSupports(media, 'edit')).toBe(false);
  });

  it('uses agent chrome and conversation-specific capabilities for agents', () => {
    const agent = surface('agent-conversation');

    expect(getWorkColumnSurfaceDefinition(agent).chrome).toBe('agent');
    expect(surfaceSupports(agent, 'stream-conversation')).toBe(true);
    expect(surfaceSupports(agent, 'edit')).toBe(false);
  });
});
