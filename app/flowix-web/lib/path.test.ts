import { describe, expect, it } from 'vitest';
import { findOwningRoot, isPathInDirectory, notebookRelativeDirectoryPath, parentDirectoryPath, pathInDirectory, samePath, uniquePaths } from './path';

describe('physical path boundaries', () => {
  it('uses the same Windows comparison policy for ownership, relative paths and deduplication', () => {
    expect(notebookRelativeDirectoryPath('C:/Notes', 'c:\\notes\\Folder\\Plan.md')).toBe('Folder/Plan.md');
    expect(findOwningRoot('c:/notes/book/Plan.md', ['C:/Notes/', 'C:/Notes/Book'])).toBe('C:/Notes/Book');
    expect(samePath('C:/Notes/Plan.md', 'c:\\notes\\plan.md')).toBe(true);
    expect(uniquePaths(['C:/Notes/Plan.md', 'c:/notes/plan.md'])).toEqual(['C:/Notes/Plan.md']);
    expect(notebookRelativeDirectoryPath('//Server/Share', '//server/share/Folder/a.md')).toBe('Folder/a.md');
    expect(notebookRelativeDirectoryPath('C:/İş', 'c:/İş/Plan.md')).toBe('Plan.md');
  });

  it('preserves drive roots as absolute paths throughout directory operations', () => {
    expect(parentDirectoryPath('C:/a.md', 'C:/')).toBe('C:/');
    expect(parentDirectoryPath('/a.md', '/notebook')).toBe('/');
    expect(notebookRelativeDirectoryPath('C:/', 'c:/Folder/a.md')).toBe('Folder/a.md');
    expect(isPathInDirectory('c:/Folder/a.md', 'C:/')).toBe(true);
    expect(pathInDirectory('C:/', '/other/a.md')).toBe('C:/a.md');
  });

  it('keeps POSIX case sensitivity and rejects sibling directories with a shared prefix', () => {
    expect(samePath('/book/A.md', '/book/a.md')).toBe(false);
    expect(notebookRelativeDirectoryPath('/Book', '/book/a.md')).toBeNull();
    expect(notebookRelativeDirectoryPath('/book', '/book-other/a.md')).toBeNull();
    expect(isPathInDirectory('C:/Notes-other/a.md', 'C:/Notes')).toBe(false);
    expect(notebookRelativeDirectoryPath('/', '/Folder/a.md')).toBe('Folder/a.md');
  });
});
