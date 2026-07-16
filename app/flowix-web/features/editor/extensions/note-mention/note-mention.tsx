import { type Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import {
  createSuggestionExtension,
  openSuggestionMenuFromEditor,
  type SuggestionMenuConfig,
} from '@features/editor/extensions/shared/suggestion-menu';
import { NoteMentionDropdown } from '@features/editor/extensions/note-mention/note-mention-dropdown';
import {
  queryMentionNotes,
  toNoteReferenceAttrs,
  type MentionNoteItem,
} from '@features/editor/extensions/note-mention/note-mention-data';

const TRIGGER = '@';
const WIDTH = 280;

const noteMentionConfig: SuggestionMenuConfig<MentionNoteItem> = {
  trigger: TRIGGER,
  width: WIDTH,

  parseQuery: (view: EditorView, triggerFrom, trigger) => {
    const { selection } = view.state;
    if (!selection.empty || selection.from < triggerFrom + 1) return null;

    const $trigger = view.state.doc.resolve(triggerFrom);
    const $cursor = view.state.doc.resolve(selection.from);
    if (!$trigger.sameParent($cursor)) return null;

    const text = view.state.doc.textBetween(triggerFrom, selection.from, '\n', '\n');
    if (!text.startsWith(trigger)) return null;

    const query = text.slice(1);
    // Note titles often contain punctuation; only whitespace closes the query.
    if (/\s/.test(query)) return null;
    return query;
  },

  fetchItems: (query) => queryMentionNotes(query),

  render: ({ items, selectedIndex, scrollSelectedItem, hasMore, loading, onSelect, onHover, onLoadMore }) => (
    <NoteMentionDropdown
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
    deleteTriggerText();
    if (!editor.schema.nodes.noteReference) return;
    editor.commands.insertContent({
      type: 'noteReference',
      attrs: toNoteReferenceAttrs(item),
    });
  },

  onError: (err) => console.warn('[note-mention] query failed:', err),
};

export function openNoteMention(editor: Editor): boolean {
  return openSuggestionMenuFromEditor(editor, noteMentionConfig);
}

/**
 * `@` trigger for note references. Selecting an item inserts a `noteReference`
 * inline card that can navigate to the target memo.
 */
export const NoteMention = createSuggestionExtension<MentionNoteItem>(noteMentionConfig);
