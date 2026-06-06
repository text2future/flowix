'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useDocumentStore, useMemoStore, type MemoItem } from '../../../lib/store';
import { formatDateTime } from '../../../lib/utils';
import { ComnTiptapEditor } from '../../../components/mdeditor/comn-tiptap-editor';
import { SrcEditor } from '../../../components/srceditor/src-editor';
import { memos as memosClient } from '../../../lib/tauri/client';
import { listen } from '@tauri-apps/api/event';
import { Save } from 'lucide-react';

interface LoadContentOptions {
  preservePending?: boolean;
  showLoading?: boolean;
}

interface ParsedFrontmatter {
  filename?: string;
  title?: string;
  tags?: string[];
  todos?: Array<{ content: string; status: string }>;
}

function extractBodyContent(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function countTextUnits(content: string): number {
  const chineseChars = content.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = content.match(/[A-Za-z]+/g)?.length ?? 0;

  return chineseChars + englishWords;
}
function extractTagsFromBody(content: string): string[] {
  const body = extractBodyContent(content);
  const tagSet = new Set<string>();
  const tagRegex = /#([^\s\p{P}]+)(?=$|[\s\p{P}])/gu;
  let match;
  while ((match = tagRegex.exec(body)) !== null) {
    const tag = match[1];
    if (tag.length > 0) {
      tagSet.add(tag);
    }
  }
  return Array.from(tagSet);
}

function extractTodosFromBody(content: string): Array<{ content: string; status: string }> {
  const body = extractBodyContent(content);
  const todos: Array<{ content: string; status: string }> = [];
  const todoRegex = /^(\s*)- \[([ x])\][^\S\r\n]*(.*)$/gm;
  let match;
  while ((match = todoRegex.exec(body)) !== null) {
    const todoContent = match[3].trim();
    if (isBlankLine(todoContent)) continue;

    todos.push({
      content: todoContent,
      status: match[2].toLowerCase() === 'x' ? 'completed' : 'pending',
    });
  }
  return todos;
}

function extractTitleAndPreview(content: string): { title: string; preview: string } {
  const body = extractBodyContent(content);
  const lines = body.split('\n').map(line => line.trim()).filter(line => !isBlankLine(line));

  const title = lines.length > 0 ? stripMarkdown(lines[0]) : '';
  const preview = lines.length > 1 ? stripMarkdown(lines[1]).slice(0, 200) : '';

  return { title, preview };
}

function isBlankLine(line: string): boolean {
  return line.replace(/&nbsp;|\u00a0/gi, '').trim() === '';
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};

  const fmStr = match[1];
  const result: ParsedFrontmatter = {};

  fmStr.split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'title' || key === 'filename') {
      result.filename = value.replace(/^["']|["']$/g, '');
    } else if (key === 'tags') {
      const tagMatch = value.match(/\[(.*)\]/);
      if (tagMatch) {
        result.tags = tagMatch[1].split(',').map(t => t.trim().replace(/^["']|["']$/g, ''));
      }
    } else if (key === 'todos') {
      // Simple todos parsing: - [ ] content or - [x] content
      const todos: Array<{ content: string; status: string }> = [];
      const lines = fmStr.split('\n');
      let inTodos = false;
      for (const l of lines) {
        const todoMatch = l.match(/^\s*-\s*\[([ x])\]\s*(.+)/);
        if (todoMatch) {
          const todoContent = todoMatch[2].trim();
          if (isBlankLine(todoContent)) continue;

          inTodos = true;
          todos.push({
            content: todoContent,
            status: todoMatch[1] === 'x' ? 'completed' : 'pending',
          });
        } else if (inTodos && !l.match(/^\s*-\s*\[/) && l.trim() !== '') {
          inTodos = false;
        }
      }
      if (todos.length > 0) result.todos = todos;
    }
  });

  return result;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#+\s*/, '')       // Headers (# ## ### etc.)
    .replace(/^\s*[-*+]\s*\[[ xX]?\]\s*/, '') // Todo list markers (- [ ] / - [x])
    .replace(/^\s*\[[ xX]?\]\s*/, '') // Bare todo markers ([ ] / [x])
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // Bold
    .replace(/\*([^*]+)\*/g, '$1')      // Italic
    .replace(/__([^_]+)__/g, '$1')    // Bold (underscore)
    .replace(/_([^_]+)_/g, '$1')       // Italic (underscore)
    .replace(/`([^`]+)`/g, '$1')       // Inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Links [text](url)
    .replace(/^[-*+]\s+/, '')    // Unordered list markers
    .replace(/^\d+\.\s+/, '')    // Ordered list markers
    .replace(/^>\s+/, '')        // Blockquotes
    .replace(/^\|\s*|\s*\|$/g, '') // Table row markers
    .replace(/\s+/g, ' ')        // Collapse multiple spaces
    .trim();
}

interface DocumentContainerState {
  // fullContent includes frontmatter + body markdown
  fullContent: string;
  isLoading: boolean;
  error: string | null;
  isScrolled: boolean;
  isNewlyCreated: boolean;
  charCount: number;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
  updatedAtDate: Date | null;
  isFavorited: boolean;
  frontmatterMeta: Record<string, unknown>;
}

interface DocumentContainerProps {
  filePath: string;
  onMetainfoData?: (data: {
    charCount: number;
    tokenCount: number;
    createdAt: string;
    updatedAt: string;
    memoPath: string | null;
    memoContent: string;
    isFavorited: boolean;
    frontmatterMeta: Record<string, unknown>;
  }) => void;
  onCharCountChange?: (count: number) => void;
  isSrcView?: boolean;
  isExternalDocument?: boolean;
}

const initialState: DocumentContainerState = {
  fullContent: '',
  isLoading: false,
  error: null,
  isScrolled: false,
  isNewlyCreated: false,
  charCount: 0,
  tokenCount: 0,
  createdAt: '',
  updatedAt: '',
  updatedAtDate: null,
  isFavorited: false,
  frontmatterMeta: {},
};

function joinPath(basePath: string, filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\')) {
    return filePath;
  }
  return `${basePath.replace(/[\\/]+$/, '')}\\${filePath.replace(/^[\\/]+/, '')}`;
}

function resolveMemoDocumentPath(notebookPath: string | undefined, memo: MemoItem, fallbackPath: string): string {
  if (!notebookPath || !memo.path) {
    return memo.path ?? fallbackPath;
  }

  return joinPath(notebookPath, memo.path);
}

export function DocumentContainer({ filePath, onMetainfoData, onCharCountChange, isSrcView = false, isExternalDocument = false }: DocumentContainerProps) {
  const [state, setState] = useState<DocumentContainerState>(initialState);
  const [isImportingExternal, setIsImportingExternal] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<string>('');
  const lastSavedContentRef = useRef<string>('');
  const lastFrontmatterRef = useRef<ParsedFrontmatter>({});
  const loadIdRef = useRef<number>(0);
  // Pending content from current editor, preserved when switching between views
  const pendingContentRef = useRef<string | null>(null);
  const { selectedMemo, selectedNotebook, setSelectedMemo, updateMemoMeta, syncMemoMeta, loadMemos } = useMemoStore();
  const setCurrentMemoDocumentPath = useDocumentStore((store) => store.setCurrentMemoDocumentPath);

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const hasUnsavedLocalChanges = useCallback(() => {
    return contentRef.current !== lastSavedContentRef.current;
  }, []);

  const applyLoadedContent = useCallback((fullContent: string, options?: Pick<LoadContentOptions, 'preservePending'>) => {
    const memo = isExternalDocument ? null : useMemoStore.getState().selectedMemo;
    const createdAt = memo?.createdAt ? formatDateTime(memo.createdAt) : '';
    const updatedAt = memo?.updatedAt ? formatDateTime(memo.updatedAt) : '';
    const updatedAtDate = memo?.updatedAt ? new Date(memo.updatedAt) : null;
    const isFavorited = memo?.favorited || false;
    const isNew = fullContent.trimStart().startsWith('# ');
    const initialContent = options?.preservePending ? (pendingContentRef.current ?? fullContent) : fullContent;
    const initialBody = extractBodyContent(initialContent);
    const initialCharCount = countTextUnits(initialBody);

    setState({
      fullContent: initialContent,
      isLoading: false,
      error: null,
      isScrolled: false,
      isNewlyCreated: isNew,
      charCount: initialCharCount,
      tokenCount: Math.ceil(initialCharCount / 4),
      createdAt,
      updatedAt,
      updatedAtDate,
      isFavorited,
      frontmatterMeta: {},
    });
    contentRef.current = initialContent;
    lastSavedContentRef.current = fullContent;
    lastFrontmatterRef.current = {};
    if (!options?.preservePending) {
      pendingContentRef.current = null;
    }
  }, [isExternalDocument]);

  const reloadDocument = useCallback(async (path: string, options?: LoadContentOptions) => {
      if (!path) return;

    const currentLoadId = ++loadIdRef.current;
    if (options?.showLoading ?? true) {
      setState(prev => ({ ...prev, isLoading: true, error: null, isScrolled: false, isNewlyCreated: false }));
    }

    try {
      const fullContent = await memosClient.readDocument(path);

      if (currentLoadId !== loadIdRef.current) return;

      if (fullContent === null || fullContent === undefined) {
        setState(prev => ({ ...prev, isLoading: false, error: '读取失败' }));
        return;
      }

      applyLoadedContent(fullContent, { preservePending: options?.preservePending });
    } catch (err) {
      if (currentLoadId !== loadIdRef.current) return;
      setState(prev => ({ ...prev, isLoading: false, error: '读取失败' }));
    }
  }, [applyLoadedContent]);

  const saveDoc = useCallback(async (content: string, path: string) => {
    if (!path) return;

    try {
      const expectedContent = lastSavedContentRef.current;
      const result = await memosClient.writeDocument(path, content, expectedContent);

      if (result) {
        const now = Date.now();
        setState(prev => ({
          ...prev,
          updatedAt: formatDateTime(now),
          updatedAtDate: new Date(now),
          error: null,
        }));
        if (selectedMemo && !isExternalDocument) {
          // Extract title and preview from content (lines after frontmatter)
          const { title, preview } = extractTitleAndPreview(content);

          // Update preview in local store (not persisted to frontmatter)
          updateMemoMeta(selectedMemo.id, { updatedAt: now, preview });

          // Parse frontmatter and extract tags/todos from body content
          const fm = parseFrontmatter(content);
          const prevFm = lastFrontmatterRef.current;

          // Extract tags from body content (#tag format)
          const bodyTags = extractTagsFromBody(content);
          // Merge frontmatter tags with body tags (union)
          const allTags = [...new Set([...(fm.tags || []), ...bodyTags])];

          // Extract todos from body content (- [ ] or - [x] format)
          const bodyTodos = extractTodosFromBody(content);
          // Merge frontmatter todos with body todos (combine, avoid duplicate content)
          const existingTodoContents = new Set((fm.todos || []).map(t => t.content));
          const mergedTodos = [
            ...(fm.todos || []),
            ...bodyTodos.filter(t => !existingTodoContents.has(t.content)),
          ];

          const hasTagsChanged = JSON.stringify(allTags) !== JSON.stringify(prevFm.tags);
          const hasTodosChanged = JSON.stringify(mergedTodos) !== JSON.stringify(prevFm.todos);
          // Only consider filename changed if prevFm had a defined value and it actually differs
          const hasFilenameExplicitlyChanged = prevFm.filename !== undefined && fm.filename !== prevFm.filename;
          // Title changes even when the document is cleared and the extracted title becomes empty.
          const hasTitleChanged = title !== prevFm.title;

          // Determine what filename to sync: prefer explicit filename change, otherwise use title
          const syncFilename = hasFilenameExplicitlyChanged ? fm.filename : (hasTitleChanged ? title : undefined);

          const hasPreviewChanged = preview !== selectedMemo.preview;

          if (hasTagsChanged || hasTodosChanged || hasFilenameExplicitlyChanged || hasTitleChanged || hasPreviewChanged) {
            syncMemoMeta(selectedMemo.id, {
              filename: syncFilename,
              preview: hasPreviewChanged ? preview : undefined,
            }).then(() => {
              // Reload memos to pick up backend-derived tags, todos, preview, and path.
              loadMemos();
            });
          }
          lastFrontmatterRef.current = { ...fm, title, tags: allTags, todos: mergedTodos };
        }
        lastSavedContentRef.current = content;
        contentRef.current = content;
        pendingContentRef.current = null;
      } else {
        await reloadDocument(path, { preservePending: false, showLoading: false });
      }
    } catch (err) {
      console.error('[DocumentContainer] Failed to save memo:', err);
      setState(prev => ({ ...prev, error: '保存失败' }));
    }
  }, [selectedMemo, isExternalDocument, updateMemoMeta, syncMemoMeta, loadMemos, reloadDocument]);

  const handleSaveExternalToMemo = useCallback(async () => {
    if (!filePath || !isExternalDocument || isImportingExternal) return;

    clearSaveTimer();
    const content = contentRef.current;
    await saveDoc(content, filePath);

    setIsImportingExternal(true);
    try {
      const memo = await memosClient.importExternalDocumentToMemo(filePath, content, selectedNotebook?.id) as MemoItem | null;
      if (!memo) {
        setState(prev => ({ ...prev, error: '保存到 Memo 失败' }));
        return;
      }

      setSelectedMemo(memo);
      await loadMemos({ notebookId: selectedNotebook?.id });
      setCurrentMemoDocumentPath(resolveMemoDocumentPath(selectedNotebook?.path, memo, filePath));
    } catch (error) {
      console.error('[DocumentContainer] Failed to import external document:', error);
      setState(prev => ({ ...prev, error: '保存到 Memo 失败' }));
    } finally {
      setIsImportingExternal(false);
    }
  }, [
    filePath,
    isExternalDocument,
    isImportingExternal,
    clearSaveTimer,
    saveDoc,
    selectedNotebook?.id,
    selectedNotebook?.path,
    setSelectedMemo,
    loadMemos,
    setCurrentMemoDocumentPath,
  ]);

  const handleChange = useCallback((content: string) => {
    if (content === lastSavedContentRef.current) return;
    contentRef.current = content;
    pendingContentRef.current = content;
    const body = extractBodyContent(content);
    const textUnits = countTextUnits(body);
    setState(prev => ({
      ...prev,
      fullContent: content,
      charCount: textUnits,
      tokenCount: Math.ceil(textUnits / 4),
    }));
    const currentPath = filePath;
    clearSaveTimer();
    saveTimerRef.current = setTimeout(async () => {
      await saveDoc(content, currentPath);
    }, 1000);
  }, [filePath, saveDoc, clearSaveTimer]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && filePath && contentRef.current) {
        clearSaveTimer();
        saveDoc(contentRef.current, filePath);
      }
    };

    const handleBeforeUnload = () => {
      if (filePath && contentRef.current) {
        saveDoc(contentRef.current, filePath);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [filePath, saveDoc, clearSaveTimer]);

  useEffect(() => {
    const handleNavigateToMemo = async (e: Event) => {
      const customEvent = e as CustomEvent<{ memoId: string }>;
      const targetMemoId = customEvent.detail?.memoId;
      if (targetMemoId) {
        const { memos } = useMemoStore.getState();
        const memo = memos.find(m => m.id === targetMemoId);
        if (memo?.path) {
          // Navigate by path - handled by parent component
          window.location.hash = `/memo/${memo.id}`;
        }
      }
    };

    document.addEventListener('navigate-to-memo', handleNavigateToMemo);
    return () => {
      document.removeEventListener('navigate-to-memo', handleNavigateToMemo);
    };
  }, []);

  useEffect(() => {
    if (!filePath) {
      setState(initialState);
      return;
    }

    // Clear pending content when switching to a different document
    if (pendingContentRef.current !== null && contentRef.current !== pendingContentRef.current) {
      pendingContentRef.current = null;
    }

    clearSaveTimer();

    reloadDocument(filePath, { preservePending: true, showLoading: true });
  }, [filePath, reloadDocument, clearSaveTimer]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<{ path?: string; tool?: string }>('agent-document-updated', async (event) => {
      if (disposed || !filePath || !event.payload?.path) return;
      const updatedPath = normalizePathForCompare(event.payload.path);
      const currentPath = normalizePathForCompare(filePath);
      if (updatedPath !== currentPath) return;

      if (hasUnsavedLocalChanges()) return;

      clearSaveTimer();

      await reloadDocument(filePath, { preservePending: false, showLoading: false });
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
  }, [filePath, reloadDocument, clearSaveTimer, hasUnsavedLocalChanges]);

  useEffect(() => {
    if (!filePath) return;

    let disposed = false;
    let inFlight = false;

    const checkForExternalUpdate = async () => {
      if (disposed || inFlight || document.hidden) return;
      if (hasUnsavedLocalChanges()) return;

      inFlight = true;
      try {
        const diskContent = await memosClient.readDocument(filePath);
        if (disposed || diskContent === null || diskContent === undefined) return;
        if (
          diskContent !== lastSavedContentRef.current &&
          contentRef.current === lastSavedContentRef.current
        ) {
          clearSaveTimer();
          applyLoadedContent(diskContent, { preservePending: false });
        }
      } finally {
        inFlight = false;
      }
    };

    const handleFocus = () => {
      checkForExternalUpdate();
    };

    const timer = window.setInterval(checkForExternalUpdate, 2500);
    window.addEventListener('focus', handleFocus);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [filePath, applyLoadedContent, clearSaveTimer, hasUnsavedLocalChanges]);

  const metaInfo = useMemo(() => {
    return {
      charCount: state.charCount,
      tokenCount: state.tokenCount,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      memoPath: selectedMemo?.id ?? null,
      memoContent: state.fullContent,
      isFavorited: state.isFavorited,
      frontmatterMeta: state.frontmatterMeta,
    };
  }, [state.charCount, state.tokenCount, state.createdAt, state.updatedAt, state.fullContent, state.isFavorited, state.frontmatterMeta, selectedMemo?.id]);

  useEffect(() => {
    if (filePath) {
      onMetainfoData?.(metaInfo);
      onCharCountChange?.(state.charCount);
    }
  }, [filePath, metaInfo, onMetainfoData, onCharCountChange, state.charCount]);

  if (!filePath) {
    return (
      <div className="w-full flex items-center justify-center h-full text-[var(--muted-foreground)] text-sm">
        请选择一个 Memo 文档
      </div>
    );
  }

  if (state.isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--muted-foreground)] text-sm">
        加载中...
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--muted-foreground)] text-sm">
        {state.error}
      </div>
    );
  }

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-transparent relative overflow-hidden">
      <div className="flex-1 h-full min-w-0 overflow-hidden flex flex-col">
        {isExternalDocument && (
          <div className="shrink-0 flex items-center gap-3 border-b border-black/5 bg-white/85 px-6 py-2 text-xs text-[#4D4F5B]">
            <span className="shrink-0 text-gray-400">外部文档</span>
            <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
            <button
              type="button"
              onClick={handleSaveExternalToMemo}
              disabled={isImportingExternal}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-black/10 bg-white px-2.5 text-xs text-[#4D4F5B] hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" />
              {isImportingExternal ? '保存中...' : '保存到 Memo'}
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-hidden">
        {isSrcView && (
          <SrcEditor
            key={filePath}
            content={state.fullContent}
            onChange={(content) => {
              handleChange(content);
              if (state.isNewlyCreated) setState(prev => ({ ...prev, isNewlyCreated: false }));
            }}
          />
        )}
        {!isSrcView && state.fullContent && (
          <>
            <ComnTiptapEditor
              key={filePath}
              content={state.fullContent}
              onChange={(content) => {
                handleChange(content);
                if (state.isNewlyCreated) setState(prev => ({ ...prev, isNewlyCreated: false }));
              }}
              placeholder="请输入 Memo..."
              className=""
              onEditorScroll={(scrollTop) => setState(prev => ({ ...prev, isScrolled: scrollTop > 90 }))}
              autoFocus={state.isNewlyCreated}
              editorStorageUpdatedAt={state.updatedAtDate ?? (selectedMemo?.updatedAt ? new Date(selectedMemo.updatedAt) : null)}
            />
          </>
        )}
        </div>
      </div>
    </div>
  );
}
