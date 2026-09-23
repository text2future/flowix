import { describe, expect, it, vi } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import type { Editor } from '@tiptap/core'

import { deleteBlock } from './actions'

function createSchema() {
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      text: { group: 'inline' },
      bulletList: { group: 'block', content: 'listItem+' },
      listItem: { content: 'paragraph block*' },
    },
  })
}

function findItem(doc: ReturnType<Schema['node']>, text: string): number {
  let result = -1
  doc.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.firstChild?.textContent === text) result = pos
    return true
  })
  if (result < 0) throw new Error(`Missing item ${text}`)
  return result
}

function makeTarget(doc: ReturnType<Schema['node']>, pos: number) {
  const node = doc.nodeAt(pos)!
  return {
    node,
    typeName: node.type.name,
    attrs: node.attrs,
    pos,
    nodeSize: node.nodeSize,
    dom: document.createElement('li'),
  }
}

describe('deleteBlock list item cleanup', () => {
  it('replaces the last root list item with an empty paragraph', () => {
    const schema = createSchema()
    const item = schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('only')))
    const doc = schema.nodes.doc.create(null, schema.nodes.bulletList.create(null, item))
    const pos = findItem(doc, 'only')
    const state = EditorState.create({ schema, doc })
    const dispatch = vi.fn()
    const editor = { state, view: { dispatch } } as unknown as Editor

    expect(deleteBlock(editor, makeTarget(doc, pos))).toBe(true)
    const transaction = dispatch.mock.calls[0]?.[0]
    expect(transaction.doc.firstChild?.type.name).toBe('paragraph')
    expect(transaction.doc.firstChild?.content.size).toBe(0)
  })

  it('removes a last nested list and leaves an input paragraph in its parent item', () => {
    const schema = createSchema()
    const nested = schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('nested')))
    const outer = schema.nodes.listItem.create(null, [
      schema.nodes.paragraph.create(null, schema.text('outer')),
      schema.nodes.bulletList.create(null, nested),
    ])
    const doc = schema.nodes.doc.create(null, schema.nodes.bulletList.create(null, outer))
    const pos = findItem(doc, 'nested')
    const state = EditorState.create({ schema, doc })
    const dispatch = vi.fn()
    const editor = { state, view: { dispatch } } as unknown as Editor

    expect(deleteBlock(editor, makeTarget(doc, pos))).toBe(true)
    const transaction = dispatch.mock.calls[0]?.[0]
    const remainingOuter = transaction.doc.firstChild?.firstChild
    expect(remainingOuter?.childCount).toBe(2)
    expect(remainingOuter?.child(1).type.name).toBe('paragraph')
  })
})
