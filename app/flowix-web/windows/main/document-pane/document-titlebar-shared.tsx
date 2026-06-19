'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Ellipsis, Loader2, Paintbrush, Palette, Search } from 'lucide-react';
import {
  LinkSimpleIcon,
  CopyIcon,
  PushPinIcon,
  PushPinSlashIcon,
  FileMdIcon,
  FileDocIcon,
  ClockIcon,
  TrashIcon,
  BoxArrowDownIcon,
} from '@phosphor-icons/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../../../components/ui/dropdown-menu';
import { Tooltip } from '../../../components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog';
import {
  MEMO_COLORS,
  MEMO_COLOR_HEX,
  flushDocumentPath,
  getDocumentBuffer,
  useDocumentStore,
  type DocumentIdentity,
  type MemoColor,
  type MemoItem,
} from '../../../lib/store';
import { memos as memosClient, type MemoVersionMeta } from '../../../lib/tauri/client';
import { toast } from '../../../lib/toast';

/**
 * Document state for the titlebar. Exactly one is active at a time:
 *   - 'empty':    no memo, no external file (titlebar shows only the shell
 *                 and the optional sidebar toggle)
 *   - 'memo':     an internal memo is open → memo action group on the right
 *   - 'external': an external file is open → path display in the middle,
 *                 "保存为笔记" button on the right
 */
export type DocumentState = 'empty' | 'memo' | 'external';

// =====================================================================
// External file path display — platform-agnostic, zero-prop besides path
// =====================================================================

