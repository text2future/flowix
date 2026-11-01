import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  create: vi.fn(), ensureDefaultPath: vi.fn(), getDefaultPath: vi.fn(),
  list: vi.fn(), getImportStatus: vi.fn(),
}));
vi.mock('@features/memo/services/note-repository', () => ({ notebookRepository: repository }));
// createNotebookRegistration now best-effort creates a default note folder via
// the desktop files client; stub it so these repository-focused tests stay
// isolated from Tauri IPC.
const files = vi.hoisted(() => ({
  createFolder: vi.fn(), getNotebookViewPreferences: vi.fn(), setNotebookViewPreferences: vi.fn(),
}));
vi.mock('@platform/tauri/client/desktop', () => ({ files }));
import { createNotebookRegistration } from './notebook-creation-service';

describe('notebook registration critical path', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    files.getNotebookViewPreferences.mockResolvedValue({
      defaultCreateFolder: null,
    });
  });

  it('creates the default notebook in one IPC without precreating its directory', async () => {
    const notebook = { id: 'new', path: 'C:/Notes/Book' };
    repository.create.mockResolvedValue(notebook);
    expect(await createNotebookRegistration({ name: ' Book ' })).toEqual({
      notebook, created: true, needsImport: true,
    });
    expect(repository.create).toHaveBeenCalledExactlyOnceWith('Book', undefined, undefined, false);
    expect(repository.ensureDefaultPath).not.toHaveBeenCalled();
    expect(repository.getDefaultPath).not.toHaveBeenCalled();
  });

  it('resolves a default path only when recovering an explicitly reusable registration', async () => {
    const notebook = { id: 'existing', path: 'C:/Notes/Book/' };
    repository.create.mockRejectedValue('PATH_ALREADY_REGISTERED');
    repository.getDefaultPath.mockResolvedValue('C:/Notes/Book');
    repository.list.mockResolvedValue([notebook]);
    repository.getImportStatus.mockResolvedValue({ status: 'failed' });
    expect(await createNotebookRegistration({ name: 'Book', reuseExisting: true })).toEqual({
      notebook, created: false, needsImport: true,
    });
    expect(repository.getDefaultPath).toHaveBeenCalledExactlyOnceWith('Book');
    expect(repository.ensureDefaultPath).not.toHaveBeenCalled();
  });

  it('does not adopt an existing notebook without explicit reuse', async () => {
    repository.create.mockRejectedValue('PATH_ALREADY_REGISTERED');
    await expect(createNotebookRegistration({ name: 'Book' })).rejects.toBe('PATH_ALREADY_REGISTERED');
    expect(repository.list).not.toHaveBeenCalled();
  });
});
