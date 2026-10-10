import { getPlatform } from '@/lib/shortcuts/platform';
import type { Platform } from '@/lib/shortcuts/types';

export interface NativeDropPosition {
  x: number;
  y: number;
}

/** Convert Wry's native drop coordinates into CSS pixels for DOM hit testing. */
export function normalizeTauriDropPosition(
  position: NativeDropPosition,
  scaleFactor = 1,
  platform: Platform = getPlatform(),
): NativeDropPosition {
  // Windows receives screen coordinates in physical pixels. AppKit and GTK
  // deliver coordinates in view points, which already match CSS pixels.
  const factor = platform === 'windows' && Number.isFinite(scaleFactor) && scaleFactor > 0
    ? scaleFactor
    : 1;
  return { x: position.x / factor, y: position.y / factor };
}
