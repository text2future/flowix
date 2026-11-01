import { createContext, useContext } from 'react';

/** All collection panels share the shell's scrolling element. */
export const CollectionScrollContext = createContext<HTMLDivElement | null>(null);
export function useCollectionScrollRoot() {
  return useContext(CollectionScrollContext);
}
