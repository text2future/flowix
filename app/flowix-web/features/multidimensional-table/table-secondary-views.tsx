import { Fragment, useMemo, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, FileText, MoreHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import documentCardPlaceholder from '@/assets/placeholder-document-card.jpg';
import type { TableField, TableRecord } from './model';

type ValueRenderer = (record: TableRecord, field: TableField) => string;
type MoveRecord = (recordId: string, fieldId: string, value: string) => void;
type DropKanbanRecord = (recordId: string, groupId: string, beforeRecordId: string | null) => void | Promise<void>;

function formatCalendarTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatGalleryUpdatedAt(timestamp: string): string {
  const updatedAt = Date.parse(timestamp);
  if (!Number.isFinite(updatedAt)) return '更新时间未知';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (elapsedSeconds < 60) return '更新 刚刚';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `更新 ${elapsedMinutes}分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `更新 ${elapsedHours}小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `更新 ${elapsedDays}天前`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `更新 ${elapsedMonths}个月前`;
  return `更新 ${Math.floor(elapsedMonths / 12)}年前`;
}

export function TableGalleryView({ records, titleField, fields, renderValue, imageUrl, onOpenRecord }: {
  records: TableRecord[];
  titleField: TableField;
  fields: TableField[];
  renderValue: ValueRenderer;
  imageUrl: (record: TableRecord, field: TableField) => string | null;
  onOpenRecord: (record: TableRecord, anchorRect: DOMRect) => void;
}) {
  const imageField = fields.find((field) => field.type === 'Image');

  return <div className="multidimensional-table__gallery flex-1 px-5">
    {records.length > 0
      ? <div className="multidimensional-table__gallery-grid grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] items-stretch gap-3.5 pt-3">
          {records.map((record) => {
            const cover = imageField ? imageUrl(record, imageField) : null;
            return <button key={record.id} type="button" onClick={(event) => onOpenRecord(record, event.currentTarget.getBoundingClientRect())} className="group flex h-[210px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-[background-color,border-color] hover:border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
              <span className="flex h-[148px] w-full shrink-0 items-center justify-center overflow-hidden border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)]">
                <img
                  src={cover ?? documentCardPlaceholder}
                  alt=""
                  loading="lazy"
                  className={`h-full w-full object-cover ${cover ? '' : 'opacity-50'}`}
                  onError={(event) => {
                    const image = event.currentTarget;
                    if (image.dataset.fallbackApplied === 'true') return;
                    image.dataset.fallbackApplied = 'true';
                    image.src = documentCardPlaceholder;
                    image.classList.add('opacity-50');
                  }}
                />
              </span>
              <span className="flex h-[61px] min-w-0 items-start gap-1 px-3 py-2.5">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-5 text-[var(--foreground)]">{renderValue(record, titleField)}</span>
                  <span className="mt-0.5 block truncate text-[11px] leading-4 text-[var(--muted-foreground)]">
                    {formatGalleryUpdatedAt(record.updated_at)}
                  </span>
                </span>
              </span>
            </button>;
          })}
        </div>
      : <div className="flex min-h-40 items-center justify-center text-sm text-[var(--muted-foreground)]">未添加内容</div>}
  </div>;
}

export function TableKanbanView({ groupField, titleField, records, groups, renderValue, onDropRecord, onReorderLane }: {
  groupField: TableField;
  titleField: TableField;
  records?: TableRecord[];
  groups: ReadonlyMap<string, TableRecord[]>;
  renderValue: ValueRenderer;
  onDropRecord: DropKanbanRecord;
  onReorderLane: (sourceOptionId: string, targetOptionId: string, insertAfter: boolean) => void;
}) {
  const [draggingRecordId, setDraggingRecordId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ groupId: string; beforeRecordId: string | null } | null>(null);
  const [draggingLaneId, setDraggingLaneId] = useState<string | null>(null);
  const [laneDropTarget, setLaneDropTarget] = useState<{ optionId: string; insertAfter: boolean } | null>(null);
  const kanbanBoardRef = useRef<HTMLDivElement | null>(null);
  const lanePointerDragRef = useRef<{ pointerId: number; optionId: string; startX: number; startY: number; active: boolean } | null>(null);
  const pointerDragRef = useRef<{ pointerId: number; recordId: string; startX: number; startY: number; active: boolean } | null>(null);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const floatingCardRef = useRef<HTMLElement | null>(null);
  const allRecords = useMemo(() => records ?? [...new Map([...groups.values()].flat().map((record) => [record.id, record])).values()], [groups, records]);
  const visibleAllRecords = allRecords.filter((record) => record.id !== draggingRecordId);
  const draggedRecord = useMemo(() => draggingRecordId
    ? allRecords.find((record) => record.id === draggingRecordId) ?? null
    : null, [allRecords, draggingRecordId]);
  const showInsertionPreview = Boolean(draggedRecord && dropTarget);
  const laneOptions = groupField.options ?? [];
  const previewLaneOptions = (() => {
    if (!draggingLaneId || !laneDropTarget) return laneOptions;
    const sourceIndex = laneOptions.findIndex((option) => option.id === draggingLaneId);
    if (sourceIndex < 0 || laneDropTarget.optionId === draggingLaneId) return laneOptions;
    const nextOptions = laneOptions.filter((option) => option.id !== draggingLaneId);
    const targetIndex = nextOptions.findIndex((option) => option.id === laneDropTarget.optionId);
    if (targetIndex < 0) return laneOptions;
    nextOptions.splice(targetIndex + (laneDropTarget.insertAfter ? 1 : 0), 0, laneOptions[sourceIndex]);
    return nextOptions;
  })();

  const laneTargetAt = (x: number, y: number, sourceOptionId: string) => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const lane = element?.closest<HTMLElement>('[data-kanban-lane]');
    const targetOptionId = lane?.dataset.kanbanLane;
    if (!lane || !targetOptionId || targetOptionId === sourceOptionId) return null;
    const bounds = lane.getBoundingClientRect();
    return { optionId: targetOptionId, insertAfter: x >= bounds.left + bounds.width / 2 };
  };

  const onLanePointerDown = (event: PointerEvent<HTMLElement>, optionId: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    lanePointerDragRef.current = { pointerId: event.pointerId, optionId, startX: event.clientX, startY: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onLanePointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = lanePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.active = true;
      setDraggingLaneId(drag.optionId);
    }
    const target = laneTargetAt(event.clientX, event.clientY, drag.optionId);
    if (target) setLaneDropTarget(target);
  };

  const onLanePointerUp = (event: PointerEvent<HTMLElement>) => {
    const drag = lanePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) {
      const hoveredLaneId = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)
        ?.closest<HTMLElement>('[data-kanban-lane]')?.dataset.kanbanLane;
      const target = laneTargetAt(event.clientX, event.clientY, drag.optionId)
        ?? (hoveredLaneId === drag.optionId ? laneDropTarget : null);
      if (target) onReorderLane(drag.optionId, target.optionId, target.insertAfter);
    }
    lanePointerDragRef.current = null;
    setDraggingLaneId(null);
    setLaneDropTarget(null);
  };

  const onLanePointerCancel = () => {
    lanePointerDragRef.current = null;
    setDraggingLaneId(null);
    setLaneDropTarget(null);
  };

  const targetAt = (x: number, y: number, draggedId: string) => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const lane = element?.closest<HTMLElement>('[data-kanban-lane]');
    const groupId = lane?.dataset.kanbanLane;
    if (!groupId) return null;
    const beforeCard = [...lane.querySelectorAll<HTMLElement>('[data-kanban-record]')]
      .filter((card) => card.dataset.kanbanRecord !== draggedId)
      .find((card) => {
        const bounds = card.getBoundingClientRect();
        return y < bounds.top + bounds.height / 2;
      });
    return { groupId, beforeRecordId: beforeCard?.dataset.kanbanRecord ?? null };
  };

  const resetDrag = () => {
    pointerDragRef.current = null;
    setDraggingRecordId(null);
    setDropTarget(null);
  };

  const onCardPointerDown = (event: PointerEvent<HTMLElement>, recordId: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerDragRef.current = { pointerId: event.pointerId, recordId, startX: event.clientX, startY: event.clientY, active: false };
    kanbanBoardRef.current?.setPointerCapture?.(event.pointerId);
  };

  const onCardPointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    if (floatingCardRef.current) {
      floatingCardRef.current.style.left = `${event.clientX + 14}px`;
      floatingCardRef.current.style.top = `${event.clientY + 14}px`;
    }
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.active = true;
      setDraggingRecordId(drag.recordId);
    }
    setDropTarget(targetAt(event.clientX, event.clientY, drag.recordId));
  };

  const onCardPointerUp = (event: PointerEvent<HTMLElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) {
      const target = targetAt(event.clientX, event.clientY, drag.recordId);
      if (target) {
        Promise.resolve(onDropRecord(drag.recordId, target.groupId, target.beforeRecordId)).then(resetDrag, resetDrag);
        return;
      }
    }
    resetDrag();
  };

  return <div ref={kanbanBoardRef} onPointerMove={onCardPointerMove} onPointerUp={onCardPointerUp} onPointerCancel={resetDrag} className="flex min-h-0 flex-1 flex-col">
    <div className="multidimensional-table__kanban-lanes flex w-max items-start gap-3 px-5 py-3">
      <section data-kanban-all-records="true" className="multidimensional-table__kanban-lane flex w-64 shrink-0 flex-col rounded-xl border border-[var(--border)]">
        <header className="flex min-h-10 items-center justify-between gap-3 px-3.5 pt-3.5 pb-1.5">
          <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--foreground)]">全部</h2>
          <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{allRecords.length}</span>
        </header>
        <div className="multidimensional-table__kanban-lane-content min-h-0 flex-1 overflow-y-auto flex flex-col gap-2 px-2.5 pt-[5px] pb-4">
          {visibleAllRecords.map((record) => <article key={record.id} onPointerDown={(event) => onCardPointerDown(event, record.id)} className="multidimensional-table__kanban-card cursor-grab select-none touch-none rounded-lg border border-[var(--border)] px-3 py-3 active:cursor-grabbing">
            <div className="break-words text-sm font-medium leading-5 text-[var(--foreground)]">{renderValue(record, titleField)}</div>
          </article>)}
          {allRecords.length === 0 && <div className="multidimensional-table__kanban-empty pointer-events-none flex min-h-24 select-none items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-4 text-center text-xs text-[var(--muted-foreground)]">暂无笔记</div>}
        </div>
      </section>
      {previewLaneOptions.map((option) => {
        const group = groups.get(option.id) ?? [];
        const visibleGroup = group.filter((record) => record.id !== draggingRecordId);
        const showEndPreview = showInsertionPreview && dropTarget?.groupId === option.id && dropTarget.beforeRecordId === null;
        return <section key={option.id} data-kanban-lane={option.id} className={`multidimensional-table__kanban-lane flex w-64 shrink-0 flex-col rounded-xl border border-[var(--border)] transition-opacity ${draggingLaneId === option.id ? 'opacity-50' : ''}`}>
          <header title="拖动调整泳道顺序" className="flex min-h-10 touch-none select-none cursor-grab items-center justify-between gap-3 px-3.5 pt-3.5 pb-1.5 active:cursor-grabbing" onPointerDown={(event) => onLanePointerDown(event, option.id)} onPointerMove={onLanePointerMove} onPointerUp={onLanePointerUp} onPointerCancel={onLanePointerCancel}>
            <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--foreground)]">{option.label}</h2>
            <span className="shrink-0 text-xs font-normal text-[var(--muted-foreground)]">{group.length}</span>
          </header>
          <div className="multidimensional-table__kanban-lane-content min-h-0 flex-1 overflow-y-auto flex flex-col gap-2 px-2.5 pt-[5px] pb-4">
            {visibleGroup.map((record) => <Fragment key={record.id}>
              {showInsertionPreview && draggedRecord && dropTarget?.groupId === option.id && dropTarget.beforeRecordId === record.id && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-3 py-3 opacity-50">
                <div className="break-words text-sm font-medium leading-5 text-[var(--foreground)]">{renderValue(draggedRecord, titleField)}</div>
              </article>}
              <article data-kanban-record={record.id} onPointerDown={(event) => onCardPointerDown(event, record.id)} className="multidimensional-table__kanban-card cursor-grab select-none touch-none rounded-lg border border-[var(--border)] px-3 py-3 active:cursor-grabbing">
                <div className="break-words text-sm font-medium leading-5 text-[var(--foreground)]">{renderValue(record, titleField)}</div>
              </article>
            </Fragment>)}
            {showEndPreview && draggedRecord && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-3 py-3 opacity-50">
              <div className="break-words text-sm font-medium leading-5 text-[var(--foreground)]">{renderValue(draggedRecord, titleField)}</div>
            </article>}
            {visibleGroup.length === 0 && !showEndPreview && <div className="multidimensional-table__kanban-empty pointer-events-none flex min-h-24 select-none items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-4 text-center text-xs text-[var(--muted-foreground)]">拖动记录到此处</div>}
          </div>
        </section>;
      })}
    </div>
    {draggedRecord && typeof document !== 'undefined' && createPortal(
      <article ref={floatingCardRef} data-kanban-floating-preview aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none fixed z-[1000] w-[252px] select-none rounded-lg border border-[var(--border)] px-3 py-3 shadow-lg" style={{ left: pointerPositionRef.current.x + 14, top: pointerPositionRef.current.y + 14 }}>
        <div className="break-words text-sm font-medium leading-5 text-[var(--foreground)]">{renderValue(draggedRecord, titleField)}</div>
      </article>, document.body)}
  </div>;
}

