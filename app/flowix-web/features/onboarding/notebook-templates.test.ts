import { describe, expect, it } from 'vitest';
import {
  BLANK_NOTEBOOK_TEMPLATE_ID,
  getNotebookTemplate,
  NOTEBOOK_TEMPLATES,
} from './notebook-templates';

describe('notebook templates', () => {
  it('keeps blank creation as the default template', () => {
    expect(NOTEBOOK_TEMPLATES[0].id).toBe(BLANK_NOTEBOOK_TEMPLATE_ID);
    expect(getNotebookTemplate(BLANK_NOTEBOOK_TEMPLATE_ID).documents).toHaveLength(0);
  });

  it('provides guide and example notes for every non-blank template', () => {
    for (const template of NOTEBOOK_TEMPLATES.slice(1)) {
      expect(template.documents.length).toBeGreaterThan(1);
      expect(template.documents.some((document) => document.kind === 'guide')).toBe(true);
      expect(template.documents.some((document) => document.kind === 'example')).toBe(true);
      expect(new Set(template.documents.map((document) => document.title)).size)
        .toBe(template.documents.length);
    }
  });
});
