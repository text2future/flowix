import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Schema, type Node as PMNode } from 'prosemirror-model'

import {
  BlockDragExtension,
  dropBlockDragAtForView,
  resolveListDropTarget,
  resolveRootListDropTarget,
  startBlockDragForView,
} from './block-drag'

function createSchema() {
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      text: { group: 'inline' },
      bulletList: { group: 'block', content: 'listItem+' },
      taskList: { group: 'block', content: 'taskItem+' },
      listItem: { content: 'paragraph block*' },
      taskItem: { content: 'paragraph block*', attrs: { checked: { default: false } } },
    },
  })
}

function makeDocument(schema: Schema) {
  const item = (text: string, children: ReturnType<typeof schema.nodes.bulletList.create> | null = null) => schema.nodes.listItem.create(
    null,
    [schema.nodes.paragraph.create(null, schema.text(text)), ...(children ? [children] : [])],
  )
  const a1a = item('A1a')
  const a1 = item('A1', schema.nodes.bulletList.create(null, a1a))
  const a = item('A', schema.nodes.bulletList.create(null, a1))
  const b = item('B')
  return schema.nodes.doc.create(null, schema.nodes.bulletList.create(null, [a, b]))
}

function findItem(doc: ReturnType<Schema['node']>, text: string) {
  let found: { pos: number; depth: number } | null = null
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem' || node.firstChild?.textContent !== text) return true
    let depth = 0
    try {
      const $pos = doc.resolve(pos)
      for (let level = 1; level <= $pos.depth; level += 1) {
        if ($pos.node(level).type.name === 'listItem') depth += 1
      }
    } catch {
      return false
    }
    found = { pos, depth }
    return true
  })
  const result = found as { pos: number; depth: number } | null
  if (!result) throw new Error(`Missing list item ${text}`)
  return result
}

describe('resolveListDropTarget', () => {
  it('promotes a deep source to the existing shallower list', () => {
    const schema = createSchema()
    const doc = makeDocument(schema)
    const source = findItem(doc, 'A1a')
    const anchor = findItem(doc, 'A')
    const target = resolveListDropTarget(doc, {
      from: source.pos,
      to: source.pos + doc.nodeAt(source.pos)!.nodeSize,
      sourceDepth: source.depth,
      sourceListTypeName: 'bulletList',
    }, anchor, 'after')

    expect(target?.anchorDepth).toBe(0)
    expect(target?.desiredDepth).toBe(1)
    expect(target?.listTypeName).toBe('bulletList')
  })

  it('inserts a shallow source after the whole ancestor subtree', () => {
    const schema = createSchema()
    const doc = makeDocument(schema)
    const source = findItem(doc, 'B')
    const anchor = findItem(doc, 'A1a')
    const target = resolveListDropTarget(doc, {
      from: source.pos,
      to: source.pos + doc.nodeAt(source.pos)!.nodeSize,
      sourceDepth: source.depth,
      sourceListTypeName: 'bulletList',
    }, anchor, 'after')
    const a = findItem(doc, 'A')

    expect(target?.anchorDepth).toBe(2)
    expect(target?.desiredDepth).toBe(0)
    expect(target?.insertPos).toBe(a.pos + doc.nodeAt(a.pos)!.nodeSize)
  })

  it('does not allow task items to enter an ordinary list', () => {
    const schema = createSchema()
    const doc = makeDocument(schema)
    const source = findItem(doc, 'B')
    const anchor = findItem(doc, 'A')
    const target = resolveListDropTarget(doc, {
      from: source.pos,
      to: source.pos + doc.nodeAt(source.pos)!.nodeSize,
      sourceDepth: source.depth,
      sourceListTypeName: 'taskList',
    }, anchor, 'after')

    expect(target).toBeNull()
  })

  it('creates a root list drop target between ordinary top-level blocks', () => {
    const schema = createSchema()
    const list = schema.nodes.bulletList.create(null, schema.nodes.listItem.create(
      null,
      schema.nodes.paragraph.create(null, schema.text('source')),
    ))
    const firstParagraph = schema.nodes.paragraph.create(null, schema.text('first'))
    const secondParagraph = schema.nodes.paragraph.create(null, schema.text('second'))
    const topLevel = [
      { pos: 0, node: list, top: 0, bottom: 20 },
      { pos: list.nodeSize, node: firstParagraph, top: 30, bottom: 50 },
      { pos: list.nodeSize + firstParagraph.nodeSize, node: secondParagraph, top: 60, bottom: 80 },
    ]

    const target = resolveRootListDropTarget({
      sourceDepth: 0,
      sourceListTypeName: 'bulletList',
    }, 55, topLevel)

    expect(target?.createList).toBe(true)
    expect(target?.listTypeName).toBe('bulletList')
    expect(target?.insertPos).toBe(secondParagraph ? list.nodeSize + firstParagraph.nodeSize : -1)
  })
})

