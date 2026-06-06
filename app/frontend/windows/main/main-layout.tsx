'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { MenuBoard } from './menu-board';
import { DocumentContainer } from './document-pane/document-container';
import { DocumentTitlebarWin } from './document-pane/document-titlebar-win';
import { DocumentTitlebarMac } from './document-pane/document-titlebar-mac';
import { MemoList } from './memo-pane/memo-list';
import { MemoListTitlebarWin } from './memo-pane/memo-list-titlebar-win';
import { MemoListTitlebarMac } from './memo-pane/memo-list-titlebar-mac';
import { AgentChatRoot } from './agent-panel/agent-root';
import { useTauriRpc } from '../../hooks/useTauriRpc';
import { useMemoStore, useDocumentStore, useSettingsStore, type Notebook, type MemoItem } from '../../lib/store';
import { files, memos as memosClient, notebooks as notebooksClient, dialogs, type SaveFileFilter, windows } from '../../lib/tauri/client';
import { WindowsTitlebarControls } from '../../components/windows-titlebar-controls';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from '../../lib/toast';
import {
  buildWordHtml,
  markdownToHtml,
  sanitizeFileName,
  stripFrontmatter,
} from '../../lib/export';
import { StatusBar } from './status-bar/status-bar';
import { NotebookDeleteDialog } from './notebook-delete-dialog';

interface MemoMetadataFile {
  todos?: unknown[];
}

type ExportableDocument = { title: string; markdown: string };

const EXTERNAL_MARKDOWN_OPENED_EVENT = 'external-markdown-opened';
const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i;

function isWindowsPlatform(): boolean {
  return /Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform);
}

function getNotebookMemoMetadataPath(notebookPath: string): string {
  const clean = notebookPath.replace(/[\\/]+$/, '');
  return `${clean}/.metadata/memo.json`;
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION_PATTERN.test(path);
}

