import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestCollectionDatasetFilter, subscribeCollectionDatasetFilter } from './dataset-filter-requests';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collection dataset filter requests', () => {
  it('delivers a request to a mounted panel', () => {
    const openFilter = vi.fn();
    const unsubscribe = subscribeCollectionDatasetFilter('/book/collection.index.yaml', 'notes', openFilter);

    requestCollectionDatasetFilter({ indexPath: '/book/collection.index.yaml', target: 'notes' });

    expect(openFilter).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('holds a request briefly when its lazy panel has not mounted yet', () => {
    requestCollectionDatasetFilter({ indexPath: '/book/collection.index.yaml', target: 'media' });
    const openFilter = vi.fn();

    const unsubscribe = subscribeCollectionDatasetFilter('/book/collection.index.yaml', 'media', openFilter);

    expect(openFilter).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