describe('block drag transactions', () => {
  it('moves an item between two ordinary paragraphs and removes the empty source list', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [StarterKit, BlockDragExtension],
      content: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [{
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'source' }] }],
            }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
        ],
      },
    })

    try {
      const { view } = editor
      const topLevelPositions: number[] = []
      view.state.doc.forEach((_node, pos) => topLevelPositions.push(pos))
      topLevelPositions.forEach((pos, index) => {
        const dom = view.nodeDOM(pos)
        if (!(dom instanceof HTMLElement)) return
        const top = index * 30
        Object.defineProperty(dom, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ top, bottom: top + 20 }),
        })
      })

      const sourcePos = topLevelPositions[0] + 1
      const source = view.state.doc.nodeAt(sourcePos)
      expect(source?.type.name).toBe('listItem')
      expect(startBlockDragForView(view, {
        pos: sourcePos,
        nodeSize: source!.nodeSize,
      })).toBe(true)

      // The gap between the first and second paragraph is y=45.
      expect(dropBlockDragAtForView(view, 0, 45)).toBe(true)

      expect(view.state.doc.childCount).toBe(3)
      expect(view.state.doc.child(0).type.name).toBe('paragraph')
      expect(view.state.doc.child(1).type.name).toBe('bulletList')
      expect(view.state.doc.child(1).firstChild?.textContent).toBe('source')
      expect(view.state.doc.child(2).type.name).toBe('paragraph')
      expect(view.state.doc.child(2).textContent).toBe('second')
    } finally {
      editor.destroy()
      element.remove()
    }
  })

  it('merges a newly created root list with an adjacent list of the same type', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [StarterKit, BlockDragExtension],
      content: {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [{
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'source' }] }],
            }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
          {
            type: 'bulletList',
            content: [{
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'existing' }] }],
            }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'last' }] },
        ],
      },
    })

    try {
      const { view } = editor
      const topLevelPositions: number[] = []
      view.state.doc.forEach((_node, pos) => topLevelPositions.push(pos))
      topLevelPositions.forEach((pos, index) => {
        const dom = view.nodeDOM(pos)
        if (!(dom instanceof HTMLElement)) return
        const top = index * 30
        Object.defineProperty(dom, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ top, bottom: top + 20 }),
        })
      })

      const sourcePos = topLevelPositions[0] + 1
      const source = view.state.doc.nodeAt(sourcePos)
      expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source!.nodeSize })).toBe(true)

      // The gap before the existing list is y=55.
      expect(dropBlockDragAtForView(view, 0, 55)).toBe(true)
      expect(view.state.doc.childCount).toBe(3)
      expect(view.state.doc.child(0).type.name).toBe('paragraph')
      expect(view.state.doc.child(1).type.name).toBe('bulletList')
      expect(view.state.doc.child(1).childCount).toBe(2)
      expect(view.state.doc.child(1).textContent).toBe('sourceexisting')
      expect(view.state.doc.child(2).type.name).toBe('paragraph')
    } finally {
      editor.destroy()
      element.remove()
    }
  })

  it('keeps list-item drops inside a list nested in a blockquote', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const editor = new Editor({
      element,
      extensions: [StarterKit, BlockDragExtension],
      content: {
        type: 'doc',
        content: [{
          type: 'blockquote',
          content: [{
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'source' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'target' }] }] },
            ],
          }],
        }],
      },
    })

    try {
      const { view } = editor
      const listPos = findNodePos(view.state.doc, 'bulletList')
      const itemPositions: number[] = []
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'listItem') itemPositions.push(pos)
        return true
      })
      const blockquote = view.nodeDOM(0)
      const list = view.nodeDOM(listPos)
      if (!(blockquote instanceof HTMLElement) || !(list instanceof HTMLElement)) throw new Error('Missing list DOM')
      Object.defineProperty(blockquote, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: 0, bottom: 80 }),
      })
      Object.defineProperty(list, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: 0, bottom: 60 }),
      })
      itemPositions.forEach((pos, index) => {
        const item = view.nodeDOM(pos)
        if (!(item instanceof HTMLElement)) return
        Object.defineProperty(item, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ top: index * 30, bottom: index * 30 + 20 }),
        })
      })

      const source = view.state.doc.nodeAt(itemPositions[0])!
      expect(startBlockDragForView(view, { pos: itemPositions[0], nodeSize: source.nodeSize })).toBe(true)
      expect(dropBlockDragAtForView(view, 0, 45)).toBe(true)
      expect(view.state.doc.firstChild?.firstChild?.textContent).toBe('targetsource')
    } finally {
      editor.destroy()
      element.remove()
    }
  })
})

function findNodePos(doc: PMNode, typeName: string): number {
  let result = -1
  doc.descendants((node, pos) => {
    if (node.type.name === typeName && result < 0) result = pos
    return result < 0
  })
  if (result < 0) throw new Error(`Missing node ${typeName}`)
  return result
}
