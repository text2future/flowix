import { describe, expect, it } from 'vitest';
import { computeOverlayFrame } from '@features/editor/overlay/compute-overlay-frame';

const root = { left: 100, top: 40, width: 800, height: 600 };
const viewport = { width: 1200, height: 800 };
const menu = { width: 240, height: 34 };
const selection = { left: 400, top: 300, width: 200, height: 24 };

describe('computeOverlayFrame', () => {
  it('centers the menu over the anchor and sits it above', () => {
    // 选区中心 500 → 菜单左边缘 500-120=380; 视口坐标, 不再减面板偏移。
    expect(computeOverlayFrame({ anchor: selection, root, menu, viewport }))
      .toEqual({ left: 380, top: 300 - 8 - 34 });
  });

  it('flips below the anchor when there is no room above', () => {
    expect(computeOverlayFrame({
      anchor: { ...selection, top: 52 },
      root,
      menu,
      viewport,
    })?.top).toBe(52 + 24 + 8);
  });

  it('keeps the menu above the anchor when flipping is disabled', () => {
    // 表格气泡: 翻到下方会盖住首行, 上方放不下就贴面板顶。
    expect(computeOverlayFrame({
      anchor: { ...selection, top: 52 },
      root,
      menu,
      viewport,
      flip: false,
    })?.top).toBe(40 + 8);
  });

  it('keeps a fixed width and lets the menu escape a narrow panel', () => {
    const narrowPanel = { left: 100, top: 40, width: 200, height: 600 };
    const wideMenu = { width: 300, height: 34 };
    const frame = computeOverlayFrame({
      anchor: selection,
      root: narrowPanel,
      menu: wideMenu,
      viewport,
    });

    // 面板只有 100..300, 菜单仍按自身宽度居中在选区上, 越过面板右缘而不是被削窄。
    expect(frame?.left).toBe(400 + 100 - 150);
  });

  it('clamps to the window and overflows outside it when the window is narrower', () => {
    expect(computeOverlayFrame({
      anchor: selection,
      root: { left: 0, top: 0, width: 200, height: 800 },
      menu: { width: 300, height: 34 },
      viewport: { width: 200, height: 800 },
    })?.left).toBe(8);
  });

  it('clamps horizontally to the window edges', () => {
    expect(computeOverlayFrame({
      anchor: { ...selection, left: -100 },
      root,
      menu,
      viewport,
    })?.left).toBe(8);

    expect(computeOverlayFrame({
      anchor: { ...selection, left: 1100, width: 40 },
      root,
      menu,
      viewport,
    })?.left).toBe(1200 - 8 - 240);
  });

  it('sticks to the panel edge instead of disappearing when the anchor scrolls out', () => {
    // 锚点滚到面板下方: 钳在面板底边, 工具条仍可见 (产品决定)。
    expect(computeOverlayFrame({
      anchor: { ...selection, top: 700 },
      root,
      menu,
      viewport,
    })?.top).toBe(40 + 600 - 8 - 34);

    // 锚点滚到面板上方: 钳在面板顶边。
    expect(computeOverlayFrame({
      anchor: { ...selection, top: -200 },
      root,
      menu,
      viewport,
    })?.top).toBe(40 + 8);
  });

  it('uses the gap between the anchor and the menu', () => {
    expect(computeOverlayFrame({
      anchor: { left: 300, top: 204, width: 500, height: 120 },
      root,
      menu,
      viewport,
      gap: 4,
      flip: false,
    })?.top).toBe(204 - 4 - 34);
  });

  it('returns null when the panel has no room inside the window', () => {
    expect(computeOverlayFrame({
      anchor: selection,
      root: { left: 100, top: 790, width: 800, height: 600 },
      menu,
      viewport,
    })).toBeNull();
  });

  it('returns null for an unmeasured menu or a non-finite anchor', () => {
    expect(computeOverlayFrame({
      anchor: selection,
      root,
      menu: { width: 0, height: 0 },
      viewport,
    })).toBeNull();

    expect(computeOverlayFrame({
      anchor: { ...selection, top: Number.NaN },
      root,
      menu,
      viewport,
    })).toBeNull();
  });
});
