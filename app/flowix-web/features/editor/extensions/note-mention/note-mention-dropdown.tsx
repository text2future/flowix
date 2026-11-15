import { type MouseEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useSelectedItemScroll } from '@features/editor/extensions/shared/use-selected-item-scroll';
import { PopupScrollArea } from '@shared/ui/popup-scroll-area';
import type { MentionNoteItem } from '@features/editor/extensions/note-mention/note-mention-data';
import { useI18n } from '@/lib/i18n';

export interface NoteMentionDropdownProps {
  items: MentionNoteItem[];
  selectedIndex: number;
  scrollSelectedItem: boolean;
  hasMore: boolean;
  loading: boolean;
  error?: boolean;
  onSelect: (item: MentionNoteItem) => void;
  onHover: (index: number) => void;
  onLoadMore: () => void;
}

export function NoteMentionDropdown({
  items,
  selectedIndex,
  scrollSelectedItem,
  hasMore,
  loading,
  error = false,
  onSelect,
  onHover,
  onLoadMore,
}: NoteMentionDropdownProps) {
  const { t } = useI18n();
  const { scrollerRef, itemRefs } = useSelectedItemScroll({
    items,
    selectedIndex,
    scrollSelectedItem,
  });
  const handleItemMouseMove = (
    event: MouseEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (event.movementX === 0 && event.movementY === 0) return;
    onHover(index);
  };

  return (
    <div
      className={`mention-note-dropdown${scrollSelectedItem ? ' is-keyboard-navigation' : ''}`}
      role="listbox"
      aria-label="Notes"
    >
      <div className="mention-note-header" aria-label="Mention type">
        <span>{t('editor.noteMention.header')}</span>
        {loading && (
          <LoaderCircle
            className="mention-note-header-spinner flowix-spin"
            aria-hidden="true"
          />
        )}
      </div>
      <PopupScrollArea
        className="mention-note-items-frame"
        scrollerClassName="mention-note-items"
        scrollerRef={scrollerRef}
        onScroll={(event) => {
            const el = event.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
              onLoadMore();
            }
        }}
      >
          {loading && items.length === 0 ? (
            <div className="mention-note-empty mention-note-empty--loading">
              <span className="mention-note-loading-title">{t('editor.noteMention.loading')}</span>
            </div>
          ) : error ? (
            <div className="mention-note-empty">{t('editor.noteMention.error')}</div>
          ) : items.length === 0 ? (
            <div className="mention-note-empty">{t('editor.noteMention.empty')}</div>
          ) : (
            items.map((item, index) => {
              const selected = index === selectedIndex;
              return (
                <button
                  key={`${item.notebookId}:${item.relativePath}`}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`mention-note-item${selected ? ' is-selected' : ''}`}
                  onMouseMove={(event) => handleItemMouseMove(event, index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(item);
                  }}
                >
                  <span className="mention-note-title">{item.title}</span>
                </button>
              );
            })
          )}
          {hasMore && (
            <button
              type="button"
              className="mention-note-more"
              onMouseDown={(event) => {
                event.preventDefault();
                onLoadMore();
              }}
            >
              {t('editor.noteMention.loadMore')}
            </button>
          )}
      </PopupScrollArea>
    </div>
  );
}
