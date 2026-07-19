'use client';

import { useRef, useState, useCallback } from 'react';
import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@shared/ui/dropdown-menu';
import { files, notebooks as notebooksClient } from '@platform/tauri/client';
import { NotebookIcon, useMemoStore, type Notebook } from '@features/memo';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@features/i18n';

async function enrichNotebookMissingState(notebooks: Notebook[]): Promise<Notebook[]> {
  if (notebooks.every((notebook) => Object.prototype.hasOwnProperty.call(notebook, 'missing'))) {
    return notebooks;
  }

  return Promise.all(
    notebooks.map(async (notebook) => {
      if (Object.prototype.hasOwnProperty.call(notebook, 'missing')) {
        return notebook;
      }
      try {
        const tree = await files.getTree(notebook.path);
        return { ...notebook, missing: tree === null };
      } catch {
        return { ...notebook, missing: true };
      }
    })
  );
}

interface NotebookSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelect: (notebook: Notebook) => void;
  onEdit: (notebook: Notebook) => void;
  onDelete: (notebook: Notebook) => void;
  /**
   * Called each time the dropdown opens. Parent uses it to refetch the
   * notebook list so newly created / imported notebooks show up immediately.
   */
  onRefresh: (notebooks: Notebook[]) => void;
  /** Width passed to the dropdown content; usually derived from the memo list column. */
  dropdownWidth: number;
}

/** Pointer movement before treating the gesture as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** Visual estimate of one notebook row (h-6 + py-1.5 + 间距)。 */
const ROW_HEIGHT_PX = 36;

type DropPosition = 'before' | 'after';

interface DragState {
  sourceId: string;
  sourceIndex: number;
  pointerX: number;
  pointerY: number;
}

/**
 * Bottom-bar trigger + dropdown for switching, creating, editing, deleting
 * AND reordering notebooks.
 *
 * Click semantics: a quick pointerdown→pointerup with movement under
 * DRAG_THRESHOLD_PX is treated as a click and triggers `onSelect`. Once
 * movement exceeds the threshold we enter reorder mode — the row becomes
 * a plain `<div>` instead of `DropdownMenuItem` (so Radix's auto-close
 * on click never fires), and pointerup commits the new id order via
 * `useMemoStore.reorderNotebooks`.
 *
 * Drag implementation note: we deliberately avoid dnd-kit / react-dnd and
 * roll a tiny pointer state machine. The list is short (single digits),
 * the gesture is bounded by the dropdown bounds, and the project already
 * uses the same approach in `note-navigation-panel.tsx` and `tab-window.tsx`.
 */
