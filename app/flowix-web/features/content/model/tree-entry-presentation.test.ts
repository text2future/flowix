import { describe, expect, it } from 'vitest';
import { treeEntryPresentation } from './tree-entry-presentation';

describe('tree entry presentation', () => {
  it('keeps a nonempty name when an index suffix is the whole name', () => {
    expect(treeEntryPresentation({ type: 'document', name: '.index.yaml', fullPath: '/book/.index.yaml' }).displayName).toBe('.index.yaml');
    expect(treeEntryPresentation({ type: 'document', name: '计划.index.yml', fullPath: '/book/计划.index.yml' }).displayName).toBe('计划');
  });
});
