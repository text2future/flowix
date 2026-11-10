import { MediaLibraryLoadingSkeleton } from '@shared/ui/media-library-loading-skeleton';
import { MultidimensionalTableLoadingSkeleton } from '@shared/ui/multidimensional-table-loading-skeleton';
import { WorkDocumentsLoadingSkeleton } from '@shared/ui/work-documents-loading-skeleton';

/** 内容区占位形态：集合缺省 tab 是表格视图；媒体域用图墙、工作文档域用卡片。 */
export type CollectionSkeletonBody = 'table' | 'gallery' | 'cards';

/**
 * 集合外壳骨架 ── 集合类 surface 在渲染器加载期间的占位。
 *
 * 形状逐段对齐 `CollectionShell` 无头图时的真实首帧（头图默认隐藏，骨架不画；
 * 用户开了头图时加载完成才出现，属于可接受的一次性跳变），度量来源：
 *
 *   大标题   行内图标 `h-7 w-7`（`titleIconSlot` 的图标本体档）；行高由名称按钮
 *            `h-11`（44px 行盒）决定；名称文字起点 = 图标右缘 +12px（header 的
 *            `gap-3` − 按钮容器 `-ml-2` + 按钮自身 `px-2` 恰好相抵，骨架用 gap-3 等价）
 *   副标题   不画占位条，只留真实副标题盒的高度（textarea `py-1` + text-sm 行盒
 *            ≈31px，加 header 的 `gap-0.5` 共 33px）—— tab 条才能与真实位置对齐
 *   tab 条   `px-4 py-1` + `h-7` pill = 行高 36px（= `--collection-tab-bar-h`）；
 *            外壳 track 的 `gap-2` 用 `mt-2` 补出
 *   顶部偏移  根节点 `pt-[var(--work-titlebar-h,0px)]`：骨架阶段外壳未挂载，头图
 *            注册表不可用时 Work 列按「头图可见」上穿标题栏（负 margin + 注入
 *            `--work-titlebar-h`），无头图的真实首帧则从标题栏下方开始 —— 骨架
 *            借这个变量把内容推到加载后的位置；穿透关闭时变量回落 0px，无副作用
 *   内容区   按 body 传对应面板的内容占位（表格 / 图墙 / 卡片）
 *
 * 所有集合文件（`.table/.lib/.workdocs/.index.yaml`）与文件夹打开都走
 * `CollectionShell`（含旧的单域文件），所以骨架只有这一份；面板挂载后
 * tab 条之下的加载占位由各面板自己的 loading 兜底，不在这里。
 */
export function CollectionShellLoadingSkeleton({ body = 'table' }: { body?: CollectionSkeletonBody }) {
  return <div aria-label="集合预览" aria-busy="true" className="flex h-full min-h-0 flex-col overflow-hidden pt-[var(--work-titlebar-h,0px)]">
    {/* 大标题（行内图标 + 名称条）+ 副标题高度空档（不画条，只撑出 tab 条的真实纵向位置） */}
    <div className="flex shrink-0 flex-col gap-0.5 px-4 pb-2 pt-4" aria-hidden="true">
      <div className="flex h-11 min-w-0 items-center gap-3">
        <span className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-[var(--muted)] opacity-[0.36]" />
        <span className="h-7 w-48 max-w-full animate-pulse rounded bg-[var(--muted)] opacity-[0.36]" />
      </div>
      {/* 真实副标题盒高（textarea py-1 + text-sm 行盒 ≈31px） */}
      <div className="h-[31px]" />
    </div>
    {/* tab 条（CollectionTabBar: px-4 py-1，pill h-7，行高 36px；mt-2 = 外壳 track 的 gap-2；不画右侧操作区） */}
    <div className="mt-2 flex shrink-0 items-center gap-1.5 px-4 py-1" aria-hidden="true">
      <span className="h-7 w-16 animate-pulse rounded-md bg-[var(--muted)] opacity-[0.36]" />
      <span className="h-7 w-20 animate-pulse rounded-md bg-[var(--muted)] opacity-[0.36]" />
    </div>
    {/* 内容区：tab 条之下的面板占位 */}
    <div className="min-h-0 flex-1" aria-hidden="true">
      {body === 'gallery' ? <MediaLibraryLoadingSkeleton />
        : body === 'cards' ? <WorkDocumentsLoadingSkeleton />
        : <MultidimensionalTableLoadingSkeleton />}
    </div>
  </div>;
}
