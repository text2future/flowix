import { resolveBrowserColumnSurface } from './browser-column-registry';
import { describe, expect, it } from 'vitest';
import {
  getWorkColumnSurfaceDefinition,
  surfaceSupports,
} from './registry';
import type { WorkColumnSurface, WorkColumnSurfaceKind } from './types';
import { workspaceSurfaceRendererRegistry } from './workspace-surface-renderer-registry';
import { collectionIndexPath } from './collection-frame';
import { workspaceSurfaceRendererDataFromWorkSurface } from './work-column-surface-adapter';
import { workspaceSurfaceUsesCollectionFrame, workspaceSurfaceRegistry } from '@features/workspace/public/surface-api';

function fileIdentity(path: string) {
  return { path, displayId: `display:${path}` };
}

function surface(kind: WorkColumnSurfaceKind): WorkColumnSurface {
  switch (kind) {
    case 'file-browser': return resolveBrowserColumnSurface({
      id: 'file-browser:1', title: 'Folder', icon: null,
      target: { kind: 'file-browser', folderPath: '/workspace', activeFilePath: null,
        scopePath: '/workspace', notebookId: null, fileTreeVisible: true, fileTreeWidth: 220 },
    }, { runtimeHost: 'main-third' });
    case 'folder-collection':
      return { kind, instanceKey: 'folder-collection:1', notebookId: 'notebook-1', notebookPath: '/notebook', folderPath: '/notebook/folder', folderName: 'folder' };
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
    case 'work-documents-file':
      return { kind, instanceKey: 'work-documents:1', fileIdentity: fileIdentity('/workspace/documents'), notebookPath: '/workspace', notebookId: null };
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
        props: { notePath: '/notebook/pointer.md' },
      };
    case 'html':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'html',
        props: { notePath: '/notebook/pointer.md' },
      };
    case 'json':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'json-viewer',
        props: { notePath: '/notebook/pointer.md' },
      };
    case 'text':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'text',
        props: { notePath: '/notebook/pointer.md' },
      };
    case 'plugin-artifact':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: null,
        props: { notePath: '/notebook/pointer.md' },
      };
    case 'agent-conversation':
      return { kind, instanceKey: 'agent:1', instanceId: 'agent-1' };
    case 'plugin-workbench':
      throw new Error('Plugin workbench is not needed by these capability tests');
    case 'web':
      return { kind, instanceKey: 'web:1', url: 'https://example.com' };
  }
}

describe('Work surface adapter', () => {
  it('provides one renderer registration for every canonical surface kind', () => {
    expect(Object.keys(workspaceSurfaceRendererRegistry).sort()).toEqual(Object.keys(workspaceSurfaceRegistry).sort());
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


describe('unified collection frame', () => {
  it.each(['folder-collection', 'table-file', 'media-library-file', 'work-documents-file'] as const)(
    '%s uses the same header underlap and display controls', (kind) => {
      const value = surface(kind);
      expect(workspaceSurfaceUsesCollectionFrame(workspaceSurfaceRendererDataFromWorkSurface(value).kind)).toBe(true);
      expect(collectionIndexPath(value)).toBe(kind === 'folder-collection'
        ? '/notebook/folder/.index.yaml'
        : 'fileIdentity' in value ? value.fileIdentity?.path ?? null : null);
    },
  );
  it('ordinary documents do not inherit collection underlap or controls', () => {
    expect(workspaceSurfaceUsesCollectionFrame('file-markdown')).toBe(false);
    expect(workspaceSurfaceUsesCollectionFrame(null)).toBe(false);
    expect(collectionIndexPath(surface('md'))).toBeNull();
  });
});
