
import { DialogFooter } from '@shared/ui/dialog-footer';
import { Input } from '@shared/ui/input';
import { friendlyErrorMessage } from '@/lib/friendly-error-message';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Link2, LoaderCircle, Plus } from 'lucide-react';
import { ArrowSquareOutIcon, DotsThreeVerticalIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import { Button } from '@shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import documentCardPlaceholder from '@/assets/placeholder-document-card.jpg';
import { getPropertyIconOption } from '@features/document/properties/property-icons';
import { NotebookTreeFileIcon } from '@features/memo/components/notebook-tree-file-icon';
import type { TableField, TableRecord } from './model';
import type { TableNoteDropPreview, TableNoteDropRejection } from './table-note-drop';
import { TableNoteDropOverlay } from './table-note-drop-overlay';
import { useTableNoteDropTarget, type TableNoteDropTargetRejection } from './use-table-note-drop-target';
import { KANBAN_UNASSIGNED_GROUP_ID } from './view-index';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { formatUpdatedAgo } from '@/lib/collection-updated-time';
import { beginDragSession, cancelDragSession, endDragSession, moveDragSession, registerDropTarget, suppressTextSelectionForDrag } from '@shared/drag-drop/drag-drop-coordinator';
import type { DragPayload, DropPreview } from '@shared/drag-drop/drag-drop-coordinator';
import { isMarkdownNoteDragResource, type NotebookNoteDragResource } from '@features/memo/public/drag-resource-api';

type ValueRenderer = (record: TableRecord, field: TableField) => string;
type MoveRecord = (recordId: string, fieldId: string, value: string) => void;
type DropKanbanRecord = (recordId: string, groupId: string, beforeRecordId: string | null) => void | Promise<void>;
interface KanbanRecordDragResource { kind: 'kanban-record'; recordId: string }
type KanbanDragItem = NotebookNoteDragResource | KanbanRecordDragResource;
interface KanbanDropLocation { groupId: string; beforeRecordId: string | null }
interface GalleryDropLocation { beforeRecordId: string | null }

function isKanbanRecordDragResource(item: unknown): item is KanbanRecordDragResource {
  if (!item || typeof item !== 'object') return false;
  const resource = item as Partial<KanbanRecordDragResource>;
  return resource.kind === 'kanban-record' && typeof resource.recordId === 'string';
}

function calendarCardColorStyle(color?: string): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    '--multidimensional-table-calendar-card-background': `color-mix(in oklch, ${color} 20%, transparent)`,
    '--multidimensional-table-calendar-card-hover-background': `color-mix(in oklch, ${color} 30%, transparent)`,
  } as CSSProperties;
}

