import { useCallback, useRef, type ComponentProps } from 'react';
import type { DocumentContainer } from '@features/document/components/document-container';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { openExternalTarget } from '@features/workspace/use-cases/workspace-navigation';
import { openMediaTarget } from '@features/workspace/use-cases/workspace-navigation';
import { openBrowserColumnTarget } from '@features/workspace/use-cases/browser-column-navigation';
import { CodeSurfaceView } from './code-surface-view';
import type { FileBrowserContext } from '@features/workspace/store/file-browser-target';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { externalFileViewKind } from '@features/editor/public/code-file';
import type { CodeSurface } from './types';

type DocumentProps = ComponentProps<typeof DocumentContainer>;

export function CodeSurfaceFileBrowser({ surface }: { surface: CodeSurface }) {
  const props = surface.props;
  const target = useWorkColumnStore((state) => state.navigation.target);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const { t } = useI18n();
  const onFlushReady = useCallback((flush: (() => Promise<boolean>) | null) => {
    flushRef.current = flush;
    props.onFlushReady?.(flush);
  }, [props.onFlushReady]);
  if (target.kind !== 'external') return <CodeSurfaceView props={props} fileTree={null} />;
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
      const fileKind = externalFileViewKind(path);
      if ((fileKind === 'image' || fileKind === 'video') && context.scopePath) {
        await openMediaTarget({
          filePath: path,
          notebookId: context.notebookId,
          notebookPath: context.scopePath,
          resourceKind: fileKind,
        });
      } else {
        await openExternalTarget(path, { destination: 'main-third', scopePath: context.scopePath, fileBrowser: context });
      }
    } catch {
      toast.error(t('tabWindow.switchFailed'));
    }
  };
  const documentProps = {
    ...props,
    filePath: target.path,
    externalScopePath: context.scopePath,
    onFlushReady,
  };
  return <CodeSurfaceView
    props={documentProps}
    fileTree={{
      ...context, kind: 'file-browser', activeFilePath: target.path,
      onSelectFile: (path) => { void selectFile(path); },
      onOpenFileInNewTab: (path) => {
        void openBrowserColumnTarget({ ...context, kind: 'file-browser', activeFilePath: path, folderPath: null }, 'open-in-column');
      },
      onContextChange: updateView,
      onTreeVisibleChange: (fileTreeVisible) => updateView({ fileTreeVisible }),
      onTreeWidthChange: (fileTreeWidth) => updateView({ fileTreeWidth }),
    }}
  />;
}
