import { type CSSProperties, type RefObject } from 'react';
import folderIcon from '@/assets/folder-outline.svg?raw';
import { useI18n } from '@/lib/i18n';
import { useComposingValue } from '@shared/hooks/use-composing-value';
import { TREE_EDGE_GUTTER, INDENT_PER_LEVEL } from './notebook-tree-layout';

/**
 * 文件树里「新建文件夹」的内联输入框。
 *
 * 从 `notebook-file-tree.tsx` 抽出：它只依赖 layout 常量与两个通用 hook，
 * 与树本身的虚拟滚动/拖拽状态无关，独立成文件即可让主文件回到冻结阈值内。
 */
export function NotebookTreeDraft({
  draft,
  depth,
  onChange,
  onSubmit,
  onCancel,
  inputRef,
  style,
  'data-notebook-tree-depth': dataDepth,
}: {
  draft: { requestId: number; value: string };
  depth: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  style?: CSSProperties;
  'data-notebook-tree-depth'?: number;
}) {
  const { t } = useI18n();
  const draftInput = useComposingValue(draft.value, onChange);
  return (
    <div
      data-notebook-tree-depth={dataDepth}
      className="flex h-8 items-center px-1.5"
      style={{
        marginLeft: TREE_EDGE_GUTTER
          + depth * INDENT_PER_LEVEL,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        data-notebook-tree-draft-icon="folder"
        className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[var(--brand)]"
      >
        <span
          className="absolute inset-0 flex items-center justify-center"
          dangerouslySetInnerHTML={{ __html: folderIcon }}
        />
      </span>
      <input
        key={draft.requestId}
        ref={inputRef}
        autoFocus
        value={draftInput.value}
        placeholder={t('memo.fileTree.newFolder')}
        onChange={draftInput.onChange}
        onCompositionStart={draftInput.onCompositionStart}
        onCompositionEnd={draftInput.onCompositionEnd}
        onBlur={onSubmit}
        onKeyDown={(event) => {
          if (draftInput.isComposingKeyboardEvent(event.nativeEvent)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="ml-1.5 h-5 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm outline-none"
      />
    </div>
  );
}
