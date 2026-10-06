'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { FileText, GripVertical, SwatchBook, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { orderNoteTemplates, saveNoteTemplateOrder } from '@/lib/note-template-order';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { notes, type NoteTemplate } from '@platform/tauri/client';
import { Button } from '@shared/ui/button';

function moveTemplate(
  templates: NoteTemplate[],
  sourceId: string,
  targetId: string,
  insertAfter: boolean,
): NoteTemplate[] | null {
  const sourceIndex = templates.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0 || sourceId === targetId || !templates.some((item) => item.id === targetId)) return null;
  const next = [...templates];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return null;
  let insertIndex = next.findIndex((item) => item.id === targetId);
  if (insertAfter) insertIndex += 1;
  next.splice(insertIndex, 0, moved);
  return next;
}

export function TemplatesSection() {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draggedTemplateId, setDraggedTemplateId] = useState<string | null>(null);
  const [dragOverTemplate, setDragOverTemplate] = useState<{ id: string; insertAfter: boolean } | null>(null);
  const dragSessionRef = useRef<{
    templateId: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const templateListRef = useRef<HTMLDivElement | null>(null);
  const previousRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const dragOverTemplateRef = useRef<{ id: string; insertAfter: boolean } | null>(null);
  const visibleTemplates = (() => {
    if (!draggedTemplateId || !dragOverTemplate) return templates;
    return moveTemplate(templates, draggedTemplateId, dragOverTemplate.id, dragOverTemplate.insertAfter) ?? templates;
  })();

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(orderNoteTemplates(await notes.listTemplates()));
    } catch (error) {
      console.warn('[TemplatesSection] listTemplates failed:', error);
      toast.error(t('preferences.templates.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const captureTemplatePositions = () => {
    const rows = templateListRef.current?.querySelectorAll<HTMLElement>('[data-note-template-id]');
    previousRectsRef.current = new Map(
      [...(rows ?? [])].map((row) => [row.dataset.noteTemplateId ?? '', row.getBoundingClientRect()]),
    );
  };

  const setDropPreview = (target: { id: string; insertAfter: boolean } | null) => {
    const current = dragOverTemplateRef.current;
    if (current?.id === target?.id && current?.insertAfter === target?.insertAfter) return;
    captureTemplatePositions();
    dragOverTemplateRef.current = target;
    setDragOverTemplate(target);
  };

  useLayoutEffect(() => {
    const previousRects = previousRectsRef.current;
    previousRectsRef.current = null;
    if (!previousRects || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const rows = templateListRef.current?.querySelectorAll<HTMLElement>('[data-note-template-id]');
    rows?.forEach((row) => {
      const id = row.dataset.noteTemplateId;
      const previous = id ? previousRects.get(id) : null;
      if (!previous) return;
      const next = row.getBoundingClientRect();
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
      row.getAnimations().forEach((animation) => animation.cancel());
      row.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    });
  }, [dragOverTemplate, templates]);

  const handleDelete = async (template: NoteTemplate) => {
    const confirmed = window.confirm(
      t('preferences.templates.deleteConfirm').replace('{name}', template.name),
    );
    if (!confirmed) return;

    setDeletingId(template.id);
    try {
      const deleted = await notes.deleteTemplate(template.id);
      if (deleted) {
        const next = templates.filter((item) => item.id !== template.id);
        setTemplates(next);
        saveNoteTemplateOrder(next);
        toast.success(t('preferences.templates.deleteSuccess'));
      } else {
        toast.error(t('preferences.templates.notFound'));
        void loadTemplates();
      }
    } catch (error) {
      console.warn('[TemplatesSection] deleteTemplate failed:', error);
      toast.error(t('preferences.templates.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  const getTemplateDropTarget = (x: number, y: number, sourceId: string) => {
    const listBounds = templateListRef.current?.getBoundingClientRect();
    if (!listBounds || x < listBounds.left || x > listBounds.right || y < listBounds.top || y > listBounds.bottom) {
      return null;
    }
    const rows = [...(templateListRef.current?.querySelectorAll<HTMLElement>('[data-note-template-id]') ?? [])]
      .filter((row) => row.dataset.noteTemplateId !== sourceId);
    for (const row of rows) {
      const id = row.dataset.noteTemplateId;
      if (!id) continue;
      const bounds = row.getBoundingClientRect();
      if (y < bounds.top + bounds.height / 2) return { id, insertAfter: false };
    }
    const lastId = rows[rows.length - 1]?.dataset.noteTemplateId;
    return lastId ? { id: lastId, insertAfter: true } : null;
  };

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, templateId: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragSessionRef.current = {
      templateId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Window pointer listeners still finish the drag if capture is unavailable.
    }
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      if (!session.active) {
        if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 6) return;
        session.active = true;
        setDraggedTemplateId(session.templateId);
      }
      setDropPreview(getTemplateDropTarget(event.clientX, event.clientY, session.templateId));
    };

    const finishPointerDrag = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      const target = session.active
        ? getTemplateDropTarget(event.clientX, event.clientY, session.templateId)
        : null;
      dragSessionRef.current = null;
      if (target) {
        const next = moveTemplate(templates, session.templateId, target.id, target.insertAfter);
        if (next) {
          captureTemplatePositions();
          setTemplates(next);
          saveNoteTemplateOrder(next);
        }
      } else {
        captureTemplatePositions();
      }
      dragOverTemplateRef.current = null;
      setDraggedTemplateId(null);
      setDragOverTemplate(null);
    };

    const cancelPointerDrag = (event: PointerEvent) => {
      if (dragSessionRef.current?.pointerId !== event.pointerId) return;
      cancelActiveDrag();
    };

    const cancelActiveDrag = () => {
      if (!dragSessionRef.current) return;
      dragSessionRef.current = null;
      captureTemplatePositions();
      dragOverTemplateRef.current = null;
      setDraggedTemplateId(null);
      setDragOverTemplate(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishPointerDrag);
    window.addEventListener('pointercancel', cancelPointerDrag);
    window.addEventListener('lostpointercapture', cancelPointerDrag);
    window.addEventListener('blur', cancelActiveDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishPointerDrag);
      window.removeEventListener('pointercancel', cancelPointerDrag);
      window.removeEventListener('lostpointercapture', cancelPointerDrag);
      window.removeEventListener('blur', cancelActiveDrag);
    };
  }, [templates]);

  return (
    <div className="space-y-4">
      <SectionHeader title={t('preferences.templates.title')} />

      {loading ? (
        <div className="flex h-[100px] items-center justify-center text-center text-sm text-[var(--muted-foreground)]">
          {t('preferences.templates.loading')}
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileText className="mb-4 h-12 w-12 text-[var(--muted-foreground)]" />
          <p className="text-sm text-[var(--muted-foreground)]">{t('preferences.templates.empty')}</p>
        </div>
      ) : (
        <div ref={templateListRef} className="space-y-2">
          {visibleTemplates.map((template) => (
            <div
              key={template.id}
              data-note-template-id={template.id}
              className={`flex min-h-12 items-center gap-2 rounded-lg border bg-[var(--card)] px-2 py-2 transition-all ${
                dragOverTemplate?.id === template.id
                  ? 'border-[var(--brand)] bg-[var(--brand)]/5'
                  : 'border-[var(--border)]'
              } ${draggedTemplateId === template.id ? 'opacity-50' : ''}`}
            >
              <button
                type="button"
                title={t('preferences.templates.dragToReorder')}
                aria-label={`${t('preferences.templates.dragToReorder')} ${template.name}`}
                onPointerDown={(event) => onHandlePointerDown(event, template.id)}
                className="flex h-7 w-5 shrink-0 touch-none cursor-grab select-none items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--muted)] active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" aria-hidden="true" />
              </button>
              <SwatchBook className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--foreground)]">{template.name}</div>
                <div className="truncate text-xs text-[var(--muted-foreground)]">{template.id}</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                tooltip={t('preferences.templates.delete')}
                aria-label={`${t('preferences.templates.delete')} ${template.name}`}
                disabled={deletingId === template.id}
                onClick={() => void handleDelete(template)}
                className="text-[var(--muted-foreground)] hover:bg-transparent hover:text-[var(--destructive)]"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
