import { useEffect, useState } from 'react';
import { files } from '@platform/tauri/client';

/**
 * `true` when the notebook's indexes and watcher skip this path: app internals,
 * blacklisted dependency folders, and anything below one of them.
 *
 * `null` while the answer is still pending, so a caller can hold its content
 * back instead of flashing the wrong one. The rules themselves live in
 * `FileManagementPolicy`; the frontend must never re-derive them from folder
 * names, because a folder can be excluded by an ancestor it cannot see.
 */
export function usePathIndexExcluded(path: string): boolean | null {
  const [excluded, setExcluded] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    setExcluded(null);
    files.isIndexExcluded(path).then(
      (value) => { if (active) setExcluded(value); },
      () => { if (active) setExcluded(false); },
    );
    return () => { active = false; };
  }, [path]);

  return excluded;
}
