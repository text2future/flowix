import { SCROLLBAR_HIDE_DELAY_MS } from '@shared/lib/scrollbar-config';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useNoteStore } from '@features/memo/store/note-store';
import { clearCreatedDocumentNotices, useCreatedDocumentNotices } from './created-document-notices';
import { CreatedDocumentNoticeCard } from './created-document-notice-card';
import { NOTICE_PAGE_SIZE, useCreatedDocumentNoticeStack } from './use-created-document-notice-stack';

const COLLAPSE_DELAY_MS = 180;
/** A single card already carries its own dismiss button; bulk clear only earns its place past this count. */
const CLEAR_ACTION_MIN_NOTICES = 3;

export function CreatedDocumentNoticeHost() {
  const { t } = useI18n();
  const notices = useCreatedDocumentNotices((state) => state.notices);
  const notebooks = useNoteStore((state) => state.notebooks);
  const pointerFocus = useRef(false);
  const [visibleCount, setVisibleCount] = useState(NOTICE_PAGE_SIZE);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const expanded = hovered || focused;
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCollapse = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = null;
  };
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Tab can originate outside the host after a clicked button is disabled.
    const keyboardInput = () => { pointerFocus.current = false; };
    document.addEventListener('keydown', keyboardInput, true);
    return () => document.removeEventListener('keydown', keyboardInput, true);
  }, []);
  useEffect(() => () => {
    if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
  }, []);
  useEffect(() => {
    if (!notices.length) {
      cancelCollapse();
      setHovered(false);
      setFocused(false);
      setVisibleCount(NOTICE_PAGE_SIZE);
      pointerFocus.current = false;
    }
  }, [notices.length]);
  const handleScroll = () => {
    setIsScrolling(true);
    if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
    scrollEndTimer.current = setTimeout(() => setIsScrolling(false), SCROLLBAR_HIDE_DELAY_MS);
  };
  const visible = notices.slice(0, visibleCount);
  const { stackHeight, cardStyle, onHeight } = useCreatedDocumentNoticeStack(visible, expanded);
  if (!notices.length) return null;
  return (
    <aside
      tabIndex={0}
      onPointerDown={(event) => {
        pointerFocus.current = true;
        setFocused(false);
        if (event.pointerType === 'touch') setHovered(true);
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
        cancelCollapse();
        setHovered(true);
      }}
      onPointerLeave={() => {
        cancelCollapse();
        collapseTimer.current = setTimeout(() => setHovered(false), COLLAPSE_DELAY_MS);
      }}
      onKeyDownCapture={() => {
        pointerFocus.current = false;
        setFocused(true);
      }}
      onFocusCapture={() => { cancelCollapse(); setFocused(!pointerFocus.current); }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          pointerFocus.current = false;
          setFocused(false);
        }
      }}
      data-expanded={expanded}
      aria-label={t('createdDocuments.region')} className="created-document-notice-host pointer-events-auto fixed bottom-7 right-4 z-[var(--layer-document-notice)] w-[min(352px,calc(100vw-2rem))] text-[var(--foreground)]">
      <span className="sr-only" role="status" aria-live="polite">{t('createdDocuments.title')} {notices.length}</span>
      <div className="created-document-notice-toolbar relative z-10" aria-hidden={!expanded} inert={!expanded}>
        <div className="created-document-notice-toolbar-inner flex items-center justify-end px-1">
          {notices.length >= CLEAR_ACTION_MIN_NOTICES && <button type="button" onClick={clearCreatedDocumentNotices} className="rounded-full px-2.5 py-1 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
            {t('createdDocuments.clear')}
          </button>}
        </div>
      </div>
      <div data-scrolling={isScrolling ? 'true' : 'false'} onScroll={handleScroll} className="created-document-notice-scroll max-h-[min(calc(48vh_+_56px),476px)] overflow-y-auto overscroll-contain px-12 pb-12 pt-2 -mx-12 -mb-12">
        <div className="created-document-notice-stack" style={{ height: stackHeight }}>
          {visible.map((notice, index) => <CreatedDocumentNoticeCard key={notice.id}
            notice={notice}
            notebookName={notebooks.find((notebook) => notebook.id === notice.notebookId)?.name}
            hidden={!expanded && index > 0}
            style={cardStyle(index)}
            onHeight={onHeight}
          />)}
        </div>
        {expanded && notices.length > visible.length && <button type="button"
          onClick={() => setVisibleCount((count) => count + NOTICE_PAGE_SIZE)}
          className="created-document-notice-more rounded-md px-2 py-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)]">
          {t('createdDocuments.showOlder')}
        </button>}
      </div>
    </aside>
  );
}
