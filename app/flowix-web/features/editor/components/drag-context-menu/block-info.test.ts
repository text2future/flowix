import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { Schema } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'

import {
  activateAgentThreadCard,
  getCurrentBlockInfo,
  getBlockInfoForInteraction,
  getFocusedAgentThreadCardInfo,
} from './block-info'

function createListSchema() {
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

function createEditorFixture() {
  const editorContent = document.createElement('div')
  editorContent.className = 'editor-content'
  const editorDom = document.createElement('div')
  editorDom.className = 'ProseMirror'
  editorDom.contentEditable = 'true'

  const card = document.createElement('section')
  card.className = 'agent-thread-card'
  card.dataset.agentThreadCard = 'true'
  const composer = document.createElement('div')
  composer.className = 'agent-thread-card__composer'
  const input = document.createElement('div')
  input.className = 'agent-thread-card__composer-input'
  input.contentEditable = 'true'
  input.tabIndex = 0
  composer.append(input)
  card.append(composer)
  editorDom.append(card)
  editorContent.append(editorDom)
  document.body.append(editorContent)

  type FixtureNode = {
    type: { name: string }
    attrs: Record<string, unknown>
    nodeSize: number
  }
  const node: FixtureNode = {
    type: { name: 'agentThreadCard' },
    attrs: { threadId: 'thread-1' },
    nodeSize: 2,
  }
  const editor = {
    isDestroyed: false,
    view: {
      dom: editorDom,
      isDestroyed: false,
      nodeDOM: (pos: number) => pos === 1 ? card : null,
      state: {
        doc: {
          nodeAt: (pos: number) => pos === 1 ? node : null,
          descendants: (callback: (node: FixtureNode, pos: number) => boolean) => {
            callback(node, 1)
          },
        },
      },
    },
  } as unknown as Editor

  return { editor, input, editorContent }
}

describe('getFocusedAgentThreadCardInfo', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('resolves the card when its nested composer input owns focus', () => {
    const { editor, input } = createEditorFixture()
    input.focus()

    const info = getFocusedAgentThreadCardInfo(editor)

    expect(info?.typeName).toBe('agentThreadCard')
    expect(info?.pos).toBe(1)
    expect(info?.nodeSize).toBe(2)
  })

  it('does not resolve a card when focus is outside its composer', () => {
    const { editor, editorContent } = createEditorFixture()
    const outside = document.createElement('button')
    outside.tabIndex = 0
    editorContent.append(outside)
    outside.focus()

    expect(getFocusedAgentThreadCardInfo(editor)).toBeNull()
  })

  it('keeps the rendered card as the interaction target after composer blur', () => {
    const { editor, input, editorContent } = createEditorFixture()
    input.focus()
    const renderedCard = getFocusedAgentThreadCardInfo(editor)
    const outside = document.createElement('button')
    outside.tabIndex = 0
    editorContent.append(outside)
    outside.focus()

    expect(getBlockInfoForInteraction(editor, renderedCard)?.typeName).toBe('agentThreadCard')
  })

  it('activates the focused card as the outer editor NodeSelection', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        agentThreadCard: { group: 'block', atom: true, selectable: true },
        paragraph: { group: 'block', content: 'text*' },
        text: { group: 'inline' },
      },
    })
    const cardNode = schema.nodes.agentThreadCard.create()
    const doc = schema.nodes.doc.create(null, [
      cardNode,
      schema.nodes.paragraph.create(),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    })
    const editorDom = document.createElement('div')
    const card = document.createElement('section')
    editorDom.append(card)
    const dispatch = vi.fn()
    const editor = {
      isDestroyed: false,
      view: {
        dom: editorDom,
        isDestroyed: false,
        state,
        nodeDOM: (pos: number) => pos === 0 ? card : null,
        dispatch,
      },
    } as unknown as Editor

    const activated = activateAgentThreadCard(editor, {
      node: cardNode,
      typeName: 'agentThreadCard',
      attrs: cardNode.attrs,
      pos: 0,
      nodeSize: cardNode.nodeSize,
      dom: card,
    })

    expect(activated).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const transaction = dispatch.mock.calls[0]?.[0]
    expect(transaction.selection).toBeInstanceOf(NodeSelection)
    expect(transaction.selection.from).toBe(0)
  })
})

describe('getCurrentBlockInfo list items', () => {
  it('resolves the nearest nested list item instead of the outer list', () => {
    const schema = createListSchema()
    const nestedItem = schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('nested')))
    const outerItem = schema.nodes.listItem.create(null, [
      schema.nodes.paragraph.create(null, schema.text('outer')),
      schema.nodes.bulletList.create(null, nestedItem),
    ])
    const doc = schema.nodes.doc.create(null, schema.nodes.bulletList.create(null, outerItem))
    const nestedItemPos = (() => {
      let result = -1
      doc.descendants((node, pos) => {
        if (node.type.name === 'listItem' && node.textContent === 'nested') result = pos
        return true
      })
      return result
    })()
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, nestedItemPos + 3),
    })
    const li = document.createElement('li')
    const editor = {
      isDestroyed: false,
      view: {
        state,
        nodeDOM: (pos: number) => pos === nestedItemPos ? li : null,
      },
    } as unknown as Editor

    const info = getCurrentBlockInfo(editor)

    expect(info?.typeName).toBe('listItem')
    expect(info?.pos).toBe(nestedItemPos)
    expect(info?.dom).toBe(li)
  })
})
