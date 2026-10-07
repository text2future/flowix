import { useEffect, useState } from 'react';

import { externalDocuments } from '@platform/tauri/client/memos';

type MimeResolution = { filePath: string; mimeType: string | null };

/** Resolve an extension-derived MIME type only for otherwise unsupported paths. */
export function useExternalFileMime(filePath: string | null, shouldResolve: boolean) {
  const [resolution, setResolution] = useState<MimeResolution | null>(null);

  useEffect(() => {
    if (!filePath || !shouldResolve) return;
    let cancelled = false;
    void externalDocuments.mimeType(filePath).then((mimeType) => {
      if (!cancelled) setResolution({ filePath, mimeType });
    }).catch(() => {
      if (!cancelled) setResolution({ filePath, mimeType: null });
    });
    return () => { cancelled = true; };
  }, [filePath, shouldResolve]);

  const current = resolution?.filePath === filePath ? resolution : null;
  return {
    mimeType: current?.mimeType ?? null,
    loading: Boolean(filePath && shouldResolve && !current),
  };
}
