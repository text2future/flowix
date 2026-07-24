import { describe, expect, it } from 'vitest';
import { buildMarkmapDocument, hasMarkmapContent, type MarkmapDocument, type MarkmapRoot } from './markmap-data';

function blockFor(document: MarkmapDocument, node: MarkmapRoot) {
  return document.blocks[node.payload!.blockId];
}

describe('buildMarkmapDocument', () => {
  it('keeps frontmatter, headings, text, and nested lists in one document tree', () => {
    const document = buildMarkmapDocument(`---
title: Demo
status: active
---
# Product

Product overview text.

## Research
- Interviews
  - Customers
- Competitors

## Delivery
- Desktop app
`);

    expect(blockFor(document, document.root).title).toBe('Product');
    expect(document.root.children.map((node) => blockFor(document, node).kind)).toEqual([
      'frontmatter',
      'paragraph',
      'heading',
      'heading',
    ]);
    const research = document.root.children.find((node) => blockFor(document, node).title === 'Research')!;
    expect(research.children.map((node) => blockFor(document, node).title)).toEqual([
      'Interviews',
      'Competitors',
    ]);
    expect(research.children[0].children.map((node) => blockFor(document, node).title)).toEqual([
      'Customers',
    ]);
    expect(hasMarkmapContent(document)).toBe(true);
  });

  it('supports prose-only documents instead of treating them as empty', () => {
    const document = buildMarkmapDocument('A paragraph without headings or lists.');
    const paragraphs = Object.values(document.blocks).filter((block) => block.kind === 'paragraph');

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].markdown).toBe('A paragraph without headings or lists.');
    expect(hasMarkmapContent(document)).toBe(true);
  });

  it('keeps a truly empty document in the empty state', () => {
    expect(hasMarkmapContent(buildMarkmapDocument(''))).toBe(false);
  });

  it('recognizes Mermaid diagrams and AI thread cards as rich blocks', () => {
    const document = buildMarkmapDocument(`# Architecture

\`\`\`mermaid
flowchart TD
  User --> Flowix
\`\`\`

::agent-thread-card{instanceId="agent-inst-1" threadId="thread-1" title="Review architecture" agentType="codex" agentRoleMemoId="" agentRoleName="Architect" collapsed="false" inputDraft="Follow%20up"}
`);
    const blocks = Object.values(document.blocks);
    const diagram = blocks.find((block) => block.kind === 'mermaid');
    const agent = blocks.find((block) => block.kind === 'agent');

    expect(diagram).toMatchObject({ language: 'mermaid', title: 'Flowchart' });
    expect(diagram?.markdown).toContain('User --> Flowix');
    expect(agent?.agent).toEqual({
      instanceId: 'agent-inst-1',
      threadId: 'thread-1',
      title: 'Review architecture',
      agentType: 'codex',
      agentRoleName: 'Architect',
      inputDraft: 'Follow up',
    });
  });

  it('escapes raw HTML in map node labels', () => {
    const document = buildMarkmapDocument('# Safe\n\n<img src=x onerror=alert(1)>');
    const paragraphNode = document.root.children[0];

    expect(paragraphNode.content).toContain('&lt;img');
    expect(paragraphNode.content).not.toContain('<img');
    expect(paragraphNode.content).not.toContain('onerror="');
  });

  it('wraps long node content in a readable, focusable preview target', () => {
    const document = buildMarkmapDocument('# 文档\n\n这是一段很长的正文内容，用来验证导图节点会显示摘要，并可以打开完整内容预览。');
    const paragraphNode = document.root.children[0];

    expect(paragraphNode.content).toContain('document-markmap-node-content--paragraph');
    expect(paragraphNode.content).toContain('role="button"');
    expect(paragraphNode.content).toContain('tabindex="0"');
    expect(document.root.content).toContain('document-markmap-heading-text');
  });
});