export function TableCalendarView({ cursor, onCursorChange, days, groups, dateFieldId, dateFieldLabel = '', titleField, renderValue, dateValueForRecord, weekStart = 0, onWeekStartChange, onMoveRecord, canMoveRecords = true, onClickDate, addingNoteDate }: {
  cursor: Date;
  onCursorChange: (date: Date) => void;
  days: Array<{ date: Date; iso: string; inMonth: boolean }>;
  groups: ReadonlyMap<string, TableRecord[]>;
  dateFieldId: string;
  dateFieldLabel?: string;
  titleField: TableField;
  renderValue: ValueRenderer;
  dateValueForRecord?: (record: TableRecord) => unknown;
  weekStart?: 0 | 1;
  onWeekStartChange?: (weekStart: 0 | 1) => void | Promise<void>;
  onMoveRecord: MoveRecord;
  canMoveRecords?: boolean;
  onClickDate?: (date: string, anchorRect: DOMRect) => void;
  addingNoteDate?: string | null;
}) {
  const [weekStartMenuOpen, setWeekStartMenuOpen] = useState(false);
  const weekdayLabels = weekStart === 1
    ? ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
    : ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const previewLimit = days.length >= 42 ? 1 : days.length >= 35 ? 2 : 3;
  const [draggingRecord, setDraggingRecord] = useState<TableRecord | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const floatingCardRef = useRef<HTMLDivElement | null>(null);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const pointerDragRef = useRef<{ pointerId: number; record: TableRecord; sourceDate: string; startX: number; startY: number; active: boolean } | null>(null);

  const dateAt = (x: number, y: number): string | null => {
    const cell = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-calendar-date]');
    return cell && calendarRef.current?.contains(cell) ? cell.dataset.calendarDate ?? null : null;
  };

  const resetDrag = () => {
    pointerDragRef.current = null;
    setDraggingRecord(null);
    setDropDate(null);
  };

  const onCardPointerDown = (event: PointerEvent<HTMLElement>, record: TableRecord, sourceDate: string) => {
    if (!canMoveRecords || event.button !== 0) return;
    event.preventDefault();
    pointerDragRef.current = { pointerId: event.pointerId, record, sourceDate, startX: event.clientX, startY: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onCardPointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
    if (floatingCardRef.current) {
      floatingCardRef.current.style.left = `${event.clientX + 14}px`;
      floatingCardRef.current.style.top = `${event.clientY + 14}px`;
    }
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.active = true;
      setDraggingRecord(drag.record);
    }
    const target = dateAt(event.clientX, event.clientY);
    setDropDate(target && target !== drag.sourceDate ? target : null);
  };

  const onCardPointerUp = (event: PointerEvent<HTMLElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) {
      const target = dateAt(event.clientX, event.clientY);
      if (target && target !== drag.sourceDate) {
        const original = dateValueForRecord?.(drag.record);
        const time = typeof original === 'string' ? /^\d{4}-\d{2}-\d{2}([T ].*)$/.exec(original)?.[1] ?? '' : '';
        onMoveRecord(drag.record.id, dateFieldId, `${target}${time}`);
      }
    }
    resetDrag();
  };

  return <div ref={calendarRef} className="multidimensional-table__calendar mx-5 flex min-h-0 flex-1 flex-col pt-3">
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] shadow-none">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {dateFieldLabel && <span title={dateFieldLabel} className="max-w-48 truncate rounded-md border border-[var(--border)] bg-[var(--muted)] px-2 py-0.5 text-xs font-medium text-[var(--muted-foreground)]">{dateFieldLabel}</span>}
          {!canMoveRecords && <span title="创建时间和更新时间由系统维护，不能通过拖动修改" className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2 py-0.5 text-xs font-medium text-[var(--muted-foreground)]">只读</span>}
          <strong className="text-sm">{cursor.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</strong>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="上个月" onClick={() => onCursorChange(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" aria-label="下个月" onClick={() => onCursorChange(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <DropdownMenu onOpenChange={(open) => { if (!open) setWeekStartMenuOpen(false); }}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="更多日历选项" title="更多" className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]">
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-[168px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <div className="relative">
                <button type="button" aria-expanded={weekStartMenuOpen} onClick={() => setWeekStartMenuOpen((open) => !open)} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)]">
                  周开始<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                </button>
                {weekStartMenuOpen && <div className="absolute right-full top-0 z-[151] mr-1 w-[120px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                  <DropdownMenuItem onClick={() => { void onWeekStartChange?.(1); }} className="!h-8 rounded-lg px-2 py-0 hover:bg-[var(--hover-bg)]">
                    周一{weekStart === 1 && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { void onWeekStartChange?.(0); }} className="!h-8 rounded-lg px-2 py-0 hover:bg-[var(--hover-bg)]">
                    周日{weekStart === 0 && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
                  </DropdownMenuItem>
                </div>}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="grid grid-cols-7 border-b border-[var(--border)] text-center text-[10px] text-[var(--muted-foreground)]">{weekdayLabels.map((day, index) => <div key={`${day}-${index}`} className="border-r border-[var(--border)] py-2 last:border-r-0">{day}</div>)}</div>
      <div className="grid min-h-0 flex-1 grid-cols-7" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(var(--multidimensional-table-calendar-day-row-min-height, 0px), 1fr))` }}>
        {days.map(({ date, iso, inMonth }, index) => {
          const lastColumn = index % 7 === 6;
          const lastRow = index >= days.length - 7;
          const isWeekend = date.getDay() === 0 || date.getDay() === 6;
          const cellBorders = `${lastRow ? '' : 'border-b'} ${lastColumn ? '' : 'border-r'} border-[var(--border)]`;
          const records = groups.get(iso) ?? [];
          const hasHiddenRecords = records.length > previewLimit;
          return <Popover key={iso} cellPopup>
            <div data-flowix-cell-anchor data-calendar-date={iso} data-calendar-drop-target={dropDate === iso ? 'true' : undefined} onClick={(event) => {
              if ((event.target as HTMLElement).closest('[data-calendar-record]')) return;
              onClickDate?.(iso, event.currentTarget.getBoundingClientRect());
            }} style={addingNoteDate === iso ? { backgroundColor: 'var(--multidimensional-table-calendar-active-bg)' } : isWeekend ? { backgroundColor: 'var(--multidimensional-table-calendar-weekend-bg)' } : undefined} className={`relative flex h-full min-h-0 w-full flex-col overflow-hidden p-1.5 text-left ${cellBorders} ${inMonth ? '' : 'text-[var(--muted-foreground)]'} ${dropDate === iso ? 'multidimensional-table__calendar-drop-target' : ''}`}>
                <div className={`absolute left-1.5 top-1.5 text-sm ${inMonth ? '' : 'opacity-50'}`}>{date.getDate()}</div>
                <div className="mt-6 flex min-h-0 flex-col gap-1 overflow-hidden">
              {dropDate === iso && draggingRecord && <div aria-hidden="true" className="multidimensional-table__calendar-card pointer-events-none flex items-center overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--brand)_25%,var(--border))] bg-[color-mix(in_oklch,var(--brand)_4%,var(--background))] px-1 py-1 opacity-50">
                <span className="min-w-0 truncate text-xs text-[var(--foreground)]">{renderValue(draggingRecord, titleField)}</span>
              </div>}
              {records.slice(0, previewLimit).map((record) => {
                const time = formatCalendarTime(dateValueForRecord?.(record));
                return <div key={record.id} data-calendar-record={record.id} onPointerDown={(event) => onCardPointerDown(event, record, iso)} onPointerMove={onCardPointerMove} onPointerUp={onCardPointerUp} onPointerCancel={resetDrag} className={`multidimensional-table__calendar-card flex items-center justify-between gap-2 overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--brand)_25%,var(--border))] bg-[color-mix(in_oklch,var(--brand)_4%,var(--background))] px-1 py-1 text-[var(--brand)] ${canMoveRecords ? 'cursor-grab touch-none active:cursor-grabbing' : 'cursor-default'} ${draggingRecord?.id === record.id ? 'opacity-50' : ''}`} title={canMoveRecords ? renderValue(record, titleField) : '创建时间和更新时间不能通过拖动修改'}>
                  <span className="min-w-0 truncate text-xs font-normal text-[var(--foreground)]">{renderValue(record, titleField)}</span>
                  {time && <span className="shrink-0 text-[11px] tabular-nums text-[var(--muted-foreground)]">{time}</span>}
                </div>;
              })}
              {hasHiddenRecords && <PopoverTrigger asChild anchorToCell>
                <button type="button" aria-label={`${date.toLocaleDateString()}，查看全部 ${records.length} 条笔记`} className="h-5 shrink-0 truncate rounded bg-transparent px-1 text-left text-xs leading-5 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] active:bg-transparent data-[state=open]:bg-transparent">更多 +{records.length - previewLimit}</button>
              </PopoverTrigger>}
                </div>
            </div>
            <PopoverContent align="start" side="bottom" sideOffset={0} matchAnchorWidth matchAnchorHeight className={`max-h-[min(60vh,360px)] overflow-y-auto rounded-xl p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)] ${draggingRecord ? 'pointer-events-none' : ''}`}>
              <div className="space-y-1">
                {records.length ? records.map((record) => {
                  const time = formatCalendarTime(dateValueForRecord?.(record));
                  return <div key={record.id} data-calendar-record={record.id} onPointerDown={(event) => onCardPointerDown(event, record, iso)} onPointerMove={onCardPointerMove} onPointerUp={onCardPointerUp} onPointerCancel={resetDrag} className={`multidimensional-table__calendar-card flex min-w-0 items-center justify-between gap-1 rounded-md border border-[color-mix(in_oklch,var(--brand)_25%,var(--border))] bg-[color-mix(in_oklch,var(--brand)_4%,var(--background))] px-1 py-1 text-[var(--brand)] ${canMoveRecords ? 'cursor-grab touch-none active:cursor-grabbing' : 'cursor-default'} ${draggingRecord?.id === record.id ? 'opacity-50' : ''}`} title={canMoveRecords ? renderValue(record, titleField) : '创建时间和更新时间不能通过拖动修改'}>
                    <span className="min-w-0 truncate text-xs font-normal text-[var(--foreground)]">{renderValue(record, titleField)}</span>
                    {time && <span className="shrink-0 text-[10px] tabular-nums text-[var(--muted-foreground)]">{time}</span>}
                  </div>;
                }) : <p className="px-0.5 py-1 text-xs text-[var(--muted-foreground)]">当天没有笔记</p>}
              </div>
            </PopoverContent>
          </Popover>;
        })}
      </div>
    </div>
    {draggingRecord && typeof document !== 'undefined' && createPortal(
      <div ref={floatingCardRef} data-calendar-floating-preview aria-hidden="true" className="multidimensional-table__calendar-card pointer-events-none fixed z-[1000] flex w-[220px] items-center justify-between gap-2 overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--brand)_25%,var(--border))] bg-[var(--card)] px-1 py-1 shadow-lg" style={{ left: pointerPositionRef.current.x + 14, top: pointerPositionRef.current.y + 14 }}>
        <span className="min-w-0 truncate text-xs text-[var(--foreground)]">{renderValue(draggingRecord, titleField)}</span>
        {formatCalendarTime(dateValueForRecord?.(draggingRecord)) && <span className="shrink-0 text-[11px] tabular-nums text-[var(--muted-foreground)]">{formatCalendarTime(dateValueForRecord?.(draggingRecord))}</span>}
      </div>, document.body)}
  </div>;
}
