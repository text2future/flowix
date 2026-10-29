import { cn } from '@/lib/utils';

// 排版与颜色类：文案与「隐藏」共用，避免两处漂移。
const EMPTY_STATE_TYPO_CLASS = 'text-xs leading-4 text-[var(--muted-foreground)]';

// 文案的淡化程度。注意：这一档 opacity 只能挂在**文案自己**身上。
// opacity 会作用于整棵子树，若挂在按钮的定位父节点上，按钮的 opacity 会与父级
// 相乘（0.48 × 0.48 ≈ 0.23），看起来就比文案浅一半。
const EMPTY_STATE_TEXT_CLASS = cn(EMPTY_STATE_TYPO_CLASS, 'opacity-[0.48]');

export interface TreeSectionEmptyStateProps {
  /** 提示文案，恒定居中，hover 也不移动。 */
  message: string;
  /** 紧贴文案右侧的操作，默认不可见，hover / 聚焦时浮出。缺省则不渲染该按钮。 */
  hideLabel?: string;
  onHide?: () => void;
  /** 与所在分区的行保持一致的左右缩进。 */
  edgeGutter?: number;
  className?: string;
}

/**
 * 文件树分区的空状态 ── 「列表为空」恒定居中；「隐藏」默认不可见，
 * hover / 键盘聚焦时紧贴文案右侧浮出。按钮用绝对定位挂在文案后面，
 * 所以它的出现不会推动文案位移。
 *
 * 三个分区共用同一视觉契约，所以放在 foundation：对话分区属 agent feature，
 * 视图与仓库分区属 memo feature，跨 feature 共享只能落这里。
 */
export function TreeSectionEmptyState({
  message,
  hideLabel,
  onHide,
  edgeGutter = 6,
  className,
}: TreeSectionEmptyStateProps) {
  return (
    <div
      className={cn('relative flex h-7 items-center justify-center px-1.5', className)}
      style={{ marginLeft: edgeGutter, width: `calc(100% - ${edgeGutter * 2}px)` }}
      data-tree-section-empty-state="true"
    >
      {/* 外层 span 只做两件事：文案居中 + 给按钮当定位上下文。它自己不带 opacity，
          否则按钮会继承并在其上再叠一层，颜色就比文案浅了。 */}
      <span className="relative inline-flex max-w-full items-center">
        <span className={EMPTY_STATE_TEXT_CLASS}>{message}</span>
        {onHide && hideLabel && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onHide();
            }}
            className={cn(
              EMPTY_STATE_TYPO_CLASS,
              // left-full + 小间距 = 紧贴文案右侧；绝对定位所以不占位、不推挤文案。
              // whitespace-nowrap + w-max 让按钮按文字撑开 —— 否则绝对定位元素的
              // 收缩宽度被文案宽度限制，"隐藏" 会被挤成两行。
              'pointer-events-none absolute left-full top-1/2 ml-1.5 w-max -translate-y-1/2 whitespace-nowrap border-0 bg-transparent p-0 opacity-0 transition-opacity duration-150',
              // 浮出时与文案同一档 0.48（此时父级无 opacity，不会被再乘一次）。
              'tree-section-empty-state__hide-action',
              // 自身 hover 再加深一档：先跟文案同色（0.48 灰），悬停时转前景色且不再稀释。
              'hover:text-[var(--foreground)] hover:!opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]',
            )}
          >
            {hideLabel}
          </button>
        )}
      </span>
    </div>
  );
}
