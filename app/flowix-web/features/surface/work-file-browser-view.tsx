import { useCallback, useRef, type ComponentProps } from 'react';
import { DocumentContainer } from '@features/document/components/document-container';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import { openBrowserColumnTarget } from '@features/workspace/use-cases/browser-column-navigation';
import { FileBrowserView } from './file-browser-view';
import type { FileBrowserContext } from '@features/workspace/store/file-browser-target';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';

export function WorkFileBrowserView({ props }: { props: ComponentProps<typeof DocumentContainer> }) {
  const target = useWorkColumnStore((state) => state.navigation.target);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const { t } = useI18n();
  const onFlushReady = useCallback((flush: (() => Promise<boolean>) | null) => {
    flushRef.current = flush;
    props.onFlushReady?.(flush);
  }, [props.onFlushReady]);
  if (target.kind !== 'external') return <DocumentContainer {...props} />;
  const context = target.fileBrowser ?? {
    notebookId: null, restoreNotebookContext: true, folderPath: null,
    scopePath: target.scopePath, fileTreeVisible: true, fileTreeWidth: 220,
  };
  const updateView = (patch: Partial<FileBrowserContext>) => useWorkColumnStore.setState((state) => ({
    navigation: state.navigation.target === target ? {
      ...state.navigation, target: { ...target, fileBrowser: { ...context, ...patch } },
    } : state.navigation,
  }));
  const selectFile = async (path: string) => {
    try {
      if (flushRef.current && !await flushRef.current()) {
        toast.error(t('tabWindow.switchFailed'));
        return;
      }
      // Do not let a delayed save override a newer navigation intent.
      const current = useWorkColumnStore.getState().navigation;
      if (current.phase === 'loading' || current.target.kind !== 'external' || current.target.path !== target.path) return;
      await openExternalTarget(path, { destination: 'main-third', scopePath: context.scopePath, fileBrowser: context });
    } catch {
      toast.error(t('tabWindow.switchFailed'));
    }
  };
  return <FileBrowserView surface={{
    ...context, kind: 'file-browser', activeFilePath: target.path,
    documentProps: { ...props, onFlushReady },
    onSelectFile: (path) => { void selectFile(path); },
    onOpenFileInNewTab: (path) => {
      void openBrowserColumnTarget({ ...context, kind: 'file-browser', activeFilePath: path, folderPath: null }, 'open-in-column');
    },
    onContextChange: updateView,
    onTreeVisibleChange: (fileTreeVisible) => updateView({ fileTreeVisible }),
    onTreeWidthChange: (fileTreeWidth) => updateView({ fileTreeWidth }),
  }} />;
}
