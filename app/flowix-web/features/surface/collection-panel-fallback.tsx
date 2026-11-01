/**
 * 集合面板加载中的占位符 ── 外壳与面板容器共用一份。
 *
 * 面板都是 `lazy` 的（图墙 / 列表 / 表格），首帧要有一块同样高度的区域顶住版式，
 * 否则头图与 tab 条会先跳一次。形状与颜色只有这一个来源，别在调用点再写一遍。
 */
export const COLLECTION_PANEL_FALLBACK = (
  <div className="flex flex-1 items-center justify-center px-2 py-6 text-center text-sm text-[var(--muted-foreground)]">…</div>
);
