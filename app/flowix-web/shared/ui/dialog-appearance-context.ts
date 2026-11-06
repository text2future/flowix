import { createContext } from 'react';

// Kept separate so buttons do not depend on dialog rendering or portals.
export const DialogAppearanceContext = createContext(false);
