import { describe, expect, it, vi } from 'vitest';

import { handleSiblingWindowContentUpdate } from '@features/document/components/session/sibling-window-document-sync';

function createDependencies() {
  return {
    onConflict: vi.fn(),
    clearSaveTimer: vi.fn(),
    reloadDocument: vi.fn().mockResolvedValue(undefined),
  };
}

describe('sibling window document sync', () => {
  it('reloads the matching clean memo from the committed path', async () => {
    const dependencies = createDependencies();
    const result = await handleSiblingWindowContentUpdate({
      event: { id: 'memo-1', path: '/notes/renamed.md' },
      identity: { kind: 'memo', id: 'memo-1' },
      isDirty: false,
      ...dependencies,
    });

    expect(result).toBe('reloaded');
    expect(dependencies.clearSaveTimer).toHaveBeenCalledOnce();
    expect(dependencies.reloadDocument).toHaveBeenCalledWith('/notes/renamed.md', {
      preservePending: false,
      showLoading: false,
    });
    expect(dependencies.onConflict).not.toHaveBeenCalled();
  });

  it('ignores an update for a different memo', async () => {
    const dependencies = createDependencies();
    const result = await handleSiblingWindowContentUpdate({
      event: { id: 'memo-2', path: '/notes/two.md' },
      identity: { kind: 'memo', id: 'memo-1' },
      isDirty: false,
      ...dependencies,
    });

    expect(result).toBe('ignored');
    expect(dependencies.clearSaveTimer).not.toHaveBeenCalled();
    expect(dependencies.reloadDocument).not.toHaveBeenCalled();
  });

  it('keeps a dirty local draft and reports a conflict', async () => {
    const dependencies = createDependencies();
    const result = await handleSiblingWindowContentUpdate({
      event: { id: 'memo-1', path: '/notes/one.md' },
      identity: { kind: 'memo', id: 'memo-1' },
      isDirty: true,
      ...dependencies,
    });

    expect(result).toBe('conflict');
    expect(dependencies.onConflict).toHaveBeenCalledOnce();
    expect(dependencies.clearSaveTimer).not.toHaveBeenCalled();
    expect(dependencies.reloadDocument).not.toHaveBeenCalled();
  });
});
