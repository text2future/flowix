import { describe, expect, it } from 'vitest';

import {
  getMemoListQueryKey,
  shouldShowMemoListLoading,
} from '@features/memo/components/memo-list-loading-state';

describe('memo-list loading state', () => {
  it('builds stable query keys from notebook, filter, sort, tag, and color state', () => {
    expect(getMemoListQueryKey('nb_1', 'all', 'createdAt', null, 'any')).toBe(
      'nb_1:all:createdAt::',
    );
    expect(getMemoListQueryKey('nb_1', 'tagged', 'updatedAt', 'tag-a', 'any')).toBe(
      'nb_1:tagged:updatedAt:tag-a:',
    );
    expect(getMemoListQueryKey('nb_1', 'color', 'updatedAt', 'tag-a', 'red')).toBe(
      'nb_1:color:updatedAt::red',
    );
  });

  it('does not show list loading when no notebook is selected', () => {
    expect(
      shouldShowMemoListLoading({
        selectedNotebookId: undefined,
        isMemoListLoading: true,
        currentMemoListQueryKey: ':all:createdAt::',
        loadedMemoListQueryKey: null,
      }),
    ).toBe(false);
  });

  it('shows loading for a selected notebook while an explicit load is running', () => {
    expect(
      shouldShowMemoListLoading({
        selectedNotebookId: 'nb_1',
        isMemoListLoading: true,
        currentMemoListQueryKey: 'nb_1:all:createdAt::',
        loadedMemoListQueryKey: 'nb_1:all:createdAt::',
      }),
    ).toBe(true);
  });

  it('shows loading when the selected notebook query has not been loaded yet', () => {
    expect(
      shouldShowMemoListLoading({
        selectedNotebookId: 'nb_1',
        isMemoListLoading: false,
        currentMemoListQueryKey: 'nb_1:all:createdAt::',
        loadedMemoListQueryKey: null,
      }),
    ).toBe(true);
  });

  it('hides loading when the selected notebook query is loaded', () => {
    expect(
      shouldShowMemoListLoading({
        selectedNotebookId: 'nb_1',
        isMemoListLoading: false,
        currentMemoListQueryKey: 'nb_1:all:createdAt::',
        loadedMemoListQueryKey: 'nb_1:all:createdAt::',
      }),
    ).toBe(false);
  });
});