export function NotebookSwitcher({
  open,
  onOpenChange,
  notebooks,
  selectedNotebook,
  onSelect,
  onEdit,
  onDelete,
  onRefresh,
  dropdownWidth,
}: NotebookSwitcherProps) {
  const { t } = useI18n();
  const reorderNotebooks = useMemoStore((s) => s.reorderNotebooks);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<{ index: number; position: DropPosition } | null>(null);
  // 用 ref 暂存 hover 状态, 以便 pointerup 同步事件里读到最新值。
  const hoverRef = useRef<{ index: number; position: DropPosition } | null>(null);

  const handlePointerDown = useCallback(
    (notebook: Notebook, index: number, event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // 不在 pointerdown 调 preventDefault: 它会取消兼容 mouse 事件,
      // 导致 DropdownMenuItem 的 onClick (选中) 不触发; 改由行上
      // select-none 防文本选中, 拖动体验不变且点击选中保留。

      const startX = event.clientX;
      const startY = event.clientY;
      const sourceId = notebook.id;
      const sourceIndex = index;

      let active = false;
      hoverRef.current = null;
      setHover(null);

      const updateHover = (pointerY: number) => {
        const rect = listRef.current?.getBoundingClientRect();
        if (!rect) {
          hoverRef.current = null;
          setHover(null);
          return;
        }
        const relativeY = pointerY - rect.top;
        if (relativeY < 0 || relativeY > rect.height) {
          hoverRef.current = null;
          setHover(null);
          return;
        }
        const raw = Math.floor(relativeY / ROW_HEIGHT_PX);
        const offsetWithin = relativeY - raw * ROW_HEIGHT_PX;
        const position: DropPosition =
          offsetWithin < ROW_HEIGHT_PX / 2 ? 'before' : 'after';
        // 把 raw (绝对插入位置, 含 source) 转成 target index (去掉 source 自己)。
        let target = raw;
        if (raw > sourceIndex) target = raw - 1;
        if (raw === sourceIndex && position === 'before') {
          // 在 source 这行上半部分 = 没移动。
          hoverRef.current = null;
          setHover(null);
          return;
        }
        if (raw === sourceIndex && position === 'after') {
          // 在 source 这行下半部分 = 也不动 (等价于原顺序)。
          hoverRef.current = null;
          setHover(null);
          return;
        }
        target = Math.max(0, Math.min(target, notebooks.length - 1));
        if (target === sourceIndex) {
          hoverRef.current = null;
          setHover(null);
          return;
        }
        const next = { index: target, position };
        hoverRef.current = next;
        setHover(next);
      };

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!active && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (!active) {
          active = true;
          setDrag({ sourceId, sourceIndex, pointerX: e.clientX, pointerY: e.clientY });
          // 进入拖动后锁住 body 选区 (替代已移除的 pointerdown preventDefault),
          // 防止拖到 dropdown 边缘外误选 body 文本; onUp 释放。
          document.body.style.userSelect = 'none';
        } else {
          // 非首次 move 只更新指针坐标; 首次已在上面 setDrag 设完整状态。
          setDrag((prev) => (prev ? { ...prev, pointerX: e.clientX, pointerY: e.clientY } : prev));
        }
        updateHover(e.clientY);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.style.userSelect = '';
        const finalHover = hoverRef.current;
        setDrag(null);
        setHover(null);
        hoverRef.current = null;
        if (finalHover) {
          const ids = notebooks.map((n) => n.id);
          const [moved] = ids.splice(sourceIndex, 1);
          ids.splice(finalHover.index, 0, moved);
          void reorderNotebooks(ids);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [notebooks, reorderNotebooks]
  );

  const sourceNotebook = drag
    ? notebooks.find((n) => n.id === drag.sourceId) ?? null
    : null;
  const listWidth = drag ? (listRef.current?.getBoundingClientRect().width ?? 0) : 0;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Refresh the notebook list each time the popup opens so newly
          // created or imported notebooks show up immediately.
          notebooksClient.getAll().then(async (nbList) => {
            if (nbList && nbList.length > 0) {
              onRefresh(await enrichNotebookMissingState(nbList));
            }
          });
        }
        // 拖拽过程中不允许 dropdown 关闭 (会让 listRef 失效, 拖拽会出 bug)。
        if (!next && drag) return;
        onOpenChange(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-[26px] flex px-1 bg-[var(--primary)] items-center hover:opacity-90 gap-1"
          aria-label={t('status.switchNotebook')}
        >
          <span className="pl-2 h-full py-0 text-[var(--primary-foreground)] flex items-center overflow-hidden whitespace-nowrap">
            {t('status.notebook')}
          </span>
          <NotebookIcon
            icon={selectedNotebook?.icon}
            name={selectedNotebook?.name}
            className="h-4 w-4 rounded bg-[color-mix(in_oklch,var(--primary-foreground)_10%,transparent)] text-[12px] font-semibold text-[var(--primary-foreground)]"
          />
          <ChevronsUpDown className="text-[var(--primary-foreground)] w-3 h-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={2}
        className="flex flex-col max-h-[500px] overflow-hidden px-1 py-1 ml-2 bg-[var(--popover)]"
        style={{ width: Math.max(160, dropdownWidth - 24) }}
      >
        <DropdownMenuLabel className="shrink-0 px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('status.notebookList')}
        </DropdownMenuLabel>
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto pb-1 space-y-0.5 relative"
        >
          {notebooks.length === 0 ? (
            <div className="px-3 py-8 text-xs text-center text-[var(--muted-foreground)]">
              {t('status.noNotebooks')}
            </div>
          ) : (
            notebooks.map((notebook, index) => {
              const isActive = selectedNotebook?.id === notebook.id;
              const isMissing = Boolean(notebook.missing);
              const notebookTitleClassName = cn(
                'text-sm font-medium',
                isMissing ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'
              );
              const isSource = drag?.sourceId === notebook.id;
              const hoverIndicator =
                hover && hover.index === index
                  ? hover.position === 'before'
                    ? 'before'
                    : 'after'
                  : null;
              const rowClassName = cn(
                'group relative flex select-none items-center gap-2 rounded-md px-2 py-1.5 pr-14 transition-colors',
                isSource ? 'opacity-30' : 'cursor-pointer hover:bg-[var(--accent)]'
              );

              // 行内容 fragment, 在拖拽态和非拖拽态复用。
              const rowInner = (
                <>
                  {/* 拖拽手柄区域: 整行 pointerdown 触发状态机 */}
                  <div
                    className="absolute inset-0 z-0"
                    onPointerDown={(e) => handlePointerDown(notebook, index, e)}
                  />
                  <NotebookIcon
                    icon={notebook.icon}
                    name={notebook.name}
                    className="relative z-10 h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)] pointer-events-none"
                  />
                  <div className="relative z-10 flex-1 min-w-0 flex items-center gap-1.5 pointer-events-none">
                    <span className="min-w-0 truncate">
                      <span className={notebookTitleClassName}>{notebook.name}</span>
                      {isMissing && (
                        <>
                          <span className={notebookTitleClassName}> </span>
                          <span className={notebookTitleClassName}>{t('status.invalid')}</span>
                        </>
                      )}
                    </span>
                  </div>
                  {hoverIndicator === 'before' && (
                    <div className="absolute left-1 right-1 -top-px h-0.5 bg-[var(--primary)] rounded z-20 pointer-events-none" />
                  )}
                  {hoverIndicator === 'after' && (
                    <div className="absolute left-1 right-1 -bottom-px h-0.5 bg-[var(--primary)] rounded z-20 pointer-events-none" />
                  )}
                  {isActive && !isSource && (
                    <div className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center transition-opacity group-hover:opacity-0 z-10 pointer-events-none">
                      <Check className="h-4 w-4 text-[var(--primary)]" />
                    </div>
                  )}
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(notebook);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="flex h-6 w-6 items-center justify-center rounded bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                      aria-label={t('status.editNotebook')}
                    >
                      <Pencil className="h-3 w-3" />
                    </span>
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(notebook);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="flex h-6 w-6 items-center justify-center rounded bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--destructive)] cursor-pointer"
                      aria-label={t('status.deleteNotebook')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </div>
                </>
              );

              // 拖拽期间 (drag !== null) 渲染为普通 div, 不挂 DropdownMenuItem
              // 避免 Radix 的内置 onClick → setOpen(false) 关闭 dropdown。
              if (drag) {
                return (
                  <div key={notebook.id} className={rowClassName} style={{ touchAction: 'none' }}>
                    {rowInner}
                  </div>
                );
              }
              return (
                <DropdownMenuItem
                  key={notebook.id}
                  onClick={() => {
                    if (isMissing) {
                      toast.warning(t('status.invalidNotebookPath'));
                      return;
                    }
                    onSelect(notebook);
                  }}
                  className={rowClassName}
                >
                  {rowInner}
                </DropdownMenuItem>
              );
            })
          )}

          {/* Ghost: 跟随鼠标的小卡片, 仅 drag 期间显示 */}
          {drag && sourceNotebook && listWidth > 0 && (
            <div
              className="fixed z-50 pointer-events-none flex items-center gap-2 rounded-md px-2 py-1.5 bg-[var(--popover)] border border-[var(--primary)] shadow-lg"
              style={{
                left: drag.pointerX + 12,
                top: drag.pointerY + 12,
                width: listWidth - 16,
              }}
            >
              <NotebookIcon
                icon={sourceNotebook.icon}
                name={sourceNotebook.name}
                className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
              />
              <span className="text-sm font-medium text-[var(--foreground)] truncate">
                {sourceNotebook.name}
              </span>
            </div>
          )}
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              // Defer to next tick so the dropdown finishes closing
              // before the modal opens.
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'));
              }, 0);
            }}
            className={cn(
              'group flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              'text-[var(--muted-foreground)] hover:bg-[var(--muted)]'
            )}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{t('status.newNotebook')}</span>
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
