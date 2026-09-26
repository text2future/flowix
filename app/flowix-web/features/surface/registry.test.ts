import { describe, expect, it } from 'vitest';
import {
  getWorkColumnSurfaceDefinition,
  surfaceSupports,
  workColumnSurfaceRegistry,
} from './registry';
import type { WorkColumnSurface, WorkColumnSurfaceKind } from './types';

function surface(kind: WorkColumnSurfaceKind): WorkColumnSurface {
  switch (kind) {
    case 'note':
      return { kind, memoId: 'memo-1', instanceKey: 'note:1', props: { filePath: '/note.md' } };
    case 'md':
      return { kind, instanceKey: 'md:1', props: { filePath: '/workspace/readme.md', isExternalDocument: true } };
    case 'code':
      return { kind, instanceKey: 'code:1', props: { filePath: '/workspace/main.ts', isExternalDocument: true } };
    case 'image-file':
      return {
        kind, instanceKey: 'image:1', filePath: '/workspace/logo.png', scopePath: '/workspace',
        props: { filePath: '/workspace/logo.png', isExternalDocument: true },
      };
    case 'video-file':
      return {
        kind, instanceKey: 'video:1', filePath: '/workspace/demo.mp4', scopePath: '/workspace',
        props: { filePath: '/workspace/demo.mp4', isExternalDocument: true },
      };
    case 'html-file':
      return {
        kind, instanceKey: 'html-file:1', filePath: '/workspace/index.html', scopePath: '/workspace',
        props: { filePath: '/workspace/index.html', isExternalDocument: true },
      };
    case 'unavailable-file':
      return {
        kind, instanceKey: 'unavailable:1', filePath: '/workspace/archive.bin',
        props: { filePath: '/workspace/archive.bin', isExternalDocument: true },
      };
    case 'media':
      return {
        kind,
        instanceKey: 'media:1',
        filePath: '/notebook/image.png',
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
      'mindmap',
      'note',
      'plugin-artifact',
      'plugin-workbench',
      'text',
      'unavailable-file',
      'video-file',
      'web',
    ]);
  });

  it('keeps note content actions on the note surface', () => {
    const markdown = surface('note');
    const externalMarkdown = surface('md');

    expect(getWorkColumnSurfaceDefinition(markdown).chrome).toBe('document');
    expect(surfaceSupports(markdown, 'edit')).toBe(true);
    expect(surfaceSupports(markdown, 'search')).toBe(true);
    expect(surfaceSupports(markdown, 'copy-content')).toBe(true);
    expect(surfaceSupports(markdown, 'memo-colors')).toBe(true);
    expect(surfaceSupports(markdown, 'export-content')).toBe(true);
    expect(surfaceSupports(markdown, 'fit')).toBe(false);
    expect(surfaceSupports(externalMarkdown, 'memo-colors')).toBe(false);
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
    expect(surfaceSupports(media, 'properties')).toBe(true);
    expect(surfaceSupports(media, 'edit')).toBe(false);
  });

  it('uses agent chrome and conversation-specific capabilities for agents', () => {
    const agent = surface('agent-conversation');

    expect(getWorkColumnSurfaceDefinition(agent).chrome).toBe('agent');
    expect(surfaceSupports(agent, 'stream-conversation')).toBe(true);
    expect(surfaceSupports(agent, 'edit')).toBe(false);
  });
});
