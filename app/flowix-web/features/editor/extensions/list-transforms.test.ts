import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { TextSelection } from 'prosemirror-state'
import { BlockDragExtension, dropBlockDragAtForView, startBlockDragForView } from './block-drag'
import { applyListType, ListTypeShortcuts, outdentAcrossListTypes } from './list-transforms'
import { itemsOf } from './list-structure'
import { getCurrentBlockInfo } from '@features/editor/components/drag-context-menu/block-info'
import { TabCharacter } from './tab-character'

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const item = (text: string, child?: object) => ({ type: 'listItem', content: [paragraph(text), ...(child ? [child] : [])] })
const task = (text: string, checked = false) => ({ type: 'taskItem', attrs: { checked }, content: [paragraph(text)] })
const list = (type: string, ...content: ReturnType<typeof item>[]) => ({ type, content })

const editors: Editor[] = []
const elements: HTMLElement[] = []

beforeEach(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }),
    },
  })
})

function createEditor(content: object[]): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  elements.push(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit.configure({ trailingNode: false }), TaskList, TaskItem.configure({ nested: true }), BlockDragExtension, ListTypeShortcuts, TabCharacter],
    content: { type: 'doc', content },
  })
  editors.push(editor)
  return editor
}

function itemPos(editor: Editor, text: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if ((node.type.name === 'listItem' || node.type.name === 'taskItem')
      && node.firstChild?.textContent === text) found = pos
    return found < 0
  })
  if (found < 0) throw new Error(`Missing ${text}`)
  return found
}

function select(editor: Editor, text: string): void {
  editor.commands.setTextSelection(itemPos(editor, text) + 2)
}

function setBounds(editor: Editor, pos: number, top: number, bottom: number): void {
  const dom = editor.view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) throw new Error(`No DOM at ${pos}`)
  Object.defineProperty(dom, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, bottom, height: bottom - top, left: 0, right: 200, width: 200 }),
  })
}

afterEach(() => {
  editors.forEach(editor => {
    editor.destroy()
  })
  elements.forEach(element => element.remove())
  editors.length = 0
  elements.length = 0
})

