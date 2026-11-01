'use client';

/**
 * 集合 tab 条 ── **唯一实现**：按钮样式 + 吸顶行 + 可横向滚动的 tab 组。
 *
 * 集合界面只有一个 tab 条，但有两处渲染它：
 *   - 表格 nav：视图 tab + 宿主 tab（文件树 / 图墙 / 列表）+「···」菜单；
 *   - 外壳的「集合还没建好」兜底分支：占位 tab（点击就地建齐）。
 * 两处若各写一份结构，吸顶偏移、圆角、间距、溢出渐隐迟早各走各的，所以：
 *
 *   collectionTabClassName  单个 tab 的唯一样式（视图 tab 与宿主 tab 必须同款）
 *   CollectionTabButton     普通按钮形态的 tab
 *   CollectionTabBar        吸顶的一行（不透明底色、宽度锁面板宽）
 *   CollectionTabStrip      tab 组（横滚 + 溢出渐隐；紧跟在它后面的「···」固定可见，
 *                           不随 tab 滚动）
 *
 * 行高与底部净空见 index.css 的 `--collection-tab-bar-h` /
 * `--collection-composer-clearance`；需要对齐 tab 条下沿的 sticky 元素一律引用变量。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function collectionTabClassName(active: boolean, extra = ''): string {
  return [
    // `select-none`：tab 是点击目标不是文本，拖选时不应被划蓝（改名输入框不走这个类，不受影响）。
    'shrink-0 select-none whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors disabled:opacity-50',
    active
      ? 'bg-[var(--muted)] font-medium text-[var(--foreground)]'
      : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)]/60',
    extra,
  ].filter(Boolean).join(' ');
}

export function CollectionTabButton({ label, active, onClick, disabled, title }: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-current={active ? 'page' : undefined}
    className={collectionTabClassName(active)}
  >{label}</button>;
}

/**
 * 吸顶的 tab 行。
 *
 * - `pinned`：整页滚动模式（集合外壳）。纵向吸在 Work 标题栏下沿（偏移 =
 *   `--work-titlebar-h`，集合内容上穿标题栏时由外壳注入；无穿透的容器里回落 0，
 *   即吸在容器顶）；横向 `sticky left-0` 钉在左缘、宽度恒为面板宽，宽表整页横滚时
 *   不会跟着跑偏；底色必须不透明，否则吸住后行内容会透出来。
 * - 非整页滚动（编辑器内嵌表格）：只纵向吸顶，不锁宽度。
 */
export function CollectionTabBar({ children, pinned = false, label, dataTitleVisible, className }: {
  children: ReactNode;
  pinned?: boolean;
  /** 无障碍名称（这一条 tab 条是什么）。 */
  label?: string;
  /** 容器查询用：标题在窄容器里让位给 tab。 */
  dataTitleVisible?: boolean;
  className?: string;
}) {
  return <div
    role="navigation"
    aria-label={label}
    data-title-visible={dataTitleVisible}
    className={cn(
      'collection-tab-bar flex min-w-0 shrink-0 items-center gap-1 px-4 py-1',
      pinned
        ? 'sticky left-0 top-[var(--work-titlebar-h,0px)] z-30 w-[var(--collection-viewport-w,100%)] bg-[var(--document-bg)]'
        : 'sticky top-0 z-10',
      className,
    )}
  >{children}</div>;
}

/**
 * tab 组：可横向滚动的 tab 区 + 两侧溢出渐隐。
 *
 * 宽度只吃「内容与剩余空间取小」（`min-w-0` + 内层 `w-max`），所以紧跟在它后面的
 * 「···」永远贴在最后一个 tab 右边；tab 再多也只挤压这一块，不会把按钮顶到行尾。
 */
export function CollectionTabStrip({ children }: { children: ReactNode }) {
  const { scrollerRef, overflow } = useTabStripOverflow();
  return <div className="flex min-w-0 items-center gap-1">
    <div
      className="collection-tab-strip relative h-7 min-w-0 overflow-hidden"
      data-overflow-left={overflow.left ? 'true' : 'false'}
      data-overflow-right={overflow.right ? 'true' : 'false'}
    >
      <div ref={scrollerRef} className="collection-tab-strip__scroller scrollbar-hide flex h-full min-w-0 items-center overflow-x-auto">
        <div className="flex w-max min-w-max shrink-0 items-center gap-1.5">{children}</div>
      </div>
    </div>
  </div>;
}

/**
 * 左右溢出状态：看内容是否还能往两侧滚。
 *
 * 之前由调用方把「视图列表 + 正在改名的视图名」当依赖传进来，新增 / 改名才重算；
 * 现在直接盯内容节点（MutationObserver）+ 容器尺寸（ResizeObserver），
 * 调用方只管渲染 tab，不必再知道这条规则。
 */
function useTabStripOverflow() {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const sync = () => {
      const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
      setOverflow((current) => {
        const left = scroller.scrollLeft > 1;
        const right = maxScrollLeft - scroller.scrollLeft > 1;
        return current.left === left && current.right === right ? current : { left, right };
      });
    };

    sync();
    scroller.addEventListener('scroll', sync, { passive: true });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    resizeObserver?.observe(scroller);
    const content = scroller.firstElementChild;
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sync);
    if (content) mutationObserver?.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      scroller.removeEventListener('scroll', sync);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  return { scrollerRef, overflow };
}