export function ExternalPathDisplay({ path }: { path: string }) {
  // Split "/Users/rop/.../file.md" into segments and drop the leading empty
  // entry from the leading slash. Trailing/duplicate slashes are also dropped
  // by filter(Boolean).
  const segments = path.split('/').filter(Boolean);

  return (
    <div className="w-fit max-w-full min-w-0 pl-3" title={path}>
      <div className="flex items-center overflow-hidden text-xs text-[var(--foreground)]">
        {segments.map((segment, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <ChevronRight
                aria-hidden="true"
                className="mx-1 h-3 w-3 shrink-0 text-[var(--muted-foreground)]"
              />
            )}
            <span className="shrink-0">{segment}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// External save button — icon + text identical across platforms,
// className (height / radius / bg / border / padding) supplied by caller
// =====================================================================

export function ExternalSaveButton({
  isSaving,
  onSave,
  className,
}: {
  isSaving: boolean;
  onSave: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={isSaving}
      className={className}
    >
      <BoxArrowDownIcon className="h-4 w-4" />
      <span className="text-xs">{isSaving ? '保存中...' : '保存为笔记'}</span>
    </button>
  );
}

// =====================================================================
// External copy-path button — icon only, iconButtonClass supplied by caller
// (uses the same class as the memo action icon buttons for visual unity)
// =====================================================================

export function ExternalCopyButton({
  onCopy,
  iconButtonClass,
}: {
  onCopy: () => void;
  iconButtonClass: string;
}) {
  return (
    <Tooltip content="复制完整路径">
      <button
        type="button"
        onClick={onCopy}
        aria-label="复制完整路径"
        className={iconButtonClass}
      >
        <CopyIcon className="w-4 h-4" />
      </button>
    </Tooltip>
  );
}

// =====================================================================
// Memo color picker — multi-select, dropdown of 7 swatches
// 触发按钮:
//   - 空数组 (无颜色) 时显示 `Palette` 图标
//   - 至少 1 个颜色时显示叠加的小圆点 (右上偏移, 制造"多色"的视觉密度)
// 7 个色块 + 1 个 "无" 按钮: 点色块 toggle, 点 "无" 清空全部。 每次切换
// 把整组新颜色走 `onChange` 一次性写回后端, 由 memo-event 链路回灌 store。
// =====================================================================

const COLOR_LABELS: Record<MemoColor, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  cyan: '青',
  blue: '蓝',
  gray: '灰',
};

export function MemoColorPicker({
  colors,
  iconButtonClass,
  onChange,
}: {
  colors: MemoColor[];
  iconButtonClass: string;
  onChange: (next: MemoColor[]) => void;
}) {
  const selected = new Set(colors);

  const toggle = (c: MemoColor) => {
    const next = new Set(selected);
    if (next.has(c)) {
      next.delete(c);
    } else {
      next.add(c);
    }
    // 保持 MEMO_COLORS 声明顺序, 列表 / 触发按钮展示稳定。
    onChange(MEMO_COLORS.filter((c) => next.has(c)));
  };

  const clear = () => onChange([]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tooltip content="文档颜色">
          <button
            type="button"
            aria-label="文档颜色"
            className={iconButtonClass}
          >
            {colors.length > 0 ? (
              <span aria-hidden="true" className="relative block h-3.5 w-3.5">
                {colors.slice(0, 3).map((c, i) => (
                  <span
                    key={c}
                    className="absolute h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor: MEMO_COLOR_HEX[c],
                      top: colors.length === 1 ? '2px' : `${(i % 2) * 4}px`,
                      left: colors.length === 1 ? '2px' : `${(i % 2) * 4}px`,
                      zIndex: 10 - i,
                    }}
                  />
                ))}
              </span>
            ) : (
              <Palette className="w-4 h-4" />
            )}
          </button>
        </Tooltip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[180px] p-2"
      >
        <div className="flex items-center gap-1.5">
          <Tooltip content="无颜色">
            <button
              type="button"
              aria-label="清除颜色"
              onClick={clear}
              className={`relative h-7 w-7 rounded-md transition-colors ${
                colors.length === 0
                  ? 'ring-2 ring-[var(--muted)]'
                  : 'hover:bg-[var(--muted)]'
              }`}
            >
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[var(--muted-foreground)]">
                <Paintbrush className="h-3.5 w-3.5" />
              </span>
            </button>
          </Tooltip>
          {MEMO_COLORS.map((c) => {
            const isSelected = selected.has(c);
            return (
              <Tooltip key={c} content={COLOR_LABELS[c]}>
                <button
                  type="button"
                  aria-label={COLOR_LABELS[c]}
                  aria-pressed={isSelected}
                  onClick={() => toggle(c)}
                  className="relative h-7 w-7 rounded-md transition-transform hover:scale-110"
                  style={{ backgroundColor: MEMO_COLOR_HEX[c] }}
                >
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-70"
                    >
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// =====================================================================
// Memo action group — color + search + ellipsis dropdown
// iconButtonClass (size / radius / bg / border) supplied by caller
// =====================================================================

const VERSION_SOURCE_LABELS: Record<MemoVersionMeta['source'], string> = {
  auto: '自动',
  manual: '手动',
  restore_backup: '恢复前',
};

function formatVersionTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatVersionSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function VersionHistorySubmenu({
  memoId,
  refreshKey,
  restoringVersionId,
  onSelectVersion,
}: {
  memoId: string;
  refreshKey: number;
  restoringVersionId: string | null;
  onSelectVersion: (version: MemoVersionMeta) => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<MemoVersionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    void memosClient.listVersions(memoId)
      .then((items) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        setVersions(items);
      })
      .catch((err) => {
        if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
        console.error('[VersionHistorySubmenu] listVersions failed', err);
        setError('读取失败');
      })
      .finally(() => {
        if (mountedRef.current && requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      });
  }, [open, memoId, refreshKey]);

  const orderedVersions = useMemo(
    () => [...versions].sort((a, b) => b.createdAt - a.createdAt),
    [versions],
  );

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--muted)]"
        onFocus={() => setOpen(true)}
      >
        <ClockIcon className="w-4 h-4 mr-2" />
        <span className="flex-1 text-left">历史版本</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
      </button>

      {open && (
        <div className="absolute right-full top-0 z-[1001] w-[300px] rounded-lg border border-[var(--border)] bg-[var(--card)] py-2 shadow-lg">
          <div className="flex items-center justify-between px-3 pb-2">
            <div className="text-xs font-medium text-[var(--foreground)]">全部历史版本</div>
            <div className="text-[11px] text-[var(--muted-foreground)]">
              {orderedVersions.length}/20
            </div>
          </div>

          <div className="max-h-[272px] overflow-y-auto px-1">
            {loading && (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--muted-foreground)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在读取
              </div>
            )}

            {!loading && error && (
              <div className="px-2 py-3 text-xs text-[var(--destructive)]">{error}</div>
            )}

            {!loading && !error && orderedVersions.length === 0 && (
              <div className="px-2 py-3 text-xs text-[var(--muted-foreground)]">
                暂无历史版本
              </div>
            )}

            {!loading && !error && orderedVersions.map((version) => {
              const isRestoring = restoringVersionId === version.id;
              return (
              <button
                key={version.id}
                type="button"
                disabled={isRestoring}
                onClick={() => {
                  setOpen(false);
                  onSelectVersion(version);
                }}
                className="block w-full rounded-md px-2 py-2 text-left hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60"
                title={version.title || version.filename}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">
                    {formatVersionTime(version.createdAt)}
                  </span>
                  {isRestoring && (
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--muted-foreground)]" />
                  )}
                  <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                    {VERSION_SOURCE_LABELS[version.source] ?? version.source}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
                  <span className="min-w-0 flex-1 truncate">
                    {version.title || version.filename}
                  </span>
                  <span className="shrink-0">{formatVersionSize(version.size)}</span>
                </div>
              </button>
            )})}
          </div>
        </div>
      )}
    </div>
  );
}

