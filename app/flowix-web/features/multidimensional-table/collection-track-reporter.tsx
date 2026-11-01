import { useEffect } from 'react';

/**
 * 版式上报器 ── 空渲染，只为把「当前版式 + 表格需要的横向宽度」交给集合外壳。
 * 独立成组件是因为表格主组件在 `!document` 时有早返回，effect 不能写在那里。
 */
export function CollectionTrackReporter({ layout, contentWidth, onChange }: {
  layout: string | null;
  contentWidth: number | null;
  onChange: (layout: string | null, contentWidth: number | null) => void;
}) {
  useEffect(() => { onChange(layout, contentWidth); }, [contentWidth, layout, onChange]);
  return null;
}
