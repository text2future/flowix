/**
 * Lightweight gallery surface shown while the media library renderer loads.
 * 只画内容占位：外壳的标题/tab 框架由 CollectionShell（或外壳骨架）负责，
 * 这里不再复刻旧的 view-nav 头（真实面板里已经没有这一行）。
 */
export function MediaLibraryLoadingSkeleton() {
  const columns = [
    ['h-56', 'h-40', 'h-64'],
    ['h-40', 'h-64', 'h-48'],
    ['h-64', 'h-48', 'h-56'],
    ['h-48', 'h-56', 'h-40'],
  ];
  return <div aria-label="媒体库预览" aria-busy="true" className="flex h-full min-h-0 flex-col overflow-auto px-5 pb-4">
    <div className="flex min-h-0 flex-1 items-start gap-2" aria-hidden="true">
      {columns.map((heights, column) => <div key={column} className={`min-w-0 flex-1 flex-col gap-2 ${column === 2 ? 'hidden sm:flex' : column === 3 ? 'hidden lg:flex' : 'flex'}`}>
        {heights.map((height, card) => <div key={card} className={`${height} w-full animate-pulse rounded-md bg-[var(--muted)] opacity-[0.36]`} />)}
      </div>)}
    </div>
  </div>;
}
