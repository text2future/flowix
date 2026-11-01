import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  create: vi.fn(), ensureDefaultPath: vi.fn(), getDefaultPath: vi.fn(),
  list: vi.fn(), getImportStatus: vi.fn(), ensureTemplateSetup: vi.fn(),
  getTemplateSetupStatus: vi.fn(),
}));
vi.mock('@features/memo/services/note-repository', () => ({ notebookRepository: repository }));

const files = vi.hoisted(() => ({
  createFolder: vi.fn(), getNotebookViewPreferences: vi.fn(), setNotebookViewPreferences: vi.fn(),
}));
vi.mock('@platform/tauri/client/desktop', () => ({ files }));

// getCurrentAppLanguage drives the localized folder name; the real i18n
// translate() is exercised so the 笔记 / Notes copy is asserted end-to-end.
const runtime = vi.hoisted(() => ({ getCurrentAppLanguage: vi.fn() }));
vi.mock('@features/preferences/public/runtime-api', () => runtime);

import { createNotebookRegistration } from './notebook-creation-service';

describe('default note folder on notebook creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    files.getNotebookViewPreferences.mockResolvedValue({
      defaultCreateFolder: null,
    });
  });

  it('creates a 笔记 folder and sets it as default for zh-CN', async () => {
    runtime.getCurrentAppLanguage.mockReturnValue('zh-CN');
    repository.create.mockResolvedValue({ id: 'n1', path: '/tmp/Book' });

    await createNotebookRegistration({ name: 'Book' });

    expect(files.createFolder).toHaveBeenCalledExactlyOnceWith('/tmp/Book', '笔记');
    expect(files.setNotebookViewPreferences).toHaveBeenCalledExactlyOnceWith('/tmp/Book', {
      defaultCreateFolder: '笔记',
    });
  });

  it('creates a Notes folder and sets it as default for en-US', async () => {
    runtime.getCurrentAppLanguage.mockReturnValue('en-US');
    repository.create.mockResolvedValue({ id: 'n2', path: '/tmp/Book' });

    await createNotebookRegistration({ name: 'Book' });

    expect(files.createFolder).toHaveBeenCalledExactlyOnceWith('/tmp/Book', 'Notes');
    expect(files.setNotebookViewPreferences).toHaveBeenCalledExactlyOnceWith('/tmp/Book', {
      defaultCreateFolder: 'Notes',
    });
  });

  it('does not touch folders when adopting an existing notebook', async () => {
    runtime.getCurrentAppLanguage.mockReturnValue('zh-CN');
    repository.create.mockRejectedValue('PATH_ALREADY_REGISTERED');
    repository.getDefaultPath.mockResolvedValue('/tmp/Book');
    repository.list.mockResolvedValue([{ id: 'existing', path: '/tmp/Book' }]);
    repository.getImportStatus.mockResolvedValue({ status: 'completed' });

    await createNotebookRegistration({ name: 'Book', reuseExisting: true });

    expect(files.createFolder).not.toHaveBeenCalled();
    expect(files.setNotebookViewPreferences).not.toHaveBeenCalled();
  });

  it('keeps the folder creation idempotent when the default is already set', async () => {
    runtime.getCurrentAppLanguage.mockReturnValue('zh-CN');
    files.getNotebookViewPreferences.mockResolvedValue({
      defaultCreateFolder: '笔记',
    });
    repository.create.mockResolvedValue({ id: 'n3', path: '/tmp/Book' });

    await createNotebookRegistration({ name: 'Book' });

    expect(files.createFolder).toHaveBeenCalledExactlyOnceWith('/tmp/Book', '笔记');
    expect(files.setNotebookViewPreferences).not.toHaveBeenCalled();
  });
});
