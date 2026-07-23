import type { EditorView } from '@tiptap/pm/view';
import { createSuggestionExtension } from '@features/editor/extensions/shared/suggestion-menu';
import { TagMentionDropdown } from '@features/editor/extensions/tag-mention/tag-mention-dropdown';
import { queryMentionTags, type MentionTagItem } from '@features/editor/extensions/tag-mention/tag-mention-data';

const TRIGGER = '#';
const WIDTH = 150;

function isValidTagTriggerPosition(view: EditorView, from: number): boolean {
  if (from === 0) return true;
  const charBefore = view.state.doc.textBetween(from - 1, from, '\n', '\n');
  return charBefore === '' || /\s/.test(charBefore);
}

export const TagMention = createSuggestionExtension<MentionTagItem>({
  trigger: TRIGGER,
  width: WIDTH,
  isValidTriggerPosition: isValidTagTriggerPosition,

  parseQuery: (view: EditorView, triggerFrom, trigger) => {
    const { selection } = view.state;
    if (!selection.empty || selection.from < triggerFrom + 1) return null;
    const $trigger = view.state.doc.resolve(triggerFrom);
    const $cursor = view.state.doc.resolve(selection.from);
    if (!$trigger.sameParent($cursor)) return null;

    const text = view.state.doc.textBetween(triggerFrom, selection.from, '\n', '\n');
    if (!text.startsWith(trigger)) return null;
    const query = text.slice(1);
    const stripped = query.replace(/\//g, '');
    if (/[\s\p{P}]/u.test(stripped)) return null;
    return query;
  },

  fetchItems: (query) => queryMentionTags(query),
  render: ({
    items,
    selectedIndex,
    scrollSelectedItem,
    hasMore,
    loading,
    onSelect,
    onHover,
    onLoadMore,
  }) => (
    <TagMentionDropdown
      items={items}
      selectedIndex={selectedIndex}
      scrollSelectedItem={scrollSelectedItem}
      hasMore={hasMore}
      loading={loading}
      onSelect={onSelect}
      onHover={onHover}
      onLoadMore={onLoadMore}
    />
  ),

  onSelect: ({ editor, item, deleteTriggerText }) => {
    if (item.create) {
      editor.chain().focus().insertContent(' ').run();
      return;
    }
    deleteTriggerText();
    editor.commands.insertContent(`#${item.name} `);
  },

  onError: (err) => console.warn('[tag-mention] query failed:', err),
});
