import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTEBOOK_TEMPLATE_ID,
  getNotebookTemplateFiles,
  NOTEBOOK_TEMPLATES,
} from './notebook-template-bundled';

describe('notebook templates', () => {
  it('uses every template directory from the notebook-template collection', () => {
    expect(NOTEBOOK_TEMPLATES.map((template) => template.sourceDirectory)).toEqual([
      '工作管理',
      '产品研发',
      '公众号写作',
      '小说创作',
      '自媒体管理',
      '股票基金投资',
      '考研规划',
      '课程设计',
    ]);
    expect(NOTEBOOK_TEMPLATES[0].id).toBe(DEFAULT_NOTEBOOK_TEMPLATE_ID);
    expect(NOTEBOOK_TEMPLATES.some((template) => template.id === 'blank')).toBe(false);
    expect(NOTEBOOK_TEMPLATES.some((template) => template.id === 'fitness-plan')).toBe(false);
  });

  it('includes each template guide, agent files, and nested Markdown structure', () => {
    for (const template of NOTEBOOK_TEMPLATES) {
      const files = getNotebookTemplateFiles(template.id);
      const paths = new Set(files.map((file) => file.path));

      expect(files.length).toBeGreaterThan(1);
      expect(paths.has('README.md')).toBe(true);
      expect(paths.has('AGENTS.md')).toBe(true);
      expect([...paths].some((path) => path.startsWith('.agents/'))).toBe(true);
      expect([...paths].some((path) => path.includes('/') && path.endsWith('.md'))).toBe(true);
    }

    const productDevelopmentPaths = getNotebookTemplateFiles('product-development')
      .map((file) => file.path);
    expect(productDevelopmentPaths).toContain('.gitignore');
    expect(productDevelopmentPaths).toContain('CODEOWNERS');
    expect(NOTEBOOK_TEMPLATES.find((template) => template.id === 'work-management')?.name).toBe('工作管理');
  });
});
