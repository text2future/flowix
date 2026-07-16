import type { EditorView } from '@tiptap/pm/view';
import { createSuggestionExtension } from '@features/editor/extensions/shared/suggestion-menu';
import { TagMentionDropdown } from '@features/editor/extensions/tag-mention/tag-mention-dropdown';
import { queryMentionTags, type MentionTagItem } from '@features/editor/extensions/tag-mention/tag-mention-data';

const TRIGGER = '#';
const WIDTH = 150;

/**
 * `#` 触发标签 mention。触发位置需行首或空白后 (与 [extensions/tag.ts]
 * TAG_REGEX 保持一致); 终止符同装饰: 空白或 Unicode 标点。
 * 选中已有标签 → 删 `#query` + 插 `#tagname` (Tag 装饰自动高亮);
 * 选中"新建"占位 → 编辑器里已存在 `#tagname`, 仅追加空格让装饰命中。
 */
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
    // 路径式 tag: 允许 `/` 出现在 query 里 (e.g. `泰国/曼`), 但空白和
    // 其他 Unicode 标点仍然禁止 — 与 Tag 装饰 [extensions/tag.ts] 字符类
    // 同步: 去掉 `/` 后剩下的部分不能含空白 / 标点。
    const stripped = query.replace(/\//g, '');
    if (/[\s\p{P}]/u.test(stripped)) return null;
    return query;
  },

  fetchItems: (query) => queryMentionTags(query),

  render: ({ items, selectedIndex, scrollSelectedItem, hasMore, loading, onSelect, onHover, onLoadMore }) => (
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
      // 编辑器里已存在 `#tagname`, 只追加空格让 Tag 装饰的终止符命中
      editor.chain().focus().insertContent(' ').run();
      return;
    }
    // 已有标签: 删 `#query`, 插 `#tagname` + 末尾空格。
    // 末尾空格作为 Tag 装饰 [extensions/tag.ts] TAG_REGEX 的终止符 (\s),
    // 确保刚插入的标签立即被高亮, 也避免用户继续敲字母时被装饰吞进更长的串。
    deleteTriggerText();
    editor.commands.insertContent(`#${item.name} `);
  },

  onError: (err) => console.warn('[tag-mention] query failed:', err),
});
