import { describe, expect, it } from 'vitest'

import { textBlockContentY, nodeContentX, nodeContentY } from './positioning'

describe('drag handle scroll-content coordinates', () => {
  it('keeps a non-ProseMirror header in the block Y coordinate', () => {
    // Scroller begins at viewport y=100. A title/header occupies 60px, so the
    // selected block begins at viewport y=180. The handle must retain that
    // 80px content offset instead of subtracting ProseMirror's shifted top.
    expect(nodeContentY(180, 100, 0, 3)).toBe(83)
  })

  it('produces a stable content coordinate while the container scrolls', () => {
    expect(nodeContentY(180, 100, 0, 3)).toBe(83)
    expect(nodeContentY(140, 100, 40, 3)).toBe(83)
  })

  it('uses the same scroll-content coordinate system on X', () => {
    expect(nodeContentX(240, 100, 0)).toBe(158)
    expect(nodeContentX(220, 100, 20)).toBe(158)
  })
})

describe('text-block text-line coordinates', () => {
  const headingInfo = {
    typeName: 'heading',
    pos: 7,
    attrs: { level: 1 },
  } as unknown as Parameters<typeof textBlockContentY>[1]

  it('anchors headings to the first text line, including heading padding', () => {
    const view = {
      coordsAtPos: (pos: number) => {
        expect(pos).toBe(8)
        return { top: 236, bottom: 273, left: 0, right: 0 }
      },
    } as unknown as Parameters<typeof textBlockContentY>[0]

    expect(textBlockContentY(view, headingInfo, 100, 0)).toBe(140)
    expect(textBlockContentY(view, headingInfo, 136, 36)).toBe(140)
  })

  it('anchors paragraphs to the measured text line, including top padding', () => {
    const view = {
      coordsAtPos: (pos: number) => {
        expect(pos).toBe(8)
        return { top: 150, bottom: 177, left: 0, right: 0 }
      },
    } as unknown as Parameters<typeof textBlockContentY>[0]

    expect(textBlockContentY(view, { ...headingInfo, typeName: 'paragraph' }, 100, 0)).toBe(50)
  })

  it('returns null for non-text blocks', () => {
    const view = {} as Parameters<typeof textBlockContentY>[0]
    expect(textBlockContentY(view, { ...headingInfo, typeName: 'image' }, 100, 0)).toBeNull()
  })

  it('only nudges H1-H3', () => {
    const view = {
      coordsAtPos: () => ({ top: 236, bottom: 273, left: 0, right: 0 }),
    } as unknown as Parameters<typeof textBlockContentY>[0]

    expect(textBlockContentY(view, { ...headingInfo, attrs: { level: 2 } }, 100, 0)).toBe(139)
    expect(textBlockContentY(view, { ...headingInfo, attrs: { level: 3 } }, 100, 0)).toBe(138)
    expect(textBlockContentY(view, { ...headingInfo, attrs: { level: 4 } }, 100, 0)).toBe(136)
  })

  it('falls back when the PM view cannot resolve the position', () => {
    const view = {
      coordsAtPos: () => { throw new Error('destroyed') },
    } as unknown as Parameters<typeof textBlockContentY>[0]

    expect(textBlockContentY(view, headingInfo, 100, 0)).toBeNull()
  })
})
