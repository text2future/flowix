import { describe, expect, it } from 'vitest';
import { resolveBrowserColumnLayout } from './browser-column-layout';

const base = {
  noteNavigationWidth: 220,
  memoListWidth: 320,
  memoListVisible: true,
  dividerCount: 3,
  splitRatio: 0.5,
};

describe('resolveBrowserColumnLayout', () => {
  it('keeps both document columns in the flex row when they fit', () => {
    expect(resolveBrowserColumnLayout({ ...base, viewportWidth: 1440 })).toMatchObject({
      canSplit: true,
      availableDocumentWidth: 897,
      mainColumnWidth: 448.5,
      browserColumnWidth: 448.5,
    });
  });

  it('keeps both panes at their minimum widths when space is tight', () => {
    expect(resolveBrowserColumnLayout({ ...base, viewportWidth: 1200 })).toMatchObject({
      canSplit: false,
      availableDocumentWidth: 657,
      mainColumnWidth: 360,
      browserColumnWidth: 360,
    });
  });

  it('does not reserve a hidden memo list', () => {
    expect(resolveBrowserColumnLayout({ ...base, viewportWidth: 1200, memoListVisible: false })).toMatchObject({
      canSplit: true,
      availableDocumentWidth: 977,
    });
  });

  it('preserves a dragged ratio while the window resizes', () => {
    const layout = resolveBrowserColumnLayout({
      ...base,
      viewportWidth: 2000,
      splitRatio: 0.35,
    });

    expect(layout.canSplit).toBe(true);
    expect(layout.browserColumnWidth / layout.availableDocumentWidth).toBeCloseTo(0.35);
    expect(layout.mainColumnWidth / layout.availableDocumentWidth).toBeCloseTo(0.65);
  });

  it('clamps both panes to the same minimum width at the split boundary', () => {
    const layout = resolveBrowserColumnLayout({
      ...base,
      viewportWidth: 1263,
      splitRatio: 0.2,
    });

    expect(layout.canSplit).toBe(true);
    expect(layout.mainColumnWidth).toBe(360);
    expect(layout.browserColumnWidth).toBe(360);
  });
});
