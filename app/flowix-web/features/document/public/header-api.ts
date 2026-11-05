/** Header primitives exclude host adapters so the shared shell cannot import itself through a barrel. */
export { ExternalTitlebarBadge, SurfaceHeaderIcon, MediaActions } from '../components/document-titlebar-controls';
export { DocumentTitlebarActions as ExternalDocumentActions } from '../components/document-titlebar-actions';
export {
  AgentThreadCardFullscreenExitButton,
  AgentThreadCardFullscreenIdentity,
  AgentThreadCardFullscreenMoreMenu,
} from '../components/agent-thread-card-titlebar';
export type { DocumentTitlebarProps, DocumentTitlebarTarget } from '../components/document-titlebar-model';

import { getBuffer } from '../store/buffer-registry';
import type { DocumentIdentity } from '../store/document-identity';
import { captureLatestDocumentContent } from '../store/document-session-service';
export { captureLatestDocumentContent } from '../store/document-session-service';
export { documentIdentityFromFile } from '../store/document-identity';
export { useDocumentEditorMode, setDocumentEditorMode } from '../store/document-editor-view-store';
export { useDocumentCommands } from '../components/use-document-commands';
export { resolveDocumentTitlebarTarget } from '../components/document-titlebar-model';

/** Read a host's freshest editor snapshot for path-based titlebar commands. */
export function readLatestDocumentContent(identity: DocumentIdentity, hostId: 'column-1' | 'column-2'): string {
  captureLatestDocumentContent(identity, hostId);
  return getBuffer(identity)?.content ?? '';
}
