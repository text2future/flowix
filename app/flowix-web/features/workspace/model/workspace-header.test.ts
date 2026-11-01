import { describe, expect, it } from 'vitest';
import { workspaceSurfaceRegistry } from '../surface-registry';
import { resolveWorkspaceHeaderModel } from './workspace-header';

describe('shared header policy', () => {
  it('uses runtime content capabilities when a Markdown note becomes a plugin preview', () => {
    const input = { ...workspaceSurfaceRegistry['file-markdown'], contentKind: 'file-markdown' as const,
      sourceKind: 'file-markdown' as const, indexable: true };
    const editing = resolveWorkspaceHeaderModel(input);
    expect(editing.documentControls).toMatchObject({ memoColors: true, versionHistory: true, exportContent: true });
    const preview = resolveWorkspaceHeaderModel({ ...input, runtime: { contentKind: 'mindmap', capabilities: ['fullscreen'] } });
    expect(preview.documentControls).toEqual({ memoColors: false, versionHistory: false, exportContent: false, copyFullText: false, saveAsTemplate: false });
    expect(preview.showEditorFontSwitcher).toBe(false);
    expect(preview.showEditorModeToggle).toBe(true);
  });

  it('lets fullscreen replace identity and surface actions without inheriting a local page or collection background', () => {
    const header = resolveWorkspaceHeaderModel({ contentKind: 'file-html', backgroundColor: 'rgb(1, 2, 3)',
      collection: true, collectionScrolled: true, fullscreen: true, capabilities: ['web-navigation', 'memo-colors'] });
    expect(header).toMatchObject({ chrome: 'agent', backgroundColor: 'var(--agent-bg, var(--document-bg))',
      gradient: true, showIdentity: false, showSurfaceActions: false, showWebAddressBar: false });
    expect(header.documentControls.memoColors).toBe(false);
  });

  it('preserves the explicit file media versus media surface appearance policy', () => {
    const file = workspaceSurfaceRegistry['file-image'];
    const media = workspaceSurfaceRegistry.media;
    expect(resolveWorkspaceHeaderModel({ chrome: file.appearance.headerStyle }).gradient).toBe(true);
    expect(resolveWorkspaceHeaderModel({ chrome: media.appearance.headerStyle })).toMatchObject({
      gradient: false, backgroundColor: 'var(--agent-bg, var(--document-bg))',
    });
  });

  it('keeps the local HTML color under the gradient and confines scroll backing to collections', () => {
    const local = { contentKind: 'file-html' as const, backgroundColor: 'rgb(17, 34, 51)' };
    expect(resolveWorkspaceHeaderModel({ ...local, collectionScrolled: true })).toMatchObject({
      backgroundColor: local.backgroundColor, gradient: true, showEditorModeToggle: true,
    });
    expect(resolveWorkspaceHeaderModel({ ...local, collection: true, collectionScrolled: true })).toMatchObject({
      backgroundColor: 'var(--document-bg)', showIdentity: false, gradient: true,
    });
  });
});
