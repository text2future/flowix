'use client';

/**
 * 集合名称的**唯一一份可编辑实现**。
 *
 * 一个集合只有一个名字，但名字有两种挂载位置（见 title-api）：
 *   - `tab`   → tab 条左侧的小标题（`CollectionTitle`，嵌入/表格 nav）；
 *   - `header`→ 独立打开时的大标题（`CollectionNameHeader`）。
 *
 * 两种形态的交互必须完全一致，所以交互只有这一份：hover 底色 + 圆角 →
 * 双击（或 Enter/F2）进入编辑 → 输入框自动聚焦并把光标放到双击位置 →
 * Enter 或失焦保存、Esc 退出不保存；保存中显示 spinner。
 * 差别只有字号（`size`），版式容器由调用方提供。
 */
import type { RefObject } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export type CollectionNameSize = 'tab' | 'header';

/** 名称编辑的状态机：由 `useCollectionNameEdit` 提供，也可由已有会话（表格 nav）驱动。 */
export interface CollectionNameEditControls {
  editing: boolean;
  draft: string;
  setDraft: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  captureCaret: (element: HTMLElement, x: number, y: number) => void;
  beginEdit: () => void;
  commit: (value: string) => void | Promise<void>;
  cancel: () => void;
  disabled?: boolean;
  busy?: boolean;
}

const NAME_STYLES = {
  tab: {
    button: 'rounded px-0.5 py-1 text-sm font-medium leading-none',
    // input 不给显式高度：高度由行盒 + padding 自然撑出（与 button 相同的 28px）。
    // WebKit 里显式高度的 input 按内容盒垂直居中文字，与 button 的行盒定位差 ~2px，
    // 会导致进出编辑文字跳动（header 44px 档实测）。
    input: 'rounded px-0.5 py-1 text-sm font-medium leading-none',
    spinner: 'h-3.5 w-3.5',
  },
  header: {
    // 字号对齐编辑器 H1（styles/editor.css：calc(var(--editor-font-size,16px) * 1.8)）。
    // 行高 = 高度（leading-[44px] = h-11）：button 与 input 都靠同一根 44px 行盒
    // 定位文字。input **不能**给显式高度（h-11）——WebKit 对显式高度的 input
    // 用内容盒垂直居中文字，与 button 的行盒定位差 2px（真实 CSS + Inter 实测），
    // 表现为进入编辑文字下移；高度自适应的 input 与 button 完全一致（44px）。
    button: 'h-11 rounded-lg px-2 py-0 text-[calc(var(--editor-font-size,16px)*1.8)] leading-[44px] font-bold',
    input: 'rounded-lg px-2 py-0 text-[calc(var(--editor-font-size,16px)*1.8)] leading-[44px] font-bold',
    spinner: 'h-4 w-4',
  },
} as const;

export function EditableCollectionName({
  title,
  size,
  inputLabel,
  renameLabel,
  renameHint,
  edit,
}: {
  title: string;
  size: CollectionNameSize;
  inputLabel: string;
  renameLabel: string;
  renameHint: string;
  edit: CollectionNameEditControls;
}) {
  const { t } = useI18n();
  const style = NAME_STYLES[size];
  const unavailable = edit.disabled || edit.busy;
  const displayTitle = edit.busy ? edit.draft.trim() || title : title;

  return <>
    {edit.editing ? <input
      ref={edit.inputRef}
      aria-label={inputLabel}
      value={edit.draft}
      disabled={unavailable}
      onChange={(event) => edit.setDraft(event.currentTarget.value)}
      onBlur={(event) => { void edit.commit(event.currentTarget.value); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          edit.cancel();
        }
      }}
      className={`box-border min-w-[2em] max-w-full flex-[0_1_auto] [field-sizing:content] border-0 bg-[var(--muted)] text-[var(--foreground)] outline-none ${style.input}`}
    /> : <button
      type="button"
      onDoubleClick={(event) => {
        if (unavailable) return;
        event.preventDefault();
        edit.captureCaret(event.currentTarget, event.clientX, event.clientY);
        edit.beginEdit();
      }}
      aria-label={`${renameLabel}：${displayTitle}`}
      title={`${renameHint}：${displayTitle}`}
      disabled={unavailable}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          edit.beginEdit();
        }
      }}
      className={`min-w-[2em] max-w-full flex-[0_1_auto] truncate text-left text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] disabled:opacity-100 ${style.button}`}
    >{displayTitle}</button>}
    {edit.busy && <span role="status" aria-label={t('memo.fileTree.renaming')} className="inline-flex shrink-0 items-center text-[var(--muted-foreground)]">
      <LoaderCircle className={`${style.spinner} flowix-spin`} aria-hidden="true" />
    </span>}
  </>;
}
