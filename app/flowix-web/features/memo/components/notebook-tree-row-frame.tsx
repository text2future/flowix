import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { DocTreeItem } from '@platform/tauri/client';
import { INDENT_PER_LEVEL, TREE_EDGE_GUTTER } from './notebook-tree-layout';

// Row gutter + inline padding + half of the caret width.
const FOLDER_CARET_CENTER_OFFSET = 12;

interface NotebookTreeRowFrameProps {
  item: DocTreeItem;
  depth: number;
  parentPath: string;
  isDropTarget: boolean;
  children: ReactNode;
}

/** Owns tree guides and drop geometry independently from row actions. */
export function NotebookTreeRowFrame({ item, depth, parentPath, isDropTarget, children }: NotebookTreeRowFrameProps) {
  return (
    <div
      className={cn(item.type === 'folder' && 'folder-file-tree__group notebook-file-tree__folder-group relative')}
      data-notebook-tree-row="true"
      data-notebook-tree-depth={depth}
      data-drag-over={isDropTarget ? 'true' : 'false'}
      data-notebook-drop-path={item.type === 'folder' ? item.fullPath : undefined}
      data-notebook-parent-path={parentPath}
      style={{
        '--folder-file-tree-drop-left': `${TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL}px`,
        '--folder-file-tree-drop-right': `${TREE_EDGE_GUTTER}px`,
      } as CSSProperties}
    >
      {depth > 0 && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {Array.from({ length: depth }, (_, level) => (
            <span
              key={level}
              className="absolute inset-y-0 w-px"
              style={{
                left: TREE_EDGE_GUTTER + level * INDENT_PER_LEVEL + FOLDER_CARET_CENTER_OFFSET,
                backgroundColor: 'color-mix(in srgb, var(--border) 72%, transparent)',
              }}
            />
          ))}
        </div>
      )}
      {children}
    </div>
  );
}
