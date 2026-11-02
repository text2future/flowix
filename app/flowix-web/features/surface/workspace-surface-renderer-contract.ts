import type { ComponentProps, ReactNode } from 'react';
import type { DocumentContainer } from '@features/document/components/document-container';
import type { FileDisplayIdentity } from '@/lib/file-display-registry';
import type { CollectionDisplayDescriptor } from '@/lib/collection-display-registry';
import type { TableDocumentViewProps } from '@features/multidimensional-table/public/surface-api';
import type { PluginDocumentViewProps, PluginWorkbenchProps } from '@features/plugin/public/surface-api';
import type { SurfaceLifecycle, SurfacePresentationUpdate, SurfaceViewContext, WorkspaceWebRuntime } from '@features/workspace/model/surface-contract';
import type { FileBrowserViewSurface } from './file-browser-view';

export interface WorkspaceWebNavigationPort {
  getRuntime: () => WorkspaceWebRuntime | null;
  setRuntime: (runtime: WorkspaceWebRuntime) => void;
  navigate: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  updateMetadata: (metadata: { title: string; icon: string | null }) => void;
}

export type WorkspaceFileBrowserSurfaceProps = FileBrowserViewSurface & {
  fileIdentity?: FileDisplayIdentity;
  collectionDisplay?: CollectionDisplayDescriptor;
  documentProps: ExternalDocumentProps;
};

export type ExternalDocumentProps = Omit<ComponentProps<typeof DocumentContainer>, 'isExternalDocument' | 'fileIdentity'> & { isExternalDocument: true };

export type WorkspaceSurfaceRendererData =
  | { kind: 'file-markdown'; fileIdentity: FileDisplayIdentity; scopePath: string | null; documentProps: ExternalDocumentProps }
  | { kind: 'file-code'; fileIdentity: FileDisplayIdentity; scopePath: string | null; documentProps: ExternalDocumentProps; instanceKey: string }
  | { kind: 'file-csv'; fileIdentity: FileDisplayIdentity; scopePath: string | null }
  | { kind: 'file-image'; fileIdentity: FileDisplayIdentity; scopePath: string | null }
  | { kind: 'file-video'; fileIdentity: FileDisplayIdentity; scopePath: string | null }
  | { kind: 'file-table'; fileIdentity: FileDisplayIdentity; props: TableDocumentViewProps }
  | { kind: 'file-media-library'; fileIdentity: FileDisplayIdentity; notebookPath: string | null; notebookId: string | null; expectedCollectionId?: string | null }
  | { kind: 'file-work-documents'; fileIdentity: FileDisplayIdentity; notebookPath: string | null; notebookId: string | null; expectedCollectionId?: string | null }
  | { kind: 'file-html'; fileIdentity: FileDisplayIdentity; scopePath: string | null; documentProps: ExternalDocumentProps }
  | { kind: 'file-docx'; fileIdentity: FileDisplayIdentity; scopePath: string | null }
  | { kind: 'file-unavailable'; fileIdentity: FileDisplayIdentity; scopePath: string | null; documentProps?: ExternalDocumentProps }
  | { kind: 'media'; fileIdentity: FileDisplayIdentity; notebookPath: string | null; notebookId: string | null; resourceKind: 'image' | 'video' }
  | { kind: 'agent-conversation'; instanceId: string }
  | { kind: 'web'; url: string; title?: string; runtime?: WorkspaceWebRuntime | null }
  | { kind: 'file-browser'; props: WorkspaceFileBrowserSurfaceProps }
  | { kind: 'collection'; notebookId: string; notebookPath: string; folderPath: string; folderName: string; viewMode?: 'work-documents' }
  | { kind: 'mindmap'; props: PluginDocumentViewProps }
  | { kind: 'plugin-artifact'; props: PluginDocumentViewProps }
  | { kind: 'plugin-workbench'; props: PluginWorkbenchProps };

export interface WorkspaceSurfaceRenderContext extends Pick<SurfaceViewContext,
  'host' | 'viewId' | 'focused' | 'readOnly' | 'initialFocus'> {
  sessionEntryId?: string | null;
  reportPresentation?: (update: SurfacePresentationUpdate) => void;
  onRendererError?: () => void;
  registerLifecycle?: (lifecycle: SurfaceLifecycle | null, owner?: object) => void;
  webNavigation?: WorkspaceWebNavigationPort;
  webAddressBarVisible?: boolean;
  onCollectionActiveViewChange?: (viewId: string) => void;
  /** Browser's file tree/source shell for the file kinds that use it. */
  wrapInFileBrowser?: (content: ReactNode) => ReactNode;
}
