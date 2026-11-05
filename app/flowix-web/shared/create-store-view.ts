import { useStore, type StoreApi } from 'zustand';

type ReadApi<T> = Pick<StoreApi<T>, 'getState' | 'getInitialState' | 'subscribe'>;
export type StoreView<T> = ReadApi<T> & { <U = T>(selector?: (state: T) => U): U };

/** A cached read projection with commands, deliberately exposing no setState. */
export function createStoreView<T extends object, R>(source: StoreApi<R>, project: (root: R, previous?: T) => T): StoreView<T> {
  let rootCache: R | undefined;
  let snapshot: T | undefined;
  const getState = () => {
    const root = source.getState();
    if (snapshot && root === rootCache) return snapshot;
    const next = project(root, snapshot);
    rootCache = root;
    if (!snapshot || Object.keys(next).some((key) => !Object.is(next[key as keyof T], snapshot![key as keyof T]))) snapshot = next;
    return snapshot;
  };
  const initial = getState();
  const api: ReadApi<T> = {
    getState, getInitialState: () => initial,
    subscribe: (listener) => {
      let previous = getState();
      return source.subscribe(() => {
        const next = getState();
        if (next === previous) return;
        const before = previous; previous = next; listener(next, before);
      });
    },
  };
  const view = (<U>(selector: (state: T) => U = ((state: T) => state as unknown as U)) => useStore(api, selector)) as StoreView<T>;
  return Object.assign(view, api);
}
