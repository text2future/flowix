import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { SparkleIcon } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { useSettingsStore } from '../../../lib/store';
import { useChatStore } from '../../../lib/store/chat-store';
import { Tooltip } from '../../../components/ui/tooltip';

interface SelectionBubbleMenuProps {
  editor: Editor;
}

/**
 * 在这些节点上不显示"使用 AI 询问"气泡:
 * - 有专属气泡菜单的 (image, table) ── 让位给它们
 * - 没有可问内容的装饰元素 (horizontalRule)
 * - 自带交互面板的复合节点 (agentThreadCard) ── 卡片内有自身的 AI 对话
 *   composer, 再触发外层 AI 询问语义重叠且视觉冲突
 */
const SUPPRESSED_NODE_TYPES: readonly string[] = [
  'image',
  'horizontalRule',
  'table',
  'agentThreadCard',
];

const TOP_FLIP_PADDING = 56;

/**
 * Floating bubble menu that appears whenever the user has a non-empty text
 * selection. A single "使用AI询问" button stages the selected text into the
 * chat store and reveals the right-hand AI panel — the input box picks up
 * the staged prompt on its next render.
 */
export function SelectionBubbleMenu({ editor }: SelectionBubbleMenuProps) {
  const setAgentPanelVisible = useSettingsStore((state) => state.setAgentPanelVisible);
  const setPendingPrompt = useChatStore((state) => state.setPendingPrompt);
  const setPendingCitation = useChatStore((state) => state.setPendingCitation);

  // IME 输入结束时 (Enter 确认候选词、Esc 取消、点击外部等) 主动清理 selection
  // 并 hide 气泡菜单 ── 修"输入法 enter 替换选中文本后气泡不消失"的 bug。
  //
  // 根因: Tiptap BubbleMenu 的 updateHandler 在 view.composing === true 时直接
  // return,既不 show 也不 hide。在 IME 期间 / compositionend 触发的那个事务里,
  // 文本被替换、selection 应收敛成 caret,本应让 shouldShow({from, to}) 返回
  // false → hide(),但 composing 短路把它挡掉了,导致气泡定格在显示状态,
  // 直到下一个真正命中 updateHandler 的事务才更新。
  //
  // 修复: 监听 ProseMirror view 根节点上的 compositionend,在下一个 rAF 里
  // (此时 view.composing 已被 ProseMirror 翻成 false) 主动做两件事 ──
  //   1. 若 range selection 仍在 (某些 IME 不收缩 selection),手动 collapse
  //      到 to 位置并清空浏览器原生 Selection,杜绝高亮残留。
  //   2. 通过 pluginKey 派发 'hide' meta,让 BubbleMenuPlugin 立刻 hide ──
  //      这与 transactionHandler 监听的 meta 协议一致 (bubble-menu-plugin.ts)。
  useEffect(() => {
    const view = editor.view;
    const dom = view.dom;

    const handleCompositionEnd = () => {
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return;

        const { from, to } = editor.state.selection;
        if (from !== to) {
          editor.commands.setTextSelection(to);
          window.getSelection()?.removeAllRanges();
        }

        view.dispatch(
          view.state.tr.setMeta('selectionAIBubbleMenu', 'hide'),
        );
      });
    };

    dom.addEventListener('compositionend', handleCompositionEnd);
    return () => {
      dom.removeEventListener('compositionend', handleCompositionEnd);
    };
  }, [editor]);

  const handleAskAI = () => {
    const { from, to } = editor.state.selection;
    if (from === to) return;

    const selectedText = editor.state.doc.textBetween(from, to, '\n').trim();
    if (!selectedText) return;

    // Stage the selection as a citation (rendered as a card above the input
    // and emitted in the outgoing user message wrapped in
    // <citation>…</citation>). The prompt itself is left empty so the user
    // types their own follow-up question; the inputbox effect still runs
    // to focus the textarea and reset its height.
    setPendingCitation(selectedText);
    setPendingPrompt("");
    setAgentPanelVisible(true);

    // Clear the editor's text selection. We do three things, in order, to make
    // sure neither the document state nor the browser surface still shows a
    // highlighted range after the user has handed the content off to the AI
    // panel:
    //   1. Blur the editor so the bubble menu (which keys off focus + a
    //      non-empty range selection) tears down immediately.
    //   2. Collapse the ProseMirror selection to a single caret position at
    //      `to`, so refocusing the editor later lands the cursor at the end
    //      of where the selection was — instead of restoring the range and
    //      re-popping the bubble menu.
    //   3. Drop the browser's native `Selection` ranges to clear the visual
    //      blue highlight on the page.
    editor.commands.blur();
    editor.commands.setTextSelection(to);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionAIBubbleMenu"
      shouldShow={({ from, to }) => {
        if (from === to) return false;
        if (!editor.isEditable) return false;
        // 任一被屏蔽的节点类型处于 selection 范围 → 隐藏。覆盖两类场景:
        // - 节点专属菜单已接管 (image / table)
        // - 节点内含 AI 交互, 再触发外层气泡语义重叠 (agentThreadCard)
        // - 装饰元素无内容可问 (horizontalRule)
        // 跨 block 文本选区只要不涉及上述节点, 仍正常显示 ── `textBetween`
        // 仍以 `\n` 拼接, 与改造前一致。
        if (SUPPRESSED_NODE_TYPES.some((type) => editor.isActive(type))) {
          return false;
        }
        return true;
      }}
      options={{
        placement: 'top',
        flip: {
          padding: {
            top: TOP_FLIP_PADDING,
            right: 8,
            bottom: 8,
            left: 8,
          },
        },
        shift: true,
        offset: 8,
      }}
    >
      <div className="selection-bubble-menu">
        <Tooltip content="使用 AI 询问选中内容">
          <button
            type="button"
            className="selection-bubble-button"
            onMouseDown={(e) => {
              // Keep editor focus through the click so the menu doesn't tear
              // down before our handler runs; we blur explicitly in the click.
              e.preventDefault();
            }}
            onClick={handleAskAI}
          >
            <SparkleIcon className="selection-bubble-icon" size={12} weight="fill" />
            <span className="selection-bubble-label">使用AI询问</span>
          </button>
        </Tooltip>
      </div>
    </BubbleMenu>
  );
}
