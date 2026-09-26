import { describe, expect, it } from 'vitest';
import type { MemoItem } from '@/types/memo-item';
import type { PluginDescriptor } from '@platform/tauri/client';
import type {
  ExternalDocumentProps,
  DocumentSurfaceContext,
  NoteSurface,
  ResolveWorkColumnContentInput,
  WorkColumnSurface,
} from './types';
import type { WorkColumnNavigationState, WorkColumnTarget } from '@features/workspace/store/work-column-target';
import { resolveWorkColumnContent } from './resolver';

function memo(properties: Record<string, unknown>, id = 'memo-1'): MemoItem {
  return {
    id,
    filename: 'note.md',
    preview: '',
    tags: [],
    todos: [],
    agents: [],
    createdAt: 0,
    updatedAt: 0,
    favorited: false,
    icon: null,
    colors: [],
    properties,
  };
}

function markdownSurface(options: {
  filePath?: string;
  memoId?: string | null;
  transitionId?: number | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  externalScopePath?: string | null;
} = {}): NoteSurface {
  return {
    kind: 'note',
    memoId: options.memoId ?? 'memo-1',
    instanceKey: options.memoId ? `memo:${options.memoId}` : `path:${options.filePath ?? '/notebook/note.md'}`,
    props: {
      filePath: options.filePath ?? '/notebook/note.md',
      transitionId: options.transitionId ?? null,
      notebookId: options.notebookId ?? 'notebook-1',
      notebookPath: options.notebookPath ?? '/notebook',
      isExternalDocument: false,
      externalScopePath: options.externalScopePath,
    },
  };
}

function externalDocumentProps(options: Parameters<typeof markdownSurface>[0] = {}): ExternalDocumentProps {
  const markdown = markdownSurface(options);
  return { ...markdown.props, memoId: null, isExternalDocument: true };
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

const memoTarget = {
  kind: 'memo' as const,
  memoId: 'memo-1',
  path: '/notebook/note.md',
  notebookId: 'notebook-1',
  notebookPath: '/notebook',
  transitionId: 1,
};

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

type MemoDocumentIdentity = Extract<DocumentSurfaceContext, { identity: { kind: 'memo' } }>['identity'];
type ExternalDocumentIdentity = Extract<DocumentSurfaceContext, { identity: { kind: 'external' } }>['identity'];

function memoDocumentIdentity(
  options: { path?: string; transitionId?: number | null } = {},
): MemoDocumentIdentity {
  return {
    kind: 'memo',
    memoId: 'memo-1',
    path: options.path ?? '/notebook/note.md',
    notebookId: 'notebook-1',
    notebookPath: '/notebook',
    transitionId: options.transitionId ?? null,
  };
}

function externalDocumentIdentity(
  options: { path?: string; scopePath?: string | null; transitionId?: number | null } = {},
): ExternalDocumentIdentity {
  return {
    kind: 'external',
    path: options.path ?? '/notebook/note.md',
    scopePath: options.scopePath ?? '/files',
    transitionId: options.transitionId ?? null,
  };
}

describe('surface resolvers', () => {
  it('resolves memo, external, plugin, agent, web, and empty workspace targets', () => {
    const markdown = markdownSurface({ transitionId: 1 });
    expect(surfaceFrom({
      navigation: navigation(memoTarget),
      document: { identity: memoDocumentIdentity({ transitionId: 1 }), memo: memo({}), surface: markdown },
      emptyMessage: 'empty',
    })).toBe(markdown);

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
        memo: null,
        documentProps: externalDocumentProps({
          filePath: '/files/readme.md',
          memoId: null,
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

  it('resolves an artifact target without depending on the active document session', () => {
    const surface = surfaceFrom({
      navigation: navigation({
        kind: 'artifact',
        pointerMemoId: 'pointer-1',
        notebookId: 'notebook-1',
        notebookPath: '/notebook',
        pluginId: 'mindmap',
        renderer: 'markmap',
      }),
      document: {
        identity: memoDocumentIdentity({ path: '/notebook/other.md', transitionId: 8 }),
        memo: memo({}, 'other-memo'),
        surface: markdownSurface({ filePath: '/notebook/other.md', transitionId: 8 }),
      },
      emptyMessage: 'empty',
    });

    expect(surface).toMatchObject({
      kind: 'mindmap',
      instanceKey: 'artifact:pointer-1',
      renderer: 'markmap',
      props: { memoId: 'pointer-1' },
    });
  });

  it('rejects stale or cross-identity workspace contexts', () => {
    const stale = resolveWorkColumnContent({
      navigation: navigation(memoTarget),
      document: { identity: memoDocumentIdentity({ transitionId: 1 }), memo: memo({}, 'other-memo'), surface: markdownSurface({ transitionId: 1 }) },
      emptyMessage: 'empty',
    });
    expect(stale).toMatchObject({ status: 'empty', reason: 'stale-context' });

    const wrongPath = resolveWorkColumnContent({
      navigation: navigation(memoTarget),
      document: {
        identity: memoDocumentIdentity({ path: '/notebook/old.md', transitionId: 1 }),
        memo: memo({}),
        surface: markdownSurface({ filePath: '/notebook/old.md', transitionId: 1 }),
      },
      emptyMessage: 'empty',
    });
    expect(wrongPath).toMatchObject({ status: 'empty', reason: 'stale-context' });

    const wrongPlugin = resolveWorkColumnContent({
      navigation: navigation({ kind: 'plugin-workbench', plugin: plugin('plugin-a') }),
      pluginWorkbench: {
        plugin: plugin('plugin-b'),
        notebookPath: undefined,
        currentNotePath: null,
        currentNoteContent: '',
      },
      emptyMessage: 'empty',
    });
    expect(wrongPlugin).toMatchObject({ status: 'empty', reason: 'stale-context' });
  });

  it('classifies malformed target data instead of returning an untyped empty state', () => {
    expect(resolveWorkColumnContent({
      navigation: navigation({ kind: 'agent-conversation', instanceId: '  ' }),
      emptyMessage: 'empty',
    })).toMatchObject({ status: 'empty', reason: 'invalid-target', tone: 'agent' });

    expect(resolveWorkColumnContent({
      navigation: navigation({
        kind: 'artifact',
        pointerMemoId: '  ',
        notebookId: null,
        notebookPath: null,
        pluginId: null,
        renderer: null,
      }),
      emptyMessage: 'empty',
    })).toMatchObject({ status: 'empty', reason: 'invalid-artifact', tone: 'document' });
  });

});
