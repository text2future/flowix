import { useEffect, useRef } from 'react';
import { isMac } from '@features/shortcuts';

/**
 * macOS 双指横向滑动识别。
 *
 * 设计要点:
 *  - 仅在 macOS 上挂监听; Win / Linux 直接 no-op (按需求)。`isMac()` 内部
 *    有缓存, 重复调用零成本。
 *  - 基于 `wheel` 事件: macOS 触控板的双指横向滑动会经 WKWebView 派发
 *    一连串 `deltaMode === 0` (DOM_DELTA_PIXEL)、`deltaX` 主导的 wheel
 *    事件。鼠标滚轮的 `deltaMode` 是 LINE / PAGE, 自动被过滤掉。
 *  - 只识别方向, 不关心业务状态。调用方负责决定"左滑/右滑"实际开关
 *    哪个面板。
 *  - 基于最近时间窗口判断方向: 触发后同方向进入短暂锁定; 只有事件流
 *    出现短暂停顿后重新累计过阈值, 才允许同方向再次触发。反方向必须在
 *    最近窗口内重新累计过阈值才会触发下一次动作。
 *  - 不调用 `preventDefault`, 保持 `passive: true` ── 不挡垂直滚动、
 *    pinch-zoom 或任何原生滚动容器。
 *  - 回调走 ref 缓存, options 引用变化不会触发 effect 重跑。
 */
export type MacosTrackpadSwipeDirection = 'left' | 'right';

type UseMacosTrackpadSwipeOptions = {
  /** 触发阈值 (像素), 最近窗口内累计 |deltaX| 超过这个值才认作一次滑动。默认 60。 */
  minDeltaX?: number;
  /** 两次触发的最小间隔 (毫秒), 用于过滤极短回弹。默认 120。 */
  cooldownMs?: number;
  /** 最近窗口内横向 delta 必须大于纵向 delta 的多少倍才算"横滑"; 默认 1.5。 */
  horizontalBias?: number;
  /** 最近多少毫秒的 wheel delta 参与方向判定。默认 180。 */
  sampleWindowMs?: number;
  /** 多久没有 wheel 事件后视为新一次手势。默认 260。 */
  gestureIdleMs?: number;
  /** 同方向连续触发的最小间隔。默认 50。 */
  sameDirectionRefireMs?: number;
  /** 同方向再次触发前, wheel 事件流需要出现的最小停顿。默认 70。 */
  sameDirectionRearmGapMs?: number;
  /** 识别到一次明确横滑时触发。 */
  onSwipe: (direction: MacosTrackpadSwipeDirection) => void;
};

export function useMacosTrackpadSwipe({
  minDeltaX = 60,
  cooldownMs = 120,
  horizontalBias = 1.5,
  sampleWindowMs = 180,
  gestureIdleMs = 260,
  sameDirectionRefireMs = 50,
  sameDirectionRearmGapMs = 70,
  onSwipe,
}: UseMacosTrackpadSwipeOptions): void {
  // 用 ref 包住回调, 避免 options 引用变化触发 effect 重跑。
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;

  useEffect(() => {
    // 平台判断 ── 非 mac 直接返回, 啥也不挂。
    if (!isMac()) return;

    type WheelSample = { dx: number; dy: number; ts: number };

    let samples: WheelSample[] = [];
    let lastEventTs = 0;
    let lastFireTs = 0;
    let lockedDirection: MacosTrackpadSwipeDirection | null = null;
    let sameDirectionRearmed = false;

    const resetGesture = () => {
      samples = [];
      lockedDirection = null;
      sameDirectionRearmed = false;
    };

    const pruneSamples = (now: number) => {
      const cutoff = now - sampleWindowMs;
      while (samples.length > 0 && samples[0].ts < cutoff) {
        samples.shift();
      }
    };

    const handler = (event: WheelEvent) => {
      // 1) 过滤 pinch-zoom ── macOS 触控板用 ctrlKey + wheel 实现缩放。
      if (event.ctrlKey) return;
      // 2) 过滤鼠标滚轮 / 行模式 ── 触控板才是 pixel (deltaMode === 0)。
      if (event.deltaMode !== 0) return;
      const now = performance.now();
      const eventGapMs = lastEventTs === 0 ? Infinity : now - lastEventTs;
      const hasRearmGap = eventGapMs >= sameDirectionRearmGapMs;

      // 3) 间隔太久 → 新一次手势, 旧的惯性锁不再生效。
      if (eventGapMs > gestureIdleMs) resetGesture();
      lastEventTs = now;
      if (hasRearmGap) {
        // 断流只作为"新候选手势"边界, 不复用断流前的累计 delta。
        samples = [];
      }

      samples.push({ dx: event.deltaX, dy: event.deltaY, ts: now });
      pruneSamples(now);

      const dx = samples.reduce((sum, sample) => sum + sample.dx, 0);
      const dy = samples.reduce((sum, sample) => sum + sample.dy, 0);

      // 4) 必须是最近窗口内明确横滑 ── |dx| 大于阈值, 且显著大于 |dy|。
      if (Math.abs(dx) < minDeltaX) return;
      if (Math.abs(dx) < Math.abs(dy) * horizontalBias) {
        samples = [];
        return;
      }

      // 注: WKWebView 上水平 wheel 事件的 deltaX 与手指方向是反的 ──
      // 双指向右滑 → deltaX 负; 双指向左滑 → deltaX 正 (与垂直"内容
      // 跟随手指"不同, 水平方向走的是浏览器历史手势的约定)。
      const direction: MacosTrackpadSwipeDirection = dx > 0 ? 'left' : 'right';

      // 5) 同方向短锁定: 同一段惯性尾部不允许重复 fire。快速连续的
      //    同向手势需要先出现一次短暂停顿, 再从断流后重新累计过阈值。
      if (lockedDirection === direction) {
        if (hasRearmGap) {
          sameDirectionRearmed = true;
        }
        if (
          now - lastFireTs < sameDirectionRefireMs ||
          !sameDirectionRearmed
        ) {
          samples = [];
          return;
        }
      }
      if (now - lastFireTs < cooldownMs) {
        samples = [];
        return;
      }

      onSwipeRef.current(direction);
      samples = [];
      lockedDirection = direction;
      sameDirectionRearmed = false;
      lastFireTs = now;
    };

    window.addEventListener('wheel', handler, { passive: true });
    return () => window.removeEventListener('wheel', handler);
  }, [
    minDeltaX,
    cooldownMs,
    horizontalBias,
    sampleWindowMs,
    gestureIdleMs,
    sameDirectionRefireMs,
    sameDirectionRearmGapMs,
  ]);
}
