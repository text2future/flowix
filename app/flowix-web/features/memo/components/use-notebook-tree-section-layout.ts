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

  // Sections the view is allowed to mount. Agents stay here before they measure
  // a height — dropping them on the first frame would mean they never mount,
  // never measure, and never appear.
  const renderableSectionOrder = useMemo(() => sectionOrder.filter((section) => (
    !hiddenSections.includes(section) && (section === 'files'
      || section === 'repositories'
      || section === 'more'
      || (section === 'agents' && Boolean(notebookId))
      || (section === 'pinned' && (pinnedItemCount > 0 || pinnedHasPrevious || pinnedHasMore)))
  )), [hiddenSections, notebookId, pinnedHasMore, pinnedHasPrevious, pinnedItemCount, sectionOrder]);

  // Ordering/“fills remaining space” only counts sections that occupy space.
  const visibleSectionOrder = useMemo(
    () => renderableSectionOrder.filter((section) => section !== 'agents' || agentSectionHeight > 0),
    [agentSectionHeight, renderableSectionOrder],
  );

  const pinnedSectionHeight = pinnedItemCount > 0 || pinnedHasPrevious || pinnedHasMore
    ? TREE_HEADER_HEIGHT + (pinnedCollapsed ? 0 : pinnedItemCount * TREE_ROW_SIZE + (pinnedHasPrevious || pinnedHasMore ? TREE_ROW_SIZE : 0)) + 12
    : 0;
  const sectionHeights: Record<NotebookTreeSection, number> = {
    agents: notebookId ? agentSectionHeight : 0,
    pinned: pinnedSectionHeight,
    files: TREE_HEADER_HEIGHT,
    repositories: repositorySectionHeight,
    more: moreSectionHeight,
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
    renderableSectionOrder,
    visibleSectionOrder,
    treeContentOffset,
    setMoreSectionHeight,
    handleAgentSectionHeightChange,
    handleRepositorySectionHeightChange,
    moveTreeSection,
    hideTreeSection,
  };
}
