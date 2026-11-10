/**
 * 重放一次标准 popover 入场关键帧 (`.flowix-popover-enter`, 定义在
 * `styles/index.css` 的 `flowix-popover-in`)。
 *
 * 为什么不直接用 transition: 元素从 `display:none` (hidden 属性) 变为可见的
 * 同一帧里, transition 没有可过渡的"前一刻"状态, 不会触发; 关键帧动画则在
 * 每次从隐藏变为可见时都会完整播放 ── 但同一个类反复添加不会重启动画, 所以
 * 需要走一遍 remove → 强制 reflow → re-add 的循环。
 *
 * 重放时机由调用方决定: 打开弹窗、在弹窗内翻页都属于"出现", 应该调用;
 * 弹窗保持打开时的原地内容重绘 (增删一行、数据刷新) 不应调用, 否则整个
 * 弹窗会闪一遍。
 */
export function replayEnterAnimation(
  element: HTMLElement,
  className = "flowix-popover-enter",
): void {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}
