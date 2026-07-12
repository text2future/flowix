'use client';

import { useState, type JSX } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { useUserSettings } from '@features/preferences/hooks/use-user-settings';
import { useI18n, type I18nKey } from '@features/i18n';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { Textarea } from '@shared/ui/textarea';
import {
  Field,
  FIELD_INPUT_CLASS,
  FIELD_TITLE_CLASS,
  SectionHeader,
} from '@features/preferences/sections/primitives';
import {
  MAX_QUICK_PHRASE_PROMPT_LENGTH,
  MAX_QUICK_PHRASE_TITLE_LENGTH,
  type QuickPhrase,
} from '@/lib/constants';
import { cn } from '@/lib/utils';

/** 单条常用语的草稿 ── title / prompt 两个字段。 */
interface Draft {
  title: string;
  prompt: string;
}

function emptyDraft(): Draft {
  return { title: '', prompt: '' };
}

/** trim + 长度截断 (按字符而非 codepoint, 与 MAX_*_LENGTH 语义一致) */
function normalizeDraft(draft: Draft): { title: string; prompt: string } {
  return {
    title: draft.title.trim().slice(0, MAX_QUICK_PHRASE_TITLE_LENGTH),
    prompt: draft.prompt.trim().slice(0, MAX_QUICK_PHRASE_PROMPT_LENGTH),
  };
}

/** 校验 draft: 双字段必填, prompt 不超过上限。 返回 ok + i18n key (失败时)。 */
function validateDraft(
  draft: Draft,
): { ok: true } | { ok: false; errorKey: I18nKey } {
  if (!draft.title.trim()) {
    return { ok: false, errorKey: 'preferences.quickPhrases.titleRequired' };
  }
  if (!draft.prompt.trim()) {
    return { ok: false, errorKey: 'preferences.quickPhrases.promptRequired' };
  }
  if (draft.prompt.trim().length > MAX_QUICK_PHRASE_PROMPT_LENGTH) {
    return { ok: false, errorKey: 'preferences.quickPhrases.promptTooLong' };
  }
  return { ok: true };
}

/**
 * 偏好设置 → 工具 tab 下的「常用语」子区块。
 *
 * 视觉与交互基线对齐 AgentSection (供应商 / 模型 / Base URL 表单):
 *  - SectionHeader size="compact" ── 与「AI Agent 配置」子区块同一节奏
 *  - 编辑态内嵌展开, 每个输入用 <Field title=...> 包一层 ── 与其它表单一
 *    致, 用户一眼能识别"哪个标题对应哪个输入"
 *  - 底部 action bar 含「取消 / 保存」+ 状态文字 ── 写盘后显示「已保存」
 *
 * 数据源: useUserSettings().settings.agents.quickPhrases, 写回通过
 * updateSettings({ agents: { quickPhrases: next } }) 触发 200ms debounce
 * 落盘到 ~/.flowix/boot/preference.json。
 */
