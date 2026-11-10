/**
 * 编辑器漂浮层（选区气泡工具条 / 表格气泡工具条）的定位计算 —— 纯函数，便于单测。
 *
 * 坐标系：输入输出都是**视口坐标**，漂浮层用 `position: fixed` 渲染。
 *
 * 为什么不用「相对编辑器根 + absolute」：`.markdown-editor` 是 `overflow: hidden`
 * 的裁剪盒，absolute 子元素越出面板就被裁掉 —— 窄分栏里工具条右侧几个按钮直接
 * 看不见也点不到。fixed 元素的包含块是视口，祖先的 overflow 管不到它，所以面板
 * 装不下时工具条可以压到相邻栏、甚至窗口外，而不是把自己削窄。
 *
 * 宽度策略：菜单宽度固定（由内容决定），这里只算落点、不返回可用宽度。
 * 唯一「装不下」的情况是窗口本身比菜单窄 —— 那时贴左内边距、右边溢出到窗口外。
 * 这是产品决定：宁可出界，不可压缩/裁切。
 */

export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OverlayFrame {
  left: number;
  top: number;
}

export interface OverlayFrameInput {
  /** 锚点（选区包围盒 / 表格包围盒）的视口矩形。 */
  anchor: OverlayRect;
  /** 编辑器面板的视口矩形；垂直方向以它为准，避免工具条飘到标题栏上。 */
  root: OverlayRect;
  /** 菜单实测尺寸；尚未测量时传估算值。 */
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  /** 菜单与锚点之间的间距，默认 8。 */
  gap?: number;
  /** 首选一侧（默认上方）。 */
  placement?: 'above' | 'below';
  /**
   * 首选一侧放不下时是否翻到另一侧，默认 true。
   * 表格气泡传 false：它在表格上沿，翻到下方会盖住首行。
   */
  flip?: boolean;
}

/** 菜单与窗口边缘 / 面板边缘的最小留白。 */
export const OVERLAY_EDGE_PADDING = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function computeOverlayFrame(input: OverlayFrameInput): OverlayFrame | null {
  const { anchor, root, menu, viewport, placement = 'above', flip = true } = input;
  const gap = input.gap ?? OVERLAY_EDGE_PADDING;

  if (!Number.isFinite(anchor.left) || !Number.isFinite(anchor.top)) return null;
  if (menu.width <= 0 || menu.height <= 0) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  const pad = OVERLAY_EDGE_PADDING;

  // 水平：只受窗口约束。菜单比窗口还宽时靠左内边距，右侧溢出到窗口外。
  const minX = pad;
  const maxX = viewport.width - pad;
  if (maxX <= minX) return null;
  const centered = anchor.left + anchor.width / 2 - menu.width / 2;
  const left = clamp(centered, minX, Math.max(minX, maxX - menu.width));

  // 垂直：以「面板 ∩ 视口」为准。锚点滚出面板时工具条贴边停住（不消失），
  // 但不会飘到标题栏 / 工具栏上。
  const minY = Math.max(root.top, 0) + pad;
  const maxY = Math.min(root.top + root.height, viewport.height) - pad;
  if (maxY <= minY) return null;

  const above = anchor.top - gap - menu.height;
  const below = anchor.top + anchor.height + gap;
  const preferred = placement === 'below' ? below : above;
  const other = placement === 'below' ? above : below;
  const preferredFits = placement === 'below'
    ? preferred + menu.height <= maxY
    : preferred >= minY;

  const top = clamp(
    !flip || preferredFits ? preferred : other,
    minY,
    Math.max(minY, maxY - menu.height),
  );

  return { left, top };
}