describe('list transforms', () => {
  it('does not transform a read-only list', () => {
    const editor = createEditor([list('bulletList', item('A'), item('B'))])
    select(editor, 'B')
    editor.setEditable(false)

    expect(applyListType(editor, 'taskList')).toBe(false)
    expect(editor.state.doc.firstChild?.type.name).toBe('bulletList')
    expect(editor.state.doc.childCount).toBe(1)
  })

  it('uses the same item conversion for Tiptap list shortcuts', () => {
    const editor = createEditor([list('bulletList', item('A'), item('B'))])
    select(editor, 'B')
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: '9', code: 'Digit9', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }))

    expect(editor.state.doc.child(0).type.name).toBe('bulletList')
    expect(editor.state.doc.child(1).type.name).toBe('taskList')
  })

  it('converts one item into a task list without changing its siblings', () => {
    const editor = createEditor([list('bulletList', item('A'), item('B'), item('C'))])
    select(editor, 'B')

    expect(applyListType(editor, 'taskList')).toBe(true)
    expect(editor.state.doc.toJSON().content).toMatchObject([
      { type: 'bulletList', content: [{ type: 'listItem' }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false } }] },
      { type: 'bulletList', content: [{ type: 'listItem' }] },
    ])

    select(editor, 'B')
    expect(getCurrentBlockInfo(editor)?.typeName).toBe('taskItem')
    expect(applyListType(editor, 'orderedList')).toBe(true)
    expect(editor.state.doc.toJSON().content?.map((node: { type: string }) => node.type))
      .toEqual(['bulletList', 'orderedList', 'bulletList'])

    select(editor, 'B')
    expect(applyListType(editor, 'bulletList')).toBe(true)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.textContent).toBe('ABC')
  })

  it('converts a contiguous selection and keeps ordered list numbering', () => {
    const editor = createEditor([{
      type: 'orderedList',
      attrs: { start: 4 },
      content: [item('A'), item('B'), item('C'), item('D')],
    }])
    const from = itemPos(editor, 'B') + 2
    const to = itemPos(editor, 'C') + 3
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))

    expect(applyListType(editor, 'taskList')).toBe(true)
    expect(editor.state.doc.childCount).toBe(3)
    expect(editor.state.doc.child(0).attrs.start).toBe(4)
    expect(editor.state.doc.child(1).childCount).toBe(2)
    expect(editor.state.doc.child(2).attrs.start).toBe(7)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.attrs.start).toBe(4)
    expect(editor.state.doc.firstChild?.childCount).toBe(4)
  })

  it('rejoins numbered runs when a task item is converted back', () => {
    const editor = createEditor([{
      type: 'orderedList', attrs: { start: 4 }, content: [item('A'), item('B'), item('C')],
    }])
    select(editor, 'B')
    expect(applyListType(editor, 'taskList')).toBe(true)
    select(editor, 'B')
    expect(applyListType(editor, 'orderedList')).toBe(true)

    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.attrs.start).toBe(4)
    expect(editor.state.doc.firstChild?.textContent).toBe('ABC')
  })

  it('resets a checked task when it is converted to a regular item and back', () => {
    const editor = createEditor([{ type: 'taskList', content: [task('Done', true)] }])
    select(editor, 'Done')
    expect(applyListType(editor, 'bulletList')).toBe(true)
    select(editor, 'Done')
    expect(applyListType(editor, 'taskList')).toBe(true)
    expect(editor.state.doc.firstChild?.firstChild?.attrs.checked).toBe(false)
  })

  it('preserves a nested list when converting its parent item', () => {
    const editor = createEditor([list('bulletList',
      item('Parent', { type: 'orderedList', content: [item('Child')] }),
    )])
    select(editor, 'Parent')

    expect(applyListType(editor, 'taskList')).toBe(true)
    expect(editor.state.doc.firstChild?.firstChild?.lastChild?.type.name).toBe('orderedList')
    expect(editor.state.doc.firstChild?.firstChild?.lastChild?.textContent).toBe('Child')
  })

  it('indents and outdents a task item across an ordinary list boundary', () => {
    const editor = createEditor([
      list('bulletList', item('A')),
      { type: 'taskList', content: [task('B', true)] },
    ])
    select(editor, 'B')

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }))
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.firstChild?.lastChild?.type.name).toBe('taskList')
    expect(editor.state.doc.firstChild?.firstChild?.lastChild?.firstChild?.attrs.checked).toBe(true)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }))
    expect(editor.state.doc.childCount).toBe(2)
    expect(editor.state.doc.child(0).type.name).toBe('bulletList')
    expect(editor.state.doc.child(1).type.name).toBe('taskList')
    expect(editor.state.doc.child(1).firstChild?.attrs.checked).toBe(true)
  })

  it('keeps an unordered child unordered when outdenting from a numbered parent', () => {
    const editor = createEditor([{
      type: 'orderedList',
      attrs: { start: 3 },
      content: [item('Parent', list('bulletList', item('Child')))],
    }])
    select(editor, 'Child')

    expect(outdentAcrossListTypes(editor)).toBe(true)
    expect(editor.state.doc.child(0).type.name).toBe('orderedList')
    expect(editor.state.doc.child(0).attrs.start).toBe(3)
    expect(editor.state.doc.child(1).type.name).toBe('bulletList')
    expect(editor.state.doc.child(1).textContent).toBe('Child')
  })

  it('moves a paragraph between list items by splitting the list', () => {
    const editor = createEditor([
      list('bulletList', item('A'), item('B')),
      paragraph('Outside'),
    ])
    const { view } = editor
    const listNode = view.state.doc.firstChild!
    const sourcePos = listNode.nodeSize
    setBounds(editor, 0, 0, 60)
    setBounds(editor, 1, 0, 20)
    setBounds(editor, 2, 0, 20)
    const secondPos = 1 + listNode.firstChild!.nodeSize
    setBounds(editor, secondPos, 30, 50)
    setBounds(editor, secondPos + 1, 30, 50)
    const source = view.state.doc.nodeAt(sourcePos)!

    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 20, 25)).toBe(true)
    expect(view.state.doc.childCount).toBe(3)
    expect(view.state.doc.child(0).textContent).toBe('A')
    expect(view.state.doc.child(1).textContent).toBe('Outside')
    expect(view.state.doc.child(2).textContent).toBe('B')
  })

  it('splits a nested list when a root paragraph lands between its children', () => {
    const editor = createEditor([
      list('bulletList', item('Parent', list('bulletList', item('A'), item('B')))),
      paragraph('Outside'),
    ])
    const { view } = editor
    let nestedListPos = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'bulletList' && pos > 0) nestedListPos = pos
      return true
    })
    const sourcePos = view.state.doc.firstChild!.nodeSize
    const firstPos = itemPos(editor, 'A')
    const secondPos = itemPos(editor, 'B')
    setBounds(editor, 0, 0, 100)
    setBounds(editor, nestedListPos, 25, 90)
    setBounds(editor, firstPos, 30, 50)
    setBounds(editor, firstPos + 1, 30, 50)
    setBounds(editor, secondPos, 60, 80)
    setBounds(editor, secondPos + 1, 60, 80)

    const source = view.state.doc.nodeAt(sourcePos)!
    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 20, 55)).toBe(true)
    const parent = view.state.doc.firstChild!.firstChild!
    expect(itemsOf(parent).slice(1).map(node => node.type.name))
      .toEqual(['bulletList', 'paragraph', 'bulletList'])
  })

  it('nests a dragged task item under an ordinary item while keeping its checkbox', () => {
    const editor = createEditor([
      list('bulletList', item('Parent')),
      { type: 'taskList', content: [task('Child', true)] },
    ])
    const { view } = editor
    const sourcePos = view.state.doc.firstChild!.nodeSize + 1
    setBounds(editor, 0, 0, 40)
    setBounds(editor, 1, 0, 30)
    setBounds(editor, 2, 0, 30)
    const source = view.state.doc.nodeAt(sourcePos)!

    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 80, 15)).toBe(true)
    expect(view.state.doc.childCount).toBe(1)
    const childList = view.state.doc.firstChild?.firstChild?.lastChild
    expect(childList?.type.name).toBe('taskList')
    expect(childList?.firstChild?.attrs.checked).toBe(true)
  })

  it('nests a dragged numbered item under a task item without changing its type', () => {
    const editor = createEditor([
      { type: 'taskList', content: [task('Parent')] },
      { type: 'orderedList', attrs: { start: 4 }, content: [item('Child')] },
    ])
    const { view } = editor
    const sourcePos = view.state.doc.firstChild!.nodeSize + 1
    setBounds(editor, 0, 0, 40)
    setBounds(editor, 1, 0, 30)
    setBounds(editor, 2, 0, 30)
    const source = view.state.doc.nodeAt(sourcePos)!

    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 80, 15)).toBe(true)
    const childList = view.state.doc.firstChild?.firstChild?.lastChild
    expect(childList?.type.name).toBe('orderedList')
    expect(childList?.attrs.start).toBe(4)
    expect(childList?.firstChild?.type.name).toBe('listItem')
  })

  it('places an incompatible dragged task item between ordinary items as its own list run', () => {
    const editor = createEditor([
      list('bulletList', item('A'), item('B')),
      { type: 'taskList', content: [task('C', true)] },
    ])
    const { view } = editor
    const rootList = view.state.doc.firstChild!
    const sourcePos = rootList.nodeSize + 1
    const secondPos = 1 + rootList.firstChild!.nodeSize
    setBounds(editor, 0, 0, 60)
    setBounds(editor, 1, 0, 20)
    setBounds(editor, 2, 0, 20)
    setBounds(editor, secondPos, 30, 50)
    setBounds(editor, secondPos + 1, 30, 50)
    const source = view.state.doc.nodeAt(sourcePos)!

    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 20, 25)).toBe(true)
    expect(view.state.doc.childCount).toBe(3)
    expect(view.state.doc.content.content.map(node => node.type.name))
      .toEqual(['bulletList', 'taskList', 'bulletList'])
    expect(view.state.doc.child(1).firstChild?.attrs.checked).toBe(true)
  })

  it('keeps a user-created empty sibling when moving the only nonempty item', () => {
    const editor = createEditor([
      list('bulletList', item('A'), { type: 'listItem', content: [{ type: 'paragraph' }] } as ReturnType<typeof item>),
      paragraph('Destination'),
    ])
    const { view } = editor
    const sourcePos = itemPos(editor, 'A')
    const source = view.state.doc.nodeAt(sourcePos)!
    setBounds(editor, 0, 0, 40)
    setBounds(editor, view.state.doc.firstChild!.nodeSize, 60, 90)

    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 0, 100)).toBe(true)
    expect(view.state.doc.firstChild?.type.name).toBe('bulletList')
    expect(view.state.doc.firstChild?.childCount).toBe(1)
    expect(view.state.doc.firstChild?.firstChild?.textContent).toBe('')
  })

  it('preserves ordered numbering when moving an item to a root list', () => {
    const editor = createEditor([
      { type: 'orderedList', attrs: { start: 4 }, content: [item('A'), item('B')] },
      paragraph('Destination'),
    ])
    const { view } = editor
    const sourcePos = itemPos(editor, 'B')
    const source = view.state.doc.nodeAt(sourcePos)!
    setBounds(editor, 0, 0, 40)
    setBounds(editor, view.state.doc.firstChild!.nodeSize, 60, 90)

    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 0, 100)).toBe(true)
    expect(view.state.doc.lastChild?.type.name).toBe('orderedList')
    expect(view.state.doc.lastChild?.attrs.start).toBe(5)
  })

  it('does not merge adjacent ordered lists with discontinuous numbering', () => {
    const editor = createEditor([
      { type: 'orderedList', attrs: { start: 4 }, content: [item('Source')] },
      paragraph('Between'),
      { type: 'orderedList', attrs: { start: 10 }, content: [item('Existing')] },
    ])
    const { view } = editor
    const sourcePos = itemPos(editor, 'Source')
    const source = view.state.doc.nodeAt(sourcePos)!
    setBounds(editor, 0, 0, 20)
    setBounds(editor, view.state.doc.child(0).nodeSize, 30, 50)
    setBounds(editor, view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize, 60, 80)

    expect(startBlockDragForView(view, { pos: sourcePos, nodeSize: source.nodeSize })).toBe(true)
    expect(dropBlockDragAtForView(view, 0, 55)).toBe(true)
    expect(view.state.doc.childCount).toBe(3)
    expect(view.state.doc.child(1).attrs.start).toBe(4)
    expect(view.state.doc.child(2).attrs.start).toBe(10)
  })
})
