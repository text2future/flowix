import { Schema } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'

import { selectionBelongsToMenuPin, type MenuPinState } from './menu-pin'

function createFixture() {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      noteReference: { group: 'inline', inline: true, atom: true, selectable: true },
      text: { group: 'inline' },
    },
  })
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text('before '),
    schema.nodes.noteReference.create(),
    schema.text(' after'),
  ])
  const doc = schema.nodes.doc.create(null, paragraph)
  const notePos = (() => {
    let result = -1
    doc.descendants((node, pos) => {
      if (node.type.name === 'noteReference') result = pos
      return true
    })
    return result
  })()
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 1),
  })

  return { doc, notePos, paragraph, state }
}

describe('selectionBelongsToMenuPin', () => {
  it('keeps a paragraph pin while the text cursor remains inside it', () => {
    const { paragraph, state } = createFixture()
    const pin: MenuPinState = {
      pos: 0,
      typeName: 'paragraph',
      nodeSize: paragraph.nodeSize,
    }

    expect(selectionBelongsToMenuPin(state, pin)).toBe(true)
  })

  it('clears a paragraph pin when an inline document node is selected', () => {
    const { doc, notePos, paragraph, state } = createFixture()
    const nextState = state.apply(
      state.tr.setSelection(NodeSelection.create(doc, notePos)),
    )
    const pin: MenuPinState = {
      pos: 0,
      typeName: 'paragraph',
      nodeSize: paragraph.nodeSize,
    }

    expect(nextState.selection).toBeInstanceOf(NodeSelection)
    expect(selectionBelongsToMenuPin(nextState, pin)).toBe(false)
  })

  it('keeps a pin when the pinned node itself is NodeSelected', () => {
    const { doc, notePos, state } = createFixture()
    const note = doc.nodeAt(notePos)!
    const nextState = state.apply(
      state.tr.setSelection(NodeSelection.create(doc, notePos)),
    )
    const pin: MenuPinState = {
      pos: notePos,
      typeName: 'noteReference',
      nodeSize: note.nodeSize,
    }

    expect(selectionBelongsToMenuPin(nextState, pin)).toBe(true)
  })
})
