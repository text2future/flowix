import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { Markdown } from '@tiptap/markdown';
import { closeHistory } from '@tiptap/pm/history';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComposerAttachmentToken,
  composerAttachmentMarkdownToDisplay,
  composerAttachmentMarkdownToPrompt,
} from './composer-attachment-token';
import { insertComposerAttachmentToken } from './composer-attachment-document';
import { COMPOSER_ATTACHMENT_NODE_NAME } from './composer-attachment-compat';
import { ComposerAttachmentController, type AgentThreadCardInputAttachment } from './composer-attachment-controller';
import { captureComposerInsertionAnchor } from './composer-insertion-anchor';
import { NotebookTreeResourceIcon } from '@features/memo/public/file-icon-api';

const mocks = vi.hoisted(() => ({ cacheAttachment: vi.fn(), deleteCachedAttachment: vi.fn(), readCachedAttachment: vi.fn() }));
vi.mock('@platform/tauri/client', () => ({ agent: mocks }));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  mocks.cacheAttachment.mockImplementation(async (_data: string, mimeType: string) => ({ path: `/tmp/${mocks.cacheAttachment.mock.calls.length}`, name: 'generated', mimeType }));
  mocks.readCachedAttachment.mockResolvedValue('data:image/png;base64,AQID');
  mocks.deleteCachedAttachment.mockResolvedValue(true);
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) },
  });
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.resetAllMocks();
});
function setup(content = '') {
  const input = document.createElement('div');
  document.body.append(input);
  const editor = new Editor({ element: { mount: input }, extensions: [Document, Paragraph, Text, UndoRedo, Markdown, ComposerAttachmentToken], content, contentType: 'markdown' });
  const attachments = new ComposerAttachmentController({ input, initialAttachments: [], onChange: vi.fn(), onStateChange: vi.fn(), onError: vi.fn(), onLimitExceeded: vi.fn() });
  attachments.connectDocument({
    captureAttachmentInsertionAnchor: () => captureComposerInsertionAnchor(editor),
    insertAttachmentToken: (attachment, position) => insertComposerAttachmentToken(editor, attachment, position),
    removeAttachmentToken: () => undefined,
    setAttachmentTokensChanged(handler) {
      const sync = () => {
        const tokens: AgentThreadCardInputAttachment[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === COMPOSER_ATTACHMENT_NODE_NAME) tokens.push({ path: node.attrs.path, name: node.attrs.name, mimeType: node.attrs.mimeType });
        });
        handler(tokens);
      };
      editor.on('update', sync);
      sync();
    },
    dispose: () => undefined,
  });
  cleanups.push(() => { attachments.dispose(); editor.destroy(); });
  return { editor, attachments, input };
}
const pdf = (name: string) => new File(['pdf'], name, { type: 'application/pdf' });

describe('Inline composer attachments', () => {
  it('keeps image markers in display Markdown without adding them to the model prompt', () => {
    const path = '/tmp/test image.png';
    const token = `⟦attachment:${encodeURIComponent(path)}:${encodeURIComponent('test image.png')}:${encodeURIComponent('image/png')}⟧`;

    expect(composerAttachmentMarkdownToDisplay(`before ${token} after`)).toBe(
      `before [test image.png](flowix://agent-image-attachment?path=${encodeURIComponent(path)}) after`,
    );
    expect(composerAttachmentMarkdownToPrompt(`before ${token} after`)).toBe('before  after');
  });

  it('replaces the selected text once when uploading multiple files', async () => {
    const { editor, attachments } = setup('before replace after');
    editor.commands.setTextSelection({ from: 8, to: 15 });
    attachments.captureInsertionAnchor();
    attachments.addFiles([pdf('first.pdf'), pdf('second.pdf')]);
    await vi.waitFor(() => expect(attachments.hasPending).toBe(false));
    expect(editor.state.doc.textContent).toContain('before');
    expect(editor.state.doc.textContent).toContain('after');
    expect(editor.state.doc.textContent).not.toContain('replace');
    expect(attachments.readyAttachments.map((attachment) => attachment.name)).toEqual(['first.pdf', 'second.pdf']);
  });

  it('maps the captured insertion position through edits made while the file caches', async () => {
    const { editor, attachments } = setup('abcd');
    let resolveCache!: (value: AgentThreadCardInputAttachment) => void;
    mocks.cacheAttachment.mockImplementation(() => new Promise((resolve) => { resolveCache = resolve; }));
    editor.commands.setTextSelection(5);
    attachments.captureInsertionAnchor();
    attachments.addFiles([pdf('report.pdf')]);
    await vi.waitFor(() => expect(mocks.cacheAttachment).toHaveBeenCalled());
    editor.commands.insertContentAt(1, 'prefix ');
    resolveCache({ path: '/tmp/report.pdf', name: 'generated', mimeType: 'application/pdf' });
    await vi.waitFor(() => expect(attachments.hasPending).toBe(false));
    let attachmentPosition = -1;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === COMPOSER_ATTACHMENT_NODE_NAME) attachmentPosition = pos; });
    expect(editor.state.doc.textBetween(0, attachmentPosition)).toBe('prefix abcd ');
  });

  it('keeps an attachment submit-ready after delete and undo', () => {
    const { editor, attachments } = setup();
    const attachment = { path: '/tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' };
    insertComposerAttachmentToken(editor, attachment, { from: 1, to: 1 });
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.deleteRange({ from: 1, to: 2 });
    expect(attachments.readyAttachments).toEqual([]);
    editor.commands.undo();
    expect(attachments.readyAttachments).toEqual([attachment]);
    expect(mocks.deleteCachedAttachment).not.toHaveBeenCalled();
  });

  it('uses the matching SVG icon from the workspace file tree for non-image attachments', () => {
    const { editor, input } = setup();
    insertComposerAttachmentToken(editor, { path: '/tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' });
    const icon = input.querySelector<SVGSVGElement>('.agent-composer__attachment-token-icon');
    const expectedTemplate = document.createElement('template');
    expectedTemplate.innerHTML = renderToStaticMarkup(createElement(NotebookTreeResourceIcon, {
      path: 'report.pdf',
      className: 'agent-composer__attachment-token-icon',
    }));
    expect(icon?.outerHTML).toBe(expectedTemplate.content.firstElementChild?.outerHTML);
  });

  it('round-trips attachment cards in the saved Markdown draft', () => {
    const { editor, attachments } = setup();
    const attachment = { path: '/tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' };
    insertComposerAttachmentToken(editor, attachment);
    const markdown = editor.getMarkdown();
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(attachments.readyAttachments).toEqual([attachment]);
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe(COMPOSER_ATTACHMENT_NODE_NAME);
  });
});
