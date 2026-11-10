import { describe, expect, it } from 'vitest';
import { rewriteMovedNoteLinks } from './note-link-rewriter';

const before = {
  book: 'My Vault',
  file: 'Projects/Old.md',
  notebookId: 'vault-id',
  path: 'C:/Notes/Projects/Old.md',
};
const after = { file: 'Projects/New.md', notebookId: 'vault-id' };
const vault = { id: 'vault-id', name: 'My Vault', path: 'C:/Notes' };
const otherBook = { id: 'other-book', name: 'Other', path: 'D:/Other' };

describe('rewrite moved note links', () => {
  it('updates links and display names for the renamed file', async () => {
    const content = '[Old title](flowix://open?b=My+Vault&f=Projects%2FOld.md) '
      + '[Other](flowix://open?b=My+Vault&f=Projects%2FOther.md)';
    await expect(rewriteMovedNoteLinks(content, before, after, false, vault)).resolves.toBe(
      '[New](flowix://open?f=Projects%2FNew.md) '
      + '[Other](flowix://open?b=My+Vault&f=Projects%2FOther.md)',
    );
  });

  it('leaves the same link alone in a document of another notebook', async () => {
    const content = '[Old](flowix://open?b=My+Vault&f=Projects%2FOld.md)';
    await expect(rewriteMovedNoteLinks(content, before, after, false, otherBook)).resolves.toBe(content);
  });

  it('migrates older path links while keeping heading parameters', async () => {
    const content = '[Section](flowix://open?notebookId=vault-id&relativePath=Projects%2FOld.md&heading=Tasks)';
    await expect(rewriteMovedNoteLinks(content, before, after, false, vault)).resolves.toBe(
      '[New](flowix://open?heading=Tasks&f=Projects%2FNew.md)',
    );
  });

  it('updates existing book/file links to the canonical form', async () => {
    const content = '[Old](flowix://open?book=My+Vault&file=Projects%2FOld.md)';
    await expect(rewriteMovedNoteLinks(content, before, after, false, vault)).resolves.toBe(
      '[New](flowix://open?f=Projects%2FNew.md)',
    );
  });

  it('names the new notebook when the note itself moved across notebooks', async () => {
    const content = '[Old](flowix://open?f=Projects%2FOld.md)';
    await expect(rewriteMovedNoteLinks(content, before, {
      file: 'Imported/New.md', notebookId: 'archive-id',
    }, false, vault)).resolves.toBe(
      '[New](flowix://open?notebookId=archive-id&f=Imported%2FNew.md)',
    );
  });

  it('rewrites a bare f link only inside the notebook that owns it', async () => {
    const link = '[Old](flowix://open?f=Projects%2FOld.md)';
    await expect(rewriteMovedNoteLinks(link, before, after, false, vault)).resolves.toBe(
      '[New](flowix://open?f=Projects%2FNew.md)',
    );
    // The same text in another notebook points at that notebook's own file.
    await expect(rewriteMovedNoteLinks(link, before, after, false, otherBook)).resolves.toBe(link);
  });

  it('keeps heading anchor fragments when rewriting moved note links', async () => {
    const content = '[Plan](flowix://open?b=My+Vault&f=Projects%2FOld.md#%E7%9B%AE%E6%A0%87)';
    await expect(rewriteMovedNoteLinks(content, before, after, false, vault)).resolves.toBe(
      '[New](flowix://open?f=Projects%2FNew.md#%E7%9B%AE%E6%A0%87)',
    );
  });

  it('does not replace plain text or links to another notebook', async () => {
    const content = 'flowix://open?b=My+Vault&f=Projects%2FOld.md '
      + '[Old](flowix://open?b=Other&f=Projects%2FOld.md) '
      + '[Elsewhere](flowix://open?notebookId=other-book&f=Projects%2FOld.md)';
    await expect(rewriteMovedNoteLinks(content, before, after, false, vault)).resolves.toBe(content);
  });

  it('leaves code examples unchanged', async () => {
    const link = '[Old](flowix://open?b=My+Vault&f=Projects%2FOld.md)';
    const content = `\`${link}\`\n\`\`\`md\n${link}\n\`\`\`\n${link}`;
    await expect(rewriteMovedNoteLinks(content, before, after, false, vault)).resolves.toBe(
      `\`${link}\`\n\`\`\`md\n${link}\n\`\`\`\n[New](flowix://open?f=Projects%2FNew.md)`,
    );
  });

  it('updates each descendant when a folder moves without changing the note filename', async () => {
    const content = '[Old](flowix://open?b=My+Vault&f=Projects%2FChild%2FNote.md)';
    await expect(rewriteMovedNoteLinks(content, {
      ...before, file: 'Projects', path: 'C:/Notes/Projects',
    }, { file: 'Archive/Projects', notebookId: 'vault-id' }, true, vault)).resolves.toBe(
      '[Note](flowix://open?f=Archive%2FProjects%2FChild%2FNote.md)',
    );
  });
});
