import { Schema } from '@tiptap/pm/model'
import { describe, expect, it, vi } from 'vitest'

vi.mock(
  '@features/editor/extensions/codeblock-shiki/shiki/shiki-highlighter',
  () => ({
    getShiki: () => ({
      codeToTokensBase: (code: string) => (
        code.split('\n').map((line) => (
          line
            ? [
                { color: '#ffffff', content: '' },
                { color: '#ffffff', content: line },
              ]
            : []
        ))
      ),
      getLoadedLanguages: () => ['javascript'],
      getLoadedThemes: () => ['github-light'],
    }),
  }),
)

import { getDecorations } from './shiki-decorations'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    codeBlock: {
      attrs: {
        language: { default: 'javascript' },
        theme: { default: 'github-light' },
      },
      content: 'text*',
      group: 'block',
    },
  },
})

describe('Shiki code block decorations', () => {
  it('does not insert atomic widgets at line boundaries', () => {
    const codeBlock = schema.node(
      'codeBlock',
      { language: 'javascript', theme: 'github-light' },
      schema.text('alpha\nbeta\ngamma'),
    )
    const doc = schema.node('doc', null, [codeBlock])

    const decorations = getDecorations({
      doc,
      name: 'codeBlock',
      defaultLanguage: 'plaintext',
      defaultTheme: 'github-light',
    }).find()

    expect(decorations).toHaveLength(3)
    expect(decorations.every(({ from, to }) => from < to)).toBe(true)
  })
})
