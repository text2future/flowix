import { describe, expect, it } from 'vitest';
import { createTableDocument, serializeTableDocument } from './model';
import { parseTableDocumentAsync } from './parse-table-document';

describe('parseTableDocumentAsync', () => {
  it('parses current table documents through the asynchronous API', async () => {
    const source = serializeTableDocument(createTableDocument());
    const parsed = await parseTableDocumentAsync(source);
    expect(parsed).toMatchObject({ records: { data: [], auto_collect: null } });
    expect(parsed.table).not.toHaveProperty('name');
  });
});
