import { describe, expect, it } from 'vitest';
import { resolvePanelSwipeTransition } from './use-main-panel-controller';

describe('resolvePanelSwipeTransition', () => {
  it.each([
    [{ noteNavigationVisible: true, memoListVisible: true }, 'left', { noteNavigationVisible: false }],
    [{ noteNavigationVisible: true, memoListVisible: false }, 'left', { noteNavigationVisible: false }],
    [{ noteNavigationVisible: false, memoListVisible: true }, 'left', { memoListVisible: false }],
    [{ noteNavigationVisible: false, memoListVisible: false }, 'left', null],
    [{ noteNavigationVisible: true, memoListVisible: true }, 'right', null],
    [{ noteNavigationVisible: true, memoListVisible: false }, 'right', { memoListVisible: true }],
    [{ noteNavigationVisible: false, memoListVisible: true }, 'right', { noteNavigationVisible: true }],
    [{ noteNavigationVisible: false, memoListVisible: false }, 'right', { memoListVisible: true }],
  ] as const)('maps %o + %s to %o', (state, direction, expected) => {
    expect(resolvePanelSwipeTransition(state, direction)).toEqual(expected);
  });
});
