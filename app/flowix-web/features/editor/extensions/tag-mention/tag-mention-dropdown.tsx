import { type MouseEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useSelectedItemScroll } from '@features/editor/extensions/shared/use-selected-item-scroll';
import { PopupScrollArea } from '@shared/ui/popup-scroll-area';
import type { MentionTagItem } from '@features/editor/extensions/tag-mention/tag-mention-data';
import { TagMentionName } from '@features/editor/extensions/tag-mention/tag-mention-label';
import { useI18n } from '@/lib/i18n';
import { TagSvgIcon } from '@shared/ui/tag-icon';

export interface TagMentionDropdownProps {
  items: MentionTagItem[];
  selectedIndex: number;
  scrollSelectedItem: boolean;
  hasMore: boolean;
  loading: boolean;
  onSelect: (item: MentionTagItem) => void;
  onHover: (index: number) => void;
  onLoadMore: () => void;
}

export function TagMentionDropdown({
  items,
  selectedIndex,
  scrollSelectedItem,
  hasMore,
  loading,
  onSelect,
  onHover,
  onLoadMore,
}: TagMentionDropdownProps) {
  const { t } = useI18n();
  const { scrollerRef, itemRefs } = useSelectedItemScroll({
    items,
    selectedIndex,
    scrollSelectedItem,
  });
  const handleItemMouseMove = (
    event: MouseEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.movementX === 0 && event.movementY === 0) return;
    onHover(index);
  };

  return (
    <div
      className={`mention-note-dropdown tag-mention-dropdown${scrollSelectedItem ? ' is-keyboard-navigation' : ''}`}
      role="listbox"
      aria-label="Tags"
    >
      <div className="mention-note-header" aria-label="Mention type">
        <span>{t('editor.tagMention.header')}</span>
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
            <span className="mention-note-loading-title">{t('editor.tagMention.loading')}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="mention-note-empty">{t('editor.tagMention.empty')}</div>
        ) : (
          items.map((item, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={item.create ? `create:${item.id}` : `tag:${item.id}`}
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
                <span className="mention-note-title mention-tag-title">
                  <TagSvgIcon className="mention-tag-icon" />
                  <TagMentionName name={item.name} />
                </span>
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
            {t('editor.tagMention.loadMore')}
          </button>
        )}
      </PopupScrollArea>
    </div>
  );
}
