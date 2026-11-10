import { useEffect, useRef, useState } from 'react';
import { findFileDisplayPath } from '@/lib/file-display-registry';
import { parentDirectoryPath } from '@/lib/path';
import { useI18n } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { notes, product, type PathVersionMeta } from '@platform/tauri/client';
import { useEditorFontSize } from '@features/preferences/public/font-api';
import { applyLoadedDocumentContent, getDocumentBuffer, saveDocumentPath } from '../store/document-session-service';
import { documentIdentityFromFile } from '../store/document-identity';
import { useEditorFontSwitch } from './editor-font-switcher';
import { useDocumentTitlebarColors } from './use-document-titlebar-colors';
import type { DocumentTitlebarTarget } from './document-titlebar-model';
import type { FontSizeMode } from '@shared/ui/font-size-switcher';

const logger = createLogger('document-titlebar-actions');

export function useDocumentTitlebarActions(target: DocumentTitlebarTarget) {
  const { t } = useI18n();
  const { colors, changeColors } = useDocumentTitlebarColors(target);
  const [confirmVersion, setConfirmVersion] = useState<PathVersionMeta | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);
  const mounted = useRef(false);
  const restoring = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const fontSwitch = useEditorFontSwitch();
  const { fontSize, setFontSize } = useEditorFontSize();
  const selectedFontSizeMode: FontSizeMode | null = fontSize === 15 ? 'small'
    : fontSize === 16 ? 'medium' : fontSize === 17 ? 'large' : null;
  const setEditorFontSizeMode = (mode: FontSizeMode) => {
    void setFontSize({ small: 15, medium: 16, large: 17 }[mode]);
  };
  const filePath = target.fileIdentity.path;
  const identity = documentIdentityFromFile(target.fileIdentity);
  const isSamePath = () => findFileDisplayPath(identity.displayId) === filePath;

  const restorePathVersion = async () => {
    if (!target.notebookId || !target.relativePath || !confirmVersion || restoring.current || !isSamePath()) return;
    restoring.current = true;
    setRestoringVersionId(confirmVersion.id);
    try {
      if (!await saveDocumentPath(identity, filePath, target.scopePath)) {
        if (mounted.current) toast.error(t('document.version.saveCurrentFailed'));
        return;
      }
      if (!mounted.current || !isSamePath()) return;
      const expectedContent = getDocumentBuffer(identity).lastSavedContent;
      const content = await notes.restoreVersion(target.notebookId, target.relativePath, confirmVersion.id, expectedContent);
      if (content === null || !isSamePath()) throw new Error('Version restore was refused');
      applyLoadedDocumentContent(identity, filePath, content, { preservePending: false, setAsCurrent: false });
      if (mounted.current) {
        setConfirmVersion(null);
        setVersionRefreshKey((key) => key + 1);
        toast.success(t('document.version.restored'));
      }
    } catch (error) {
      logger.error('restore version failed', { error, filePath });
      if (mounted.current) toast.error(t('document.version.restoreFailed'));
    } finally {
      restoring.current = false;
      if (mounted.current) setRestoringVersionId(null);
    }
  };

  const copyFolderPath = async () => {
    try {
      await navigator.clipboard.writeText(parentDirectoryPath(filePath, target.scopePath ?? '/'));
      toast.success(t('memo.fileTree.pathCopied'));
    } catch (error) {
      logger.warn('copy folder path failed', { error, filePath });
      toast.error(t('memo.fileTree.copyFailed'));
    }
  };

  const revealFile = async () => {
    try { await product.revealInFileManager(filePath); }
    catch { toast.error(t('memo.fileTree.openFailed')); }
  };

  return {
    colors, changeColors, fontSwitch, selectedFontSizeMode, setEditorFontSizeMode,
    confirmVersion, setConfirmVersion, restoringVersionId, versionRefreshKey,
    restorePathVersion, copyFolderPath, revealFile,
  };
}
