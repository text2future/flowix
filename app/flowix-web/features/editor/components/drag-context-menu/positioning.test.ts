import { describe, expect, it } from 'vitest'

import { nodeContentX, nodeContentY } from './positioning'

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
