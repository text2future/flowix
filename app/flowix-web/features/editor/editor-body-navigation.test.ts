import { Schema } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { findFirstBlock } from './editor-body-navigation';

/**
 * `findFirstBlock` is the single traversal behind both "where does the body
 * start" (caret, backspace at start) and the first-block CSS marks. The two
 * callers deliberately skip different chrome, so the skip set is the contract.
 */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    frontmatter: { group: 'block', content: '', atom: true },
    agentThreadCard: { group: 'block', content: '', atom: true },
    text: {},
  },
});

const paragraph = () => schema.nodes.paragraph.create(null, schema.text('Body'));
const frontmatter = () => schema.nodes.frontmatter.create();
const card = () => schema.nodes.agentThreadCard.create();

describe('findFirstBlock', () => {
  it('returns the range and index of the first block it does not skip', () => {
    const doc = schema.nodes.doc.create(null, [frontmatter(), paragraph(), paragraph()]);
    const first = findFirstBlock(doc, new Set(['frontmatter']));

    expect(first).toMatchObject({ index: 1, from: doc.child(0).nodeSize });
    expect(first?.node.type.name).toBe('paragraph');
    expect(first?.to).toBe(first!.from + doc.child(1).nodeSize);
  });

  it('honours the caller skip set', () => {
    const doc = schema.nodes.doc.create(null, [card(), paragraph()]);

    expect(findFirstBlock(doc, new Set(['frontmatter']))?.node.type.name).toBe('agentThreadCard');
    expect(findFirstBlock(doc, new Set(['frontmatter', 'agentThreadCard']))?.node.type.name)
      .toBe('paragraph');
  });

  it('returns null when every block is skipped', () => {
    expect(findFirstBlock(schema.nodes.doc.create(null, [frontmatter()]), new Set(['frontmatter'])))
      .toBeNull();
  });

  it('counts nested content of the first block in the range', () => {
    const nested = schema.nodes.paragraph.create(null, [schema.text('a'), schema.text('b')]);
    const doc = schema.nodes.doc.create(null, [nested]);
    const first = findFirstBlock(doc, new Set(['frontmatter']));

    expect(first?.from).toBe(0);
    expect(first?.to).toBe(nested.nodeSize);
  });
});
