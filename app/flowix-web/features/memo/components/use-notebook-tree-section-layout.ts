import { useCallback, useMemo, useState } from 'react';

import { TREE_HEADER_HEIGHT, TREE_ROW_SIZE } from './notebook-tree-layout';
import type {
  NotebookTreeHiddenSection,
  NotebookTreeSection,
} from './use-notebook-tree-sections';

interface UseNotebookTreeSectionLayoutOptions {
  notebookId: string | null;
  sectionOrder: NotebookTreeSection[];
  hiddenSections: NotebookTreeHiddenSection[];
  updateSections: (order: NotebookTreeSection[], hidden: NotebookTreeHiddenSection[]) => void;
  pinnedItemCount: number;
  pinnedHasPrevious: boolean;
  pinnedHasMore: boolean;
  pinnedCollapsed: boolean;
}

/** Coordinates section ordering, measured heights, and the file tree offset. */
export function useNotebookTreeSectionLayout({
  notebookId,
  sectionOrder,
  hiddenSections,
  updateSections,
  pinnedItemCount,
  pinnedHasPrevious,
  pinnedHasMore,
  pinnedCollapsed,
}: UseNotebookTreeSectionLayoutOptions) {
  const [agentSectionHeight, setAgentSectionHeight] = useState(0);
  const [repositorySectionHeight, setRepositorySectionHeight] = useState(0);
  const [moreSectionHeight, setMoreSectionHeight] = useState(0);

  const visibleSectionOrder = useMemo(() => sectionOrder.filter((section) => (
    !hiddenSections.includes(section) && (section === 'files'
      || section === 'repositories'
      || section === 'more'
      || (section === 'agents' && Boolean(notebookId) && agentSectionHeight > 0)
      || (section === 'pinned' && (pinnedItemCount > 0 || pinnedHasPrevious || pinnedHasMore)))
  )), [agentSectionHeight, hiddenSections, notebookId, pinnedHasMore, pinnedHasPrevious, pinnedItemCount, sectionOrder]);

  const moreSectionPosition = visibleSectionOrder.indexOf('more');
  const moreCompactTopSpacing = moreSectionPosition > 0
    && visibleSectionOrder[moreSectionPosition - 1] === 'repositories';
  const pinnedSectionHeight = pinnedItemCount > 0 || pinnedHasPrevious || pinnedHasMore
    ? TREE_HEADER_HEIGHT + (pinnedCollapsed ? 0 : pinnedItemCount * TREE_ROW_SIZE + (pinnedHasPrevious || pinnedHasMore ? TREE_ROW_SIZE : 0)) + 12
    : 0;
  const sectionHeights: Record<NotebookTreeSection, number> = {
    agents: notebookId ? agentSectionHeight : 0,
    pinned: pinnedSectionHeight,
    files: TREE_HEADER_HEIGHT,
    repositories: repositorySectionHeight,
    more: moreSectionHeight - (moreCompactTopSpacing ? 10 : 0),
  };
  const treeContentOffset = TREE_HEADER_HEIGHT + sectionOrder
    .slice(0, sectionOrder.indexOf('files'))
    .reduce((height, section) => height + (hiddenSections.includes(section) ? 0 : sectionHeights[section]), 0);

  const moveTreeSection = useCallback((section: NotebookTreeSection, direction: -1 | 1) => {
    if (!notebookId) return;
    const visibleIndex = visibleSectionOrder.indexOf(section);
    const targetSection = visibleSectionOrder[visibleIndex + direction];
    if (visibleIndex < 0 || !targetSection) return;
    const index = sectionOrder.indexOf(section);
    const targetIndex = sectionOrder.indexOf(targetSection);
    const next = [...sectionOrder];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    updateSections(next, hiddenSections);
  }, [hiddenSections, notebookId, sectionOrder, updateSections, visibleSectionOrder]);

  const hideTreeSection = useCallback((section: NotebookTreeSection) => {
    if (!notebookId || hiddenSections.includes(section)) return;
    updateSections(sectionOrder, [...hiddenSections, section]);
  }, [hiddenSections, notebookId, sectionOrder, updateSections]);

  const handleAgentSectionHeightChange = useCallback((height: number) => {
    setAgentSectionHeight((current) => current === height ? current : height);
  }, []);
  const handleRepositorySectionHeightChange = useCallback((height: number) => {
    setRepositorySectionHeight((current) => current === height ? current : height);
  }, []);

  return {
    visibleSectionOrder,
    moreCompactTopSpacing,
    treeContentOffset,
    setMoreSectionHeight,
    handleAgentSectionHeightChange,
    handleRepositorySectionHeightChange,
    moveTreeSection,
    hideTreeSection,
  };
}
