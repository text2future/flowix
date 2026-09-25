import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './markdown-editor'
import { ShortcutsProvider } from '@features/shortcuts'
import '@features/shortcuts/actions'

let container: HTMLDivElement
let root: Root

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

async function mountEditor(): Promise<Editor> {
  let editor: Editor | null = null
  await act(async () => {
    root.render(
      <ShortcutsProvider overrides={{}}>
        <MarkdownEditor content="" onBeforeCreate={instance => { editor = instance }} />
      </ShortcutsProvider>,
    )
  })
  if (!editor) throw new Error('Editor did not mount')
  return editor
}

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const item = (text: string, child?: object) => ({ type: 'listItem', content: [paragraph(text), ...(child ? [child] : [])] })
const task = (text: string, checked = false, child?: object) => ({
  type: 'taskItem', attrs: { checked }, content: [paragraph(text), ...(child ? [child] : [])],
})

describe('mixed list Markdown round trips', () => {
  it('restores a paragraph placed between two list items', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'bulletList', content: [item('A')] },
        paragraph('Between'),
        { type: 'bulletList', content: [item('B')] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    expect(editor.state.doc.content.content.slice(0, 3).map(node => node.type.name))
      .toEqual(['bulletList', 'paragraph', 'bulletList'])
  })

  it('restores a paragraph between nested list runs', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [
            paragraph('Parent'),
            { type: 'bulletList', content: [item('A')] },
            paragraph('Between'),
            { type: 'bulletList', content: [item('B')] },
          ],
        }],
      }],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const restored = editor.state.doc.firstChild?.firstChild
    expect(restored?.content.content.slice(1).map(node => node.type.name))
      .toEqual(['bulletList', 'paragraph', 'bulletList'])
  })

  it('restores adjacent ordinary and task list runs', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'bulletList', content: [item('A')] },
        { type: 'taskList', content: [task('B', true)] },
        { type: 'bulletList', content: [item('C')] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const lists = editor.state.doc.content.content.filter(node =>
      ['bulletList', 'orderedList', 'taskList'].includes(node.type.name))
    expect(lists.map(node => node.type.name)).toEqual(['bulletList', 'taskList', 'bulletList'])
    expect(lists[1].firstChild?.attrs.checked).toBe(true)
  })

  it('keeps numbering across a converted task item', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 4 }, content: [item('A')] },
        { type: 'taskList', content: [task('B')] },
        { type: 'orderedList', attrs: { start: 6 }, content: [item('C')] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const lists = editor.state.doc.content.content.filter(node =>
      ['orderedList', 'taskList'].includes(node.type.name))
    expect(lists.map(node => node.type.name)).toEqual(['orderedList', 'taskList', 'orderedList'])
    expect(lists[0].attrs.start).toBe(4)
    expect(lists[2].attrs.start).toBe(6)
  })

  it('restores task lists under numbered items and numbered lists under tasks', async () => {
    const editor = await mountEditor()
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'orderedList', attrs: { start: 3 }, content: [
          item('Parent', { type: 'taskList', content: [task('Child', true)] }),
        ] },
        { type: 'taskList', content: [
          task('Task parent', false, { type: 'orderedList', content: [item('Numbered child')] }),
        ] },
      ],
    }))

    const markdown = editor.getMarkdown()
    act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
    const ordered = editor.state.doc.content.content.find(node => node.type.name === 'orderedList')
    const taskList = editor.state.doc.content.content.find(node => node.type.name === 'taskList')
    expect(ordered?.attrs.start).toBe(3)
    expect(ordered?.firstChild?.lastChild?.type.name).toBe('taskList')
    expect(ordered?.firstChild?.lastChild?.firstChild?.attrs.checked).toBe(true)
    expect(taskList?.firstChild?.lastChild?.type.name).toBe('orderedList')
  })

  it('restores all six mixed parent and child list combinations', async () => {
    const editor = await mountEditor()
    const listTypes = ['bulletList', 'orderedList', 'taskList'] as const
    for (const parentType of listTypes) {
      for (const childType of listTypes) {
        if (parentType === childType) continue
        const child = {
          type: childType,
          content: [childType === 'taskList' ? task('Child', true) : item('Child')],
        }
        const parent = {
          type: parentType,
          content: [parentType === 'taskList' ? task('Parent', false, child) : item('Parent', child)],
        }
        act(() => editor.commands.setContent({ type: 'doc', content: [parent] }))
        const markdown = editor.getMarkdown()
        act(() => editor.commands.setContent(markdown, { contentType: 'markdown' }))
        const restored = editor.state.doc.content.content.find(node => node.type.name === parentType)
        expect(restored?.firstChild?.lastChild?.type.name, `${parentType} > ${childType}: ${markdown}`)
          .toBe(childType)
      }
    }
  })
})
