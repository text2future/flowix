'use client';

import { useCallback, useEffect, useState } from 'react';

import { canonicalDirectoryPath } from '@/lib/path';

interface NotebookPinnedExpansionOptions {
  roots: readonly string[];
  loadDirectory: (path: string) => Promise<unknown>;
}

/** Owns pinned-folder expansion; directory contents still use the shared tree cache. */
export function useNotebookPinnedExpansion({ roots, loadDirectory }: NotebookPinnedExpansionOptions) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const keys = roots.map(canonicalDirectoryPath);
    setExpanded((previous) => {
      const next = new Set([...previous].filter((path) =>
        keys.some((root) => path === root || path.startsWith(`${root}/`))));
      return next.size === previous.size ? previous : next;
    });
  }, [roots]);

  const toggle = useCallback((path: string) => {
    const key = canonicalDirectoryPath(path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    void loadDirectory(path);
  }, [loadDirectory]);

  return { expanded, toggle };
}
