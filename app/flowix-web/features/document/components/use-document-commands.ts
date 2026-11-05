import { createLogger } from '@/lib/logger';
const logger = createLogger('use-document-commands');
import { useCallback } from 'react';

import { displayTitleFromFilename } from '@/lib/utils';
import { sanitizeFileName, stripFrontmatter } from '@/lib/export-utils';
import { notes, dialogs, type SaveFileFilter } from '@platform/tauri/client';
import { buildNoteOpenLinkFromPath } from '@platform/open-target/path-link';
import { useNoteStore } from '@features/memo/store/note-store';
import { memoDocumentOperations } from '@features/document/use-cases/memo-document-operations';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';
import { preparePdfPrint } from '@features/document/pdf-print';
import type { Editor } from '@tiptap/core';

type ExportableDocument = { title: string; markdown: string };

let pdfExportInProgress = false;

type CommandKey =
  | 'document.command.readFailed'
  | 'document.command.noDocumentToExport'
  | 'document.command.copySuccess'
  | 'document.command.copyFailed'
  | 'document.command.copyPathSuccess'
  | 'document.command.unpinFailed'
  | 'document.command.pinFailed'
  | 'document.command.unpinSuccess'
  | 'document.command.pinSuccess'
  | 'document.command.exportMarkdown.success'
  | 'document.command.exportMarkdown.failed'
  | 'document.command.saveAsTemplate'
  | 'document.command.saveTemplateFailed'
  | 'document.command.wordDocName'
  | 'document.command.exportFailed'
  | 'document.command.exportWord.success'
  | 'document.command.exportWord.failed'
  | 'document.command.exportPdf.success'
  | 'document.command.exportPdf.failed'
  | 'document.command.pdfName';

function tCmd(key: CommandKey, params?: Record<string, string | number>): string {
  const language = getCurrentAppLanguage();
  return translate(language, key, params);
}

interface UseDocumentCommandsOptions {
  currentDocumentPath: string | null;
  getCurrentDocumentContent: () => string;
  getCurrentDocumentEditor: () => Editor | null;
  pdfHost?: 'column-1' | 'column-2';
  onExported?: (filePath: string) => void;
}

