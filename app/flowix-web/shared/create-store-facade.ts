import { useStore, type StoreApi, type UseBoundStore } from 'zustand';

type SetState<T> = (partial: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: boolean) => void;

/**
 * A selector/action facade over another store. The cache is a derived snapshot,
 * never a second state source; every mutation is committed to the source.
 */
export function createStoreFacade<T extends object, R>(
  source: StoreApi<R>,
  initialize: (set: SetState<T>, get: () => T) => T,
  project: (root: R, actions: T) => T,
  commit: (next: T, previous: T) => void,
): UseBoundStore<StoreApi<T>> {
  let rootCache: R | undefined;
  let snapshot: T | undefined;
  const getState = () => {
    const root = source.getState();
    if (snapshot && root === rootCache) return snapshot;
    const next = project(root, snapshot ?? actions);
    rootCache = root;
    if (!snapshot || Object.keys(next).some((key) => !Object.is(next[key as keyof T], snapshot![key as keyof T]))) snapshot = next;
    return snapshot;
  };
  const setState: SetState<T> = (partial, replace) => {
    const previous = getState();
    const value = typeof partial === 'function' ? partial(previous) : partial;
    if (value === previous) return;
    commit(replace ? value as T : { ...previous, ...value }, previous);
  };
  const actions = initialize(setState, getState);
  const initial = getState();
  const api: StoreApi<T> = {
    getState, getInitialState: () => initial,
    setState: setState as StoreApi<T>['setState'],
    subscribe: (listener) => {
      let previous = getState();
      return source.subscribe(() => {
        const next = getState();
        if (next === previous) return;
        const before = previous;
        previous = next;
        listener(next, before);
      });
    },
  };
  const useFacade = (<U>(selector: (state: T) => U = ((state: T) => state as unknown as U)) => useStore(api, selector)) as UseBoundStore<StoreApi<T>>;
  return Object.assign(useFacade, api);
}
