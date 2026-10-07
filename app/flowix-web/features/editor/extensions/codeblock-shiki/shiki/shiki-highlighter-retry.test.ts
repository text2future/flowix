import { describe, expect, it, vi } from 'vitest'

describe('Shiki initialization retry', () => {
  it('retries after the first engine initialization fails', async () => {
    const highlighter = { getLoadedLanguages: () => [] }
    const createHighlighterCore = vi.fn()
      .mockRejectedValueOnce(new Error('temporary load failure'))
      .mockResolvedValueOnce(highlighter)

    vi.doMock('shiki/core', () => ({ createHighlighterCore }))
    vi.doMock('shiki/engine/oniguruma', () => ({
      createOnigurumaEngine: () => ({}),
    }))

    try {
      const { getShiki, loadHighlighter } = await import('./shiki-highlighter')
      await expect(loadHighlighter()).rejects.toThrow('temporary load failure')
      expect(getShiki()).toBeUndefined()

      await expect(loadHighlighter()).resolves.toBeUndefined()
      expect(getShiki()).toBe(highlighter)
      expect(createHighlighterCore).toHaveBeenCalledTimes(2)
    } finally {
      vi.doUnmock('shiki/core')
      vi.doUnmock('shiki/engine/oniguruma')
    }
  })
})
