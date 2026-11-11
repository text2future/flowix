/** 浮层与参考元素之间保留的视口边距。 */
const VIEWPORT_PADDING = 8;

/** 气泡实际落到视口上的矩形 (fixed 定位坐标 + 量到的尺寸)。 */
export interface FloatingBubbleFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 把 fixed 定位的气泡摆在参考矩形的一侧 (默认上方, 选区入口传 `below`),
 * 首选一侧放不下就翻到另一侧, 水平方向夹在视口内。链接 hover 气泡与内联链接
 * 编辑器共用这套落点, 保证两者在同一个位置上下文切换时不会跳动。
 *
 * 元素需要先在 DOM 中挂载 (读 offsetWidth / offsetHeight 量尺寸)。
 * 返回实际落点: 调用方据此算「锚点 ↔ 气泡」之间的留白时, 不必再读一次会被
 * 进场动画 transform 干扰的 getBoundingClientRect()。
 */
export function positionFloatingBubble(
  element: HTMLElement,
  anchor: DOMRect,
  padding = VIEWPORT_PADDING,
  placement: 'above' | 'below' = 'above',
): FloatingBubbleFrame {
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const centeredLeft = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.min(
    Math.max(centeredLeft, padding),
    window.innerWidth - width - padding,
  );
  const above = anchor.top - height - padding;
  const below = anchor.bottom + padding;
  const fitsAbove = above >= padding;
  const fitsBelow = below + height <= window.innerHeight - padding;
  const preferred = placement === 'below' ? below : above;
  const fallback = placement === 'below' ? above : below;
  const preferredFits = placement === 'below' ? fitsBelow : fitsAbove;
  const top = Math.min(
    Math.max(preferredFits ? preferred : fallback, padding),
    window.innerHeight - height - padding,
  );

  const frameLeft = Math.max(padding, left);
  const frameTop = Math.max(padding, top);
  element.style.left = `${frameLeft}px`;
  element.style.top = `${frameTop}px`;
  return { left: frameLeft, top: frameTop, width, height };
}