function extractTitleFromMarkdown(body: string): string {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed
      .replace(/^#+\s*/, '')
      .replace(/^[-*+]\s*\[[ xX]?\]\s*/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .slice(0, 120);
  }
  return '';
}

function firstMarkdownPath(paths?: string[]): string | undefined {
  return paths?.find(isMarkdownPath);
}

export function MainLayout() {
  const { memos, notebooks, selectedMemo, selectedNotebook, refreshTrigger, activeSort, setActiveFilter, loadMemos, setSelectedMemo, setSelectedNotebook, setNotebooks, triggerRefresh, updateMemoMeta } = useMemoStore();
  const { currentDocumentPath, currentDocumentSource, setCurrentExternalDocumentPath } = useDocumentStore();
  const {
    memoListVisible,
    agentPanelVisible,
    agentColWidth,
    setMemoListVisible,
    toggleMemoListVisible,
    toggleAgentPanelVisible,
    setAgentColWidth,
  } = useSettingsStore();
  const [isMenuBoardOpen, setIsMenuBoardOpen] = useState(false);
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);
  const [notebookToDelete, setNotebookToDelete] = useState<Notebook | null>(null);
  const { request } = useTauriRpc();
  const [memoColWidth, setMemoColWidth] = useState(320);
  const [agentPanelDraftWidth, setAgentPanelDraftWidth] = useState(agentColWidth);
  const [isDraggingListDivider, setIsDraggingListDivider] = useState(false);
  const [isDraggingAgentDivider, setIsDraggingAgentDivider] = useState(false);
  const [isSrcView, setIsSrcView] = useState(false);
  const [charCount, setCharCount] = useState(0);
  const [todoCount, setTodoCount] = useState(0);
  const [currentDocumentContent, setCurrentDocumentContent] = useState('');
  const listDividerStartRef = useRef({ x: 0, width: 0 });
  const agentDividerStartRef = useRef({ x: 0, width: agentColWidth });
  const agentPanelDraftWidthRef = useRef(agentColWidth);
  const isMemoListHidden = !memoListVisible;
  const memoListWidth = isMemoListHidden ? 0 : memoColWidth;
  const agentPanelWidth = agentPanelVisible ? agentPanelDraftWidth : 0;

  useEffect(() => {
    if (isDraggingAgentDivider) return;
    setAgentPanelDraftWidth(agentColWidth);
    agentPanelDraftWidthRef.current = agentColWidth;
  }, [agentColWidth, isDraggingAgentDivider]);

  // Memo list divider drag
  const handleListDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingListDivider(true);
    listDividerStartRef.current = { x: e.clientX, width: memoColWidth };
  }, [memoColWidth]);

  // Agent panel divider drag
  const handleAgentDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingAgentDivider(true);
    agentDividerStartRef.current = { x: e.clientX, width: agentPanelDraftWidth };
    agentPanelDraftWidthRef.current = agentPanelDraftWidth;
  }, [agentPanelDraftWidth]);

  useEffect(() => {
    if (!isDraggingListDivider && !isDraggingAgentDivider) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingListDivider) {
        const diff = e.clientX - listDividerStartRef.current.x;
        const newW = listDividerStartRef.current.width + diff;
        if (newW >= 150 && newW <= 500) setMemoColWidth(newW);
      }
      if (isDraggingAgentDivider) {
        const diff = agentDividerStartRef.current.x - e.clientX;
        const newW = agentDividerStartRef.current.width + diff;
        if (newW >= 200 && newW <= 600) {
          agentPanelDraftWidthRef.current = newW;
          setAgentPanelDraftWidth(newW);
        }
      }
    };

    const handleMouseUp = () => {
      if (isDraggingAgentDivider) {
        setAgentColWidth(agentPanelDraftWidthRef.current);
      }
      setIsDraggingListDivider(false);
      setIsDraggingAgentDivider(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingListDivider, isDraggingAgentDivider, setAgentColWidth]);

  // Narrow window: opening the agent panel auto-collapses the memo list to
  // reclaim horizontal space. We only act on the false→true transition, so
  // once the agent panel is open the user can freely re-open the memo list
  // without us fighting them.
  const prevAgentPanelVisibleRef = useRef(agentPanelVisible);
  useEffect(() => {
    if (
      agentPanelVisible &&
      !prevAgentPanelVisibleRef.current &&
      window.innerWidth < 1100 &&
      memoListVisible
    ) {
      setMemoListVisible(false);
    }
    prevAgentPanelVisibleRef.current = agentPanelVisible;
  }, [agentPanelVisible, memoListVisible, setMemoListVisible]);

  const currentMemo = currentDocumentPath && currentDocumentSource === 'memo' ? selectedMemo : null;
  const isExternalDocument = currentDocumentSource === 'external';

  const openExternalDocument = useCallback((path: string | undefined) => {
    if (!path || !isMarkdownPath(path)) return;
    setSelectedMemo(null);
    setCurrentExternalDocumentPath(path);
    setIsSrcView(false);
  }, [setCurrentExternalDocumentPath, setSelectedMemo]);

  useEffect(() => {
    setCurrentDocumentContent('');
  }, [currentDocumentPath]);

  const writeClipboardText = useCallback(async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }, []);

  const handleCopyFullText = useCallback(async () => {
    if (!currentDocumentPath) return;

    try {
      const content = currentDocumentContent || await memosClient.readDocument(currentDocumentPath) || '';
      await writeClipboardText(content);
      toast.success('复制成功');
    } catch (error) {
      console.warn('[MainLayout] Failed to copy document content:', error);
      toast.error('复制失败');
    }
  }, [currentDocumentContent, currentDocumentPath, writeClipboardText]);

  const handleCopyLink = useCallback(async () => {
    if (!currentDocumentPath) return;

    try {
      await writeClipboardText(currentDocumentPath);
      toast.success('复制成功');
    } catch (error) {
      console.warn('[MainLayout] Failed to copy document link:', error);
      toast.error('复制失败');
    }
  }, [currentDocumentPath, writeClipboardText]);

  const handleTogglePin = useCallback(async () => {
    if (!currentMemo) return;

    const wasFavorited = currentMemo.favorited;
    try {
      const ok = wasFavorited
        ? await memosClient.unfavoriteMemo(currentMemo.id)
        : await memosClient.favoriteMemo(currentMemo.id);

      if (!ok) {
        toast.error(wasFavorited ? '取消置顶失败' : '置顶失败');
        return;
      }

      updateMemoMeta(currentMemo.id, { favorited: !wasFavorited });
      toast.success(wasFavorited ? '取消置顶成功' : '置顶成功');
    } catch (error) {
      console.warn('[MainLayout] Failed to toggle pin:', error);
      toast.error(wasFavorited ? '取消置顶失败' : '置顶失败');
    }
  }, [currentMemo, updateMemoMeta]);

  const getExportableDocument = useCallback(async (): Promise<ExportableDocument | null> => {
    if (!currentDocumentPath) return null;

    let raw = currentDocumentContent;
    if (!raw) {
      try {
        raw = (await memosClient.readDocument(currentDocumentPath)) ?? '';
      } catch (error) {
        console.warn('[MainLayout] Failed to read document for export:', error);
        toast.error('读取文档失败');
        return null;
      }
    }

    const title = currentMemo?.filename || extractTitleFromMarkdown(stripFrontmatter(raw)) || 'Untitled';
    return { title, markdown: raw };
  }, [currentDocumentContent, currentDocumentPath, currentMemo?.filename]);

  const requireExportableDocument = useCallback(async () => {
    const doc = await getExportableDocument();
    if (!doc) {
      toast.error('没有可导出的文档');
      return null;
    }
    return doc;
  }, [getExportableDocument]);

  const promptExportTarget = useCallback(async (doc: ExportableDocument, extension: string, filter: SaveFileFilter) => {
    return dialogs.saveFile(`${sanitizeFileName(doc.title)}.${extension}`, [filter]);
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    const doc = await requireExportableDocument();
    if (!doc) return;

    const target = await promptExportTarget(doc, 'md', { name: 'Markdown', extensions: ['md', 'markdown'] });
    if (!target) return;

    const ok = await dialogs.writeExportFile(target, doc.markdown);
    toast[ok ? 'success' : 'error'](ok ? '已导出 Markdown' : '导出失败');
  }, [promptExportTarget, requireExportableDocument]);

  const handleExportWord = useCallback(async () => {
    const doc = await requireExportableDocument();
    if (!doc) return;

    const target = await promptExportTarget(doc, 'doc', { name: 'Word 文档', extensions: ['doc'] });
    if (!target) return;

    let bodyHtml: string;
    try {
      bodyHtml = markdownToHtml(doc.markdown);
    } catch (error) {
      console.warn('[MainLayout] Failed to convert markdown for Word export:', error);
      toast.error('导出失败');
      return;
    }

    const ok = await dialogs.writeExportFile(target, buildWordHtml(doc.title, bodyHtml));
    toast[ok ? 'success' : 'error'](ok ? '已导出 Word 文档' : '导出失败');
  }, [promptExportTarget, requireExportableDocument]);

  const handleOpenTodos = useCallback(async () => {
    setMemoListVisible(true);
    setActiveFilter('todos');
    await loadMemos({
      notebookId: selectedNotebook?.id,
      filter: 'todos',
      sort: activeSort,
    });
  }, [activeSort, loadMemos, selectedNotebook?.id, setActiveFilter, setMemoListVisible]);

  const handleSelectNotebook = useCallback(
    async (notebook: Notebook) => {
      if (selectedNotebook?.id === notebook.id) return;
      setSelectedNotebook(notebook);
      setSelectedMemo(null);
      useDocumentStore.getState().setCurrentDocumentPath(null);
      try {
        await request('set_current_notebook', { notebookId: notebook.id });
      } catch (error) {
        console.warn('[MainLayout] Failed to sync current notebook:', error);
      }
      triggerRefresh();
    },
    [request, selectedNotebook?.id, setSelectedMemo, setSelectedNotebook, triggerRefresh]
  );

  const handleEditNotebook = useCallback(
    (notebook: Notebook) => {
      // Close the dropdown first so it doesn't overlap the dialog.
      setNotebookPopupOpen(false);
      // Defer to next tick so the dropdown finishes closing before the dialog opens.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent<Notebook>('woop:open-edit-notebook', { detail: notebook }));
      }, 0);
    },
    []
  );

  const handleDeleteNotebook = useCallback(
    (notebook: Notebook) => {
      if (notebook.isDefault) {
        toast.error('默认笔记本不可删除');
        return;
      }
      // Close the dropdown so the confirmation dialog isn't visually stacked
      // on top of the popup, then open the confirmation dialog on the next
      // tick (the dropdown needs a frame to start its close transition).
      setNotebookPopupOpen(false);
      setTimeout(() => {
        setNotebookToDelete(notebook);
      }, 0);
    },
    []
  );

  const handleConfirmDeleteNotebook = useCallback(async () => {
    const target = notebookToDelete;
    if (!target) return;
    try {
      const ok = await notebooksClient.delete(target.id);
      if (ok) {
        toast.success('已删除');
        const nbList = await notebooksClient.getAll();
        if (nbList) setNotebooks(nbList);
      } else {
        toast.error('删除失败');
      }
    } catch (error) {
      console.warn('[MainLayout] Failed to delete notebook:', error);
      toast.error('删除失败');
    } finally {
      setNotebookToDelete(null);
    }
  }, [notebookToDelete, setNotebooks]);

  // Document titlebar's more → delete menu: hand off to MemoList, which owns
  // the delete-memo confirmation dialog. We use a custom event (same pattern
  // as the notebook edit dialog) so MainLayout doesn't need to lift MemoList's
  // state up.
  const handleRequestDeleteMemo = useCallback(() => {
    if (!currentMemo) return;
    window.dispatchEvent(
      new CustomEvent<MemoItem>('woop:request-delete-memo', { detail: currentMemo })
    );
  }, [currentMemo]);

  useEffect(() => {
    let cancelled = false;

    async function loadNotebookTodoCount() {
      if (!selectedNotebook?.path) {
        setTodoCount(0);
        return;
      }

      try {
        const content = await files.read(
          getNotebookMemoMetadataPath(selectedNotebook.path),
          selectedNotebook.path
        );
        if (cancelled) return;

        if (!content) {
          setTodoCount(0);
          return;
        }

        const metadata = JSON.parse(content) as MemoMetadataFile;
        setTodoCount(Array.isArray(metadata.todos) ? metadata.todos.length : 0);
      } catch (error) {
        if (!cancelled) {
          console.warn('[MainLayout] Failed to read memo metadata todos:', error);
          setTodoCount(0);
        }
      }
    }

    loadNotebookTodoCount();

    return () => {
      cancelled = true;
    };
  }, [selectedNotebook?.path, refreshTrigger, memos.length]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    memosClient.getLaunchOpenFiles()
      .then((paths) => {
        const path = firstMarkdownPath(paths);
        if (!disposed && path) {
          openExternalDocument(path);
        }
      })
      .catch((error) => console.warn('[MainLayout] Failed to read launch files:', error));

    listen<string[]>(EXTERNAL_MARKDOWN_OPENED_EVENT, (event) => {
      openExternalDocument(firstMarkdownPath(event.payload));
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openExternalDocument]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      openExternalDocument(firstMarkdownPath(event.payload.paths));
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch((error) => {
      console.warn('[MainLayout] Failed to listen for file drops:', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openExternalDocument]);

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ backgroundColor: 'var(--memo-detail-bg)' }}>
      <WindowsTitlebarControls />
      <MenuBoard open={isMenuBoardOpen} onOpenChange={setIsMenuBoardOpen} />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex flex-1 h-full overflow-hidden">
          {/* Memo list column */}
          <div
            className={`flex flex-col overflow-hidden will-change-[width] ${
              isDraggingListDivider ? 'transition-none' : 'transition-[width] duration-150 ease-out'
            }`}
            style={{ width: memoListWidth, flexShrink: 0 }}
            aria-hidden={isMemoListHidden}
          >
            <div
              className={`flex flex-col overflow-hidden h-full bg-white border-black/5 border-r border-black/5 transition-transform duration-150 ease-out will-change-transform ${
                isMemoListHidden ? '-translate-x-full' : 'translate-x-0'
              }`}
              style={{ width: memoColWidth }}
            >
              {isWindowsPlatform() ? (
                <MemoListTitlebarWin
                  onCollapseSidebar={() => setMemoListVisible(false)}
                  onOpenPreferences={() => windows.openPreferences()}
                />
              ) : (
                <MemoListTitlebarMac
                  onCollapseSidebar={() => setMemoListVisible(false)}
                  onOpenPreferences={() => windows.openPreferences()}
                />
              )}
              <div className="flex-1 min-h-0">
                <MemoList />
              </div>
            </div>
          </div>
          {/* List <-> Memo detail divider */}
          {!isMemoListHidden && (
            <div className="relative w-[1px] h-full cursor-col-resize group z-10" onMouseDown={handleListDividerMouseDown}>
              <div className="absolute inset-0 -translate-x-1/2 w-[12px] left-1/2 bg-transparent z-11" />
              <div className={`w-[1px] h-full transition-colors ${isDraggingListDivider ? 'bg-transparent' : 'group-hover:bg-transparent bg-transparent'}`} />
            </div>
          )}
          {/* Memo detail */}
            <div className="h-full min-w-0 relative flex flex-col" style={{ minWidth: 200, flex: 1 }}>
            {/* Fixed top navigation bar */}
            {isWindowsPlatform() ? (
              <DocumentTitlebarWin
                currentMemo={currentMemo}
                isSidebarHidden={isMemoListHidden}
                isAgentPanelVisible={agentPanelVisible}
                isSrcView={isSrcView}
                onToggleSidebar={toggleMemoListVisible}
                onToggleSrcView={() => setIsSrcView(v => !v)}
                onCopyLink={handleCopyLink}
                onCopyFullText={handleCopyFullText}
                onTogglePin={handleTogglePin}
                onExportMarkdown={handleExportMarkdown}
                onExportWord={handleExportWord}
                onRequestDeleteMemo={handleRequestDeleteMemo}
              />
            ) : (
              <DocumentTitlebarMac
                currentMemo={currentMemo}
                isSidebarHidden={isMemoListHidden}
                isSrcView={isSrcView}
                onToggleSidebar={toggleMemoListVisible}
                onToggleSrcView={() => setIsSrcView(v => !v)}
                onCopyLink={handleCopyLink}
                onCopyFullText={handleCopyFullText}
                onTogglePin={handleTogglePin}
                onExportMarkdown={handleExportMarkdown}
                onExportWord={handleExportWord}
                onRequestDeleteMemo={handleRequestDeleteMemo}
              />
            )}

            {/* Content area */}
            <div className="flex-1 min-w-0 overflow-hidden">
              {currentDocumentPath ? (
                <DocumentContainer
                  key={currentDocumentPath}
                  filePath={currentDocumentPath}
                  isExternalDocument={isExternalDocument}
                  isSrcView={isSrcView}
                  onMetainfoData={(data) => setCurrentDocumentContent(data.memoContent)}
                  onCharCountChange={setCharCount}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-center text-[var(--muted-foreground)] text-sm">
                  请选择一个 Memo 文档
                </div>
              )}
            </div>
          </div>
          {/* Agent chat panel divider */}
            <div
              className={`relative h-full group z-10 overflow-hidden ${
                isDraggingAgentDivider ? 'transition-none' : 'transition-[width,opacity] duration-150 ease-out'
              } ${
                agentPanelVisible ? 'cursor-col-resize opacity-100' : 'pointer-events-none opacity-0'
              }`}
              style={{ width: agentPanelVisible ? 1 : 0, flexShrink: 0 }}
              onMouseDown={agentPanelVisible ? handleAgentDividerMouseDown : undefined}
            >
              <div className="absolute inset-0 -translate-x-1/2 w-[12px] left-1/2 bg-transparent z-11" />
              <div className="w-[1px] h-full transition-colors bg-transparent" />
            </div>
          {/* Agent chat panel */}
            <div
              className={`h-full flex-shrink-0 overflow-hidden will-change-[width] ${
                isDraggingAgentDivider ? 'transition-none' : 'transition-[width] duration-150 ease-out'
              }`}
              style={{ width: agentPanelWidth }}
              aria-hidden={!agentPanelVisible}
            >
              <div
                className={`h-full overflow-hidden bg-[#f7f7f7]/95 border-black/5 border-l border-[var(--border)] transition-transform duration-150 ease-out will-change-transform ${
                  agentPanelVisible ? 'translate-x-0' : 'translate-x-full'
                }`}
                style={{ width: agentPanelDraftWidth }}
              >
                <AgentChatRoot onClosePanel={toggleAgentPanelVisible} />
              </div>
            </div>
          </div>
          {/* Status bar */}
          <StatusBar
            memoColWidth={memoColWidth}
            notebooks={notebooks}
            selectedNotebook={selectedNotebook}
            notebookPopupOpen={notebookPopupOpen}
            setNotebookPopupOpen={setNotebookPopupOpen}
            onSelectNotebook={handleSelectNotebook}
            onEditNotebook={handleEditNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onRefreshNotebooks={(nbList) => setNotebooks(nbList)}
            todoCount={todoCount}
            onOpenTodos={handleOpenTodos}
            charCount={charCount}
            onToggleAgentPanel={toggleAgentPanelVisible}
            onOpenPreferences={() => windows.openPreferences()}
          />
        </div>
      </div>

      <NotebookDeleteDialog
        target={notebookToDelete ? { id: notebookToDelete.id, name: notebookToDelete.name } : null}
        onCancel={() => setNotebookToDelete(null)}
        onConfirm={handleConfirmDeleteNotebook}
      />
    </div>
  );
}
