import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceSessionStore } from '@features/workspace/store/workspace-session-store';
import { appendAdjacentContentContext } from './adjacent-document-context';
import { describeAdjacentTarget, getAdjacentContent } from '@features/workspace/public/adjacent-content-api';
import { stripSystemBlock } from '@features/agent/message/system';
import { prepareUserMessage } from './user-message';

describe('adjacent content context', () => {
  beforeEach(() => useWorkspaceSessionStore.getState().reset());

  it('tracks both column placements and only the visible conversation', () => {
    const store = useWorkspaceSessionStore.getState();
    store.setBrowserLayout({ visible: true });
    store.commitTarget('column-1', { kind: 'agent-conversation', instanceId: 'chat' });
    store.commitTarget('column-2', { kind: 'external', path: '/notes/a.pdf', scopePath: null, transitionId: null });
    expect(getAdjacentContent('chat')).toEqual({ path: '/notes/a.pdf', kind: '文件' });
    store.swapColumnContents();
    expect(getAdjacentContent('chat')?.path).toBe('/notes/a.pdf');
    expect(getAdjacentContent('other')).toBeUndefined();
    store.setBrowserLayout({ visible: false });
    expect(getAdjacentContent('chat')).toBeUndefined();
  });

  it('handles folders, collections, images and arbitrary documents', () => {
    expect(describeAdjacentTarget({ kind: 'folder-collection', folderPath: '/folder', notebookId: 'n', notebookPath: '/', folderName: 'folder' })).toEqual({ path: '/folder', kind: '文件夹集合' });
    expect(describeAdjacentTarget({ kind: 'table', filePath: '/db.csv', notebookPath: null, notebookId: null })).toEqual({ path: '/db.csv', kind: '集合' });
    expect(describeAdjacentTarget({ kind: 'media', filePath: '/a.png', notebookId: null, notebookPath: null, resourceKind: 'image' })).toEqual({ path: '/a.png', kind: '图片' });
    expect(describeAdjacentTarget({ kind: 'external', path: '/a.docx', scopePath: null, transitionId: null })?.path).toBe('/a.docx');
    expect(describeAdjacentTarget({ kind: 'web', url: 'https://example.com' })).toBeUndefined();
  });

  it('sends context on later messages without displaying it, including restored messages', () => {
    const adjacent = { path: '/x/-->.md', kind: '文件' };
    const prepared = prepareUserMessage({ content: 'hello', isFirstMessage: false, agentType: 'pi', adjacentContent: adjacent });
    expect(prepared.userMessage.content).toBe('hello');
    expect(prepared.llmContent).toContain('FLOWIX_ACTIVE_DOCUMENT_CONTEXT');
    expect(prepared.llmContent).not.toContain('/x/-->.md');
    expect(stripSystemBlock(prepared.llmContent)).toBe('hello');
    expect(stripSystemBlock('hello <!-- user comment -->')).toBe('hello <!-- user comment -->');
    expect(appendAdjacentContentContext('hello')).toBe('hello');
  });
});
