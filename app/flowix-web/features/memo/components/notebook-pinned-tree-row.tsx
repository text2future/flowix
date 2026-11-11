'use client';

import { memo, type ComponentProps } from 'react';

import { parentDirectoryPath } from '@/lib/path';
import { NotebookTreeRow } from './notebook-tree-row';
import type { NotebookTreeRowPresentation } from './notebook-tree-row-model';
import type { PinnedTreeItem } from './use-notebook-pinned-notes';

type TreeRowProps = ComponentProps<typeof NotebookTreeRow>;

type PinnedTreeRowActions = Pick<TreeRowProps,
  | 'onToggle'
  | 'onSelectFolder'
  | 'onOpen'
  | 'onCreateNote'
  | 'onCreateFolder'
  | 'onCreateView'
  | 'onCreateMediaLibrary'
  | 'onCreateWorkDocuments'
  | 'onImportFiles'
  | 'onImportFolder'
  | 'onRename'
  | 'onDeleteFile'
  | 'onDeleteSelected'
  | 'onPointerDown'
  | 'onKeepAliveChange'
  | 'onFocus'
  | 'onFavoriteChanged'
>;

export interface NotebookPinnedTreeRowController {
  notebookPath: string;
  getPresentation: (item: PinnedTreeItem) => Pick<NotebookTreeRowPresentation, 'expanded' | 'active' | 'selected' | 'isLoadingChildren' | 'childrenError'>;
  isCut: (path: string) => boolean;
  canDeleteSelected: (item: PinnedTreeItem) => boolean;
  hasWorkDocumentsCollection: (path: string) => boolean;
  onOpenInNewTab?: TreeRowProps['onOpenInNewTab'];
  onTogglePinned: (item: PinnedTreeItem) => TreeRowProps['onTogglePinned'];
  onRetryChildren?: TreeRowProps['onRetryChildren'];
  onKeyDown: NonNullable<TreeRowProps['onKeyDown']>;
  actions: PinnedTreeRowActions;
}

interface NotebookPinnedTreeRowProps {
  item: PinnedTreeItem;
  controller: NotebookPinnedTreeRowController;
}

/** Adapts a pinned entry and its list state to the shared notebook tree row. */
export const NotebookPinnedTreeRow = memo(function NotebookPinnedTreeRow({ item, controller }: NotebookPinnedTreeRowProps) {
  const { actions } = controller;
  const presentation = controller.getPresentation(item);

  return (
    <NotebookTreeRow
      item={item}
      notebookPath={controller.notebookPath}
      parentPath={parentDirectoryPath(item.fullPath, controller.notebookPath)}
      depth={item.pinnedDepth ?? 0}
      expanded={presentation.expanded}
      isLoadingChildren={presentation.isLoadingChildren}
      childrenError={presentation.childrenError}
      onRetryChildren={controller.onRetryChildren}
      active={presentation.active}
      selected={presentation.selected}
      cut={controller.isCut(item.fullPath)}
      onDeleteSelected={controller.canDeleteSelected(item) ? actions.onDeleteSelected : undefined}
      onToggle={actions.onToggle}
      onSelectFolder={actions.onSelectFolder}
      onOpen={actions.onOpen}
      onOpenInNewTab={item.pinnedEntryKind !== 'collection' ? controller.onOpenInNewTab : undefined}
      onCreateNote={actions.onCreateNote}
      onCreateFolder={actions.onCreateFolder}
      onImportFiles={actions.onImportFiles}
      onImportFolder={actions.onImportFolder}
      onCreateView={actions.onCreateView}
      onCreateMediaLibrary={actions.onCreateMediaLibrary}
      onCreateWorkDocuments={actions.onCreateWorkDocuments}
      onRename={actions.onRename}
      onDeleteFile={actions.onDeleteFile}
      onPointerDown={actions.onPointerDown}
      onKeepAliveChange={actions.onKeepAliveChange}
      workDocumentsCollection={controller.hasWorkDocumentsCollection(item.fullPath)}
      favoritePath={item.fullPath}
      onFavoriteChanged={actions.onFavoriteChanged}
      onTogglePinned={controller.onTogglePinned(item)}
      onFocus={actions.onFocus}
      onKeyDown={controller.onKeyDown}
      tabIndex={0}
    />
  );
});
