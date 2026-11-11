// Compatibility exports for document and Agent titlebar consumers.
export {
  type DocumentTitlebarProps,
  type DocumentTitlebarTarget,
} from './document-titlebar-model';
export { DocumentTitlebarActions as ExternalDocumentActions } from './document-titlebar-actions';
export { ExternalTitlebarBadge, ExternalPathDisplay, SurfaceHeaderIcon, NoteColorPicker, MediaActions } from './document-titlebar-controls';
export {
  AgentThreadCardFullscreenExitButton,
  AgentThreadCardFullscreenMoreMenu,
  AgentThreadCardFullscreenIdentity,
  useAgentThreadCardFullscreenActive,
  useFullscreenAgentThreadCardInfo,
  type AgentThreadCardFullscreenHost,
} from './agent-thread-card-titlebar-shell';