function extractTitleFromMarkdown(body: string): string {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 与后端 `derivation::decode_html_entities` 对齐: 行首/行尾的空白类 HTML
    // 实体 (例如 `&nbsp;` / `&ensp;` / `&#160;`) 在标题里会被折叠为空, 不应作为内容
    // 泄漏到导出文件名 / 复制文本。
    const cleaned = trimmed
      .replace(/&nbsp;|&#160;|&#xa0;|&#xA0;| |&ensp;|&#8194;|&#x2002;|&emsp;|&#8195;|&#x2003;|&thinsp;|&#8201;|&#x2009;|&hairsp;|&#8202;|&#x200A;|&numsp;|&#8199;|&#x2007;|&puncsp;|&#8200;|&#x2008;|&mediumsp;|&#8287;|&#x205F;|&idsp;|&#12288;|&#x3000;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;|&#34;/g, '"')
      .trim();
    if (!cleaned) continue;
    return cleaned
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
  getCurrentDocumentEditor,
  pdfHost = 'column-1',
  onExported,
}: UseDocumentCommandsOptions) {
  const getExportableDocument = useCallback(async (): Promise<ExportableDocument | null> => {
    if (!currentDocumentPath) return null;

    let raw = getCurrentDocumentContent();
    if (!raw) {
      try {
        raw = (await memoDocumentOperations.read({ path: currentDocumentPath, scopePath: null })) ?? '';
      } catch (error) {
        logger.warn('[useDocumentCommands] Failed to read document for export:', { error: error });
        toast.error(tCmd('document.command.readFailed'));
        return null;
      }
    }

    const pathFilename = currentDocumentPath.split(/[\\/]/).filter(Boolean).pop();
    const title = displayTitleFromFilename(pathFilename)
      || extractTitleFromMarkdown(stripFrontmatter(raw))
      || 'Untitled';
    return { title, markdown: raw };
  }, [currentDocumentPath, getCurrentDocumentContent]);

  const requireExportableDocument = useCallback(async () => {
    const doc = await getExportableDocument();
    if (!doc) {
      toast.error(tCmd('document.command.noDocumentToExport'));
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
      const content = getCurrentDocumentContent() || await memoDocumentOperations.read({ path: currentDocumentPath, scopePath: null }) || '';
      await writeClipboardText(content);
      toast.success(tCmd('document.command.copySuccess'));
    } catch (error) {
      logger.warn('[useDocumentCommands] Failed to copy document content:', { error: error });
      toast.error(tCmd('document.command.copyFailed'));
    }
  }, [currentDocumentPath, getCurrentDocumentContent]);

  const handleCopyLink = useCallback(async () => {
    if (!currentDocumentPath) return;

    try {
      const link = buildNoteOpenLinkFromPath(currentDocumentPath, useNoteStore.getState().notebooks);
      if (!link) throw new Error('Cannot create an unambiguous notebook link');
      await writeClipboardText(link);
      toast.success(tCmd('document.command.copySuccess'));
    } catch (error) {
      logger.warn('[useDocumentCommands] Failed to copy document link:', { error: error });
      toast.error(tCmd('document.command.copyFailed'));
    }
  }, [currentDocumentPath]);

  const handleExportMarkdown = useCallback(async () => {
    const doc = await requireExportableDocument();
    if (!doc) return;

    const target = await promptExportTarget(doc, 'md', { name: 'Markdown', extensions: ['md', 'markdown'] });
    if (!target) return;

    const ok = await dialogs.writeExportFile(target, doc.markdown);
    if (ok) onExported?.(target);
    toast[ok ? 'success' : 'error'](tCmd(ok ? 'document.command.exportMarkdown.success' : 'document.command.exportMarkdown.failed'));
  }, [onExported, promptExportTarget, requireExportableDocument]);

  const handleSaveAsTemplate = useCallback(async () => {
    const doc = await requireExportableDocument();
    if (!doc) return;

    try {
      const template = await notes.saveTemplate(doc.title, doc.markdown);
      toast.success(tCmd('document.command.saveAsTemplate', { name: template.name }));
    } catch (error) {
      logger.warn('[useDocumentCommands] Failed to save template:', { error: error });
      toast.error(tCmd('document.command.saveTemplateFailed'));
    }
  }, [requireExportableDocument]);

  const handleExportWord = useCallback(async () => {
    const doc = await requireExportableDocument();
    if (!doc) return;

    const wordDocName = tCmd('document.command.wordDocName');
    const target = await promptExportTarget(doc, 'doc', { name: wordDocName, extensions: ['doc'] });
    if (!target) return;

    let exportModule: typeof import('@/lib/export');
    let bodyHtml: string;
    try {
      exportModule = await import('@/lib/export');
      bodyHtml = exportModule.markdownToHtml(doc.markdown);
    } catch (error) {
      logger.warn('[useDocumentCommands] Failed to convert markdown for Word export:', { error: error });
      toast.error(tCmd('document.command.exportFailed'));
      return;
    }

    const language = getCurrentAppLanguage();
    const ok = await dialogs.writeExportFile(target, exportModule.buildWordHtml(doc.title, bodyHtml, language));
    if (ok) onExported?.(target);
    toast[ok ? 'success' : 'error'](tCmd(ok ? 'document.command.exportWord.success' : 'document.command.exportWord.failed'));
  }, [onExported, promptExportTarget, requireExportableDocument]);

  const handleExportPdf = useCallback(async () => {
    if (pdfExportInProgress) return;
    pdfExportInProgress = true;

    let restorePrintView: (() => void) | null = null;
    try {
      const doc = await requireExportableDocument();
      if (!doc) return;

      const pdfName = tCmd('document.command.pdfName');
      const target = await promptExportTarget(doc, 'pdf', { name: pdfName, extensions: ['pdf'] });
      if (!target) return;

      restorePrintView = await preparePdfPrint(getCurrentDocumentEditor(), pdfHost);
      const ok = await dialogs.exportPdf(target);
      if (ok) onExported?.(target);
      toast[ok ? 'success' : 'error'](
        tCmd(ok ? 'document.command.exportPdf.success' : 'document.command.exportPdf.failed'),
      );
    } catch (error) {
      logger.warn('[useDocumentCommands] Failed to export PDF:', { error: error });
      toast.error(tCmd('document.command.exportPdf.failed'));
    } finally {
      const restore = restorePrintView;
      restorePrintView = null;
      restore?.();
      pdfExportInProgress = false;
    }
  }, [getCurrentDocumentEditor, onExported, pdfHost, promptExportTarget, requireExportableDocument]);

  return {
    handleCopyFullText,
    handleCopyLink,
    handleExportMarkdown,
    handleSaveAsTemplate,
    handleExportWord,
    handleExportPdf,
  };
}
