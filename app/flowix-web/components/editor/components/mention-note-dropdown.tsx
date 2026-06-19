import type { MentionNoteItem } from '../extensions/note-reference';

export interface MentionNoteDropdownProps {
  items: MentionNoteItem[];
  selectedIndex: number;
  hasMore: boolean;
  loading: boolean;
  onSelect: (item: MentionNoteItem) => void;
  onHover: (index: number) => void;
  onLoadMore: () => void;
}

export function MentionNoteDropdown({
  items,
  selectedIndex,
  hasMore,
  loading,
  onSelect,
  onHover,
  onLoadMore,
}: MentionNoteDropdownProps) {
  return (
    <div className="mention-note-dropdown" role="listbox" aria-label="Note references">
      <div
        className="mention-note-items"
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
            onLoadMore();
          }
        }}
      >
        {loading && items.length === 0 ? (
          <div className="mention-note-empty">加载中</div>
        ) : items.length === 0 ? (
          <div className="mention-note-empty">无匹配笔记</div>
        ) : (
          items.map((item, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={`${item.notebookId}:${item.id}`}
                type="button"
                role="option"
                aria-selected={selected}
                className={`mention-note-item${selected ? ' is-selected' : ''}`}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item);
                }}
              >
                <span className="mention-note-title">{item.title}</span>
                <span className="mention-note-notebook">{item.notebookName}</span>
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
            加载更多
          </button>
        )}
      </div>
    </div>
  );
}
