import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, Plus } from 'lucide-react';
import type { NoteEntry } from '@platform/tauri/client';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { PopupScrollArea } from '@shared/ui/popup-scroll-area';

/** Shared interaction for creating a note or linking an existing one. Persistence stays in the caller. */
export function NoteCreatePicker({ value, onChange, notes = [], allowSelect = true, disabled = false, error, onCreate, onSelect, onCancel, actions, actionsLayout = 'row', scrollTitleWithActions = false, footer, showCreateButton = true, mode = 'create' }: {
  value: string;
  onChange: (value: string) => void;
  notes?: readonly NoteEntry[];
  allowSelect?: boolean;
  disabled?: boolean;
  error?: string | null;
  onCreate: () => unknown;
  onSelect?: (note: NoteEntry) => unknown;
  onCancel: () => void;
  actions?: ReactNode;
  actionsLayout?: 'row' | 'column';
  scrollTitleWithActions?: boolean;
  footer?: ReactNode;
  showCreateButton?: boolean;
  mode?: 'create' | 'edit';
}) {
  const input = useComposingValue(value, onChange);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const query = input.value.trim().toLocaleLowerCase();
  const filtered = allowSelect && onSelect ? notes.filter((note) => !query || `${note.title ?? ''} ${note.relativePath}`.toLocaleLowerCase().includes(query)) : [];
  const activeIndex = filtered.findIndex((note) => note.relativePath === activePath);

  useLayoutEffect(() => { textareaRef.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    const contentHeight = textarea.scrollHeight + 2;
    textarea.style.height = `${scrollTitleWithActions ? contentHeight : Math.min(contentHeight, window.innerHeight * 0.5)}px`;
  }, [input.value, scrollTitleWithActions]);
  const navigate = (direction: number, fromIndex = activeIndex, moveFocus = false) => {
    if (!filtered.length) return;
    const next = fromIndex < 0 ? (direction > 0 ? 0 : filtered.length - 1) : (fromIndex + direction + filtered.length) % filtered.length;
    setActivePath(filtered[next].relativePath);
    setKeyboardNavigation(true);
    if (moveFocus) optionRefs.current[next]?.focus({ preventScroll: true });
    optionRefs.current[next]?.scrollIntoView({ block: 'nearest' });
  };
  const titleInput = <div className={`flex shrink-0 items-start gap-1${scrollTitleWithActions ? ' pb-2' : ''}`}>
    <textarea ref={textareaRef} rows={1} aria-label={mode === 'edit' || !allowSelect ? '笔记名称' : '新建或选择笔记'} placeholder={mode === 'edit' || !allowSelect ? '笔记名称' : '输入名称搜索 或 新建'}
      value={input.value} disabled={disabled}
      className="multidimensional-table__primary-title-input min-w-0 flex-1 !py-2"
      onChange={(event) => { input.onChange(event); setActivePath(null); }}
      onCompositionStart={input.onCompositionStart} onCompositionEnd={input.onCompositionEnd}
      onKeyDown={(event) => {
        if (input.isComposingKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); return; }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!filtered.length) return;
          event.preventDefault(); event.stopPropagation(); navigate(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation();
          if (activeIndex >= 0 && onSelect) void onSelect(filtered[activeIndex]);
          else if (value.trim()) void onCreate();
        }
      }} />
    {showCreateButton && value.trim() && <button type="button" aria-label="创建并关联笔记" title="创建并关联笔记" disabled={disabled}
      onMouseDown={(event) => event.preventDefault()} onClick={() => void onCreate()}
      className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--hover-bg)] disabled:opacity-50">
      <Plus size={14} aria-hidden="true" />
    </button>}
  </div>;
  const actionContent = actions && <div className={actionsLayout === 'column' ? 'flex w-full min-w-0 flex-col items-stretch' : 'multidimensional-table__primary-editor-actions'}>{actions}</div>;
  const NoteListArea = scrollTitleWithActions ? 'div' : PopupScrollArea;
  const noteList = mode === 'create' && allowSelect && onSelect && <div className="min-w-0">
    <NoteListArea className={scrollTitleWithActions ? '-mx-1' : '-mx-1 max-h-48'}>
      <div className="slash-menu-header !px-1.5" role="presentation"><span>搜索并添加笔记</span></div>
      <div role="listbox" aria-label="已创建笔记">
        {filtered.map((note, index) => <button key={note.relativePath} ref={(element) => { optionRefs.current[index] = element; }}
          type="button" role="option" aria-selected={index === activeIndex} disabled={disabled}
          onFocus={() => { setActivePath(note.relativePath); setKeyboardNavigation(true); }}
          onKeyDown={(event) => {
            if (input.isComposingKeyboardEvent(event.nativeEvent)) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); event.stopPropagation();
              navigate(event.key === 'ArrowDown' ? 1 : -1, index, true);
            } else if (event.key === 'Enter') {
              event.preventDefault(); event.stopPropagation(); void onSelect?.(note);
            } else if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation(); onCancel();
            }
          }}
          onMouseMove={(event) => {
            if (!event.movementX && !event.movementY) return;
            setActivePath(note.relativePath); setKeyboardNavigation(false);
          }}
          onMouseDown={(event) => event.preventDefault()} onClick={() => void onSelect?.(note)}
          className={`multidimensional-table__note-picker-option${index === activeIndex ? ' is-selected' : ''}`} title={note.relativePath}>
          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
          <span className="truncate">{note.title || note.relativePath}</span>
        </button>)}
      </div>
      {(error || filtered.length === 0) && <p className="px-1 py-2 text-center text-sm text-[var(--muted-foreground)]">{error || (notes.length ? '没有匹配的笔记' : '没有可选择的笔记')}</p>}
    </NoteListArea>
  </div>;

  return <div className={`multidimensional-table__primary-editor${keyboardNavigation ? ' is-keyboard-navigation' : ''}${scrollTitleWithActions ? ' flex min-h-0 flex-1 flex-col' : ''}`}>
    {scrollTitleWithActions
      ? <>
        <PopupScrollArea
          className="-mr-1 -mt-2 h-auto min-h-[120px] max-h-[min(360px,calc(100vh-112px))] flex-none"
          scrollerClassName="h-auto min-h-[120px] max-h-[min(360px,calc(100vh-112px))] pl-1 pr-1 pt-2"
        >{titleInput}{actionContent}{noteList}</PopupScrollArea>
        {footer}
      </>
      : <>{titleInput}{actionContent}{noteList}{footer}</>}
  </div>;
}
