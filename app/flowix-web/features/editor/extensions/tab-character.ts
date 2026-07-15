import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';

import { DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';

const TABLE_CELL_TYPES = new Set(['tableCell', 'tableHeader']);
const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem']);
const DOUBLE_TAB_WINDOW_MS = 650;

interface RunnableBlock {
  from: number;
  to: number;
  prompt: string;
}

interface PendingTabCharacter extends RunnableBlock {
  insertedFrom: number;
  insertedTo: number;
  time: number;
}

function isInsideTableCell(selection: TextSelection): boolean {
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (TABLE_CELL_TYPES.has($from.node(depth).type.name)) {
      return true;
    }
  }
  return false;
}

function getListItemType(selection: TextSelection): 'listItem' | 'taskItem' | null {
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const typeName = $from.node(depth).type.name;
    if (LIST_ITEM_TYPES.has(typeName)) {
      return typeName as 'listItem' | 'taskItem';
    }
  }
  return null;
}

function isSupportedTextBlock(typeName: string): boolean {
  return typeName === 'paragraph' || typeName === 'heading';
}

function getBlockPrompt(block: ProseMirrorNode, editor: Editor): string {
  const markdown = editor.markdown?.serialize(block.toJSON()).trim();
  return markdown || block.textContent.trim();
}

function getRunnableBlock(selection: TextSelection, editor: Editor): RunnableBlock | null {
  if (!selection.empty) return null;

  const { $from } = selection;
  const blockDepth = $from.depth;
  if (blockDepth !== 1) return null;

  const block = $from.node(blockDepth);
  if (!block.isTextblock || !isSupportedTextBlock(block.type.name)) return null;

  const prompt = getBlockPrompt(block, editor);
  if (!prompt) return null;

  return {
    from: $from.before(blockDepth),
    to: $from.after(blockDepth),
    prompt,
  };
}

function isPendingSecondTab(
  pendingTab: PendingTabCharacter | null,
  selection: TextSelection,
  now: number,
): pendingTab is PendingTabCharacter {
  return !!pendingTab
    && selection.empty
    && selection.from === pendingTab.insertedTo
    && now - pendingTab.time <= DOUBLE_TAB_WINDOW_MS;
}

export const TabCharacter = Extension.create({
  name: 'tabCharacter',
  priority: 1000,

  addProseMirrorPlugins() {
    const editor = this.editor;
    let pendingTab: PendingTabCharacter | null = null;

    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'Tab') return false;
            if (event.altKey || event.ctrlKey || event.metaKey) return false;
            if (event.isComposing || !editor.isEditable) return false;

            const { selection } = view.state;
            if (!(selection instanceof TextSelection)) return false;
            if (isInsideTableCell(selection)) return false;

            const listItemType = getListItemType(selection);
            if (listItemType) {
              pendingTab = null;
              event.preventDefault();
              if (event.shiftKey) {
                editor.commands.liftListItem(listItemType);
              } else {
                editor.commands.sinkListItem(listItemType);
              }
              return true;
            }

            if (event.shiftKey) return false;

            const now = Date.now();
            event.preventDefault();
            if (isPendingSecondTab(pendingTab, selection, now)) {
              const tab = pendingTab;
              pendingTab = null;
              view.dispatch(view.state.tr.delete(tab.insertedFrom, tab.insertedTo));
              editor.chain().focus().insertAgentThreadCard({
                typeKey: DEFAULT_AGENT_TYPE_KEY,
                replaceRange: { from: tab.from, to: tab.to },
                initialPrompt: tab.prompt,
                autoSubmit: true,
              }).run();
              return true;
            }

            const runnableBlock = getRunnableBlock(selection, editor);
            editor.chain().focus().insertContent('\t').run();
            pendingTab = runnableBlock
              ? {
                  ...runnableBlock,
                  insertedFrom: selection.from,
                  insertedTo: selection.from + 1,
                  time: now,
                }
              : null;
            return true;
          },
        },
      }),
    ];
  },
});
