import type { WindowPosition } from '@platform/tauri/client';

export interface Point {
  x: number;
  y: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DragCoordinates {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

export interface HorizontalTabRect {
  id: string;
  left: number;
  width: number;
}

export type TabDragMode = 'disabled' | 'tear_off';

export const FLOWIX_TAB_DRAG_TYPE = 'application/x-flowix-tab';

export function tabDragMode(tabCount: number): TabDragMode {
  if (tabCount < 1) return 'disabled';
  return 'tear_off';
}

/** Converts a viewport rect into the same screen coordinate space as DragEvent. */
export function toScreenRect(
  rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>,
  pointer: DragCoordinates,
): ScreenRect {
  const viewportScreenX = pointer.screenX - pointer.clientX;
  const viewportScreenY = pointer.screenY - pointer.clientY;
  return {
    left: viewportScreenX + rect.left,
    top: viewportScreenY + rect.top,
    right: viewportScreenX + rect.right,
    bottom: viewportScreenY + rect.bottom,
  };
}

export function isOutsideRect(point: Point, rect: ScreenRect): boolean {
  return point.x < rect.left
    || point.x > rect.right
    || point.y < rect.top
    || point.y > rect.bottom;
}

export function expandScreenRect(rect: ScreenRect, amount: number): ScreenRect {
  return {
    left: rect.left - amount,
    top: rect.top - amount,
    right: rect.right + amount,
    bottom: rect.bottom + amount,
  };
}

/** Returns the tab that the dragged item should be inserted before. */
export function tabDropBeforeId(
  tabs: HorizontalTabRect[],
  draggedTabId: string,
  pointerX: number,
): string | null {
  for (const tab of tabs) {
    if (tab.id !== draggedTabId && pointerX < tab.left + tab.width / 2) {
      return tab.id;
    }
  }
  return null;
}

/**
 * Keeps the pointer at the same place in the new window that it occupied in
 * the source Webview. DragEvent screen coordinates and Tauri logical window
 * positions both use platform logical pixels.
 */
export function tearOffWindowPosition(
  dropPoint: Point,
  pointerOffsetInWindow: Point,
): WindowPosition {
  return {
    x: Math.round(dropPoint.x - pointerOffsetInWindow.x),
    y: Math.round(dropPoint.y - pointerOffsetInWindow.y),
  };
}
