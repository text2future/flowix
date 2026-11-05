import { seedWorkColumn } from '@features/workspace/test-support/workspace-fixtures';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeSurfaceFileBrowser } from './work-file-browser-view';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { openWorkspaceSurface } from '@features/workspace/public/open-surface-api';
import { openWorkspaceSurface as openSessionSurface } from '@features/workspace/public/session-opening-api';
import type { CodeSurfaceFileTree } from './code-surface-view';

vi.mock('@features/workspace/public/session-opening-api', () => ({ openWorkspaceSurface: vi.fn().mockResolvedValue(null) }));
vi.mock('@features/workspace/public/open-surface-api', () => ({ openWorkspaceSurface: vi.fn().mockResolvedValue(null) }));
vi.mock('./code-surface-view', () => ({ CodeSurfaceView: ({ fileTree }: { fileTree: CodeSurfaceFileTree }) => <>
  <button onClick={() => fileTree.onSelectFile('/book/report.docx')}>docx</button>
  <button onClick={() => fileTree.onSelectFile('/book/archive.bin')}>unsupported</button>
  <button onClick={() => fileTree.onOpenFileInNewTab('/book/report.docx')}>browser</button>
</> }));

const initial = useWorkColumnStore.getState();
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  seedWorkColumn({ navigation: { ...initial.navigation, phase: 'committed', target: {
    kind: 'external', path: '/book/main.ts', scopePath: '/book', transitionId: null,
  } } });
  host = document.createElement('div');
  root = createRoot(host);
  await act(async () => root.render(<CodeSurfaceFileBrowser surface={{ kind: 'code', instanceKey: 'code-main',
    fileIdentity: { path: '/book/main.ts', displayId: 'main' }, props: { isExternalDocument: true } }} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  seedWorkColumn(initial, true);
});

describe('Work file tree open destination', () => {
  it.each(['docx', 'unsupported'])('keeps %s selection in Work', async (label) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
    await act(async () => button.click());
    expect(openSessionSurface).toHaveBeenCalledWith(expect.objectContaining({ columnId: 'column-1', target: expect.objectContaining({ kind: 'external' }) }));
  });
  it('opens Browser when explicitly requested', async () => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'browser')!;
    await act(async () => button.click());
    expect(openWorkspaceSurface).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
  });
});
