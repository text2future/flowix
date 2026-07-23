import { describe, expect, it, vi } from 'vitest';

vi.mock('@features/editor/extensions/attachment-link/upload/plugin', () => ({
  handleFileUpload: () => undefined,
}));

vi.mock('@features/editor/extensions/note-link', () => ({
  tryMatchPhysicalMemoPath: () => null,
}));

import { readClipboardSnapshot } from '@features/editor/extensions/paste-rules/clipboard';
import {
  containsLooseCodeBlock,
  detectLooseCodeBlocks,
  normalizeLooseCodeBlocks,
} from '@features/editor/extensions/paste-rules/code-block-detector';
import { hasMeaningfulInlineHtml, isStandaloneHtmlTable } from '@features/editor/extensions/paste-rules/html';
import { containsMarkdownTable, hasLeadingFrontmatter } from '@features/editor/extensions/paste-rules/markdown';
import {
  htmlTableToTableContent,
  looksLikeTsvTable,
  tsvToTableContent,
} from '@features/editor/extensions/paste-rules/table';
import { mergeFrontmatterYaml, parseVisibleFrontmatter } from '@features/document/properties/frontmatter-model';
import { createManagedPasteRules } from '@features/editor/extensions/paste-rules/rules';

function cellText(table: any, row: number, cell: number): string {
  return table.content[row].content[cell].content[0].content?.[0]?.text ?? '';
}

