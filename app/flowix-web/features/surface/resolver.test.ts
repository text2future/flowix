import { describe, expect, it } from 'vitest';
import type { PluginDescriptor } from '@platform/tauri/client';
import type {
  ExternalDocumentProps,
  DocumentSurfaceContext,
  MDSurface,
  ResolveWorkColumnContentInput,
  WorkColumnSurface,
} from './types';
import type { WorkColumnNavigationState, WorkColumnTarget } from '@features/workspace/store/work-column-target';
import { resolveWorkColumnContent } from './resolver';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';

function markdownSurface(options: {
  filePath?: string;
  memoId?: string | null;
  transitionId?: number | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  externalScopePath?: string | null;
} = {}): MDSurface {
  return {
    kind: 'md',
    instanceKey: options.memoId ? `memo:${options.memoId}` : `path:${options.filePath ?? '/notebook/note.md'}`,
    fileIdentity: {
      path: options.filePath ?? '/notebook/note.md',
      displayId: `display:${options.filePath ?? '/notebook/note.md'}`,
    },
    props: {
      isExternalDocument: true,
      transitionId: options.transitionId ?? null,
      notebookId: options.notebookId ?? 'notebook-1',
      notebookPath: options.notebookPath ?? '/notebook',
      externalScopePath: options.externalScopePath,
    },
  };
}

function externalDocumentProps(options: Parameters<typeof markdownSurface>[0] = {}): ExternalDocumentProps {
  const markdown = markdownSurface(options);
  return { ...markdown.props, isExternalDocument: true };
}

function plugin(id = 'mindmap'): PluginDescriptor {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name: 'Mindmap',
      version: '1.0.0',
      kind: 'agent-markdown',
      ui: { placement: 'sidebar', order: 1, icon: 'mindmap' },
      input: { fields: [] },
      agent: { skill: 'SKILL.md' },
      output: {
        format: 'markdown',
        directory: '.plugin-output/mindmap',
        extension: '.md',
        renderer: 'markmap',
      },
    },
    installedPath: '/plugins/mindmap',
    skill: '',
    isSystem: true,
    enabled: true,
    permissions: [],
    integrityStatus: 'unverified',
  };
}

function navigation(target: WorkColumnTarget | WorkColumnNavigationState) {
  return 'phase' in target
    ? target
    : {
        phase: 'committed' as const,
        showWorkColumnLoading: false,
        requestId: 1,
        target,
        pendingTarget: null,
        previousTarget: null,
        failure: null,
        retryToken: null,
      };
}

function surfaceFrom(input: ResolveWorkColumnContentInput): WorkColumnSurface {
  const content = resolveWorkColumnContent(input);
  if (content.status !== 'surface') throw new Error(`Expected surface, received ${content.status}`);
  return content.surface;
}

type ExternalDocumentIdentity = Extract<DocumentSurfaceContext, { identity: { kind: 'external' } }>['identity'];

function externalDocumentIdentity(
  options: { path?: string; scopePath?: string | null; transitionId?: number | null } = {},
): ExternalDocumentIdentity {
  const path = options.path ?? '/notebook/note.md';
  return {
    kind: 'external',
    fileIdentity: { path, displayId: `display:${path}` },
    scopePath: options.scopePath ?? '/files',
    transitionId: options.transitionId ?? null,
  };
}

describe('surface resolvers', () => {
  it('resolves a standalone table target without an external document session', () => {
    ensureFileDisplayIdentity('/notebook/Tasks.table.yml');
    const surface = surfaceFrom({
      navigation: navigation({ kind: 'table', filePath: '/notebook/Tasks.table.yml', notebookPath: '/notebook', notebookId: 'notebook-1' }),
      emptyMessage: 'empty',
    });
    expect(surface.kind).toBe('table-file');
    if (surface.kind === 'table-file') {
      expect(surface.props).toEqual({ filePath: '/notebook/Tasks.table.yml', notebookPath: '/notebook', notebookId: 'notebook-1' });
    }
  });

  it('resolves memo, external, plugin, agent, web, and empty workspace targets', () => {
    expect(surfaceFrom({
      navigation: navigation({
        kind: 'external',
        path: '/files/readme.md',
        scopePath: '/files',
        transitionId: 2,
      }),
      document: {
        identity: externalDocumentIdentity({ path: '/files/readme.md', transitionId: 2 }),
        instanceKey: 'external:readme:2',
        documentProps: externalDocumentProps({
          transitionId: 2,
          externalScopePath: '/files',
        }),
      },
      emptyMessage: 'empty',
    }).kind).toBe('md');

    expect(surfaceFrom({
      navigation: navigation({ kind: 'plugin-workbench', plugin: plugin('plugin-a') }),
      pluginWorkbench: {
        plugin: plugin('plugin-a'),
        notebookPath: '/notebook',
        currentNotePath: null,
        currentNoteContent: '',
      },
      emptyMessage: 'empty',
    }).kind).toBe('plugin-workbench');

    expect(surfaceFrom({
      navigation: navigation({ kind: 'agent-conversation', instanceId: 'conversation-1' }),
      emptyMessage: 'empty',
    }).kind).toBe('agent-conversation');
    expect(surfaceFrom({
      navigation: navigation({ kind: 'web', url: 'https://example.com' }),
      emptyMessage: 'empty',
    }).kind).toBe('web');
    expect(resolveWorkColumnContent({ navigation: navigation({ kind: 'empty' }), emptyMessage: 'empty' })).toEqual({
      status: 'empty',
      message: 'empty',
      reason: 'no-target',
      tone: 'document',
    });
  });

});
