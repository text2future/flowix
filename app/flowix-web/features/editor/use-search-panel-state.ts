import { useCallback, useRef, useState } from 'react';

/** Supply both fields for controlled mode; omit both for editor-local state. */
export type SearchPanelControlProps =
  | { searchPanelOpen: boolean; onSearchPanelOpenChange: (open: boolean) => void }
  | { searchPanelOpen?: never; onSearchPanelOpenChange?: never };

export function useSearchPanelState(
  controlledOpen: boolean,
  onControlledOpenChange: ((open: boolean) => void) | undefined,
) {
  const [localOpen, setLocalOpen] = useState(false);
  const onControlledOpenChangeRef = useRef(onControlledOpenChange);
  onControlledOpenChangeRef.current = onControlledOpenChange;

  const setOpen = useCallback((open: boolean) => {
    if (onControlledOpenChangeRef.current) onControlledOpenChangeRef.current(open);
    else setLocalOpen(open);
  }, []);

  return [onControlledOpenChange ? controlledOpen : localOpen, setOpen] as const;
}
