import { setCollectionActiveView } from '@features/workspace/use-cases/collection-view-state';
import { externalFileViewKind } from '@features/editor/public/code-file';
import type { WorkColumnSurface } from './types';
import type { WorkspaceSurfaceRendererData } from './workspace-surface-renderer-contract';

/** Convert Work's navigation discriminants to the canonical renderer input. */
export function workspaceSurfaceRendererDataFromWorkSurface(surface: WorkColumnSurface): WorkspaceSurfaceRendererData {
  switch (surface.kind) {
    case 'file-browser': return { kind: 'file-browser', props: surface };
    case 'folder-collection': return { kind: 'collection', notebookId: surface.notebookId,
      notebookPath: surface.notebookPath, folderPath: surface.folderPath, folderName: surface.folderName, viewMode: surface.viewMode };
    case 'media': return { kind: 'media', fileIdentity: surface.fileIdentity, notebookPath: surface.notebookPath, notebookId: surface.notebookId, resourceKind: surface.resourceKind };
    case 'agent-conversation': return { kind: 'agent-conversation', instanceId: surface.instanceId };
    case 'mindmap': return { kind: 'mindmap', props: surface.props };
    case 'html':
    case 'json':
    case 'text':
    case 'plugin-artifact': return { kind: 'plugin-artifact', props: surface.props };
    case 'plugin-workbench': return { kind: 'plugin-workbench', props: surface.props };
    case 'md': return { kind: 'file-markdown', fileIdentity: surface.fileIdentity, scopePath: surface.props.externalScopePath ?? null, documentProps: surface.props };
    case 'code': return { kind: 'file-code', fileIdentity: surface.fileIdentity, scopePath: surface.props.externalScopePath ?? null, documentProps: surface.props, instanceKey: surface.instanceKey };
    case 'csv-file': return { kind: 'file-csv', fileIdentity: surface.fileIdentity, scopePath: surface.scopePath };
    case 'image-file': return { kind: 'file-image', fileIdentity: surface.fileIdentity, scopePath: surface.scopePath };
    case 'video-file': return { kind: 'file-video', fileIdentity: surface.fileIdentity, scopePath: surface.scopePath };
    case 'table-file': {
      const { notebookId, expectedCollectionId } = surface.props;
      return { kind: 'file-table', fileIdentity: surface.fileIdentity, props: {
        ...surface.props,
        onActiveViewChange: notebookId && expectedCollectionId
          ? (viewId) => setCollectionActiveView({ host: 'main-third' }, { notebookId, collectionId: expectedCollectionId }, viewId)
          : surface.props.onActiveViewChange,
      } };
    }
    case 'media-library-file': return { kind: 'file-media-library', fileIdentity: surface.fileIdentity, notebookPath: surface.notebookPath, notebookId: surface.notebookId };
    case 'work-documents-file': return { kind: 'file-work-documents', fileIdentity: surface.fileIdentity, notebookPath: surface.notebookPath, notebookId: surface.notebookId, expectedCollectionId: surface.expectedCollectionId };
    case 'html-file': return { kind: 'file-html', fileIdentity: surface.fileIdentity, scopePath: surface.scopePath, documentProps: surface.props };
    case 'unavailable-file':
      return externalFileViewKind(surface.fileIdentity.path) === 'docx'
        ? { kind: 'file-docx', fileIdentity: surface.fileIdentity, scopePath: surface.scopePath }
        : { kind: 'file-unavailable', fileIdentity: surface.fileIdentity, scopePath: surface.scopePath, documentProps: surface.props };
    case 'web': return { kind: 'web', url: surface.url };
  }
}
