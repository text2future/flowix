import { useEffect, useRef, useState } from 'react';

/**
 * Gallery-card placeholder used while the work-document surface is loading.
 * 只画卡片占位：标题/tab 框架由 CollectionShell（或外壳骨架）负责，
 * 不再复刻旧的 view-nav 头（真实面板里已经没有这一行）。
 */
export function WorkDocumentsLoadingSkeleton() {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const updateColumnCount = () => {
      const nextColumnCount = Math.max(1, Math.floor((grid.clientWidth + 14) / 214));
      setColumnCount((current) => current === nextColumnCount ? current : nextColumnCount);
    };

    updateColumnCount();
    const observer = new ResizeObserver(updateColumnCount);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const placeholderClass = 'animate-pulse rounded bg-[var(--muted)] opacity-[0.36]';

  return <div aria-label="工作文档列表加载中" aria-busy="true" className="flex h-full min-h-0 flex-col overflow-auto px-5 pb-4">
    <div ref={gridRef} className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3" aria-hidden="true">
      {Array.from({ length: columnCount * 2 }, (_, index) => <div key={index} className="h-[210px] min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
        <div className={`h-[148px] border-b border-[var(--border)] ${placeholderClass}`} />
        <div className="space-y-2 px-3 py-3">
          <div className={`h-3.5 w-3/4 ${placeholderClass}`} />
          <div className={`h-2.5 w-1/2 ${placeholderClass}`} />
        </div>
      </div>)}
    </div>
  </div>;
}
