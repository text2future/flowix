import { useCallback, useEffect, useRef, useState } from 'react';
import type { MultidimensionalTableDocument } from './model';
import { rememberTableView, resolveTableView } from './view-selection';

interface Options {
  document: MultidimensionalTableDocument | null;
  initialViewId?: string | null;
  editable: boolean;
  saving: boolean;
  save: (document: MultidimensionalTableDocument) => Promise<boolean>;
  onActiveViewChange?: (viewId: string) => void;
}

/** Restoring a view never writes. Only an explicit selection changes the file. */
export function useTableViewSelection({ document, initialViewId, editable, saving, save, onActiveViewChange }: Options) {
  const [activeViewId, setActiveViewId] = useState<string | null>(initialViewId ?? null);
  const previousInitialIdRef = useRef(initialViewId ?? null);
  /**
   * 外部选择了一个**当前文档里还没有**的视图时（外壳刚新增「日历」tab，而落盘内容
   * 还在路上），先按原逻辑回退；等这份内容到达、该视图第一次出现时补一次采用。
   * 否则会一直停在回退视图上，直到刷新。
   */
  const requestedAvailableRef = useRef(false);
  const selectionSavingRef = useRef(false);

  useEffect(() => {
    const requestedId = initialViewId ?? null;
    const changed = previousInitialIdRef.current !== requestedId;
    previousInitialIdRef.current = requestedId;
    setActiveViewId((current) => {
      if (!document) return null;
      if (!changed && document.views.items.some((view) => view.id === current)) return current;
      return resolveTableView(document, requestedId)?.id ?? null;
    });
  }, [document, initialViewId]);

  useEffect(() => {
    const requestedId = initialViewId ?? null;
    if (!document || !requestedId) {
      requestedAvailableRef.current = false;
      return;
    }
    const available = document.views.items.some((view) => view.id === requestedId);
    const appeared = available && !requestedAvailableRef.current;
    requestedAvailableRef.current = available;
    // 只在「从没有到有」的那一次补采用：正常切换 / 用户手动选别的视图都不受影响。
    if (!appeared || selectionSavingRef.current) return;
    setActiveViewId(requestedId);
  }, [document, initialViewId]);

  const activateView = useCallback((viewId: string) => {
    setActiveViewId(viewId);
    if (editable) onActiveViewChange?.(viewId);
  }, [editable, onActiveViewChange]);

  const selectView = useCallback(async (viewId: string) => {
    if (!document || saving || selectionSavingRef.current || !document.views.items.some((view) => view.id === viewId)) return;
    activateView(viewId);
    if (!editable) return;
    const next = rememberTableView(document, viewId);
    if (next === document) return;
    selectionSavingRef.current = true;
    try { await save(next); }
    finally { selectionSavingRef.current = false; }
  }, [activateView, document, editable, save, saving]);

  return { activeViewId, activeView: document ? resolveTableView(document, activeViewId ?? initialViewId) : undefined, activateView, selectView };
}
