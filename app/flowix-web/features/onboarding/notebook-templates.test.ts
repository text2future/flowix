import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTEBOOK_TEMPLATE_ID,
  getNotebookTemplateFiles,
  NOTEBOOK_TEMPLATES,
} from './notebook-template-bundled';

describe('notebook templates', () => {
  it('uses every template directory from the notebook-template collection', () => {
    expect(NOTEBOOK_TEMPLATES).toHaveLength(72);
    expect([...new Set(NOTEBOOK_TEMPLATES.map((template) => template.category))]).toEqual([
      '内容创作',
      '电商零售',
      '个人管理',
      '产品研发',
      '教育学习',
      '线下活动',
    ]);
    expect(NOTEBOOK_TEMPLATES[0].id).toBe(DEFAULT_NOTEBOOK_TEMPLATE_ID);
    expect(NOTEBOOK_TEMPLATES.every((template) => template.category)).toBe(true);
  });

  it('includes each template guide, nested Markdown, and table structure', () => {
    for (const template of NOTEBOOK_TEMPLATES) {
      const files = getNotebookTemplateFiles(template.id);
      const paths = new Set(files.map((file) => file.path));

      expect(files.length).toBeGreaterThan(1);
      expect(paths.has('AGENTS.md')).toBe(true);
      expect([...paths].some((path) => path.startsWith('.agents/'))).toBe(true);
      expect([...paths].some((path) => path.includes('/') && path.endsWith('.md'))).toBe(true);
      expect([...paths].some((path) => path.endsWith('.csv'))).toBe(true);
    }

    const firstTemplateId = NOTEBOOK_TEMPLATES[0].id;
    expect(firstTemplateId).toMatch(/^preset-(?=.*[a-z])(?=.*\d)[a-z0-9]{6}$/u);
    expect(new Set(NOTEBOOK_TEMPLATES.map((template) => template.id)).size).toBe(72);
    expect(
      NOTEBOOK_TEMPLATES.every((template) =>
        /^preset-(?=.*[a-z])(?=.*\d)[a-z0-9]{6}$/u.test(template.id),
      ),
    ).toBe(true);
    const firstTemplatePaths = getNotebookTemplateFiles(firstTemplateId)
      .map((file) => file.path);
    expect(firstTemplatePaths).toContain('进度视图.csv');
    expect(NOTEBOOK_TEMPLATES.find((template) => template.id === firstTemplateId)?.name).toBe('自媒体运营');
  });
});
