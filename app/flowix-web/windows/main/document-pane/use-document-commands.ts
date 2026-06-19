import { useCallback } from 'react';

import { displayTitleFromFilename } from '../../../lib/utils';
import { sanitizeFileName, stripFrontmatter } from '../../../lib/export-utils';
import { memos as memosClient, dialogs, type SaveFileFilter } from '../../../lib/tauri/client';
import { toast } from '../../../lib/toast';
import type { MemoColor, MemoItem } from '../../../lib/store';

type ExportableDocument = { title: string; markdown: string };

interface UseDocumentCommandsOptions {
  currentDocumentPath: string | null;
  getCurrentDocumentContent: () => string;
  currentMemo: MemoItem | null;
  isExternalDocument: boolean;
  updateMemoMeta: (id: string, meta: Partial<Pick<MemoItem, 'updatedAt' | 'preview' | 'favorited' | 'filename'>>) => void;
  setMemoColors: (id: string, colors: MemoColor[]) => Promise<boolean>;
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

async function writeClipboardText(text: string): Promise<void> {
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
}

export function useDocumentCommands({
  currentDocumentPath,
  getCurrentDocumentContent,
  currentMemo,
  isExternalDocument,
  updateMemoMeta,
  setMemoColors,
}: UseDocumentCommandsOptions) {
  const getExportableDocument = useCallback(async (): Promise<ExportableDocument | null> => {
    if (!currentDocumentPath) return null;

    let raw = getCurrentDocumentContent();
    if (!raw) {
      try {
        raw = (await memosClient.readDocument(currentDocumentPath)) ?? '';
      } catch (error) {
        console.warn('[useDocumentCommands] Failed to read document for export:', error);
        toast.error('读取文档失败');
        return null;
      }
    }

    const title = displayTitleFromFilename(currentMemo?.filename)
      || extractTitleFromMarkdown(stripFrontmatter(raw))
      || 'Untitled';
    return { title, markdown: raw };
  }, [currentDocumentPath, currentMemo?.filename, getCurrentDocumentContent]);

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

  const handleCopyFullText = useCallback(async () => {
    if (!currentDocumentPath) return;

    try {
      const content = getCurrentDocumentContent() || await memosClient.readDocument(currentDocumentPath) || '';
      await writeClipboardText(content);
      toast.success('复制成功');
    } catch (error) {
      console.warn('[useDocumentCommands] Failed to copy document content:', error);
      toast.error('复制失败');
    }
  }, [currentDocumentPath, getCurrentDocumentContent]);

  const handleCopyLink = useCallback(async () => {
    if (!currentDocumentPath) return;

    try {
      await writeClipboardText(currentDocumentPath);
      toast.success('复制成功');
    } catch (error) {
      console.warn('[useDocumentCommands] Failed to copy document link:', error);
      toast.error('复制失败');
    }
  }, [currentDocumentPath]);

  const handleCopyExternalPath = useCallback(async () => {
    if (!currentDocumentPath || !isExternalDocument) return;

    try {
      await writeClipboardText(currentDocumentPath);
      toast.success('已复制完整路径');
    } catch (error) {
      console.warn('[useDocumentCommands] Failed to copy external path:', error);
      toast.error('复制失败');
    }
  }, [currentDocumentPath, isExternalDocument]);

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
      console.warn('[useDocumentCommands] Failed to toggle pin:', error);
      toast.error(wasFavorited ? '取消置顶失败' : '置顶失败');
    }
  }, [currentMemo, updateMemoMeta]);

  const handleColorsChange = useCallback((next: MemoColor[]) => {
    if (!currentMemo) return;
    void setMemoColors(currentMemo.id, next);
  }, [currentMemo, setMemoColors]);

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

    let exportModule: typeof import('../../../lib/export');
    let bodyHtml: string;
    try {
      exportModule = await import('../../../lib/export');
      bodyHtml = exportModule.markdownToHtml(doc.markdown);
    } catch (error) {
      console.warn('[useDocumentCommands] Failed to convert markdown for Word export:', error);
      toast.error('导出失败');
      return;
    }

    const ok = await dialogs.writeExportFile(target, exportModule.buildWordHtml(doc.title, bodyHtml));
    toast[ok ? 'success' : 'error'](ok ? '已导出 Word 文档' : '导出失败');
  }, [promptExportTarget, requireExportableDocument]);

  return {
    handleCopyFullText,
    handleCopyLink,
    handleCopyExternalPath,
    handleTogglePin,
    handleColorsChange,
    handleExportMarkdown,
    handleExportWord,
  };
}