export function MemoActions({
  memo,
  iconButtonClass,
  onOpenSearch,
  onCopyLink,
  onCopyFullText,
  onTogglePin,
  onExportMarkdown,
  onExportWord,
  onRequestDeleteMemo,
  onColorsChange,
}: {
  memo: MemoItem;
  iconButtonClass: string;
  onOpenSearch: () => void;
  onCopyLink: () => void;
  onCopyFullText: () => void;
  onTogglePin: () => void;
  onExportMarkdown: () => void;
  onExportWord: () => void;
  onRequestDeleteMemo: () => void;
  onColorsChange: (next: MemoColor[]) => void;
}) {
  const isPinned = !!memo.favorited;
  const [confirmVersion, setConfirmVersion] = useState<MemoVersionMeta | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);

  const handleConfirmRestoreVersion = async () => {
    if (!confirmVersion || restoringVersionId) return;

    const version = confirmVersion;
    const identity: DocumentIdentity = { kind: 'memo', id: memo.id };
    setRestoringVersionId(version.id);

    try {
      const activeMemoSession = useDocumentStore.getState().activeMemoSession;
      const activePath = activeMemoSession?.memoId === memo.id
        ? activeMemoSession.path
        : null;

      if (activePath) {
        const flushed = await flushDocumentPath(identity, activePath);
        if (!flushed) {
          toast.error('保存当前内容失败，未切换版本');
          return;
        }
      }

      const expectedContent = activePath
        ? getDocumentBuffer(identity).lastSavedContent
        : undefined;
      const restored = await memosClient.restoreVersion(memo.id, version.id, expectedContent);

      if (!restored) {
        toast.error('切换版本失败');
        return;
      }

      const latestActiveMemoSession = useDocumentStore.getState().activeMemoSession;
      if (latestActiveMemoSession?.memoId === memo.id) {
        useDocumentStore.getState().replaceActiveMemoPath(memo.id, restored.path);
        window.dispatchEvent(new CustomEvent('flowix:memo-version-restored', {
          detail: {
            memoId: memo.id,
            path: restored.path,
            content: restored.content,
          },
        }));
      }

      setConfirmVersion(null);
      setVersionRefreshKey((key) => key + 1);
      toast.success('已切换到历史版本');
    } catch (err) {
      console.error('[MemoActions] restore version failed', err);
      toast.error('切换版本失败');
    } finally {
      setRestoringVersionId(null);
    }
  };

  return (
    <>
      <MemoColorPicker
        colors={memo.colors}
        iconButtonClass={iconButtonClass}
        onChange={onColorsChange}
      />
      <Tooltip content="文档搜索" shortcut="editor.find">
        <button
          onClick={onOpenSearch}
          className={iconButtonClass}
        >
          <Search className="w-4 h-4" />
        </button>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Tooltip content="更多">
            <button className={iconButtonClass}>
              <Ellipsis className="w-4 h-4" />
            </button>
          </Tooltip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px] px-1 py-1.5 space-y-1">
          <DropdownMenuItem
            onClick={onCopyLink}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <LinkSimpleIcon className="w-4 h-4 mr-2" /> 复制链接
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onCopyFullText}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <CopyIcon className="w-4 h-4 mr-2" /> 复制全文
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onTogglePin}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            {isPinned ? (
              <><PushPinSlashIcon className="w-4 h-4 mr-2" /> 取消置顶</>
            ) : (
              <><PushPinIcon className="w-4 h-4 mr-2" /> 置顶</>
            )}
          </DropdownMenuItem>
          <hr className="mx-2 border-t border-[var(--border)] opacity-50" />
          <DropdownMenuItem
            onClick={onExportMarkdown}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <FileMdIcon className="w-4 h-4 mr-2" /> 导出为 Markdown
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onExportWord}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
          >
            <FileDocIcon className="w-4 h-4 mr-2" /> 导出为 Word
          </DropdownMenuItem>
          <hr className="mx-2 border-t border-[var(--border)] opacity-50" />
          <VersionHistorySubmenu
            memoId={memo.id}
            refreshKey={versionRefreshKey}
            restoringVersionId={restoringVersionId}
            onSelectVersion={setConfirmVersion}
          />
          <DropdownMenuItem
            onClick={onRequestDeleteMemo}
            className="flex items-center cursor-pointer rounded-md px-2 hover:bg-[var(--muted)] text-[var(--destructive)]"
          >
            <TrashIcon className="w-4 h-4 mr-2" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!confirmVersion} onOpenChange={(open) => !open && setConfirmVersion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认是否切换版本</DialogTitle>
            <DialogDescription>
              确定切换到 {confirmVersion ? formatVersionTime(confirmVersion.createdAt) : ''} 版本使用吗？当前内容会先保存为一个历史版本。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={!!restoringVersionId}
              onClick={() => setConfirmVersion(null)}
              className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!!restoringVersionId}
              onClick={handleConfirmRestoreVersion}
              className="inline-flex h-8 items-center gap-2 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {restoringVersionId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              确定
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
