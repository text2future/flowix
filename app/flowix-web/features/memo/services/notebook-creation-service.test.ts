import { describe, expect, it } from 'vitest';
import { notebookNeedsImportFromStatus } from '@features/memo/services/notebook-creation-service';

describe('notebookNeedsImportFromStatus', () => {
  it('retries when no persisted status exists', () => {
    expect(notebookNeedsImportFromStatus(null)).toBe(true);
  });

  it('does not repeat a completed import', () => {
    expect(notebookNeedsImportFromStatus({ notebookId: 'book', status: 'completed' })).toBe(false);
  });

  it('retries interrupted or failed imports', () => {
    expect(notebookNeedsImportFromStatus({ notebookId: 'book', status: 'started' })).toBe(true);
    expect(notebookNeedsImportFromStatus({ notebookId: 'book', status: 'failed' })).toBe(true);
    expect(notebookNeedsImportFromStatus({ notebookId: 'book', status: 'skipped' })).toBe(true);
  });
});
