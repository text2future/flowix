import { createContext } from 'react';

/** The active dataset menu hosts the note editor owned by the table session. */
export const CollectionNoteFilterSlot = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
} | null>(null);
