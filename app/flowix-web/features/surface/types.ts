import type { ComponentProps } from 'react';
import type { AgentConversationDetail } from '@features/agent/components/agent-conversation-detail';
import type { DocumentContainer } from '@features/document/components/document-container';
import type {
  PluginDocumentViewProps,
  PluginWorkbenchProps,
} from '@features/plugin/public/surface-api';
import type { PluginArtifactRendererId } from '@features/plugin/plugin-note';
import type { MemoItem } from '@/types/memo-item';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { WorkColumnNavigationState } from '@features/workspace/store/work-column-target';

export type WorkColumnSurfaceCapability =
  | 'edit'
  | 'search'
  | 'memo-colors'
  | 'properties'
  | 'copy-content'
  | 'export-content'
  | 'save-template'
  | 'version-history'
  | 'fit'
  | 'zoom'
  | 'fullscreen'
  | 'open-source'
  | 'run-agent'
  | 'stream-conversation';

/** Visual chrome owned by the currently mounted surface. */
export type WorkColumnSurfaceChrome = 'document' | 'agent' | 'media';

export type WorkColumnEmptyReason =
  | 'no-target'
  | 'stale-context'
  | 'invalid-target'
  | 'invalid-artifact';

export type WorkColumnEmptyStateTone = 'document' | 'agent';

interface SurfaceBase {
  instanceKey: string;
}

export type ExternalDocumentProps = Omit<ComponentProps<typeof DocumentContainer>, 'isExternalDocument'> & {
  isExternalDocument: true;
};

export interface NoteSurface extends SurfaceBase {
  kind: 'note';
  memoId: string;
  props: Omit<ComponentProps<typeof DocumentContainer>, 'isExternalDocument' | 'memoId'> & {
    isExternalDocument?: false;
  };
}

/** Markdown files opened as external documents, outside the memo model. */
export interface MDSurface extends SurfaceBase {
  kind: 'md';
  props: ExternalDocumentProps;
}

/** Plain-text/code documents opened from outside the notebook memo model. */
export interface CodeSurface extends SurfaceBase {
  kind: 'code';
  props: ExternalDocumentProps;
}

export interface ImageFileSurface extends SurfaceBase {
  kind: 'image-file';
  filePath: string;
  scopePath: string | null;
  props: ExternalDocumentProps;
}

export interface VideoFileSurface extends SurfaceBase {
  kind: 'video-file';
  filePath: string;
  scopePath: string | null;
  props: ExternalDocumentProps;
}

export interface HtmlFileSurface extends SurfaceBase {
  kind: 'html-file';
  filePath: string;
  scopePath: string | null;
  props: ExternalDocumentProps;
}

export interface UnavailableFileSurface extends SurfaceBase {
  kind: 'unavailable-file';
  filePath: string;
  props: ExternalDocumentProps;
}

export interface MediaResourceSurface extends SurfaceBase {
  kind: 'media';
  filePath: string;
  notebookId: string | null;
  notebookPath: string | null;
  resourceKind: 'image' | 'video';
}

export interface PluginArtifactSurfaceBase extends SurfaceBase {
  props: PluginDocumentViewProps;
  renderer: PluginArtifactRendererId | null;
}

export interface MindmapSurface extends PluginArtifactSurfaceBase {
  kind: 'mindmap';
  renderer: 'markmap';
}

export interface HtmlSurface extends PluginArtifactSurfaceBase {
  kind: 'html';
  renderer: 'html' | 'webpage';
}

export interface JsonSurface extends PluginArtifactSurfaceBase {
  kind: 'json';
  renderer: 'json-viewer';
}

export interface TextSurface extends PluginArtifactSurfaceBase {
  kind: 'text';
  renderer: 'text' | 'markdown';
}

export interface PluginArtifactSurface extends PluginArtifactSurfaceBase {
  kind: 'plugin-artifact';
}

export interface AgentConversationSurface extends SurfaceBase {
  kind: 'agent-conversation';
  instanceId: ComponentProps<typeof AgentConversationDetail>['instanceId'];
}

export interface PluginWorkbenchSurface extends SurfaceBase {
  kind: 'plugin-workbench';
  props: PluginWorkbenchProps;
}

export interface WebSurface extends SurfaceBase {
  kind: 'web';
  url: string;
}

export type WorkColumnSurface =
  | NoteSurface
  | MDSurface
  | CodeSurface
  | ImageFileSurface
  | VideoFileSurface
  | HtmlFileSurface
  | UnavailableFileSurface
  | MediaResourceSurface
  | MindmapSurface
  | HtmlSurface
  | JsonSurface
  | TextSurface
  | PluginArtifactSurface
  | AgentConversationSurface
  | PluginWorkbenchSurface
  | WebSurface;

export type WorkColumnSurfaceKind = WorkColumnSurface['kind'];

export type WorkColumnContentPresentation =
  | {
      status: 'surface';
      surface: WorkColumnSurface;
    }
  | {
      status: 'empty';
      reason: WorkColumnEmptyReason;
      tone: WorkColumnEmptyStateTone;
      message: string;
    };

export type DocumentSurfaceIdentity =
  | {
      kind: 'memo';
      memoId: string;
      path: string;
      notebookId: string | null;
      notebookPath: string | null;
      transitionId: number | null;
    }
  | {
      kind: 'external';
      path: string;
      scopePath: string | null;
      transitionId: number | null;
    };

/** A document session contributes the surface matching its business identity. */
export type DocumentSurfaceContext =
  | {
      /** Identity captured from the document session, independent of props. */
      identity: Extract<DocumentSurfaceIdentity, { kind: 'memo' }>;
      memo: MemoItem | null;
      surface: NoteSurface;
    }
  | {
      /** Identity captured from the document session, independent of props. */
      identity: Extract<DocumentSurfaceIdentity, { kind: 'external' }>;
      instanceKey: string;
      memo: null;
      documentProps: ExternalDocumentProps;
    };

export interface PluginWorkbenchContext {
  plugin: PluginDescriptor;
  notebookPath: string | undefined;
  currentNotePath: string | null;
  currentNoteContent: string;
}

export interface ResolveWorkColumnContentInput {
  navigation: WorkColumnNavigationState;
  document?: DocumentSurfaceContext | null;
  pluginWorkbench?: PluginWorkbenchContext | null;
  emptyMessage: string;
}