export function QuickPhrasesSection() {
  const { t } = useI18n();
  const { settings, updateSettings } = useUserSettings();
  const phrases = settings.agents.quickPhrases;

  const [newDraft, setNewDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  // 落盘反馈 ── 与 AgentSection 的 saveStatus 同源语义, 但只闪一次
  // ("已保存" 1.5s 后回到 idle), 给用户"按了就有反馈"的体感。
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');

  const commit = (next: QuickPhrase[]): void => {
    void updateSettings({ agents: { quickPhrases: next } });
    setSaveStatus('saved');
    window.setTimeout(() => {
      setSaveStatus((s) => (s === 'saved' ? 'idle' : s));
    }, 1500);
  };

  const closeAllEditors = (): void => {
    setEditingId(null);
    setEditDraft(null);
    setNewDraft(null);
  };

  const startAdd = (): void => {
    setEditingId(null);
    setEditDraft(null);
    setNewDraft(emptyDraft());
  };

  const startEdit = (p: QuickPhrase): void => {
    setNewDraft(null);
    setEditingId(p.id);
    setEditDraft({ title: p.title, prompt: p.prompt });
  };

  const saveNew = (): void => {
    if (!newDraft) return;
    const validation = validateDraft(newDraft);
    if (!validation.ok) return;
    const normalized = normalizeDraft(newDraft);
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `qp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    commit([...phrases, { id, ...normalized }]);
    closeAllEditors();
  };

  const saveEdit = (): void => {
    if (!editDraft || editingId === null) return;
    const validation = validateDraft(editDraft);
    if (!validation.ok) return;
    const normalized = normalizeDraft(editDraft);
    commit(
      phrases.map((p) => (p.id === editingId ? { ...p, ...normalized } : p)),
    );
    closeAllEditors();
  };

  const deletePhrase = (id: string): void => {
    if (!window.confirm(t('preferences.quickPhrases.deleteConfirm'))) return;
    if (editingId === id) closeAllEditors();
    commit(phrases.filter((p) => p.id !== id));
  };

  const cancelNew = (): void => setNewDraft(null);
  const cancelEdit = (): void => {
    setEditingId(null);
    setEditDraft(null);
  };

  return (
    <div className="space-y-3">
      <SectionHeader
        title={t('preferences.quickPhrases.title')}
        description={t('preferences.quickPhrases.subtitle')}
      />

      {phrases.length === 0 && newDraft === null ? (
        <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-[var(--border)] px-4 text-center text-sm text-[var(--muted-foreground)]">
          {t('preferences.quickPhrases.empty')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]">
          {phrases.map((p, idx) => {
            const isEditing = editingId === p.id;
            const isLast = idx === phrases.length - 1 && newDraft === null;
            return (
              <div
                key={p.id}
                className={cn(
                  'px-3 py-2.5',
                  !isLast && 'border-b border-[var(--divider)]',
                )}
              >
                {isEditing && editDraft ? (
                  <DraftEditor
                    draft={editDraft}
                    onDraftChange={setEditDraft}
                    validation={validateDraft(editDraft)}
                    titleLabel={t('preferences.quickPhrases.field.title')}
                    promptLabel={t('preferences.quickPhrases.field.prompt')}
                    titlePlaceholder={t(
                      'preferences.quickPhrases.titlePlaceholder',
                    )}
                    promptPlaceholder={t(
                      'preferences.quickPhrases.promptPlaceholder',
                    )}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                  />
                ) : (
                  <ViewRow
                    phrase={p}
                    editLabel={t('common.edit')}
                    deleteLabel={t('preferences.quickPhrases.delete')}
                    onEdit={() => startEdit(p)}
                    onDelete={() => deletePhrase(p.id)}
                  />
                )}
              </div>
            );
          })}

          {newDraft !== null ? (
            <div className="px-3 py-2.5 border-t border-[var(--divider)]">
              <DraftEditor
                draft={newDraft}
                onDraftChange={setNewDraft}
                validation={validateDraft(newDraft)}
                titleLabel={t('preferences.quickPhrases.field.title')}
                promptLabel={t('preferences.quickPhrases.field.prompt')}
                titlePlaceholder={t(
                  'preferences.quickPhrases.titlePlaceholder',
                )}
                promptPlaceholder={t(
                  'preferences.quickPhrases.promptPlaceholder',
                )}
                onSave={saveNew}
                onCancel={cancelNew}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* 底部 action bar ── 与 AgentSection 的「[保存] 状态文字」节奏一致。
          不自动保存, 仅在点 + 添加 / 编辑保存时调用 commit() ── store
          内部 200ms debounce 落盘。 */}
      <div className="flex items-center gap-3 min-h-[2.25rem] pt-1">
        {newDraft === null ? (
          <Button onClick={startAdd}>
            <Plus className="size-3.5" />
            {t('preferences.quickPhrases.add')}
          </Button>
        ) : null}

        {saveStatus === 'saved' ? (
          <span className="flex items-center gap-1 text-xs text-[var(--success)]">
            <Check className="size-3.5" />
            {t('preferences.agent.saved')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ViewRow({
  phrase,
  editLabel,
  deleteLabel,
  onEdit,
  onDelete,
}: {
  phrase: QuickPhrase;
  editLabel: string;
  deleteLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="truncate text-sm text-[var(--foreground)]">
          {phrase.title}
        </div>
        <div className="line-clamp-2 break-words text-xs text-[var(--muted-foreground)]">
          {phrase.prompt}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip={editLabel}
          aria-label={editLabel}
          onClick={onEdit}
          className="rounded-lg"
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip={deleteLabel}
          aria-label={deleteLabel}
          onClick={onDelete}
          className="rounded-lg text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/** 行内展开的编辑器 ── 每个输入用 <Field title=...> 包一层, 视觉与 AgentSection
 *  的供应商 / 模型 / Base URL 表单同源: title 在上, input 在下。
 *
 *  提示词 Field 略有不同: title 行额外承载字符计数 ({count}/{max}),
 *  用 flex justify-between 让计数贴右 ── 与标题同行, 不占 textarea 下方空间。
 *  按钮顺序按用户要求 save (主) 在前, cancel (ghost) 在后。 */
function DraftEditor({
  draft,
  onDraftChange,
  validation,
  titleLabel,
  promptLabel,
  titlePlaceholder,
  promptPlaceholder,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onDraftChange: (next: Draft) => void;
  validation: { ok: true } | { ok: false; errorKey: I18nKey };
  titleLabel: string;
  promptLabel: string;
  titlePlaceholder: string;
  promptPlaceholder: string;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const showError: I18nKey | null = validation.ok ? null : validation.errorKey;
  const promptCount = draft.prompt.length;
  const overLimit = promptCount > MAX_QUICK_PHRASE_PROMPT_LENGTH;

  return (
    <div className="space-y-3">
      <Field title={titleLabel}>
        <Input
          type="text"
          value={draft.title}
          maxLength={MAX_QUICK_PHRASE_TITLE_LENGTH}
          placeholder={titlePlaceholder}
          onChange={(event) =>
            onDraftChange({ ...draft, title: event.target.value })
          }
          className={FIELD_INPUT_CLASS}
          autoFocus
          aria-invalid={
            showError === 'preferences.quickPhrases.titleRequired'
          }
        />
      </Field>

      {/* 提示词 Field ── 手写 title 行以承载右上角字数计数。
          跟标题 Field 视觉节奏一致, 不引入新的 primitive。 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <label className={FIELD_TITLE_CLASS}>{promptLabel}</label>
          <span
            className={cn(
              'text-[11px] tabular-nums text-[var(--muted-foreground)]',
              overLimit && 'text-[var(--destructive)]',
            )}
          >
            {promptCount}/{MAX_QUICK_PHRASE_PROMPT_LENGTH}
          </span>
        </div>
        <Textarea
          value={draft.prompt}
          maxLength={MAX_QUICK_PHRASE_PROMPT_LENGTH}
          placeholder={promptPlaceholder}
          rows={3}
          onChange={(event) =>
            onDraftChange({ ...draft, prompt: event.target.value })
          }
          className={cn(FIELD_INPUT_CLASS, 'min-h-[64px] text-sm')}
          aria-invalid={Boolean(showError)}
        />
      </div>

      {/* 底部 action bar ── save (primary) 在前, cancel (ghost) 在后,
          错误状态文字贴右对齐。 */}
      <div className="flex items-center gap-2 min-h-[2.25rem]">
        <Button type="button" onClick={onSave} disabled={!validation.ok}>
          {t('common.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {showError && showError !== 'preferences.quickPhrases.titleRequired' ? (
          <span className="text-xs text-[var(--destructive)]">
            {t(showError)}
          </span>
        ) : null}
      </div>
    </div>
  );
}