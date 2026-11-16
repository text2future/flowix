import type { RefObject } from 'react';

import { useI18n } from '@/lib/i18n';
import {
  resolveMainColumnPresentation,
  resolveMainColumnRuntimePresentation,
  useWorkspaceSurfacePresentation,
  type DocumentSurfaceContext,
  type MainColumnPresentation,
} from '@features/surface/public/shell-api';
import type { Notebook } from '@features/memo/public/shell-api';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { useShellWorkspaceViewModel } from '@features/workspace/public/shell-api';

type WorkspaceNavigation = ReturnType<typeof useShellWorkspaceViewModel>['navigation'];

export interface UseMainColumnPresentationInput {
  navigation: WorkspaceNavigation;
  selectedNotebook: Notebook | null;
  mainColumnDocument: DocumentSurfaceContext | null;
  activePlugin: PluginDescriptor | null;
  currentDocumentPath: string | null;
  /** Ref, not value: keeps the resolver reading freshest content without re-subscribing. */
  currentDocumentContentRef: RefObject<string>;
}

/**
 * Resolves the work column presentation (header/content/runtime state) for
 * the main detail column, including the media-target override that forces an
 * empty state when the target notebook is not the selected one.
 */
export function useMainColumnPresentation({
  navigation,
  selectedNotebook,
  mainColumnDocument,
  activePlugin,
  currentDocumentPath,
  currentDocumentContentRef,
}: UseMainColumnPresentationInput) {
  const { t } = useI18n();
  const visibleNavigationState = selectedNotebook && (
    navigation.target.kind === 'media'
    && navigation.target.notebookId !== selectedNotebook.id
  ) ? { ...navigation, target: { kind: 'empty' as const } } : navigation;
  const mainColumnPresentation: MainColumnPresentation = resolveMainColumnPresentation({
    navigation: visibleNavigationState,
    document: mainColumnDocument,
    pluginWorkbench: activePlugin
      ? {
          plugin: activePlugin,
          notebookPath: selectedNotebook?.path,
          currentNotePath: currentDocumentPath,
          currentNoteContent: currentDocumentContentRef.current,
        }
      : null,
    emptyMessage: t('shell.emptyDocument'),
  });
  const workSurfaceViewId = mainColumnPresentation.content.status === 'surface'
    ? mainColumnPresentation.content.surface.instanceKey
    : '';
  const workRuntimePresentation = useWorkspaceSurfacePresentation(workSurfaceViewId);
  const workSurfaceBlockingLoading = workRuntimePresentation.state?.status === 'loading'
    && workRuntimePresentation.state.loadingMode === 'blocking';
  const effectiveWorkPresentation = resolveMainColumnRuntimePresentation(
    mainColumnPresentation,
    workRuntimePresentation,
    mainColumnDocument?.identity,
  );
  return {
    mainColumnPresentation,
    workRuntimePresentation,
    workSurfaceBlockingLoading,
    effectiveWorkPresentation,
    workCapabilities: effectiveWorkPresentation.capabilities,
    workHeaderStyle: effectiveWorkPresentation.chrome,
    isAgentConversationDetail: mainColumnPresentation.header.kind === 'agent',
  };
}
