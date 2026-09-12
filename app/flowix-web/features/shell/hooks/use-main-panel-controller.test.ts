import { describe, expect, it } from 'vitest';
import { isPanelSwipeArea, resolvePanelSwipeTransition } from './use-main-panel-controller';

describe('resolvePanelSwipeTransition', () => {
  it.each([
    [{ noteNavigationVisible: true, memoListVisible: true }, 'left', { memoListVisible: false }],
    [{ noteNavigationVisible: true, memoListVisible: false }, 'left', null],
    [{ noteNavigationVisible: false, memoListVisible: true }, 'left', { memoListVisible: false }],
    [{ noteNavigationVisible: false, memoListVisible: false }, 'left', null],
    [{ noteNavigationVisible: true, memoListVisible: true }, 'right', null],
    [{ noteNavigationVisible: true, memoListVisible: false }, 'right', { memoListVisible: true }],
    [{ noteNavigationVisible: false, memoListVisible: true }, 'right', null],
    [{ noteNavigationVisible: false, memoListVisible: false }, 'right', { memoListVisible: true }],
  ] as const)('maps %o + %s to %o', (state, direction, expected) => {
    expect(resolvePanelSwipeTransition(state, direction)).toEqual(expected);
  });
});

describe('isPanelSwipeArea', () => {
  it('accepts targets inside the memo list and main work column', () => {
    document.body.innerHTML = `
      <div data-memo-list-swipe-area><button id="list-child"></button></div>
      <div data-workspace-host="main-third"><button id="work-child"></button></div>
    `;

    expect(isPanelSwipeArea(document.querySelector('#list-child'))).toBe(true);
    expect(isPanelSwipeArea(document.querySelector('#work-child'))).toBe(true);
  });

  it('does not accept targets in the browser column or outside the layout', () => {
    document.body.innerHTML = `
      <div data-workspace-host="browser-column"><button id="browser-child"></button></div>
    `;

    expect(isPanelSwipeArea(document.querySelector('#browser-child'))).toBe(false);
    expect(isPanelSwipeArea(null)).toBe(false);
  });
});
