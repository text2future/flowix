import { type Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import {
  createSuggestionExtension,
  openSuggestionMenuFromEditor,
  type SuggestionMenuConfig,
} from '@features/editor/extensions/shared/suggestion-menu';
import { NoteMentionDropdown } from '@features/editor/extensions/note-mention/note-mention-dropdown';
import type { NoteMentionContextStorage } from '@features/editor/extensions/note-mention/note-mention-context';
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

  fetchItems: (query, editor) => {
    const context = editor.storage.noteMentionContext as NoteMentionContextStorage | undefined;
    return queryMentionNotes(query, context?.getNotebookId());
  },

  render: ({ items, selectedIndex, scrollSelectedItem, hasMore, loading, error, onSelect, onHover, onLoadMore }) => (
    <NoteMentionDropdown
      items={items}
      selectedIndex={selectedIndex}
      scrollSelectedItem={scrollSelectedItem}
      hasMore={hasMore}
      loading={loading}
      error={error}
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

const wikiNoteMentionConfig: SuggestionMenuConfig<MentionNoteItem> = {
  ...noteMentionConfig,
  trigger: '[[',
  parseQuery: (view: EditorView, triggerFrom, trigger) => {
    const { selection } = view.state;
    if (!selection.empty || selection.from < triggerFrom + trigger.length) return null;
    const $trigger = view.state.doc.resolve(triggerFrom);
    const $cursor = view.state.doc.resolve(selection.from);
    if (!$trigger.sameParent($cursor)) return null;
    const text = view.state.doc.textBetween(triggerFrom, selection.from, '\n', '\n');
    if (!text.startsWith(trigger)) return null;
    const query = text.slice(trigger.length);
    if (/[\]】\n]/.test(query)) return null;
    return query;
  },
  onSelect: ({ editor, item, deleteTriggerText }) => {
    deleteTriggerText();
    if (!editor.schema.nodes.noteReference) return;
    editor.commands.insertContent({
      type: 'noteReference',
      attrs: {
        ...toNoteReferenceAttrs(item),
        heading: null,
      },
    });
  },
};

/** Obsidian-style `[[` note picker. */
export const WikiNoteMention = createSuggestionExtension<MentionNoteItem>(wikiNoteMentionConfig);

/** Chinese keyboard alias; inserts the same canonically serialized note reference. */
export const ChineseWikiNoteMention = createSuggestionExtension<MentionNoteItem>({
  ...wikiNoteMentionConfig,
  trigger: '【【',
});
