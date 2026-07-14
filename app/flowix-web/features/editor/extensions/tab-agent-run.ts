import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';

import { DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';

const DOUBLE_TAB_WINDOW_MS = 650;

interface RunnableBlock {
  from: number;
  to: number;
  prompt: string;
}

interface PendingTab extends RunnableBlock {
  time: number;
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

function isPendingSecondTab(pendingTab: PendingTab | null, block: RunnableBlock, now: number): boolean {
  return !!pendingTab
    && pendingTab.from === block.from
    && pendingTab.to === block.to
    && pendingTab.prompt === block.prompt
    && now - pendingTab.time <= DOUBLE_TAB_WINDOW_MS;
}

export const TabAgentRun = Extension.create({
  name: 'tabAgentRun',

  addProseMirrorPlugins() {
    const editor = this.editor;
    let pendingTab: { from: number; to: number; prompt: string; time: number } | null = null;

    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'Tab') return false;
            if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
            if (event.isComposing || !editor.isEditable) return false;

            const { selection } = view.state;
            if (!(selection instanceof TextSelection)) return false;

            const block = getRunnableBlock(selection, editor);
            if (!block) {
              pendingTab = null;
              return false;
            }
            const now = Date.now();

            event.preventDefault();
            if (!isPendingSecondTab(pendingTab, block, now)) {
              pendingTab = { ...block, time: now };
              return true;
            }

            pendingTab = null;
            editor.chain().insertAgentThreadCard({
              typeKey: DEFAULT_AGENT_TYPE_KEY,
              replaceRange: { from: block.from, to: block.to },
              initialPrompt: block.prompt,
              autoSubmit: true,
            }).run();
            return true;
          },
        },
      }),
    ];
  },
});