describe('paste rule helpers', () => {
  it('normalizes text/uri-list by ignoring comments', () => {
    const data = {
      types: ['text/uri-list'],
      files: [],
      getData(type: string) {
        if (type === 'text/uri-list') return '# copied link\r\nhttps://example.com/page\r\n';
        return '';
      },
    } as unknown as DataTransfer;

    expect(readClipboardSnapshot(data).text).toBe('https://example.com/page');
  });

  it('detects and converts TSV tables without forcing a header row', () => {
    const tsv = 'A\tB\n1\t2';

    expect(looksLikeTsvTable(tsv)).toBe(true);

    const table = tsvToTableContent(tsv);
    expect(table?.type).toBe('table');
    expect(table?.content?.[0].content?.[0].type).toBe('tableCell');
    expect(cellText(table, 1, 1)).toBe('2');
  });

  it('converts HTML tables and preserves an explicit header row', () => {
    const html = '<table><thead><tr><th>Name</th><th>Count</th></tr></thead><tbody><tr><td>Alpha</td><td>3</td></tr></tbody></table>';

    const table = htmlTableToTableContent(html);
    expect(table?.type).toBe('table');
    expect(table?.content?.[0].content?.[0].type).toBe('tableHeader');
    expect(cellText(table, 0, 0)).toBe('Name');
    expect(cellText(table, 1, 1)).toBe('3');
  });

  it('detects markdown tables embedded in a larger markdown paste', () => {
    const markdown = [
      'Intro paragraph',
      '',
      '| Service | MCP support | Notes |',
      '|------|-------------|------|',
      '| Google Drive | Official | Drive MCP |',
      '',
      '- follow up',
    ].join('\n');

    expect(containsMarkdownTable(markdown)).toBe(true);
  });

  it('detects pasted markdown with YAML frontmatter', () => {
    const markdown = [
      '---',
      'title: Paste target',
      'tags:',
      '  - inbox',
      '---',
      'Plain body without markdown markers.',
    ].join('\n');

    expect(hasLeadingFrontmatter(markdown)).toBe(true);
  });

  it('merges pasted frontmatter into the existing document frontmatter', () => {
    const merged = mergeFrontmatterYaml(
      ['key: sg8qgwdq', 'title: Existing'].join('\n'),
      ['name: guizang-ppt-skill', 'description: deck generator', 'key: pasted1'].join('\n'),
    );

    expect(merged).toContain('key: sg8qgwdq');
    expect(merged).toContain('title: Existing');
    expect(merged).toContain('name: guizang-ppt-skill');
    expect(merged).toContain('description: deck generator');
    expect(merged).not.toContain('key: pasted1');
    expect(parseVisibleFrontmatter(merged).userData).toMatchObject({
      title: 'Existing',
      name: 'guizang-ppt-skill',
      description: 'deck generator',
    });
  });

  it('normalizes loose AI-style language blocks into fenced code blocks', () => {
    const markdown = [
      'Reference implementation: Claude Desktop integration',
      '',
      'json',
      '// Configure in Claude settings',
      '{',
      '  "serverUrl": "https://drivemcp.googleapis.com/mcp/v1",',
      '  "oauth": {',
      '    "clientId": "client-id"',
      '  }',
      '}',
      'Your product should follow this pattern:',
    ].join('\n');

    expect(containsLooseCodeBlock(markdown)).toBe(true);
    expect(detectLooseCodeBlocks(markdown)[0]).toMatchObject({
      startLine: 2,
      endLine: 9,
      language: 'json',
    });
    expect(normalizeLooseCodeBlocks(markdown)).toContain([
      '```json',
      '// Configure in Claude settings',
      '{',
      '  "serverUrl": "https://drivemcp.googleapis.com/mcp/v1",',
      '  "oauth": {',
      '    "clientId": "client-id"',
      '  }',
      '}',
      '```',
    ].join('\n'));
  });

  it('does not rewrite loose language lines inside fenced code blocks', () => {
    const markdown = [
      '```text',
      'json',
      '{',
      '  "nested": true',
      '}',
      '```',
    ].join('\n');

    expect(containsLooseCodeBlock(markdown)).toBe(false);
    expect(normalizeLooseCodeBlocks(markdown)).toBe(markdown);
  });

  it('keeps blank lines inside loose code blocks without swallowing following prose', () => {
    const markdown = [
      'javascript',
      'function configure() {',
      '  const clientId = "client-id";',
      '',
      '  return { clientId };',
      '}',
      '',
      'This is regular prose after the code.',
    ].join('\n');

    expect(normalizeLooseCodeBlocks(markdown)).toBe([
      '```javascript',
      'function configure() {',
      '  const clientId = "client-id";',
      '',
      '  return { clientId };',
      '}',
      '```',
      '',
      'This is regular prose after the code.',
    ].join('\n'));
  });

  it('keeps shell comments and commands in the same loose code block', () => {
    const markdown = [
      'MCP Inspector',
      '',
      'bash',
      '# Install Inspector',
      'npm install -g @modelcontextprotocol/inspector',
      '',
      '# Start',
      'npx @modelcontextprotocol/inspector',
      'Open http://localhost:3001 in the browser.',
    ].join('\n');

    expect(normalizeLooseCodeBlocks(markdown)).toContain([
      '```bash',
      '# Install Inspector',
      'npm install -g @modelcontextprotocol/inspector',
      '',
      '# Start',
      'npx @modelcontextprotocol/inspector',
      '```',
    ].join('\n'));
  });

  it('normalizes loose text diagrams without swallowing following prose', () => {
    const markdown = [
      'Architecture flow',
      'text',
      'User settings UI',
      '    ↓',
      'MCP Client Service',
      '    ├─ Create transport',
      '    └─ Initialize client',
      '    ↓',
      'AI calls tools',
      'Key implementation points',
      'Responsibility',
      'Product action',
    ].join('\n');

    expect(detectLooseCodeBlocks(markdown)[0]).toMatchObject({
      startLine: 1,
      endLine: 8,
      language: 'text',
    });
    expect(normalizeLooseCodeBlocks(markdown)).toBe([
      'Architecture flow',
      '```text',
      'User settings UI',
      '    ↓',
      'MCP Client Service',
      '    ├─ Create transport',
      '    └─ Initialize client',
      '    ↓',
      'AI calls tools',
      '```',
      'Key implementation points',
      'Responsibility',
      'Product action',
    ].join('\n'));
  });

  it('only treats inline HTML as rich when it has semantic tags or meaningful styles', () => {
    expect(hasMeaningfulInlineHtml('<span>plain wrapper</span>')).toBe(false);
    expect(hasMeaningfulInlineHtml('<span style="color: red">red text</span>')).toBe(true);
    expect(hasMeaningfulInlineHtml('<a href="https://example.com">link</a>')).toBe(true);
  });

  it('only treats table-only HTML as a standalone HTML table paste', () => {
    expect(isStandaloneHtmlTable('<table><tr><td>A</td></tr></table>')).toBe(true);
    expect(isStandaloneHtmlTable('<h3>Title</h3><table><tr><td>A</td></tr></table>')).toBe(false);
  });

  it('keeps paste rules in deterministic priority order', () => {
    expect(createManagedPasteRules().map(rule => rule.id)).toEqual([
      'files',
      'physical-memo-path',
      'asset-markdown-link',
      'loose-code-block',
      'markdown-table',
      'frontmatter-markdown',
      'html-table',
      'tsv-table',
      'rich-html',
      'rich-inline-html',
      'markdown-block',
    ]);
  });
});