export function TableGalleryView({ records, titleField, fields, renderValue, imageUrl, noteThumbnail, onOpenRecord, onCreateBlankNote, onChooseData, recordStatus, noteIcon, canAddData = true, dropNotebookId, canDropExternal = false, previewExternalNoteDrop, nextRecordId, dropAreaRef, onExternalNoteDrop, pageScroll = false }: {
  records: TableRecord[];
  titleField: TableField;
  fields: TableField[];
  renderValue: ValueRenderer;
  imageUrl: (record: TableRecord, field: TableField) => string | null;
  noteThumbnail?: (record: TableRecord) => string | null;
  onOpenRecord: (record: TableRecord, anchorRect: DOMRect) => void;
  onCreateBlankNote?: () => void;
  onChooseData?: () => void;
  recordStatus?: (record: TableRecord) => 'draft' | 'linked' | 'unknown' | 'missing';
  noteIcon?: (record: TableRecord) => string | null;
  canAddData?: boolean;
  dropNotebookId?: string | null;
  canDropExternal?: boolean;
  previewExternalNoteDrop?: (notes: NotebookNoteDragResource[], beforeRecordId: string | null) => TableNoteDropPreview | TableNoteDropRejection;
  nextRecordId?: string | null;
  dropAreaRef?: { current: HTMLElement | null };
  onExternalNoteDrop?: (notes: NotebookNoteDragResource[], beforeRecordId: string | null) => void | Promise<void>;
  pageScroll?: boolean;
}) {
  const { t } = useI18n();
  const galleryId = useId();
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const [dropPreview, setDropPreview] = useState<TableNoteDropPreview | null>(null);
  const imageField = fields.find((field) => field.type === 'Image');

  useEffect(() => {
    if (!dropPreview) return;
    galleryRef.current?.querySelector<HTMLElement>('[data-gallery-preview]')?.scrollIntoView?.({ block: 'nearest' });
  }, [dropPreview]);

  const dropPositionAt = useCallback((x: number, y: number): GalleryDropLocation | null => {
    const root = galleryRef.current;
    if (!root) return null;
    const dropArea = dropAreaRef?.current ?? root;
    const rootBounds = dropArea.getBoundingClientRect();
    if (x < rootBounds.left || x > rootBounds.right || y < rootBounds.top || y > rootBounds.bottom) return null;
    const cards = [...root.querySelectorAll<HTMLElement>('[data-gallery-record]')]
      .filter((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > rootBounds.top && bounds.top < rootBounds.bottom
          && bounds.right > rootBounds.left && bounds.left < rootBounds.right;
      });
    if (!cards.length) return { beforeRecordId: nextRecordId ?? null };

    // DOM hit testing can land on a transparent overlay in embedded workspaces.
    // Use the gallery/card rectangles so drop detection is independent of the
    // element under the pointer and still works in the gaps between cards.
    const card = cards.reduce((nearest, candidate) => {
      const bounds = candidate.getBoundingClientRect();
      const nearestBounds = nearest.getBoundingClientRect();
      const distance = Math.hypot(x - (bounds.left + bounds.width / 2), y - (bounds.top + bounds.height / 2));
      const nearestDistance = Math.hypot(x - (nearestBounds.left + nearestBounds.width / 2), y - (nearestBounds.top + nearestBounds.height / 2));
      return distance < nearestDistance ? candidate : nearest;
    });
    const index = cards.indexOf(card);
    const bounds = card.getBoundingClientRect();
    const insertAfter = x >= bounds.left + bounds.width / 2;
    const neighboringId = cards[index + (insertAfter ? 1 : 0)]?.dataset.galleryRecord;
    if (neighboringId) return { beforeRecordId: neighboringId };
    const recordIndex = records.findIndex((record) => record.id === card.dataset.galleryRecord);
    return { beforeRecordId: (insertAfter ? records[recordIndex + 1]?.id : undefined) ?? nextRecordId ?? null };
  }, [dropAreaRef, nextRecordId, records]);

  const previewGalleryDrop = useCallback((notes: NotebookNoteDragResource[], location: GalleryDropLocation) => (
    previewExternalNoteDrop?.(notes, location.beforeRecordId) ?? { reason: 'unavailable' as const }
  ), [previewExternalNoteDrop]);
  const onGalleryDropPreview = useCallback((preview: TableNoteDropPreview | null) => {
    setDropPreview((current) => preview && current
      && current.records.length === preview.records.length
      && current.records.every((record, index) => record.id === preview.records[index].id)
      && current.draggedPaths.join('\0') === preview.draggedPaths.join('\0') ? current : preview);
  }, []);
  const onGalleryDropReject = useCallback((reason: TableNoteDropTargetRejection) => {
    if (reason === 'unsupported-resource' || reason === 'wrong-notebook' || reason === 'unavailable') {
      toast.warning(t('memo.fileTree.galleryDropUnsupported'));
    } else if (reason === 'read-only') {
      toast.warning(t('multidimensionalTable.galleryDropReadOnly'));
    } else if (reason === 'filtered') {
      toast.warning(t('multidimensionalTable.galleryDropFiltered'));
    }
  }, [t]);
  useTableNoteDropTarget({
    id: `gallery:${galleryId}`,
    active: true,
    notebookId: dropNotebookId ?? null,
    canDrop: canDropExternal,
    canHandleDrop: Boolean(previewExternalNoteDrop && onExternalNoteDrop),
    hitTest: ({ x, y }) => dropPositionAt(x, y),
    locationKey: ({ beforeRecordId }) => beforeRecordId ?? 'end',
    preview: previewGalleryDrop,
    onPreview: onGalleryDropPreview,
    onDrop: (notes, location) => onExternalNoteDrop?.(notes, location.beforeRecordId),
    onReject: onGalleryDropReject,
    onError: (error) => toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteMove')),
  });

  const renderedRecords = dropPreview?.records ?? records;

  return <div ref={galleryRef} className={`multidimensional-table__gallery relative flex-1 ${pageScroll ? 'px-12' : 'px-5'}`}>
    <div className="multidimensional-table__gallery-grid grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,160px),1fr))] items-stretch gap-3.5">
      {renderedRecords.length === 0 && (onCreateBlankNote || onChooseData) ? <div className="col-span-full flex min-h-10 items-center justify-start gap-2 text-sm text-[var(--muted-foreground)]">
        {onCreateBlankNote && <button
          type="button"
          disabled={!canAddData}
          onClick={onCreateBlankNote}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-left transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>添加笔记</span>
        </button>}
        {onChooseData && <button
          type="button"
          disabled={!canAddData}
          onClick={onChooseData}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-left transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Link2 className="h-4 w-4" aria-hidden="true" />
          <span>选择数据</span>
        </button>}
      </div> : (onCreateBlankNote || onChooseData) && <div className="flex h-[210px] min-w-0 flex-col overflow-hidden rounded-xl border border-dashed border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] bg-transparent text-sm text-[var(--muted-foreground)]">
        {onCreateBlankNote && <button
          type="button"
          disabled={!canAddData}
          onClick={onCreateBlankNote}
          className="flex min-h-0 flex-1 items-center justify-center gap-2 px-3 transition-colors hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>添加笔记</span>
        </button>}
        {onCreateBlankNote && onChooseData && <span aria-hidden="true" className="mx-3 h-px w-auto shrink-0 bg-[var(--border)]" />}
        {onChooseData && <button
          type="button"
          disabled={!canAddData}
          onClick={onChooseData}
          className="flex min-h-0 flex-1 items-center justify-center gap-2 px-3 transition-colors hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Link2 className="h-4 w-4" aria-hidden="true" />
          <span>选择数据</span>
        </button>}
      </div>}
      {renderedRecords.map((record) => {
        const cover = imageField ? imageUrl(record, imageField) : null;
        const notePreview = noteThumbnail?.(record) ?? null;
        const imageSources = [...new Set([notePreview, cover, documentCardPlaceholder].filter((source): source is string => Boolean(source)))];
        const missing = recordStatus?.(record) === 'missing';
        const iconValue = noteIcon?.(record);
        const icon = iconValue ? getPropertyIconOption(iconValue) : null;
        const isPreview = dropPreview?.draggedPaths.includes(record.note_path.replace(/\\/g, '/')) ?? false;
        return <button key={record.id} data-gallery-record={isPreview ? undefined : record.id} data-gallery-preview={isPreview ? 'true' : undefined} aria-hidden={isPreview || undefined} tabIndex={isPreview ? -1 : undefined} type="button" onClick={(event) => { if (!isPreview) onOpenRecord(record, event.currentTarget.getBoundingClientRect()); }} className={`group flex h-[210px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left transition-[background-color,border-color] hover:border-[color-mix(in_oklch,var(--border)_94%,var(--foreground)_6%)] hover:bg-[color-mix(in_oklch,var(--card)_98%,var(--foreground)_2%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${isPreview ? 'pointer-events-none opacity-50' : ''}`}>
          <span className="flex h-[148px] w-full shrink-0 items-center justify-center overflow-hidden border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_97%,var(--foreground)_3%)]">
            <img
              src={imageSources[0]}
              alt=""
              loading="lazy"
              data-source-index="0"
              className={`h-full w-full object-cover ${imageSources[0] === documentCardPlaceholder ? 'opacity-50' : ''}`}
              onError={(event) => {
                const image = event.currentTarget;
                const nextIndex = Number(image.dataset.sourceIndex ?? '0') + 1;
                const nextSource = imageSources[nextIndex];
                if (!nextSource) return;
                image.dataset.sourceIndex = String(nextIndex);
                image.src = nextSource;
                image.classList.toggle('opacity-50', nextSource === documentCardPlaceholder);
              }}
            />
          </span>
          <span className="flex h-[61px] min-w-0 px-2 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1">
                {icon
                  ? <img src={icon.src} alt="" aria-hidden="true" draggable={false} className="h-4 w-4 shrink-0 object-contain" />
                  : <NotebookTreeFileIcon className='h-4 w-4 shrink-0 text-[color-mix(in_oklch,var(--foreground)_70%,black_30%)] [[data-theme="dark"]_&]:text-[var(--foreground)] [[data-theme="mist"]_&]:text-[var(--foreground)]' />}
                <span className={`block min-w-0 truncate text-sm font-medium leading-5 ${missing ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'}`}>{renderValue(record, titleField)}</span>
              </span>
              <span className="mt-0.5 block truncate text-xs leading-4 text-[var(--muted-foreground)]">
                {formatUpdatedAgo(record.updated_at, t)}
              </span>
            </span>
          </span>
        </button>;
      })}
    </div>
    <TableNoteDropOverlay active={Boolean(dropPreview)} dropAreaRef={dropAreaRef ?? galleryRef} />
  </div>;
}

