/**
 * 拖动结束后浏览器仍会派发一次 click。文件夹行的单击选中延迟 300ms,
 * 靠「抑制源路径」或「抑制一小段时间」都拦不住这一次 click; 改用一次性信号:
 * 拖动结束时 arm, 树容器在捕获阶段吞掉紧随其后的 click, 下一次 pointerdown
 * 先 reset, 因此不会误吞用户之后发起的真实点击。
 */
export function createDragClickSuppression() {
  let armed = false;
  return {
    arm: () => { armed = true; },
    reset: () => { armed = false; },
    consume: () => {
      if (!armed) return false;
      armed = false;
      return true;
    },
  };
}

export interface DragGrabOffset {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DRAG_PREVIEW_CLASS = 'notebook-file-tree__drag-preview';

/** 抓取点相对行左上角, 在 pointerdown 时一次算好, 整个拖动过程保持不变。 */
export function readDragGrabOffset(element: HTMLElement, clientX: number, clientY: number): DragGrabOffset {
  const rect = element.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 预览直接克隆被拖动的行, 因此图标、颜色标记、名称、选中态与行完全一致。
 * 挂在 body 上避免祖先 transform 改变 fixed 的包含块; 显式宽高是因为行原本用
 * `width: calc(100% - 缩进)` 与 marginLeft, 离开树容器后两者都不再成立。
 */
export function createTreeDragPreview(source: HTMLElement, grab: DragGrabOffset, count: number): HTMLDivElement {
  const preview = document.createElement('div');
  preview.className = DRAG_PREVIEW_CLASS;
  preview.setAttribute('aria-hidden', 'true');
  preview.style.width = `${grab.width}px`;
  preview.style.height = `${grab.height}px`;

  const clone = source.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.removeAttribute('tabindex');
  clone.removeAttribute('data-notebook-tree-path');
  clone.querySelectorAll('[id], [tabindex], [data-notebook-tree-path]').forEach((element) => {
    element.removeAttribute('id');
    element.removeAttribute('tabindex');
    element.removeAttribute('data-notebook-tree-path');
  });
  clone.style.marginLeft = '0';
  clone.style.marginTop = '0';
  clone.style.width = `${grab.width}px`;
  clone.style.height = `${grab.height}px`;
  preview.append(clone);

  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'notebook-file-tree__drag-preview-count';
    badge.textContent = String(count);
    preview.append(badge);
  }
  document.body.append(preview);
  return preview;
}
