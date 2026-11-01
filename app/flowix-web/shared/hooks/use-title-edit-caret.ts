import { useLayoutEffect, useRef } from 'react';

/** Preserve the clicked text position when a title is replaced by an input. */
export function useTitleEditCaret(editing: boolean) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingOffset = useRef<number | null>(null);

  const captureCaret = (element: HTMLElement, x: number, y: number) => {
    const doc = element.ownerDocument;
    const caretDocument = doc as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = caretDocument.caretPositionFromPoint?.(x, y);
    const nativeRange = position ? null : caretDocument.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode ?? nativeRange?.startContainer;
    const offset = position?.offset ?? nativeRange?.startOffset;
    if (node && offset !== undefined && element.contains(node)) {
      const prefix = doc.createRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(node, offset);
      pendingOffset.current = prefix.toString().length;
      return;
    }

    // Fallback for WebViews without a native caret API. Measure the rendered
    // glyphs, retaining UTF-16 offsets required by input.setSelectionRange.
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) {
      pendingOffset.current = null;
      return;
    }
    let index = 0;
    let closestOffset = 0;
    let closestDistance = Infinity;
    const range = doc.createRange();
    // 少数环境（服务端渲染/测试文档）没有 Range 几何信息：退回「光标放到末尾」。
    if (typeof range.getBoundingClientRect !== 'function') {
      pendingOffset.current = null;
      return;
    }
    for (const character of text.textContent ?? '') {
      const end = index + character.length;
      range.setStart(text, index);
      range.setEnd(text, end);
      const rect = range.getBoundingClientRect();
      for (const [boundary, boundaryOffset] of [[rect.left, index], [rect.right, end]]) {
        const distance = Math.abs(x - boundary);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestOffset = boundaryOffset;
        }
      }
      index = end;
    }
    pendingOffset.current = closestOffset;
  };

  useLayoutEffect(() => {
    if (!editing || !inputRef.current) return;
    const input = inputRef.current;
    const offset = Math.min(pendingOffset.current ?? input.value.length, input.value.length);
    pendingOffset.current = null;
    input.focus();
    input.setSelectionRange(offset, offset);
  }, [editing]);

  return { inputRef, captureCaret };
}