export function TableKanbanView({ groupField, titleField, records, groups, renderValue, recordStatus, noteIconForRecord, onDropRecord, onExternalNoteDrop, dropNotebookId, canDropExternal = false, onReorderLane, onAddTask, onAddLane, onOpenRecord, onRenameRecord, onDeleteRecord, canAddTask = true, canAddLane = true, embeddedInEditor = false, pageScroll = false }: {
  groupField: TableField;
  titleField: TableField;
  records?: TableRecord[];
  groups: ReadonlyMap<string, TableRecord[]>;
  renderValue: ValueRenderer;
  recordStatus?: (record: TableRecord) => 'draft' | 'linked' | 'unknown' | 'missing';
  noteIconForRecord?: (record: TableRecord) => string | null | undefined;
  onDropRecord: DropKanbanRecord;
  onExternalNoteDrop?: (notes: NotebookNoteDragResource[], groupId: string, beforeRecordId: string | null) => void | Promise<void>;
  dropNotebookId?: string | null;
  canDropExternal?: boolean;
  onReorderLane: (sourceOptionId: string, targetOptionId: string, insertAfter: boolean) => void;
  onAddTask?: (groupId: string) => void;
  onAddLane?: () => void;
  onOpenRecord?: (recordId: string) => void;
  onRenameRecord?: (recordId: string, title: string) => void | Promise<void>;
  onDeleteRecord?: (recordId: string) => void;
  canAddTask?: boolean;
  canAddLane?: boolean;
  embeddedInEditor?: boolean;
  pageScroll?: boolean;
}) {
  const { t } = useI18n();
  const [draggingRecordId, setDraggingRecordId] = useState<string | null>(null);
  const [editingRecord, setEditingRecord] = useState<TableRecord | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ groupId: string; beforeRecordId: string | null } | null>(null);
  const [draggingLaneId, setDraggingLaneId] = useState<string | null>(null);
  const [laneDropTarget, setLaneDropTarget] = useState<{ optionId: string; insertAfter: boolean } | null>(null);
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false);
  const [externalDropPreview, setExternalDropPreview] = useState<{ groupId: string; beforeRecordId: string | null; label: string } | null>(null);
  const kanbanBoardRef = useRef<HTMLDivElement | null>(null);
  const lanePointerDragRef = useRef<{ pointerId: number; optionId: string; startX: number; startY: number; active: boolean } | null>(null);
  const laneSelectionReleaseRef = useRef<(() => void) | null>(null);
  const pointerDragRef = useRef<{ pointerId: number; recordId: string; sessionId: string; startX: number; startY: number; active: boolean } | null>(null);
  useEffect(() => () => {
    const drag = pointerDragRef.current;
    if (drag?.active) cancelDragSession(drag.sessionId);
    laneSelectionReleaseRef.current?.();
    laneSelectionReleaseRef.current = null;
  }, []);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const floatingCardRef = useRef<HTMLElement | null>(null);
  const kanbanTargetId = useId();
  const externalDropConfigRef = useRef({ groupField, dropNotebookId, canDropExternal, onExternalNoteDrop, onDropRecord });
  externalDropConfigRef.current = { groupField, dropNotebookId, canDropExternal, onExternalNoteDrop, onDropRecord };
  const laneOptions = groupField.options ?? [];
  const allRecords = useMemo(() => records ?? [...new Map([...groups.values()].flat().map((record) => [record.id, record])).values()], [groups, records]);
  const assignedRecordIds = new Set(laneOptions.flatMap((option) => groups.get(option.id) ?? []).map((record) => record.id));
  const unassignedRecords = allRecords.filter((record) => !assignedRecordIds.has(record.id));
  // The dragged card stays mounted (dimmed) as its own origin placeholder; a
  // floating preview follows the cursor and a ghost shows the drop slot.
  const visibleUnassignedRecords = unassignedRecords;
  const draggedRecord = useMemo(() => draggingRecordId
    ? allRecords.find((record) => record.id === draggingRecordId) ?? null
    : null, [allRecords, draggingRecordId]);
  const showInsertionPreview = Boolean(draggedRecord && dropTarget);
  const renderRecordCard = (record: TableRecord) => {
    const status = recordStatus?.(record);
    const title = renderValue(record, titleField);
    const displayTitle = status === 'missing' ? title.replace(/^未找到笔记\s*/, '') : title;
    return <article key={record.id} data-kanban-record={record.id} onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      onCardPointerDown(event, record.id);
    }} className={`multidimensional-table__kanban-card relative cursor-default select-none touch-none rounded-lg border border-[var(--border)] px-2 py-2 active:cursor-grabbing ${draggingRecordId === record.id ? 'opacity-50' : ''}`}>
      <div className="flex min-w-0 items-center gap-2">
        <div className={`min-w-0 flex-1 text-sm font-medium leading-5 ${(onRenameRecord || onDeleteRecord) ? 'pr-7' : ''} ${status === 'missing' ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'}`}>
          {status === 'missing' && <span className="mr-1">未找到</span>}
          <TableRecordTitle record={record} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} label={displayTitle} titleClassName="min-w-0 break-words" />
        </div>
        {(onOpenRecord || onRenameRecord || onDeleteRecord) && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="更多卡片操作" title="更多" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} className="absolute right-0 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]">
              <DotsThreeVerticalIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-36 rounded-xl p-1">
            {onOpenRecord && <DropdownMenuItem disabled={status === 'draft' || status === 'unknown'} onClick={(event) => { event.stopPropagation(); onOpenRecord(record.id); }} className="!h-8 rounded-lg px-2 py-0">
              <ArrowSquareOutIcon className="mr-2 h-4 w-4" aria-hidden="true" />打开
            </DropdownMenuItem>}
            {onRenameRecord && <DropdownMenuItem disabled={status !== 'linked'} onClick={(event) => { event.stopPropagation(); setEditingTitle(title); setEditingRecord(record); }} className="!h-8 rounded-lg px-2 py-0">
              <PencilSimpleIcon className="mr-2 h-4 w-4" aria-hidden="true" />编辑
            </DropdownMenuItem>}
            {onDeleteRecord && <DropdownMenuItem onClick={(event) => { event.stopPropagation(); onDeleteRecord(record.id); }} className="!h-8 rounded-lg px-2 py-0 text-[var(--destructive)] focus:text-[var(--destructive)]">
              <TrashIcon className="mr-2 h-4 w-4" aria-hidden="true" />删除
            </DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
      {status === 'unknown' && <div className="mt-2 text-xs text-[var(--muted-foreground)]">无法确认关联状态</div>}
    </article>;
  };
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
    if (!lane || !kanbanBoardRef.current?.contains(lane) || !targetOptionId || targetOptionId === sourceOptionId) return null;
    const bounds = lane.getBoundingClientRect();
    return { optionId: targetOptionId, insertAfter: x >= bounds.left + bounds.width / 2 };
  };

  const dropLocationAt = useCallback((x: number, y: number): KanbanDropLocation | null => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const draggedRecordId = pointerDragRef.current?.active ? pointerDragRef.current.recordId : null;
    if (draggedRecordId && element?.closest<HTMLElement>('[data-kanban-record]')?.dataset.kanbanRecord === draggedRecordId) return null;
    const lane = element?.closest<HTMLElement>('[data-kanban-lane], [data-kanban-unassigned="true"]');
    const groupId = lane?.dataset.kanbanLane
      ?? (lane?.dataset.kanbanUnassigned === 'true' ? KANBAN_UNASSIGNED_GROUP_ID : null);
    if (!lane || !kanbanBoardRef.current?.contains(lane) || !groupId) return null;
    const beforeCard = [...lane.querySelectorAll<HTMLElement>('[data-kanban-record]')]
      .filter((card) => card.dataset.kanbanRecord !== draggedRecordId)
      .find((card) => {
        const bounds = card.getBoundingClientRect();
        return y < bounds.top + bounds.height / 2;
      });
    return { groupId, beforeRecordId: beforeCard?.dataset.kanbanRecord ?? null };
  }, []);

  useEffect(() => registerDropTarget<KanbanDragItem, KanbanDropLocation>({
    id: `kanban:${kanbanTargetId}`,
    priority: 100,
    hitTest: ({ x, y }) => dropLocationAt(x, y),
    locationKey: ({ groupId, beforeRecordId }) => `${groupId}:${beforeRecordId ?? ''}`,
    evaluate: (payload, location) => {
      const config = externalDropConfigRef.current;
      const records = payload.items.filter(isKanbanRecordDragResource);
      if (records.length === payload.items.length) {
        if (records.length !== 1) return { accepted: false, reason: 'unsupported-resource' };
        // 内部卡片移动只取决于“能否落盘”——canDropExternal 管的是外部笔记拖入，
        // 用它拦内部拖拽会让传了 onDropRecord 的看板变成整块只读。
        if (!config.onDropRecord) return { accepted: false, reason: 'read-only' };
        if (location.groupId !== KANBAN_UNASSIGNED_GROUP_ID
          && (!config.groupField.options?.some((option) => option.id === location.groupId) || !config.groupField.property_key)) {
          return { accepted: false, reason: 'unavailable' };
        }
        return { accepted: true };
      }
      const notes = payload.items.filter(isMarkdownNoteDragResource);
      if (notes.length === 0 || notes.length !== payload.items.length) {
        return { accepted: false, reason: 'unsupported-resource' };
      }
      if (!config.dropNotebookId || notes.some((note) => note.notebookId !== config.dropNotebookId)) {
        return { accepted: false, reason: 'wrong-notebook' };
      }
      if (!config.canDropExternal) return { accepted: false, reason: 'read-only' };
      if (location.groupId !== KANBAN_UNASSIGNED_GROUP_ID
        && (!config.groupField.options?.some((option) => option.id === location.groupId) || !config.groupField.property_key)) {
        return { accepted: false, reason: 'unavailable' };
      }
      if (!config.onExternalNoteDrop) return { accepted: false, reason: 'unavailable' };
      return { accepted: true };
    },
    onPreview: (preview: DropPreview<KanbanDragItem, KanbanDropLocation> | null) => {
      if (!preview?.decision.accepted) {
        setExternalDropPreview(null);
        setDropTarget(null);
        if (!pointerDragRef.current?.active) setDraggingRecordId(null);
        return;
      }
      const records = preview.payload.items.filter(isKanbanRecordDragResource);
      if (records.length === 1 && records.length === preview.payload.items.length) {
        setExternalDropPreview(null);
        setDraggingRecordId(records[0].recordId);
        setDropTarget(preview.location);
        return;
      }
      const notes = preview.payload.items.filter(isMarkdownNoteDragResource);
      const next = {
        groupId: preview.location.groupId,
        beforeRecordId: preview.location.beforeRecordId,
        label: notes.length === 1 ? notes[0].title : `${notes.length} 篇笔记`,
      };
      setDraggingRecordId(null);
      setDropTarget(null);
      setExternalDropPreview((current) => current?.groupId === next.groupId
        && current?.beforeRecordId === next.beforeRecordId && current?.label === next.label ? current : next);
    },
    onDrop: (payload, location) => {
      const records = payload.items.filter(isKanbanRecordDragResource);
      if (records.length === 1 && records.length === payload.items.length) {
        return externalDropConfigRef.current.onDropRecord?.(records[0].recordId, location.groupId, location.beforeRecordId);
      }
      return externalDropConfigRef.current.onExternalNoteDrop?.(
        payload.items.filter(isMarkdownNoteDragResource), location.groupId, location.beforeRecordId,
      );
    },
    onReject: (_payload, _groupId, reason) => {
      if (reason === 'unsupported-resource' || reason === 'wrong-notebook') {
        toast.warning(t('memo.fileTree.kanbanDropUnsupported'));
      } else if (reason === 'read-only') {
        toast.warning(t('multidimensionalTable.kanbanDropReadOnly'));
      } else if (reason === 'unavailable') {
        toast.warning(t('multidimensionalTable.kanbanDropUnavailable'));
      }
    },
    onError: (error) => toast.error(friendlyErrorMessage(error, t, 'errors.friendly.noteMove')),
  }), [dropLocationAt, kanbanTargetId, t]);

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
      laneSelectionReleaseRef.current = suppressTextSelectionForDrag();
      setDraggingLaneId(drag.optionId);
    }
    const target = laneTargetAt(event.clientX, event.clientY, drag.optionId);
    if (target) setLaneDropTarget(target);
  };

  const onLanePointerUp = (event: PointerEvent<HTMLElement>) => {
    const drag = lanePointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) {
      const hoveredLane = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)
        ?.closest<HTMLElement>('[data-kanban-lane]');
      const hoveredLaneId = hoveredLane && kanbanBoardRef.current?.contains(hoveredLane)
        ? hoveredLane.dataset.kanbanLane
        : undefined;
      const target = laneTargetAt(event.clientX, event.clientY, drag.optionId)
        ?? (hoveredLaneId === drag.optionId ? laneDropTarget : null);
      if (target) onReorderLane(drag.optionId, target.optionId, target.insertAfter);
    }
    lanePointerDragRef.current = null;
    setDraggingLaneId(null);
    setLaneDropTarget(null);
    laneSelectionReleaseRef.current?.();
    laneSelectionReleaseRef.current = null;
  };

  const onLanePointerCancel = () => {
    lanePointerDragRef.current = null;
    setDraggingLaneId(null);
    setLaneDropTarget(null);
    laneSelectionReleaseRef.current?.();
    laneSelectionReleaseRef.current = null;
  };

  const resetDrag = () => {
    pointerDragRef.current = null;
    setDraggingRecordId(null);
    setDropTarget(null);
  };

  const cancelKanbanDrag = () => {
    const drag = pointerDragRef.current;
    if (drag?.active) cancelDragSession(drag.sessionId);
    else resetDrag();
  };

  const onCardPointerDown = (event: PointerEvent<HTMLElement>, recordId: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerDragRef.current = { pointerId: event.pointerId, recordId, sessionId: crypto.randomUUID(), startX: event.clientX, startY: event.clientY, active: false };
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
      beginDragSession({
        sessionId: drag.sessionId,
        sourceId: `kanban:${kanbanTargetId}`,
        items: [{ kind: 'kanban-record', recordId: drag.recordId }],
      }, { x: event.clientX, y: event.clientY }, resetDrag);
    }
    moveDragSession(drag.sessionId, { x: event.clientX, y: event.clientY });
  };

  const onCardPointerUp = (event: PointerEvent<HTMLElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) {
      endDragSession(drag.sessionId, { x: event.clientX, y: event.clientY });
      resetDrag();
      return;
    }
    const record = allRecords.find((item) => item.id === drag.recordId);
    resetDrag();
    if (record && (recordStatus?.(record) === 'linked' || recordStatus?.(record) === 'missing')) onOpenRecord?.(drag.recordId);
  };

  return <div ref={kanbanBoardRef} onPointerMove={onCardPointerMove} onPointerUp={onCardPointerUp} onPointerCancel={cancelKanbanDrag} className="flex min-h-0 flex-1 flex-col">
    <div className={`multidimensional-table__kanban-lanes flex w-max items-stretch gap-3 ${pageScroll ? 'px-12 py-1' : embeddedInEditor ? 'px-5 py-3' : 'px-4 py-1'}`}>
      <section data-kanban-unassigned="true" className={`multidimensional-table__kanban-lane flex shrink-0 flex-col rounded-xl border border-[var(--border)] ${unassignedCollapsed ? 'w-10 min-w-10 max-w-10' : 'w-64'}`}>
        <header className={`flex min-h-10 items-center gap-3 ${unassignedCollapsed ? 'w-full min-w-0 flex-col px-1.5 pt-3 pb-1.5' : 'justify-between px-3.5 pt-3.5 pb-1.5'}`}>
          {unassignedCollapsed ? <>
            <button type="button" aria-label="展开未分配泳道" title="展开未分配泳道" aria-expanded="false" onClick={() => setUnassignedCollapsed(false)} className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
            <span className="max-w-full break-all text-center text-xs text-[var(--muted-foreground)]">{unassignedRecords.length}</span>
          </> : <>
            <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--foreground)]">未分配</h2>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-xs text-[var(--muted-foreground)]">{unassignedRecords.length}</span>
              {onAddTask && <button type="button" aria-label="在未分配中添加任务" title="添加任务" disabled={!canAddTask} onClick={() => onAddTask(KANBAN_UNASSIGNED_GROUP_ID)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-40"><Plus className="h-4 w-4" aria-hidden="true" /></button>}
              <button type="button" aria-label="折叠未分配泳道" title="折叠未分配泳道" aria-expanded="true" onClick={() => setUnassignedCollapsed(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
            </div>
          </>}
        </header>
        {!unassignedCollapsed && <div className="multidimensional-table__kanban-lane-content min-h-0 overflow-y-auto flex flex-col gap-2 px-2.5 pt-[5px] pb-4">
          {visibleUnassignedRecords.map((record) => <Fragment key={record.id}>
            {externalDropPreview?.groupId === KANBAN_UNASSIGNED_GROUP_ID && externalDropPreview.beforeRecordId === record.id && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-2 py-2 opacity-50">
              <div className="min-w-0 break-words text-sm font-medium leading-5 text-[var(--foreground)]">{externalDropPreview.label}</div>
            </article>}
            {renderRecordCard(record)}
          </Fragment>)}
          {externalDropPreview?.groupId === KANBAN_UNASSIGNED_GROUP_ID && externalDropPreview.beforeRecordId === null && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-2 py-2 opacity-50">
            <div className="min-w-0 break-words text-sm font-medium leading-5 text-[var(--foreground)]">{externalDropPreview.label}</div>
          </article>}
          {unassignedRecords.length === 0 && externalDropPreview?.groupId !== KANBAN_UNASSIGNED_GROUP_ID && <div className="multidimensional-table__kanban-empty pointer-events-none flex min-h-24 select-none items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-4 text-center text-xs text-[var(--muted-foreground)]">无未分配数据</div>}
        </div>}
      </section>
      {previewLaneOptions.map((option) => {
        const group = groups.get(option.id) ?? [];
        const visibleGroup = group;
        const showEndPreview = showInsertionPreview && dropTarget?.groupId === option.id && dropTarget.beforeRecordId === null;
        return <section key={option.id} data-kanban-lane={option.id} className={`multidimensional-table__kanban-lane flex w-64 shrink-0 flex-col rounded-xl border border-[var(--border)] transition-opacity ${draggingLaneId === option.id ? 'opacity-50' : ''}`}>
          <header title="拖动调整泳道顺序" className="flex min-h-10 touch-none select-none cursor-grab items-center justify-between gap-3 px-3.5 pt-3.5 pb-1.5 active:cursor-grabbing" onPointerDown={(event) => onLanePointerDown(event, option.id)} onPointerMove={onLanePointerMove} onPointerUp={onLanePointerUp} onPointerCancel={onLanePointerCancel}>
            <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--foreground)]">{option.label}</h2>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-xs font-normal text-[var(--muted-foreground)]">{group.length}</span>
              {onAddTask && <button type="button" aria-label={`在${option.label}中添加任务`} title="添加任务" disabled={!canAddTask} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onAddTask(option.id); }} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)] disabled:opacity-40"><Plus className="h-4 w-4" aria-hidden="true" /></button>}
            </div>
          </header>
          <div className="multidimensional-table__kanban-lane-content min-h-0 overflow-y-auto flex flex-col gap-2 px-2.5 pt-[5px] pb-4">
            {visibleGroup.map((record) => <Fragment key={record.id}>
                {externalDropPreview?.groupId === option.id && externalDropPreview.beforeRecordId === record.id && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-2 py-2 opacity-50">
                  <div className="min-w-0 break-words text-sm font-medium leading-5 text-[var(--foreground)]">{externalDropPreview.label}</div>
                </article>}
                {showInsertionPreview && draggedRecord && dropTarget?.groupId === option.id && dropTarget.beforeRecordId === record.id && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-2 py-2 opacity-50">
                  <TableRecordTitle record={draggedRecord} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} titleClassName="min-w-0 break-words" className="text-sm font-medium leading-5 text-[var(--foreground)]" />
                </article>}
                {renderRecordCard(record)}
              </Fragment>)}
            {showEndPreview && draggedRecord && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-2 py-2 opacity-50">
              <TableRecordTitle record={draggedRecord} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} titleClassName="min-w-0 break-words" className="text-sm font-medium leading-5 text-[var(--foreground)]" />
            </article>}
            {externalDropPreview?.groupId === option.id && externalDropPreview.beforeRecordId === null && <article aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none rounded-lg border border-[var(--border)] px-2 py-2 opacity-50">
              <div className="min-w-0 break-words text-sm font-medium leading-5 text-[var(--foreground)]">{externalDropPreview.label}</div>
            </article>}
            {visibleGroup.length === 0 && !showEndPreview && externalDropPreview?.groupId !== option.id && <div className="multidimensional-table__kanban-empty pointer-events-none flex min-h-24 select-none items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-4 text-center text-xs text-[var(--muted-foreground)]">拖动记录到此处</div>}
          </div>
        </section>;
      })}
      {onAddLane && <div className="flex min-h-10 w-10 shrink-0 flex-col items-center rounded-xl border border-dashed border-[var(--border)]">
        <button
        type="button"
        aria-label="新增看板列"
        title="新增列"
        disabled={!canAddLane}
        onClick={onAddLane}
        className="mt-3 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-40"
      ><Plus className="h-4 w-4" aria-hidden="true" /></button>
      </div>}
    </div>
    {draggedRecord && typeof document !== 'undefined' && createPortal(
      <article ref={floatingCardRef} data-kanban-floating-preview aria-hidden="true" className="multidimensional-table__kanban-card pointer-events-none fixed z-[1000] w-[252px] select-none rounded-lg border border-[var(--border)] px-2 py-2 shadow-lg" style={{ left: pointerPositionRef.current.x + 14, top: pointerPositionRef.current.y + 14 }}>
        <TableRecordTitle record={draggedRecord} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} titleClassName="min-w-0 break-words" className="text-sm font-medium leading-5 text-[var(--foreground)]" />
      </article>, document.body)}
    <Dialog open={Boolean(editingRecord)} onOpenChange={(open) => { if (!open && !savingEdit) setEditingRecord(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>编辑任务</DialogTitle></DialogHeader>
        <form onSubmit={async (event) => {
          event.preventDefault();
          const title = editingTitle.trim();
          if (!editingRecord || !title || !onRenameRecord || savingEdit) return;
          setSavingEdit(true);
          try {
            await onRenameRecord(editingRecord.id, title);
            setEditingRecord(null);
          } finally {
            setSavingEdit(false);
          }
        }}>
          <Input autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} disabled={savingEdit} aria-label="任务名称" />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={savingEdit} onClick={() => setEditingRecord(null)}>取消</Button>
            <Button type="submit" disabled={!editingTitle.trim() || savingEdit}>
              {savingEdit && <LoaderCircle className="mr-1.5 h-4 w-4 flowix-spin" aria-hidden="true" />}
              {savingEdit ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}

function TableRecordTitle({ record, titleField, renderValue, noteIconForRecord, className = '', titleClassName = 'min-w-0 truncate', label }: {
  record: TableRecord;
  titleField: TableField;
  renderValue: ValueRenderer;
  noteIconForRecord?: (record: TableRecord) => string | null | undefined;
  className?: string;
  titleClassName?: string;
  label?: string;
}) {
  const iconValue = noteIconForRecord?.(record);
  const icon = iconValue ? getPropertyIconOption(iconValue) : null;
  return <span className={`flex min-w-0 items-center gap-1 ${className}`}>
    {icon && <img src={icon.src} alt="" aria-hidden="true" draggable={false} className="h-4 w-4 shrink-0 object-contain" />}
    <span className={titleClassName}>{label ?? renderValue(record, titleField)}</span>
  </span>;
}

export function TableCalendarView({ cursor, onCursorChange, days, groups, dateFieldId, dateFieldLabel = '', dateFieldOptions = [], embeddedInEditor = false, onDateFieldChange, onCustomDateField, titleField, renderValue, dateValueForRecord, noteColorForRecord, noteIconForRecord, weekStart = 0, onWeekStartChange, onMoveRecord, onOpenRecord, onEditRecord, canMoveRecords = true, dateFieldReadOnly = !canMoveRecords, dateFieldReadOnlyReason = '当前日期字段为只读状态', onDoubleClickDate, addingNoteDate, dropNotebookId, onExternalNoteDrop, pageScroll = false }: {
  cursor: Date;
  onCursorChange: (date: Date) => void;
  days: Array<{ date: Date; iso: string; inMonth: boolean }>;
  groups: ReadonlyMap<string, TableRecord[]>;
  dateFieldId: string;
  dateFieldLabel?: string;
  dateFieldOptions?: Array<{ id: string; label: string; readOnly?: boolean }>;
  embeddedInEditor?: boolean;
  pageScroll?: boolean;
  onDateFieldChange?: (fieldId: string) => void | Promise<void>;
  onCustomDateField?: () => void;
  titleField: TableField;
  renderValue: ValueRenderer;
  dateValueForRecord?: (record: TableRecord) => unknown;
  noteColorForRecord?: (record: TableRecord) => string | undefined;
  noteIconForRecord?: (record: TableRecord) => string | null | undefined;
  weekStart?: 0 | 1;
  onWeekStartChange?: (weekStart: 0 | 1) => void | Promise<void>;
  onMoveRecord: MoveRecord;
  onOpenRecord?: (recordId: string) => void;
  onEditRecord?: (recordId: string, anchorRect: DOMRect) => void;
  canMoveRecords?: boolean;
  dateFieldReadOnly?: boolean;
  dateFieldReadOnlyReason?: string;
  onDoubleClickDate?: (date: string, anchorRect: DOMRect) => void;
  addingNoteDate?: string | null;
  dropNotebookId?: string | null;
  onExternalNoteDrop?: (notes: NotebookNoteDragResource[], date: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [weekStartMenuOpen, setWeekStartMenuOpen] = useState(false);
  const weekdayLabels = weekStart === 1
    ? ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
    : ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const previewLimit = days.length >= 42 ? 1 : days.length >= 35 ? 2 : 3;
  const [draggingRecord, setDraggingRecord] = useState<TableRecord | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [externalDropPreview, setExternalDropPreview] = useState<{ date: string; label: string } | null>(null);
  const calendarTargetId = useId();
  const externalDropConfigRef = useRef({ dropNotebookId, canMoveRecords, onExternalNoteDrop, dateFieldReadOnlyReason });
  externalDropConfigRef.current = { dropNotebookId, canMoveRecords, onExternalNoteDrop, dateFieldReadOnlyReason };
  const calendarRef = useRef<HTMLDivElement | null>(null);
  const floatingCardRef = useRef<HTMLDivElement | null>(null);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const selectionReleaseRef = useRef<(() => void) | null>(null);
  const pointerDragRef = useRef<{ pointerId: number; record: TableRecord; sourceDate: string; startX: number; startY: number; active: boolean } | null>(null);
  useEffect(() => () => {
    selectionReleaseRef.current?.();
    selectionReleaseRef.current = null;
  }, []);

  const onCellDoubleClick = (event: MouseEvent<HTMLDivElement>, date: string) => {
    const interactiveTarget = (event.target as HTMLElement).closest('[data-calendar-record], button, a, input, textarea, [contenteditable="true"]');
    // An embedded calendar has an editable editor ancestor outside the cell.
    // Only controls inside this cell should suppress its date action.
    if (interactiveTarget && event.currentTarget.contains(interactiveTarget)) return;
    onDoubleClickDate?.(date, event.currentTarget.getBoundingClientRect());
  };

  const dateAt = useCallback((x: number, y: number): string | null => {
    const cell = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-calendar-date]');
    return cell && calendarRef.current?.contains(cell) ? cell.dataset.calendarDate ?? null : null;
  }, []);

  useEffect(() => {
    const noteResources = (payload: DragPayload<unknown>) => payload.items.filter(isMarkdownNoteDragResource);
    return registerDropTarget<unknown, string>({
      id: `calendar:${calendarTargetId}`,
      priority: 100,
      hitTest: (point) => dateAt(point.x, point.y),
      locationKey: (date) => date,
      evaluate: (payload) => {
        const config = externalDropConfigRef.current;
        const notes = noteResources(payload);
        if (notes.length !== payload.items.length || notes.length === 0) {
          return { accepted: false, reason: 'unsupported-resource' };
        }
        if (!config.dropNotebookId || notes.some((note) => note.notebookId !== config.dropNotebookId)) {
          return { accepted: false, reason: 'wrong-notebook' };
        }
        if (!config.canMoveRecords) return { accepted: false, reason: 'read-only' };
        if (!config.onExternalNoteDrop) return { accepted: false, reason: 'unavailable' };
        return { accepted: true };
      },
      onPreview: (preview) => {
        if (!preview?.decision.accepted) {
          setExternalDropPreview(null);
          return;
        }
        const notes = noteResources(preview.payload);
        const next = {
          date: preview.location,
          label: notes.length === 1 ? notes[0].title : `${notes.length} 篇笔记`,
        };
        setExternalDropPreview((current) => current?.date === next.date && current?.label === next.label ? current : next);
      },
      onDrop: (payload, date) => externalDropConfigRef.current.onExternalNoteDrop?.(noteResources(payload), date),
      onReject: (_payload, _date, reason) => {
        const config = externalDropConfigRef.current;
        if (reason === 'unsupported-resource' || reason === 'wrong-notebook') {
          toast.warning(t('memo.fileTree.calendarDropUnsupported'));
        } else if (reason === 'read-only') {
          toast.warning(config.dateFieldReadOnlyReason || '当前日期字段只读，无法加入日历');
        } else if (reason === 'unavailable') {
          toast.warning(t('memo.fileTree.calendarDropUnsupported'));
        }
      },
      onError: (error) => toast.error(friendlyErrorMessage(error, t, 'errors.friendly.tableLink')),
    });
  }, [calendarTargetId, dateAt, t]);

  const resetDrag = () => {
    pointerDragRef.current = null;
    setDraggingRecord(null);
    setDropDate(null);
    selectionReleaseRef.current?.();
    selectionReleaseRef.current = null;
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
      selectionReleaseRef.current = suppressTextSelectionForDrag();
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
    } else {
      if (onEditRecord) onEditRecord(drag.record.id, event.currentTarget.getBoundingClientRect());
      else onOpenRecord?.(drag.record.id);
    }
    resetDrag();
  };

  return <div ref={calendarRef} className={`multidimensional-table__calendar mx-0 flex min-h-0 flex-1 flex-col pt-0 ${pageScroll ? 'px-12' : embeddedInEditor ? '' : 'px-4'}`}>
    <header className="flex shrink-0 items-center justify-between pb-1">
      <div className="flex min-w-0 items-center gap-2">
          <DropdownMenu onOpenChange={(open) => { if (!open) setWeekStartMenuOpen(false); }}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="更多日历选项" title="更多" className="flex h-7 items-center gap-1 rounded-md text-sm font-semibold text-[var(--foreground)]">
                <span>{cursor.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}</span>
                <ChevronDown className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-[168px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              <div className="relative">
                <button type="button" aria-expanded={weekStartMenuOpen} disabled={!onWeekStartChange} onClick={() => setWeekStartMenuOpen((open) => !open)} className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover-bg)] disabled:opacity-50">
                  周开始<ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" aria-hidden="true" />
                </button>
                {weekStartMenuOpen && <div className="absolute right-full top-0 z-[151] mr-1 w-[120px] rounded-xl border border-[var(--border-popup)] bg-[var(--card)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                  <DropdownMenuItem disabled={!onWeekStartChange} onClick={() => { void onWeekStartChange?.(1); }} className="!h-8 rounded-lg px-2 py-0 hover:bg-[var(--hover-bg)]">
                    周一{weekStart === 1 && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!onWeekStartChange} onClick={() => { void onWeekStartChange?.(0); }} className="!h-8 rounded-lg px-2 py-0 hover:bg-[var(--hover-bg)]">
                    周日{weekStart === 0 && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
                  </DropdownMenuItem>
                </div>}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="选择日期字段" title={dateFieldLabel} disabled={!onDateFieldChange} className="flex h-7 max-w-48 items-center gap-1 rounded-md px-1 text-sm font-medium text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] data-[state=open]:bg-transparent disabled:cursor-default disabled:hover:bg-transparent">
                <span className="truncate">{dateFieldLabel}</span>
                {dateFieldReadOnly && <span title={dateFieldReadOnlyReason} className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--muted)] px-1 py-0 text-xs leading-4 font-normal text-[var(--muted-foreground)]">只读</span>}
                <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="max-h-72 w-48 overflow-y-auto rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
              {dateFieldOptions.map((field) => <DropdownMenuItem key={field.id} onClick={() => { if (field.id !== dateFieldId) void onDateFieldChange?.(field.id); }} className="!h-8 justify-start gap-1 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)]">
                <span className="min-w-0 truncate">{field.label}</span>
                {field.readOnly && <span title="创建时间和更新时间由系统维护，不能通过拖动修改" className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--muted)] px-1 py-0 text-xs leading-4 font-normal text-[var(--muted-foreground)]">只读</span>}
                {field.id === dateFieldId && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
              </DropdownMenuItem>)}
              {onCustomDateField && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onCustomDateField} className="!h-8 justify-start rounded-lg px-2 py-0 text-left text-[var(--brand)] hover:bg-[var(--hover-bg)]">自定义日期字段</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="上个月" onClick={() => onCursorChange(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => onCursorChange(new Date())} className="h-7 px-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]">今天</button>
          <button type="button" aria-label="下个月" onClick={() => onCursorChange(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-y border-[var(--border)] shadow-none">
      <div className="grid grid-cols-7 border-b border-[var(--border)] text-center text-sm text-[var(--muted-foreground)]">{weekdayLabels.map((day, index) => <div key={`${day}-${index}`} className="border-r border-[var(--border)] py-2 last:border-r-0">{day}</div>)}</div>
      <div className="grid min-h-0 flex-1 grid-cols-7" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(var(--multidimensional-table-calendar-day-row-min-height, 0px), 1fr))` }}>
        {days.map(({ date, iso, inMonth }, index) => {
          const lastColumn = index % 7 === 6;
          const lastRow = index >= days.length - 7;
          const isWeekend = date.getDay() === 0 || date.getDay() === 6;
          const isToday = iso === todayIso;
          const cellBorders = `${lastRow ? '' : 'border-b'} ${lastColumn ? '' : 'border-r'} border-[var(--border)]`;
          const records = groups.get(iso) ?? [];
          const hasHiddenRecords = records.length > previewLimit;
          return <Popover key={iso} cellPopup>
            <div data-flowix-cell-anchor data-calendar-date={iso} data-calendar-drop-target={dropDate === iso || externalDropPreview?.date === iso ? 'true' : undefined} onDoubleClick={(event) => onCellDoubleClick(event, iso)} style={dropDate === iso || externalDropPreview?.date === iso ? { backgroundColor: 'var(--multidimensional-table-calendar-drop-bg)' } : addingNoteDate === iso ? { backgroundColor: 'var(--multidimensional-table-calendar-active-bg)' } : isToday ? { backgroundColor: 'var(--multidimensional-table-calendar-today-bg)' } : isWeekend ? { backgroundColor: 'var(--multidimensional-table-calendar-weekend-bg)' } : undefined} className={`relative flex h-full min-h-0 w-full flex-col overflow-hidden p-1.5 text-left ${cellBorders} ${inMonth ? '' : 'text-[var(--muted-foreground)]'} ${dropDate === iso || externalDropPreview?.date === iso ? 'multidimensional-table__calendar-drop-target' : ''}`}>
                <div className={`absolute left-1.5 top-1.5 text-sm ${inMonth ? '' : 'opacity-50'}`}>{date.getDate()}</div>
                <div className="mt-6 flex min-h-0 flex-col gap-1 overflow-hidden">
              {externalDropPreview?.date === iso && <div aria-hidden="true" className="multidimensional-table__calendar-card pointer-events-none flex h-6 items-center overflow-hidden rounded-md border-0 px-1 py-0 opacity-70">
                <span className="min-w-0 truncate text-xs text-[var(--foreground)]">{externalDropPreview.label}</span>
              </div>}
              {dropDate === iso && draggingRecord && <div aria-hidden="true" style={calendarCardColorStyle(noteColorForRecord?.(draggingRecord))} className="multidimensional-table__calendar-card pointer-events-none flex h-6 items-center overflow-hidden rounded-md border-0 px-1 py-0 opacity-50">
                <TableRecordTitle record={draggingRecord} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} className="text-xs text-[var(--foreground)]" />
              </div>}
              {records.slice(0, previewLimit).map((record) => {
                return <div key={record.id} data-calendar-record={record.id} onPointerDown={(event) => onCardPointerDown(event, record, iso)} onPointerMove={onCardPointerMove} onPointerUp={onCardPointerUp} onPointerCancel={resetDrag} onClick={(event) => { if (canMoveRecords) return; event.stopPropagation(); if (onEditRecord) onEditRecord(record.id, event.currentTarget.getBoundingClientRect()); else onOpenRecord?.(record.id); }} style={calendarCardColorStyle(noteColorForRecord?.(record))} className={`multidimensional-table__calendar-card flex h-6 cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-md border-0 px-1 py-0 text-[var(--brand)] ${canMoveRecords ? 'touch-none active:cursor-grabbing' : ''} ${draggingRecord?.id === record.id ? 'opacity-50' : ''}`} title={canMoveRecords ? renderValue(record, titleField) : '创建时间和更新时间不能通过拖动修改'}>
                  <TableRecordTitle record={record} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} className="text-xs font-normal text-[var(--foreground)]" />
                </div>;
              })}
              {hasHiddenRecords && <PopoverTrigger asChild anchorToCell>
                <button type="button" aria-label={`${date.toLocaleDateString()}，查看全部 ${records.length} 条笔记`} className="h-5 w-full shrink-0 truncate rounded bg-transparent px-1 text-right text-xs leading-5 text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--foreground)] active:bg-transparent data-[state=open]:bg-transparent">+ {records.length - previewLimit}</button>
              </PopoverTrigger>}
                </div>
            </div>
            <PopoverContent align="start" side="bottom" sideOffset={0} matchAnchorWidth={1.6} matchAnchorHeight className={`max-h-[min(60vh,360px)] max-w-[calc(100vw-16px)] overflow-y-auto p-1.5 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)] ${draggingRecord ? 'pointer-events-none' : ''}`}>
              <div className="space-y-1">
                {records.length ? records.map((record) => {
                  return <div key={record.id} data-calendar-record={record.id} onPointerDown={(event) => onCardPointerDown(event, record, iso)} onPointerMove={onCardPointerMove} onPointerUp={onCardPointerUp} onPointerCancel={resetDrag} onClick={(event) => { if (canMoveRecords) return; event.stopPropagation(); if (onEditRecord) onEditRecord(record.id, event.currentTarget.getBoundingClientRect()); else onOpenRecord?.(record.id); }} style={calendarCardColorStyle(noteColorForRecord?.(record))} className={`multidimensional-table__calendar-card flex h-6 min-w-0 cursor-pointer items-center justify-between gap-1 overflow-hidden rounded-md border-0 px-1 py-0 text-[var(--brand)] ${canMoveRecords ? 'touch-none active:cursor-grabbing' : ''} ${draggingRecord?.id === record.id ? 'opacity-50' : ''}`} title={canMoveRecords ? renderValue(record, titleField) : '创建时间和更新时间不能通过拖动修改'}>
                    <TableRecordTitle record={record} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} className="text-xs font-normal text-[var(--foreground)]" />
                  </div>;
                }) : <p className="px-0.5 py-1 text-xs text-[var(--muted-foreground)]">当天没有笔记</p>}
              </div>
            </PopoverContent>
          </Popover>;
        })}
      </div>
    </div>
    {draggingRecord && typeof document !== 'undefined' && createPortal(
      <div ref={floatingCardRef} data-calendar-floating-preview aria-hidden="true" className="multidimensional-table__calendar-card pointer-events-none fixed z-[1000] flex h-6 w-[220px] items-center justify-between gap-2 overflow-hidden rounded-md border-0 px-1 py-0 shadow-lg" style={{ ...calendarCardColorStyle(noteColorForRecord?.(draggingRecord)), left: pointerPositionRef.current.x + 14, top: pointerPositionRef.current.y + 14 }}>
        <TableRecordTitle record={draggingRecord} titleField={titleField} renderValue={renderValue} noteIconForRecord={noteIconForRecord} className="text-xs text-[var(--foreground)]" />
      </div>, document.body)}
  </div>;
}
